import { Command } from "commander";
import { withReadSource } from "../options/common.js";
import { resolveRefs } from "../options/resolve.js";

export function buildListCommand(): Command {
  const cmd = withReadSource(
    new Command("list").description("List discovered sessions"),
    "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
  );
  cmd.action(async (opts) => {
    const sessions = await resolveRefs(opts);
    for (const session of sessions) {
      console.log(`${session.agent}\t${session.id}\t${session.path}`);
    }
  });
  return cmd;
}
