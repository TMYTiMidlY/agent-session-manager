import { Command } from "commander";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "../../core/fs.js";
import { SearchWorkerPool } from "../../core/search-worker.js";
import { deriveProject, findSessionAmong, searchRefs } from "../../core/index.js";
import { mapConcurrent } from "../../core/concurrency.js";
import { probeIdentity } from "../../core/relations.js";
import { nonNegativeInteger, searchConcurrency, withAgent, withRole, withRoots, withSource } from "../options/common.js";
import { resolveRefs } from "../options/resolve.js";
import { SearchDiagnosticReporter } from "../util/search-diagnostics.js";

export function buildSearchCommand(): Command {
  const cmd = new Command("search")
    .argument("<query>")
    .description("Search timeline text, newest sessions first (bounded read-ahead)");
  withRole(withAgent(cmd))
    .option("--session <id>", "restrict search to one session id or unambiguous prefix")
    .option("--cwd <path>", "filter exact recorded working directory")
    .option("-l, --limit <n>", "maximum hits; stop scheduling at this cap (0: no search)", nonNegativeInteger, 20)
    .option("--no-early-exit", "scan all sessions even after reaching the output cap")
    .option("--no-cache", "do not read or write derived transcript caches")
    .option("--cache-dir <path>", "cache root (default: ASMGR_CACHE_HOME or XDG_CACHE_HOME/asmgr)")
    .option("-j, --concurrency <n>", "maximum simultaneous session reads (1-32)", searchConcurrency, 2)
    .option("-q, --quiet", "suppress search diagnostics")
    .option("--verbose", "include per-session diagnostics and attachment notices")
    // Guardian sessions are background supervision transcripts; their hits are
    // noise for default searches. --include-guardian keeps them (the --role
    // option stays the timeline message-role filter — a different context).
    .option("--include-guardian", "also search guardian sessions (excluded by default)");
  withSource(cmd, "search an explicit session file/directory (e.g. a restic-restored backup cache)");
  withRoots(cmd);
  cmd.action(async (query, opts) => {
    if (!String(query).trim()) throw new Error("search query must not be empty");
    if (opts.limit === 0) return;
    const refs = await resolveRefs(opts);
    let scopedRefs = refs;
    if (opts.session) {
      // Resolve identity before hiding noise: an ambiguous prefix must never select a different session.
      const session = findSessionAmong(refs, opts.session);
      if (!session) throw new Error(`session not found: ${opts.session}`);
      scopedRefs = [session]; // Explicit selection includes a guardian intentionally.
    } else if (!opts.includeGuardian && !(refs.length === 1 && (opts.file || opts.events))) {
      const probed = await mapConcurrent(refs, 8, async (ref) => ({ ref, identity: await probeIdentity(ref) }));
      scopedRefs = probed.filter(({ identity }) => identity.role !== "guardian").map(({ ref }) => ref);
    }
    const diagnostics = new SearchDiagnosticReporter(opts.quiet, opts.verbose);
    const cacheDir = opts.cache ? resolve(expandHome(opts.cacheDir || process.env.ASMGR_CACHE_HOME
      || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "asmgr"))) : undefined;
    const readOptions = { role: opts.role, cacheDir };
    const pool = opts.concurrency > 1 && scopedRefs.length > 1
      ? new SearchWorkerPool(Math.min(opts.concurrency, scopedRefs.length), query, opts.limit, readOptions) : undefined;
    try {
      const hits = await searchRefs(scopedRefs, query, opts.limit, {
        ...readOptions, concurrency: opts.concurrency, earlyExit: opts.earlyExit,
        scanSession: pool?.scan, onDiagnostic: diagnostics.observe,
      });
      if (opts.verbose && !opts.quiet) console.error(`search backend: ${pool?.backend ?? "in-process"}; cache: ${cacheDir ? cacheDir : "disabled"}`);
      diagnostics.finish();
      for (const hit of hits) {
        console.log(`${deriveProject(hit.session.cwd)}\t${hit.session.agent}\t${hit.session.id}\t#${hit.entry.index + 1}\t${hit.entry.role}/${hit.entry.kind}\t${hit.excerpt}`);
      }
    } finally {
      await pool?.close();
    }
  });
  return cmd;
}
