import { Command } from "commander";
import { summarizeSession, type SessionSummary } from "@agent-session-manager/core";
import { withReadSource } from "../options/common.js";
import { resolveRefs } from "../options/resolve.js";

export function buildListCommand(): Command {
  const cmd = withReadSource(
    new Command("list").description("List discovered sessions"),
    "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
  );
  cmd.option("--by <mode>", "group output by project|agent (default: flat list)");
  cmd.action(async (opts) => {
    const refs = await resolveRefs(opts);
    const by = opts.by === "project" || opts.by === "agent" ? opts.by : undefined;
    if (!by) {
      for (const session of refs) {
        console.log(`${session.agent}\t${session.id}\t${session.path}`);
      }
      return;
    }

    const summaries = await Promise.all(refs.map(summarizeSession));
    const keyOf = (summary: SessionSummary): string =>
      by === "project" ? summary.project : summary.ref.agent;

    const groups = new Map<string, SessionSummary[]>();
    for (const summary of summaries) {
      const key = keyOf(summary);
      const bucket = groups.get(key);
      if (bucket) bucket.push(summary);
      else groups.set(key, [summary]);
    }

    for (const key of [...groups.keys()].sort()) {
      const items = groups.get(key)!
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      console.log(`# ${key} (${items.length})`);
      for (const summary of items) {
        console.log(`${keyOf(summary)}\t${summary.ref.agent}\t${summary.ref.id}\t${summary.updatedAt ?? ""}\t${summary.entryCount}`);
      }
    }
  });
  return cmd;
}
