#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { AGENTS, discoverPath, discoverSessions, findSession, findSessionAmong, parseSession, searchRefs, sessionToText, type AgentKind, type AgentRoots, type SessionRef } from "@agent-session-exporter/core";
import { renderSessionHtml } from "@agent-session-exporter/html";
import { renderSessionMarkdown } from "@agent-session-exporter/markdown";

const program = new Command();

program
  .name("recall")
  .description("Search and render local coding-agent session histories")
  .version("0.1.0");

program
  .command("list")
  .description("List discovered sessions")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("--file <path>", "read an explicit session file/directory instead of the live agent homes (agent auto-detected)")
  .option("--events <path>", "alias of --file (an explicit events.jsonl path)")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (opts) => {
    const sessions = await resolveRefs(opts);
    for (const session of sessions) {
      console.log(`${session.agent}\t${session.id}\t${session.path}`);
    }
  });

program
  .command("search")
  .argument("<query>")
  .description("Search user/assistant/tool text across sessions")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-l, --limit <n>", "maximum hits", "20")
  .option("--file <path>", "search an explicit session file/directory (e.g. a restic-restored backup cache)")
  .option("--events <path>", "alias of --file (an explicit events.jsonl path)")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (query, opts) => {
    const hits = await searchRefs(await resolveRefs(opts), query, Number(opts.limit));
    for (const hit of hits) {
      console.log(`${hit.session.agent}\t${hit.session.id}\t#${hit.entry.index + 1}\t${hit.entry.role}/${hit.entry.kind}\t${hit.excerpt}`);
    }
  });

program
  .command("show")
  .argument("[session-id]", "session id (optional when --file points at a single file)")
  .description("Print a session as text or JSON")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-f, --format <format>", "text|json", "text")
  .option("--file <path>", "read an explicit session file/directory instead of the live agent homes")
  .option("--events <path>", "alias of --file (an explicit events.jsonl path)")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (id, opts) => {
    const ref = await resolveOne(id, opts);
    const session = await parseSession(ref);
    if (opts.format === "json") {
      console.log(JSON.stringify(session, null, 2));
    } else {
      process.stdout.write(sessionToText(session));
    }
  });

program
  .command("html")
  .argument("[session-id]", "session id (optional when --file points at a single file)")
  .description("Generate a single-file HTML report")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-o, --out <path>", "output file", "session.html")
  .option("-s, --summary <path>", "inject an HTML fragment at the top of the report")
  .option("--file <path>", "read an explicit session file/directory instead of the live agent homes")
  .option("--events <path>", "alias of --file (an explicit events.jsonl path)")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (id, opts) => {
    const ref = await resolveOne(id, opts);
    const session = await parseSession(ref);
    const out = resolve(String(opts.out));
    await mkdir(dirname(out), { recursive: true });
    const summary = await readOptionalFile(opts.summary);
    await writeFile(out, await renderSessionHtml(session, { summary }), "utf8");
    console.log(out);
  });

program
  .command("md")
  .alias("markdown")
  .argument("[session-id]", "session id (optional when --file points at a single file)")
  .description("Export the session as a Markdown file (replicates Copilot CLI /share file)")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-o, --out <path>", "output file (default: stdout)")
  .option("-s, --summary <path>", "inject a Markdown fragment after the header note")
  .option("--no-reasoning", "drop reasoning entries (default: include)")
  .option("--file <path>", "read an explicit session file/directory instead of the live agent homes")
  .option("--events <path>", "alias of --file (an explicit events.jsonl path)")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (id, opts) => {
    const ref = await resolveOne(id, opts);
    const session = await parseSession(ref);
    const summary = await readOptionalFile(opts.summary);
    const markdown = renderSessionMarkdown(session, {
      includeReasoning: opts.reasoning !== false,
      summary,
    });
    if (opts.out) {
      const out = resolve(String(opts.out));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, markdown, "utf8");
      console.log(out);
    } else {
      process.stdout.write(markdown);
    }
  });

program
  .command("backup")
  .description("Run the existing restic backup wrapper")
  .option("--dry-run", "pass --dry-run to backup.sh")
  .action(async (opts) => {
    const script = resolve(resolveRepoRoot(), "backup.sh");
    const args = opts.dryRun ? ["--dry-run"] : [];
    await run(script, args);
  });

function parseAgents(value: string): AgentKind[] {
  if (value === "all") return AGENTS;
  if (value === "copilot" || value === "claude" || value === "codex") return [value];
  throw new Error(`unknown agent: ${value}`);
}

function filePathFromOptions(opts: Record<string, unknown>): string | undefined {
  if (typeof opts.file === "string" && opts.file) return opts.file;
  if (typeof opts.events === "string" && opts.events) return opts.events;
  return undefined;
}

function agentOverrideFromOptions(opts: Record<string, unknown>): AgentKind | undefined {
  return typeof opts.agent === "string" && opts.agent !== "all" ? parseAgents(opts.agent)[0] : undefined;
}

/** Resolve the working set of sessions from --file/--events or the live agent homes. */
async function resolveRefs(opts: Record<string, unknown>): Promise<SessionRef[]> {
  const file = filePathFromOptions(opts);
  if (file) return discoverPath(file, agentOverrideFromOptions(opts));
  return discoverSessions(parseAgents(String(opts.agent ?? "all")), rootsFromOptions(opts));
}

/** Resolve exactly one session for show/html/md. */
async function resolveOne(id: string | undefined, opts: Record<string, unknown>): Promise<SessionRef> {
  const file = filePathFromOptions(opts);
  if (file) {
    const refs = await discoverPath(file, agentOverrideFromOptions(opts));
    if (refs.length === 0) throw new Error(`no sessions found in --file path: ${file}`);
    if (!id) {
      if (refs.length === 1) return refs[0];
      throw new Error(`--file matched ${refs.length} sessions; pass a <session-id> to pick one ('recall list --file ${file}')`);
    }
    const ref = findSessionAmong(refs, id);
    if (!ref) throw new Error(`session not found in --file path: ${id}`);
    return ref;
  }
  if (!id) throw new Error("session id required (or pass --file <path>)");
  const ref = await findSession(id, parseAgents(String(opts.agent ?? "all")), rootsFromOptions(opts));
  if (!ref) throw new Error(`session not found: ${id}`);
  return ref;
}

function rootsFromOptions(opts: Record<string, unknown>): AgentRoots {
  return {
    copilot: typeof opts.copilotRoot === "string" ? opts.copilotRoot : undefined,
    claude: typeof opts.claudeRoot === "string" ? opts.claudeRoot : undefined,
    codex: typeof opts.codexRoot === "string" ? opts.codexRoot : undefined,
  };
}

async function readOptionalFile(path: unknown): Promise<string | undefined> {
  if (typeof path !== "string" || !path) return undefined;
  return readFile(resolve(path), "utf8");
}

function resolveRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, "backup.sh"))) return dir;
    dir = resolve(dir, "..");
  }
  return process.cwd();
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
    child.on("error", reject);
  });
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
