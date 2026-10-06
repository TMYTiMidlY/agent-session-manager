import { Command, Option } from "commander";
import { parseSession, sortSessionRefs, summarizeSession, type SessionSummary } from "../../core/index.js";
import { mapConcurrent } from "../../core/concurrency.js";
import { deriveStats, type DerivedStats } from "../../core/session-stats.js";
import { probeIdentity } from "../../core/relations.js";
import type { ParsedSession, SessionRef } from "../../core/types.js";
import { nonNegativeInteger, withReadSource } from "../options/common.js";
import { resolveRefs } from "../options/resolve.js";

/** Sort keys answered from the unified stats — never a re-parse of raw logs. */
const STAT_SORTS = ["peak_ctx", "ctx_util", "input", "cached", "output", "cache", "compact"] as const;
type StatSort = (typeof STAT_SORTS)[number];

const SORT_HELP = {
  peak_ctx: "max reported-input context sample (e.g. Codex last_token_usage.input_tokens), paired with its own window for ctx_util",
  ctx_util: "that max sample's input ÷ ITS OWN context window (never an independently-picked maximum)",
  input: "exact billed input (per-source exact denominator; a missing bucket stays unknown, never 0)",
  cached: "cache-read tokens",
  output: "output tokens",
  cache: "cache% = cache reads ÷ exact aggregate prompt",
  compact: "compaction events",
} as const satisfies Record<StatSort, string>;

const ROLE_CHOICES = ["main", "subagent", "guardian", "unknown"] as const;

function sortValue(stats: DerivedStats | undefined, sort: StatSort): number | undefined {
  if (!stats) return undefined;
  switch (sort) {
    case "peak_ctx": return stats.peakContextTokens;
    case "ctx_util": return stats.peakContextUtilization;
    case "input": return stats.billedInputTokens;
    case "cached": return stats.totals.cacheReadTokens;
    case "output": return stats.totals.outputTokens;
    case "cache": return stats.cacheReadRatio;
    case "compact": return stats.compactions;
  }
}

interface SessionRow {
  ref: SessionRef;
  role: string;
  stats?: DerivedStats;
  diagnostics?: ParsedSession["diagnostics"];
}

function formatUtilization(value: number | undefined): string {
  return value === undefined ? "" : `${(value * 100).toFixed(1)}%`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "" : `${(value * 100).toFixed(1)}%`;
}

/** Stat columns, in order: peak_ctx, ctx_util%, in, cached, out, cache%, compact. */
function statColumns(stats: DerivedStats | undefined): string[] {
  return [
    stats?.peakContextTokens !== undefined ? String(stats.peakContextTokens) : "",
    formatUtilization(stats?.peakContextUtilization),
    stats?.billedInputTokens !== undefined ? String(stats.billedInputTokens) : "",
    stats?.totals.cacheReadTokens !== undefined ? String(stats.totals.cacheReadTokens) : "",
    stats?.totals.outputTokens !== undefined ? String(stats.totals.outputTokens) : "",
    formatPercent(stats?.cacheReadRatio),
    stats?.compactions !== undefined ? String(stats.compactions) : "",
  ];
}

const METERING_NOTE = [
  "# metering: peak_ctx = max reported-input context sample (Codex last_token_usage.input_tokens; DSH/route watermarks when sampled);",
  "# ctx_util% = that max sample's input ÷ its OWN context window, paired exactly — a windowless max sample leaves it blank;",
  "# in = exact billed input (Codex: Σ selected raw input_tokens incl. cached; disjoint sources need every bucket — a missing bucket stays blank, never 0);",
  "# cached = cache reads; out = output; cache% = cache reads ÷ exact aggregate prompt (blank unless the denominator is exact);",
  "# compact = compaction events (0 is an exact zero from a complete parse). Missing values are unknown — left blank, never 0.",
  "# JSON keeps the camelCase stat field names (peakContextTokens, peakContextUtilization, billedInputTokens, cacheReadRatio, …);",
  "# no snake_case aliases are emitted.",
].join("\n");

function verboseNotes(row: SessionRow): string[] {
  const notes: string[] = [];
  const diagnostics = row.diagnostics;
  if (diagnostics) {
    if (diagnostics.unknown > 0) {
      const types = diagnostics.unknownTypes.length ? ` (${diagnostics.unknownTypes.join(", ")})` : "";
      notes.push(`unknown rows: ${diagnostics.unknown}${types}${diagnostics.unknownTypesTruncated ? " …" : ""}`);
    }
    for (const issue of diagnostics.issues ?? []) {
      notes.push(`${issue.code}: ${issue.message}${issue.count > 1 ? ` [${issue.count}x]` : ""}`);
    }
  }
  if (row.stats?.incomplete) notes.push("usage ledger incomplete: some sampled records carried no recognizable token metric");
  return notes;
}

/** Session role: discovery identity first, then the parsed document, then a header probe. */
async function roleOf(parsed: ParsedSession | undefined, ref: SessionRef): Promise<string> {
  if (parsed?.document?.identity?.role && parsed.document.identity.role !== "unknown") return parsed.document.identity.role;
  return (await probeIdentity(ref)).role;
}

