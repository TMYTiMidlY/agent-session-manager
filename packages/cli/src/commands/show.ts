import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseSession, sessionToText } from "@agent-session-manager/core";
import { withAgent, withRoots, withSource } from "../options/common.js";
import { resolveOne } from "../options/resolve.js";

export function buildShowCommand(): Command {
  const cmd = new Command("show")
    .argument("[session-id]", "session id (optional when --file points at a single file)")
    .description("Print a session as text or JSON");
  withAgent(cmd)
    .option("-f, --format <format>", "text|json", "text")
    .option("-o, --out <path>", "output file (default: stdout)");
  withSource(cmd, "read an explicit session file/directory instead of the live agent homes");
  withRoots(cmd);
  cmd.action(async (id, opts) => {
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
  return cmd;
}
