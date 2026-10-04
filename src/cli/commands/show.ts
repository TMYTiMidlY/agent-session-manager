import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseSession, sessionToDialogue, sessionToText } from "../../core/index.js";
import { withAgent, withRole, withRoots, withSource } from "../options/common.js";
import { resolveOne } from "../options/resolve.js";

export function buildShowCommand(): Command {
  const cmd = new Command("show")
    .argument("[session-id-or-url]", "会话 ID 或 ChatGPT 公开分享链接（--file 只有一个会话时可省略）")
    .description("Print a session as text, dialogue, or JSON");
  withRole(withAgent(cmd))
    .option("-f, --format <format>", "text|dialogue|json", "text")
    .option("-o, --out <path>", "output file (default: stdout)");
  withSource(cmd, "read an explicit session file/directory instead of the live agent homes");
  withRoots(cmd);
  cmd.action(async (id, opts) => {
    const ref = await resolveOne(id, opts);
    const parsed = await parseSession(ref);
    const session = opts.role ? { ...parsed, entries: parsed.entries.filter(entry => entry.role === opts.role) } : parsed;
    const output = opts.format === "json"
      ? `${JSON.stringify(session, null, 2)}\n`
      : opts.format === "dialogue"
        ? sessionToDialogue(session)
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
  return cmd;
}
