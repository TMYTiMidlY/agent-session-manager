# ADR 0002: Single package, `asmgr` command, and distribution

## Status

Accepted. Supersedes the naming and package-structure parts of
[ADR 0001](0001-agent-session-manager-scope-and-stack.md).

## Context

ADR 0001 set up a pnpm workspace with four scoped packages
(`@agent-session-manager/{core,html,markdown,cli}`) and a CLI binary named
`chronicle`. Two forces pushed against that shape:

- **Distribution.** The only publishable entry point is a single CLI. Installing
  from a tarball or `github:` broke on the `workspace:*` protocol (npm does not
  resolve it), and the goal is a low-friction `npm i -g` plus a Node-free native
  binary. Four scoped packages added ceremony without a consumer: nobody imports
  `@agent-session-manager/core` on its own.
- **Product identity.** HTML and Markdown are *export capabilities* of the one
  CLI, not independently shipped products. A future local web UI is the same
  story: one tool, several output surfaces.

## Decision

- **One package.** Publish a single, unscoped, public npm package named
  **`asmgr`** (Agent Session ManaGeR). The command is also `asmgr`. Do not create
  or publish `@asmgr/*` (or any scoped) sub-packages; `core`, `html`, `markdown`,
  and `cli` are internal modules under `src/*`, wired with relative imports. This
  removes the `workspace:*` resolution problem at its root.
- **HTML / Markdown are capabilities, not products.** They ship inside `asmgr`
  and are reached via `asmgr html` / `asmgr md`, not as separate packages.
- **Future `asmgr web` is local-only.** A planned browser UI for viewing one's
  own sessions ships in the same `asmgr` package, is started with `asmgr web`,
  and binds to `127.0.0.1` by default — a personal local viewer, not a server.
- **Distribution channels.**
  - `npm i -g asmgr` once published to the registry.
  - Native single-file binaries per platform via `bun build --compile`, attached
    to GitHub Releases.
  - `npm i -g github:...` as a registry-free Node install, built by the package
    `prepare` hook (esbuild bundles `src/cli/index.ts` into a self-contained
    `dist/asmgr.mjs`).
- **Release automation with semantic-release.** Conventional Commits drive the
  version; git tags are the source of truth. `@semantic-release/git` commits the
  bumped `package.json` + `CHANGELOG.md` back to `main` (no release PR), so the
  manifest always reflects the released version (which `asmgr --version` reads).
  The release workflow is manually triggered — running it *is* the release
  approval — and publishes to npm plus a GitHub Release with the binaries.

## Consequences

- The `workspace:*` install blocker is gone; there is a single `package.json`,
  `tsconfig.json`, and test run. `pnpm` remains the dev package manager.
- `asmgr --version` is single-sourced from `package.json`: inlined into the
  bundle at build time (esbuild `define`), with a filesystem fallback in dev.
- Bun does not implement `node:sqlite`, so the native binary silently skips the
  Copilot *live SQLite* source; every JSONL source and the Node install are
  unaffected. (Recorded also in the install docs.)
- The npm name `asmgr` is unscoped and was unclaimed at decision time; both
  `chronicle` and `agent-session-manager` were already taken on npm.
- The first `semantic-release` run defaults to `1.0.0` unless a seed tag (e.g.
  `v0.1.0`) is created first — a deliberate release/versioning action left to a
  human.
- No license file exists yet; `npm publish` warns until one is added.
