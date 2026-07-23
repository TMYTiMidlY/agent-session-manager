import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseSession } from "../../core/index.js";
import { renderSessionHtml } from "../../html/index.js";
import { withAgent, withRoots, withSource } from "../options/common.js";
import { resolveOne } from "../options/resolve.js";
import { readOptionalFile } from "../util/io.js";
import { parseSummaryFormat, sourceLabelForSession, summaryMismatchWarning } from "../render-options.js";

export function buildHtmlCommand(): Command {
  const cmd = new Command("html")
    .argument("[session-id]", "session id (optional when --file points at a single file)")
    .description("Generate a single-file HTML report");
  withAgent(cmd)
    .option("-o, --out <path>", "output file", "session.html")
    .option("-s, --summary <path>", "inject a raw HTML fragment at the top of the report")
    .option("--summary-format <html|markdown>", "declare the summary fragment format (no conversion)", parseSummaryFormat, "html");
  withSource(cmd, "read an explicit session file/directory instead of the live agent homes");
  withRoots(cmd);
  cmd.action(async (id, opts) => {
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
  return cmd;
}
