import { Command } from "commander";
import { buildBackupRunCommand, runBackup } from "./run.js";
import { buildBackupCacheCommand } from "./cache.js";

export function buildBackupCommand(): Command {
  const cmd = new Command("backup")
    .description("Back up and restore agent history via restic");
  cmd.addCommand(buildBackupRunCommand());
  cmd.addCommand(buildBackupCacheCommand());
  // Back-compat: bare `recall backup` still runs a full backup (= `backup run`).
  // `--dry-run` lives on the subcommands (not here) to avoid a parent/child
  // option clash that would swallow the flag before the subcommand sees it.
  cmd.action(async () => {
    await runBackup(false);
  });
  return cmd;
}
