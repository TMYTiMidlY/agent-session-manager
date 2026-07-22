import { resolve } from "node:path";
import { Command } from "commander";
import { resolveRepoRoot, run } from "../util/proc.js";

export function buildBackupCommand(): Command {
  const cmd = new Command("backup")
    .description("Run the existing restic backup wrapper")
    .option("--dry-run", "pass --dry-run to backup.sh");
  cmd.action(async (opts) => {
    const script = resolve(resolveRepoRoot(), "backup.sh");
    const args = opts.dryRun ? ["--dry-run"] : [];
    await run(script, args);
  });
  return cmd;
}
