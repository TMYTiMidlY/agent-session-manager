import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release version reported by `asmgr --version`.
 *
 * `__ASMGR_VERSION__` is inlined at bundle/compile time by `scripts/bundle.mjs`
 * (esbuild `define`) from the root `package.json`, which is the file
 * semantic-release bumps and commits back. In dev (tsx / vitest) the global is
 * undefined, so fall back to reading that same `package.json` from disk — the
 * version stays single-sourced either way.
 */
declare const __ASMGR_VERSION__: string | undefined;

function devVersion(): string {
  try {
    // src/cli -> repo root is two levels up.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string =
  typeof __ASMGR_VERSION__ !== "undefined" ? __ASMGR_VERSION__ : devVersion();
