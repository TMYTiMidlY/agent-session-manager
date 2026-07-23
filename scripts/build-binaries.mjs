/**
 * Compile standalone `chronicle` binaries with `bun build --compile`.
 *
 * These are the zero-dependency artifacts attached to GitHub Releases: a single
 * executable per platform that embeds the Bun runtime, so end users need
 * neither Node nor pnpm. The input is the same self-contained ESM bundle used
 * by the `npm i -g github:` path (dist/chronicle.mjs), which is (re)built first.
 *
 * Usage:
 *   node scripts/build-binaries.mjs                # all default targets
 *   node scripts/build-binaries.mjs linux-x64      # a subset by label
 *
 * Note: the Copilot *live SQLite* source relies on `node:sqlite`, which Bun
 * does not implement yet; in the compiled binary that source degrades to empty
 * (the JSONL `events.jsonl` Copilot source and every other agent still work).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(root, "dist/chronicle.mjs");
const outDir = resolve(root, "dist");

/** Bun cross-compilation targets → output file names. */
const TARGETS = [
  { label: "linux-x64", target: "bun-linux-x64", out: "chronicle-linux-x64" },
  { label: "darwin-x64", target: "bun-darwin-x64", out: "chronicle-darwin-x64" },
  { label: "darwin-arm64", target: "bun-darwin-arm64", out: "chronicle-darwin-arm64" },
  { label: "windows-x64", target: "bun-windows-x64", out: "chronicle-windows-x64.exe" },
];

function haveBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!haveBun()) {
  console.error("[binaries] `bun` not found on PATH. Install from https://bun.sh and retry.");
  process.exit(1);
}

const requested = process.argv.slice(2);
const selected = requested.length
  ? TARGETS.filter((t) => requested.includes(t.label) || requested.includes(t.target))
  : TARGETS;

if (!selected.length) {
  console.error(`[binaries] no matching target for: ${requested.join(", ")}`);
  console.error(`[binaries] known labels: ${TARGETS.map((t) => t.label).join(", ")}`);
  process.exit(1);
}

// Refresh the shared bundle so binaries and the npm path never diverge.
execFileSync(process.execPath, [resolve(root, "scripts/bundle.mjs")], { stdio: "inherit" });
if (!existsSync(bundle)) {
  console.error(`[binaries] expected bundle missing: ${bundle}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

for (const { label, target, out } of selected) {
  const outfile = resolve(outDir, out);
  console.log(`[binaries] compiling ${label} -> dist/${out}`);
  execFileSync("bun", ["build", "--compile", `--target=${target}`, bundle, "--outfile", outfile], {
    stdio: "inherit",
  });
}

console.log(`[binaries] done (${selected.map((t) => t.out).join(", ")})`);
