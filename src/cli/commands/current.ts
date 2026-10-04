import { Command } from "commander";
import { withRoots } from "../options/common.js";
import { resolveOne } from "../options/resolve.js";

/** An injected identity is authoritative; newest mtime is not proof of currentness. */
export function buildCurrentCommand(): Command {
  const cmd = withRoots(new Command("current")
    .description("Print the DSH session identity injected as DSH_SESSION_ID (never guess newest)")
    .option("--json", "resolve and print current session metadata"));
  cmd.action(async opts => {
    const id = process.env.DSH_SESSION_ID?.trim();
    if (!id) throw new Error("DSH_SESSION_ID is not set; run inside DSH, or use list --cwd <path> --limit 1 to find the latest (not necessarily current) session");
    if (opts.json) console.log(JSON.stringify(await resolveOne(id, { ...opts, agent: "dsh" }), null, 2));
    else console.log(id);
  });
  return cmd;
}
