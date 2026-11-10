import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chatGptRoot } from "../../../core/index.js";
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
 * cache is to stay separate from live agent homes and asmgr-managed imports.
 * Returns the resolved, absolute target on success.
 */
export function assertSafeCacheTarget(target: string): string {
  const resolved = resolve(expandHome(target));
  const home = homedir();
  if (resolved === home) {
    throw new Error(`refusing to restore into the home directory (${home}); choose a dedicated --target`);
  }
  const forbiddenRoots = [
    join(home, ".copilot"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".gemini"),
    resolve(chatGptRoot()),
  ];
  for (const forbidden of forbiddenRoots) {
    if (resolved === forbidden || resolved.startsWith(forbidden + sep)) {
      throw new Error(`refusing to restore into a live or managed session directory (${forbidden}); choose a dedicated --target`);
    }
  }
  return resolved;
}