export function buildListCommand(): Command {
  const cmd = withReadSource(
    new Command("list").description("List discovered sessions, newest file activity first"),
    "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
  );
  cmd.addOption(new Option("--by <mode>", "group output (parses full timelines for entry counts)").choices(["project", "agent"]))
    .addOption(new Option("--sort <field>", `session ordering (stat keys parse every session: ${STAT_SORTS.map((key) => `${key} = ${SORT_HELP[key]}`).join("; ")})`)
      .choices(["mtime", "id", ...STAT_SORTS]).default("mtime"))
    .option("--cwd <path>", "filter exact recorded working directory")
    .option("--stats", "parse sessions and append unified usage stats (off by default: listing stays metadata-only)")
    .addOption(new Option("--role <role>", "filter by session identity role (main|subagent|guardian|unknown) — session identity, NOT the timeline message role of search/show --role")
      .choices([...ROLE_CHOICES]))
    .addOption(new Option("-f, --format <format>", "output format (json pipeable)").choices(["tsv", "json"]).default("tsv"))
    .option("--json", "print as JSON (same as -f json)")
    .option("--verbose", "report per-session bad rows, unknown record types, and ledger gaps on stderr")
    .option("-l, --limit <n>", "maximum sessions to list", nonNegativeInteger);
  cmd.action(async (opts) => {
    const format = opts.format !== "tsv" ? opts.format : opts.json ? "json" : "tsv";
    const statSort = (STAT_SORTS as readonly string[]).includes(opts.sort) ? (opts.sort as StatSort) : undefined;
    const wantsStats = opts.stats || statSort !== undefined;

    if (opts.by && wantsStats) {
      // Deliberately rejected rather than silently ignored: grouped stats
      // would need per-group odometers the TSV row shape cannot express.
      throw new Error("--by grouping cannot be combined with --stats or stat --sort keys; drop one of them");
    }

    if (opts.limit === 0) {
      if (format === "json") console.log("[]");
      return; // Validate options, but never read a source for zero results.
    }
    let refs = await resolveRefs(opts);
    if (opts.role) {
      const probed = await mapConcurrent(refs, 8, async (ref) => ({ ref, identity: await probeIdentity(ref) }));
      refs = probed.filter(({ identity }) => identity.role === opts.role).map(({ ref }) => ref);
    }

    if (!wantsStats) {
      // Metadata-only fast path: no transcript parsing unless grouping asked for it.
      const sorted = statSort === undefined && (opts.sort === "id" || opts.sort === "mtime")
        ? sortSessionRefs(refs, opts.sort)
        : refs;
      const limited = sorted.slice(0, opts.limit);
      if (!opts.by) {
        if (format === "json") console.log(JSON.stringify(limited, null, 2));
        else for (const session of limited) {
          console.log(`${session.agent}\t${session.id}\t${session.path}\t${session.mtime ?? ""}\t${session.size ?? ""}\t${session.cwd ?? ""}`);
        }
        return;
      }
      const summaries = await mapConcurrent(limited, 4, summarizeSession);
      if (format === "json") {
        console.log(JSON.stringify(summaries, null, 2));
        return;
      }
      const keyOf = (summary: SessionSummary): string => opts.by === "project" ? summary.project : summary.ref.agent;
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
          console.log(`${keyOf(summary)}\t${summary.ref.agent}\t${summary.ref.id}\t${summary.ref.updatedAt ?? ""}\t${summary.entryCount}`);
        }
      }
      return;
    }

    // Compute stats for every filtered session BEFORE applying --limit, so
    // stat sorts rank the full population.
    const rows: SessionRow[] = await mapConcurrent(refs, 4, async (ref) => {
      const parsed = await parseSession(ref);
      const { entries, document, stats: _stats, diagnostics, ...refOnly } = parsed;
      void entries; void document; void _stats;
      return { ref: refOnly, role: await roleOf(parsed, ref), stats: deriveStats(parsed), diagnostics };
    });
    // Odometer over the unified ledger; id sorts like the metadata path.
    const ordered = statSort === undefined
      ? rows.sort((a, b) => ((opts.sort === "id")
        ? 0
        : (b.ref.mtime ?? "").localeCompare(a.ref.mtime ?? ""))
        || a.ref.agent.localeCompare(b.ref.agent) || a.ref.id.localeCompare(b.ref.id) || a.ref.path.localeCompare(b.ref.path))
      : rows.sort((a, b) => {
        // Descending; unknown values last; stable ties (sort is stable).
        const left = sortValue(a.stats, statSort);
        const right = sortValue(b.stats, statSort);
        if (left === undefined && right === undefined) return 0;
        if (left === undefined) return 1;
        if (right === undefined) return -1;
        return right - left;
      });
    const limited = ordered.slice(0, opts.limit);

    if (format === "json") {
      console.log(JSON.stringify(limited.map((row) => ({
        ...row.ref,
        role: row.role,
        ...(row.stats ? { stats: row.stats } : {}),
      })), null, 2));
    } else {
      console.error(METERING_NOTE);
      for (const row of limited) {
        const session = row.ref;
        const columns = [session.agent, session.id, session.path, session.mtime ?? "", session.size ?? "", session.cwd ?? "", ...statColumns(row.stats)];
        console.log(columns.join("\t"));
      }
    }
    if (opts.verbose) {
      for (const row of limited) {
        for (const note of verboseNotes(row)) console.error(`${row.ref.agent}\t${row.ref.id}\t${note}`);
      }
    }
  });
  return cmd;
}
