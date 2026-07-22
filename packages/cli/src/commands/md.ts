import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseSession } from "@agent-session-exporter/core";
import { renderSessionMarkdown } from "@agent-session-exporter/markdown";
import { withAgent, withRoots, withSource } from "../options/common.js";
import { resolveOne } from "../options/resolve.js";
import { readOptionalFile } from "../util/io.js";
import { parseSummaryFormat, sourceLabelForSession, summaryMismatchWarning } from "../render-options.js";

export function buildMdCommand(): Command {
  const cmd = new Command("md")
    .alias("markdown")
    .argument("[session-id]", "session id (optional when --file points at a single file)")
    .description("Export the session as a Markdown file (replicates Copilot CLI /share file)");
  withAgent(cmd)
    .option("-o, --out <path>", "output file (default: stdout)")
    .option("-s, --summary <path>", "inject a Markdown fragment after the header note")
    .option("--summary-format <html|markdown>", "declare the summary fragment format (no conversion)", parseSummaryFormat, "markdown")
    .option("--no-reasoning", "drop reasoning entries (default: include)");
  withSource(cmd, "read an explicit session file/directory instead of the live agent homes");
  withRoots(cmd);
  cmd.action(async (id, opts) => {
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
  return cmd;
}
