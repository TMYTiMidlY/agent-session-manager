import { Command, Option } from "commander";
import { sortSessionRefs, summarizeSession, type SessionSummary } from "../../core/index.js";
import { mapConcurrent } from "../../core/concurrency.js";
import { nonNegativeInteger, withReadSource } from "../options/common.js";
import { resolveRefs } from "../options/resolve.js";

export function buildListCommand(): Command {
  const cmd = withReadSource(
    new Command("list").description("List discovered sessions, newest file activity first"),
    "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
  );
  cmd.addOption(new Option("--by <mode>", "group output (parses full timelines for entry counts)").choices(["project", "agent"]))
    .addOption(new Option("--sort <field>", "session ordering").choices(["mtime", "id"]).default("mtime"))
    .option("--cwd <path>", "filter exact recorded working directory")
    .option("--json", "print metadata as a JSON array")
    .option("-l, --limit <n>", "maximum sessions to list", nonNegativeInteger);
  cmd.action(async (opts) => {
    const refs = sortSessionRefs(await resolveRefs(opts), opts.sort).slice(0, opts.limit);
    const by = opts.by;
    if (!by) {
      if (opts.json) console.log(JSON.stringify(refs, null, 2));
      else for (const session of refs) {
        // Preserve the original first three columns for existing TSV consumers.
        console.log(`${session.agent}\t${session.id}\t${session.path}\t${session.mtime ?? ""}\t${session.size ?? ""}\t${session.cwd ?? ""}`);
      }
      return;
    }

    const summaries = await mapConcurrent(refs, 4, summarizeSession);
    if (opts.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    const keyOf = (summary: SessionSummary): string => by === "project" ? summary.project : summary.ref.agent;
    const groups = new Map<string, SessionSummary[]>();
    for (const summary of summaries) {
      const key = keyOf(summary);
      const bucket = groups.get(key);
      if (bucket) bucket.push(summary);
      else groups.set(key, [summary]);
    }
    for (const key of [...groups.keys()].sort()) {
      const items = groups.get(key)!;
      console.log(`# ${key} (${items.length})`);
      for (const summary of items) {
        console.log(`${keyOf(summary)}\t${summary.ref.agent}\t${summary.ref.id}\t${summary.updatedAt ?? ""}\t${summary.entryCount}`);
      }
    }
  });
  return cmd;
}
