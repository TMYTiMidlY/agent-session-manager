import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { resolveRepoRoot, run } from "../../util/proc.js";
import { assertSafeCacheTarget, defaultCacheDir } from "./cache-target.js";

export function buildBackupCacheCommand(): Command {
  const cmd = new Command("cache")
    .argument("[snapshot]", "restic snapshot id or 'latest'", "latest")
    .description("Restore agent history from a restic snapshot into a local cache dir");
  cmd
    .option("--target <dir>", "restore destination (must be outside the live agent homes)", defaultCacheDir())
    .option("--host <host>", "restrict to a restic snapshot host")
    .option("--dry-run", "print the restic restore command without running it");
  cmd.action(async (snapshot: string, opts) => {
    const target = assertSafeCacheTarget(String(opts.target));
    const script = resolve(resolveRepoRoot(), "tools/backup-cache.sh");
    const extra: string[] = [];
    if (opts.host) extra.push("--host", String(opts.host));
    if (opts.dryRun) {
      console.log(`[dry-run] ${script} ${snapshot} ${target}${extra.length ? ` ${extra.join(" ")}` : ""}`);
      return;
    }
    if (!existsSync(script)) throw new Error(`restore helper not found: ${script}`);
    await run(script, [String(snapshot), target, ...extra]);
  });
  return cmd;
}
