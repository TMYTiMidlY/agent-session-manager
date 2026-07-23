import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Derive a stable project label from a session's recorded cwd.
 *
 * Heuristic (issue #7): the nearest ancestor directory that contains `.git/`.
 * This only probes the filesystem when the cwd actually exists on this machine;
 * for sessions copied off another host (where the path is absent) it degrades
 * gracefully to grouping by the recorded cwd verbatim. Sessions with no cwd go
 * into the "(unscoped)" bucket.
 */
export function deriveProject(cwd: string | undefined): string {
  if (!cwd) return "(unscoped)";
  if (existsSync(cwd)) {
    let dir = cwd;
    for (let i = 0; i < 40; i += 1) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return cwd;
}
