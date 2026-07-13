#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { AGENTS, discoverSessions, findSession, parseSession, searchSessions, sessionToText, type AgentKind, type AgentRoots } from "@agent-session-exporter/core";
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
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (opts) => {
    const sessions = await discoverSessions(parseAgents(opts.agent), rootsFromOptions(opts));
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
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (query, opts) => {
    const hits = await searchSessions(query, parseAgents(opts.agent), rootsFromOptions(opts), Number(opts.limit));
    for (const hit of hits) {
      console.log(`${hit.session.agent}\t${hit.session.id}\t#${hit.entry.index + 1}\t${hit.entry.role}/${hit.entry.kind}\t${hit.excerpt}`);
    }
  });

program
  .command("show")
  .argument("<session-id>")
  .description("Print a session as text or JSON")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-f, --format <format>", "text|json", "text")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (id, opts) => {
    const ref = await mustFindSession(id, parseAgents(opts.agent), rootsFromOptions(opts));
    const session = await parseSession(ref);
    if (opts.format === "json") {
      console.log(JSON.stringify(session, null, 2));
    } else {
      process.stdout.write(sessionToText(session));
    }
  });

program
  .command("html")
  .argument("<session-id>")
  .description("Generate a single-file HTML report")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-o, --out <path>", "output file", "session.html")
  .option("-s, --summary <path>", "inject an HTML fragment at the top of the report")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (id, opts) => {
    const ref = await mustFindSession(id, parseAgents(opts.agent), rootsFromOptions(opts));
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
  .argument("<session-id>")
  .description("Export the session as a Markdown file (replicates Copilot CLI /share file)")
  .option("-a, --agent <agent>", "copilot|claude|codex|all", "all")
  .option("-o, --out <path>", "output file (default: stdout)")
  .option("-s, --summary <path>", "inject a Markdown fragment after the header note")
  .option("--no-reasoning", "drop reasoning entries (default: include)")
  .option("--copilot-root <path>", "override Copilot session-state root")
  .option("--claude-root <path>", "override Claude projects root")
  .option("--codex-root <path>", "override Codex sessions root")
  .action(async (id, opts) => {
    const ref = await mustFindSession(id, parseAgents(opts.agent), rootsFromOptions(opts));
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

async function mustFindSession(id: string, agents: AgentKind[], roots: AgentRoots) {
  const ref = await findSession(id, agents, roots);
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
