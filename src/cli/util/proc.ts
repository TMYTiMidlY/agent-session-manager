import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this module to the repo root (the directory holding backup.sh).
 *
 * The restic wrapper scripts (`backup.sh`, `tools/backup-cache.sh`) live only in
 * a source checkout — they are intentionally NOT shipped in the npm bundle or
 * the compiled binary (which contain just the CLI). Throw a clear error instead
 * of falling back to `process.cwd()`: the fallback could silently execute an
 * unrelated `./backup.sh` from whatever directory the user happens to be in.
 */
export function resolveRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, "backup.sh"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error(
    "`asmgr backup` requires a source checkout: backup.sh was not found. "
    + "The npm package and native binary do not bundle the restic wrapper — "
    + "clone the repository and run backup from there.",
  );
}

/** Spawn a child process inheriting stdio; resolve on exit 0, reject otherwise. */
export function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
    child.on("error", reject);
  });
}
