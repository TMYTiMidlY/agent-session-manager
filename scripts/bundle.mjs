/**
 * Bundle the `asmgr` CLI into a single, self-contained ES module at
 * `dist/asmgr.mjs`.
 *
 * `asmgr` ships as one npm package whose only artifact is this bundle. Bundling
 * from source (rather than a tsc `dist/`) keeps two install paths trivial:
 *   - `npm i -g github:TMYTiMidlY/agent-session-manager` clones the repo and
 *     runs this script from the `prepare` lifecycle hook; the result needs only
 *     Node — no build step, no `node_modules` alongside it.
 *   - `bun build --compile` turns this same bundle into a native binary
 *     (see build-binaries.mjs).
 *
 * esbuild inlines every third-party dependency and the internal `src/` modules,
 * so the output is fully self-contained.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Single-source the release version from the root package.json (the file
// semantic-release bumps and commits back) and inline it into the bundle so
// `asmgr --version` matches the release without a runtime package.json.
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

// The HTML renderer imports `./assets.generated.js`; make sure it exists before
// esbuild tries to resolve it (idempotent, fast).
execFileSync(process.execPath, [resolve(root, "scripts/gen-assets.mjs")], { stdio: "inherit" });

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

const outfile = resolve(root, "dist/asmgr.mjs");

await build({
  entryPoints: [resolve(root, "src/cli/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [nodeNextTsPlugin],
  jsx: "automatic",
  legalComments: "none",
  define: {
    __ASMGR_VERSION__: JSON.stringify(version),
  },
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
