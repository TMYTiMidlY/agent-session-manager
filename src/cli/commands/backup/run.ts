import { resolve } from "node:path";
import { Command } from "commander";
import { resolveRepoRoot, run } from "../../util/proc.js";

/** Shared backup behavior used by both `backup run` and bare `backup` (back-compat). */
export async function runBackup(dryRun: boolean): Promise<void> {
  const script = resolve(resolveRepoRoot(), "backup.sh");
  await run(script, dryRun ? ["--dry-run"] : []);
}

export function buildBackupRunCommand(): Command {
  const cmd = new Command("run")
    .description("Run the restic backup wrapper (backup.sh)")
    .option("--dry-run", "pass --dry-run to backup.sh");
  cmd.action(async (opts) => {
    await runBackup(Boolean(opts.dryRun));
  });
  return cmd;
}
