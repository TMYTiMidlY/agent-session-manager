import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseSession, sessionToDialogue, sessionToText } from "../../core/index.js";
import { mapConcurrent } from "../../core/concurrency.js";
import { probeIdentity } from "../../core/relations.js";
import { withAgent, withRole, withRoots, withSource } from "../options/common.js";
import { resolveOne, resolveRefs } from "../options/resolve.js";
import type { ParsedSession, SessionDocument, TimelineEntry, TimelineRole } from "../../core/types.js";
import { filterDocumentRole, projectEntries } from "../../core/normalized.js";

interface GuardianThread {
  agent: string;
  id: string;
  role: string;
  path: string;
  source?: ParsedSession["source"];
  /** The guardian's own unified document — the same content shape as the main payload. */
  document?: SessionDocument;
  entries: TimelineEntry[];
}

/**
 * Guardian sub-threads of the target session, keyed by agent+parentSession.
 * Detected via header-level identity probes — never by bare id across
 * agents. Discovery only runs for applicable LOCAL sources: a ChatGPT share
 * (URL or imported snapshot) never triggers a scan of the live agent homes
 * or any network fetch, and `--file` pointing at a single session file has
 * no sibling scope to scan in the first place.
 */
async function findGuardianThreads(target: ParsedSession, opts: Record<string, unknown>): Promise<ParsedSession[]> {
  if (target.agent !== "codex" || target.source?.kind === "chatgpt-share") return [];
  const sourceOpts = opts.file || opts.events ? opts : { ...opts, agent: target.agent };
  const siblings = (await resolveRefs(sourceOpts)).filter((ref) => ref.agent === target.agent && ref.id !== target.id);
  const probed = await mapConcurrent(siblings, 8, async (ref) => ({ ref, identity: await probeIdentity(ref) }));
  const children = probed.filter(({ identity }) => identity.role === "guardian" && identity.parentSession === target.id);
  return mapConcurrent(children, 4, ({ ref }) => parseSession(ref));
}

function guardianHeader(id: string, path: string): string {
  return `==== guardian sub-thread ${id} (origin: guardian; message roles below are preserved verbatim — guardian content is not rewritten as human turns) ====\npath: ${path}`;
}

/** Apply the timeline --role filter without rewriting the filtered entries' own roles. */
function filterByRole(session: ParsedSession, role: TimelineRole | undefined): ParsedSession {
  if (role === undefined) return session;
  const document = session.document ? filterDocumentRole(session.document, role) : undefined;
  return { ...session, document, entries: document ? projectEntries(document) : session.entries.filter(entry => entry.role === role) };
}

export function buildShowCommand(): Command {
  const cmd = new Command("show")
    .argument("[session-id-or-url]", "会话 ID 或 ChatGPT 公开分享链接（--file 只有一个会话时可省略）")
    .description("Print a session as text, dialogue, or JSON");
  withRole(withAgent(cmd))
    .option("-f, --format <format>", "text|dialogue|json", "text")
    .option("--no-guardian", "show only this session, without guardian sub-threads (merged by default with their origin marked)")
    .option("-o, --out <path>", "output file (default: stdout)");
  withSource(cmd, "read an explicit session file/directory instead of the live agent homes");
  withRoots(cmd);
  cmd.action(async (id, opts) => {
    const ref = await resolveOne(id, opts);
    const parsed = await parseSession(ref);
    const session = filterByRole(parsed, opts.role);
    const guardianSessions = opts.guardian === false ? [] : await findGuardianThreads(parsed, opts);
    // The role filter applies to guardian entries too; their roles stay verbatim.
    const guardians: GuardianThread[] = guardianSessions.map(child => {
      const scoped = filterByRole(child, opts.role);
      return { agent: child.agent, id: child.id, role: "guardian", path: child.path,
        source: child.source, document: scoped.document, entries: scoped.entries };
    });

    let output: string;
    if (opts.format === "json") {
      output = `${JSON.stringify({ ...session, ...(guardians.length ? { guardianThreads: guardians } : {}) }, null, 2)}\n`;
    } else {
      const renderChild = opts.format === "dialogue" ? sessionToDialogue : sessionToText;
      const rendered = [renderChild(session).replace(/\n$/, "")];
      for (const child of guardianSessions) {
        const scoped = filterByRole(child, opts.role);
        rendered.push(`${guardianHeader(`${child.agent}:${child.id}`, child.path)}\n\n${renderChild(scoped)}`);
      }
      output = `${rendered.join("\n\n")}\n`;
    }
    if (opts.out) {
      const out = resolve(String(opts.out));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, output, "utf8");
      console.log(out);
    } else {
      process.stdout.write(output);
    }
  });
  return cmd;
}
