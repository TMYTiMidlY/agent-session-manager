import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { BIN_NAME } from "../../brand.js";

/** Expand a leading ~ to the home directory (mirrors core's fs.expandHome). */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Default restore cache directory, namespaced under the CLI brand. */
export function defaultCacheDir(): string {
  return join(homedir(), ".cache", BIN_NAME, "restic-cache");
}

/**
 * Refuse to restore into (or onto) a live agent home. The whole point of the
 * cache is to stay separate from ~/.copilot, ~/.claude and ~/.codex. Returns
 * the resolved, absolute target on success.
 */
export function assertSafeCacheTarget(target: string): string {
  const resolved = resolve(expandHome(target));
  const home = homedir();
  if (resolved === home) {
    throw new Error(`refusing to restore into the home directory (${home}); choose a dedicated --target`);
  }
  for (const name of [".copilot", ".claude", ".codex"]) {
    const forbidden = join(home, name);
    if (resolved === forbidden || resolved.startsWith(forbidden + sep)) {
      throw new Error(`refusing to restore into a live agent home (${forbidden}); choose a --target outside it`);
    }
  }
  return resolved;
}
