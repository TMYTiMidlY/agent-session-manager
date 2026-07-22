#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseSession, searchRefs, sessionToText } from "@agent-session-exporter/core";
import { renderSessionHtml } from "@agent-session-exporter/html";
import { renderSessionMarkdown } from "@agent-session-exporter/markdown";
import { parseSummaryFormat, sourceLabelForSession, summaryMismatchWarning } from "./render-options.js";
import { withAgent, withReadSource, withRoots, withSource } from "./options/common.js";
import { resolveOne, resolveRefs } from "./options/resolve.js";
import { readOptionalFile } from "./util/io.js";
import { resolveRepoRoot, run } from "./util/proc.js";

const program = new Command();

program
  .name("recall")
  .description("Search and render local coding-agent session histories")
  .version("0.1.0");

const listCommand = withReadSource(
  program.command("list").description("List discovered sessions"),
  "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
);
listCommand.action(async (opts) => {
  const sessions = await resolveRefs(opts);
  for (const session of sessions) {
    console.log(`${session.agent}\t${session.id}\t${session.path}`);
  }
});

const searchCommand = program
  .command("search")
  .argument("<query>")
  .description("Search user/assistant/tool text across sessions");
withAgent(searchCommand).option("-l, --limit <n>", "maximum hits", "20");
withSource(searchCommand, "search an explicit session file/directory (e.g. a restic-restored backup cache)");
withRoots(searchCommand);
searchCommand.action(async (query, opts) => {
  const hits = await searchRefs(await resolveRefs(opts), query, Number(opts.limit));
  for (const hit of hits) {
    console.log(`${hit.session.agent}\t${hit.session.id}\t#${hit.entry.index + 1}\t${hit.entry.role}/${hit.entry.kind}\t${hit.excerpt}`);
  }
});

const showCommand = program
  .command("show")
  .argument("[session-id]", "session id (optional when --file points at a single file)")
  .description("Print a session as text or JSON");
withAgent(showCommand)
  .option("-f, --format <format>", "text|json", "text")
  .option("-o, --out <path>", "output file (default: stdout)");
withSource(showCommand, "read an explicit session file/directory instead of the live agent homes");
withRoots(showCommand);
showCommand.action(async (id, opts) => {
  const ref = await resolveOne(id, opts);
  const session = await parseSession(ref);
  const output = opts.format === "json"
    ? `${JSON.stringify(session, null, 2)}\n`
    : sessionToText(session);
  if (opts.out) {
    const out = resolve(String(opts.out));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, output, "utf8");
    console.log(out);
  } else {
    process.stdout.write(output);
  }
});

const htmlCommand = program
  .command("html")
  .argument("[session-id]", "session id (optional when --file points at a single file)")
  .description("Generate a single-file HTML report");
withAgent(htmlCommand)
  .option("-o, --out <path>", "output file", "session.html")
  .option("-s, --summary <path>", "inject a raw HTML fragment at the top of the report")
  .option("--summary-format <html|markdown>", "declare the summary fragment format (no conversion)", parseSummaryFormat, "html");
withSource(htmlCommand, "read an explicit session file/directory instead of the live agent homes");
withRoots(htmlCommand);
htmlCommand.action(async (id, opts) => {
  const ref = await resolveOne(id, opts);
  const session = await parseSession(ref);
  const out = resolve(String(opts.out));
  await mkdir(dirname(out), { recursive: true });
  const warning = summaryMismatchWarning(opts.summary, opts.summaryFormat, "html");
  if (warning) console.warn(warning);
  const summary = await readOptionalFile(opts.summary);
  await writeFile(out, await renderSessionHtml(session, {
    summary,
    sourceLabel: sourceLabelForSession(session),
  }), "utf8");
  console.log(out);
});

const mdCommand = program
  .command("md")
  .alias("markdown")
  .argument("[session-id]", "session id (optional when --file points at a single file)")
  .description("Export the session as a Markdown file (replicates Copilot CLI /share file)");
withAgent(mdCommand)
  .option("-o, --out <path>", "output file (default: stdout)")
  .option("-s, --summary <path>", "inject a Markdown fragment after the header note")
  .option("--summary-format <html|markdown>", "declare the summary fragment format (no conversion)", parseSummaryFormat, "markdown")
  .option("--no-reasoning", "drop reasoning entries (default: include)");
withSource(mdCommand, "read an explicit session file/directory instead of the live agent homes");
withRoots(mdCommand);
mdCommand.action(async (id, opts) => {
  const ref = await resolveOne(id, opts);
  const session = await parseSession(ref);
  const warning = summaryMismatchWarning(opts.summary, opts.summaryFormat, "markdown");
  if (warning) console.warn(warning);
  const summary = await readOptionalFile(opts.summary);
  const markdown = renderSessionMarkdown(session, {
    includeReasoning: opts.reasoning !== false,
    summary,
    sourceLabel: sourceLabelForSession(session),
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

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
