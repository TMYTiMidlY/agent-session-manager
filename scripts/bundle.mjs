/**
 * Bundle the `chronicle` CLI and its workspace dependencies into a single,
 * self-contained ES module at `dist/chronicle.mjs`.
 *
 * Why bundle from source (not from the per-package `dist/` output):
 *   `npm i -g github:TMYTiMidlY/agent-session-manager` clones the repo and runs
 *   this script from the `prepare` lifecycle hook using plain npm. npm does not
 *   understand pnpm workspaces or the `workspace:*` protocol, so it never
 *   symlinks `@agent-session-manager/*` into node_modules and never runs `tsc`.
 *   esbuild therefore resolves the internal packages directly from their
 *   TypeScript sources (via the alias below) and inlines every third-party
 *   dependency, producing a file that only needs Node — no pnpm, no build, no
 *   `node_modules` alongside it.
 *
 * The same bundle is the entry point that `bun build --compile` turns into a
 * native binary (see build-binaries.mjs).
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => resolve(root, "packages", p);

// The HTML renderer imports `./assets.generated.js`; make sure it exists before
// esbuild tries to resolve it (idempotent, fast).
execFileSync(process.execPath, [src("html/scripts/gen-assets.mjs")], { stdio: "inherit" });

/** Map the internal `workspace:*` packages to their TypeScript entry points. */
const workspaceAlias = {
  "@agent-session-manager/core": src("core/src/index.ts"),
  "@agent-session-manager/html": src("html/src/index.tsx"),
  "@agent-session-manager/markdown": src("markdown/src/index.ts"),
};

/**
 * The sources use NodeNext import specifiers (`./foo.js`) that actually point at
 * `./foo.ts`/`.tsx`. esbuild does not rewrite the extension on its own, so map
 * relative `*.js` imports to their TypeScript source when no real `.js` exists.
 */
const nodeNextTsPlugin = {
  name: "nodenext-ts",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point" || !args.path.startsWith(".")) return undefined;
      const base = resolve(args.resolveDir, args.path);
      if (existsSync(base)) return undefined;
      for (const candidate of [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]) {
        if (existsSync(candidate)) return { path: candidate };
      }
      return undefined;
    });
  },
};

const outfile = resolve(root, "dist/chronicle.mjs");

await build({
  entryPoints: [src("cli/src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  alias: workspaceAlias,
  plugins: [nodeNextTsPlugin],
  jsx: "automatic",
  legalComments: "none",
  // Bundled CommonJS deps (e.g. commander) `require()` Node builtins. In an ESM
  // output esbuild's require shim throws unless a real `require` exists, so
  // provide one. esbuild keeps the entry shebang (`#!/usr/bin/env node`) on
  // line 1 and emits this banner immediately after it.
  banner: {
    js: [
      "import { createRequire as __asmCreateRequire } from 'node:module';",
      "const require = __asmCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

// Preserve the CLI shebang from the entry (`#!/usr/bin/env node`) and make the
// bundle directly executable so the `bin` symlink works.
chmodSync(outfile, 0o755);
console.log(`[bundle] wrote ${outfile}`);
