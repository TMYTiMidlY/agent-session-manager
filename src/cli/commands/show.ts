import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  lossySourceWarning,
  parseSession,
  selectTurnEntries,
  sessionToDialogue,
  sessionToPlain,
  sessionToText,
} from "../../core/index.js";
import { mapConcurrent } from "../../core/concurrency.js";
import { probeIdentity } from "../../core/relations.js";
import { nonNegativeInteger, positiveInteger, withAgent, withRole, withRoots, withSource } from "../options/common.js";
import { resolveOne, resolveRefs } from "../options/resolve.js";
import type { ParsedSession, SessionDocument, TimelineEntry, TimelineRole } from "../../core/types.js";
import { computeStats, filterDocumentRole, filterDocumentTurn, projectEntries, tailDocument } from "../../core/normalized.js";
import { buildRecoverySummary, renderRecoverySummary, type RecoverySummary } from "../util/show-recovery.js";

interface GuardianThread {
  agent: string;
  id: string;
  role: string;
  path: string;
  source?: ParsedSession["source"];
  /** The guardian's own unified document — the same content shape as the main payload. */
  document?: SessionDocument;
  entries: TimelineEntry[];
  recoverySummary?: RecoverySummary;
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

/** One-line thread separator for plain output — the bodies themselves stay untouched. */
function guardianPlainSeparator(id: string): string {
  return `==== guardian sub-thread ${id} (origin: guardian) ====`;
}

/** Apply the timeline --role filter without rewriting the filtered entries' own roles. */
function filterByRole(session: ParsedSession, role: TimelineRole | undefined): ParsedSession {
  if (role === undefined) return session;
  const document = session.document ? filterDocumentRole(session.document, role) : undefined;
  return { ...session, identity: document?.identity ?? session.identity, document,
    stats: document ? computeStats(document) : session.stats,
    entries: document ? projectEntries(document) : session.entries.filter(entry => entry.role === role) };
}

/**
 * Apply --turn over the FULL timeline (before --role) so turn numbering stays
 * stable under role filtering. Injected-context user entries neither open a
 * turn nor survive inside the selected window; the reduced document view is
 * marked with the turn number.
 */
function applyTurn(session: ParsedSession, turn: number | undefined): ParsedSession {
  if (turn === undefined) return session;
  const { entries } = selectTurnEntries(session.agent, session.entries, turn);
  const allowed = new Set(entries.map(entry => entry.index));
  const document = session.document ? filterDocumentTurn(session.document, turn, allowed) : undefined;
  return { ...session, identity: document?.identity ?? session.identity, document,
    stats: document ? computeStats(document) : session.stats,
    entries: document ? projectEntries(document) : entries };
}

/** Tail counts normalized entries, not rendered dialogue turns; zero means an empty transcript. */
function reducedView(session: ParsedSession, tail: number | undefined, summary: boolean): ParsedSession {
  if (tail === undefined && !summary) return session;
  const count = tail ?? session.entries.length;
  const document = session.document ? tailDocument(session.document, count) : undefined;
  return { ...session, identity: document?.identity ?? session.identity, document,
    stats: document ? computeStats(document) : session.stats,
    entries: document ? projectEntries(document) : count === 0 ? [] : session.entries.slice(-count) };
}

export function buildShowCommand(): Command {
  const cmd = new Command("show")
    .argument("[session-id-or-url]", "会话 ID 或 ChatGPT 公开分享链接（--file 只有一个会话时可省略）")
    .description("Print a session as text, dialogue, plain bodies, or JSON");
  withRole(withAgent(cmd))
    .addOption(new Option("-f, --format <format>", "text|dialogue|plain|json")
      .choices(["text", "dialogue", "plain", "json"])
      .default("text"))
    .option("--turn <n>", "只选第 N 轮：第 N 条人类输入起，到下一条人类输入之前；注入上下文不开轮次，所选轮次也不含它；不合并 guardian 子线程（先于 --role/--tail 生效）", positiveInteger)
    .option("--tail <n>", "last N normalized entries AFTER --role, independently per thread (non-negative safe integer; 0 = empty transcript)", nonNegativeInteger)
    .option("--summary", "factual continuation evidence, NOT native resume: replaces text/dialogue; JSON adds recoverySummary; reads full role-filtered session BEFORE --tail")
    .option("--no-guardian", "show only this session, without guardian sub-threads (merged by default with their origin marked)")
    .option("-o, --out <path>", "output file (default: stdout)");
  cmd.addHelpText("after", `
Examples:
  asmgr show <session-id> --agent codex --turn 1 --format dialogue
    第一轮对话主干：人类输入 + 其后的助手回复，直到下一轮人类输入；注入上下文（AGENTS 指令、<skill> 注入等）不算一轮。
  asmgr show <session-id> --agent codex --turn 1 --role user --format plain
    第一轮的用户原话：正文原样输出，无 session 头、序号、时间戳或标题；来源有损警告走 stderr。
  asmgr show <session-id> --agent dsh --format dialogue --role user
    全部用户消息（不限轮次）。`);
  withSource(cmd, "read an explicit session file/directory instead of the live agent homes");
  withRoots(cmd);
  cmd.action(async (id, opts) => {
    if (opts.format === "plain" && opts.summary) throw new Error("--summary 不能与 --format plain 同时使用：summary 是替代渲染，plain 是正文原样输出");
    const ref = await resolveOne(id, opts);
    const parsed = await parseSession(ref);
    // Turn → role → tail/summary: turn numbering is role-stable, and summary
    // reads the full turn+role-filtered session BEFORE --tail.
    const fullSession = filterByRole(applyTurn(parsed, opts.turn), opts.role);
    const session = reducedView(fullSession, opts.tail, !!opts.summary);
    const recoverySummary = opts.summary ? buildRecoverySummary(fullSession, { role: opts.role, tail: opts.tail }) : undefined;
    // A turn addresses this session's own timeline; guardian sub-threads have
    // separate timelines and never merge under --turn.
    const guardianSessions = opts.guardian === false || opts.turn !== undefined
      ? []
      : await findGuardianThreads(parsed, opts);
    // Role → tail applies to each thread independently; summary reads the pre-tail scope.
    const childViews = guardianSessions.map(child => {
      const full = filterByRole(child, opts.role);
      return { session: reducedView(full, opts.tail, !!opts.summary),
        summary: opts.summary ? buildRecoverySummary(full, { role: opts.role, tail: opts.tail, origin: "guardian" }) : undefined };
    });
    const guardians: GuardianThread[] = childViews.map(({ session: child, summary }) => ({
      agent: child.agent, id: child.id, role: "guardian", path: child.path,
      source: child.source, document: child.document, entries: child.entries,
      ...(summary ? { recoverySummary: summary } : {}),
    }));

    let output: string;
    if (opts.format === "json") {
      output = `${JSON.stringify({ ...session, ...(recoverySummary ? { recoverySummary } : {}),
        ...(guardians.length ? { guardianThreads: guardians } : {}) }, null, 2)}\n`;
    } else if (opts.format === "plain") {
      // stdout stays exactly the selected bodies; lossy-source caveats go to stderr.
      const warning = lossySourceWarning(session.source);
      if (warning) console.error(`warning: ${warning}`);
      const bodies = [sessionToPlain(session).replace(/\n$/, "")];
      for (const { session: child } of childViews) {
        bodies.push(`${guardianPlainSeparator(`${child.agent}:${child.id}`)}\n${sessionToPlain(child).replace(/\n$/, "")}`);
      }
      output = `${bodies.filter(body => body !== "").join("\n\n")}\n`;
    } else {
      const renderChild = opts.format === "dialogue" ? sessionToDialogue : sessionToText;
      const rendered = [(recoverySummary ? renderRecoverySummary(recoverySummary) : renderChild(session)).replace(/\n$/, "")];
      for (const { session: child, summary } of childViews) {
        rendered.push(`${guardianHeader(`${child.agent}:${child.id}`, child.path)}\n\n${summary ? renderRecoverySummary(summary) : renderChild(child)}`);
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
