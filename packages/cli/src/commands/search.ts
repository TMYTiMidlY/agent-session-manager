import { Command } from "commander";
import { searchRefs } from "@agent-session-exporter/core";
import { withAgent, withRoots, withSource } from "../options/common.js";
import { resolveRefs } from "../options/resolve.js";

export function buildSearchCommand(): Command {
  const cmd = new Command("search")
    .argument("<query>")
    .description("Search user/assistant/tool text across sessions");
  withAgent(cmd).option("-l, --limit <n>", "maximum hits", "20");
  withSource(cmd, "search an explicit session file/directory (e.g. a restic-restored backup cache)");
  withRoots(cmd);
  cmd.action(async (query, opts) => {
    const hits = await searchRefs(await resolveRefs(opts), query, Number(opts.limit));
    for (const hit of hits) {
      console.log(`${hit.session.agent}\t${hit.session.id}\t#${hit.entry.index + 1}\t${hit.entry.role}/${hit.entry.kind}\t${hit.excerpt}`);
    }
  });
  return cmd;
}
