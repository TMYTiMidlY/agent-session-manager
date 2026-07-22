# agent-session-exporter

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

**Export coding-agent CLI sessions to Markdown or single-file HTML.** `agent-session-exporter` reads local history written by GitHub Copilot CLI, Claude Code, and OpenAI Codex CLI, then exports a chosen session as a faithful, self-contained report. The CLI binary is named `recall`.

The HTML output replicates Copilot CLI's built-in `/share html` layout (Primer dark theme, sticky header, filter pills, sidebar map, jump-to-prev/next user message, search). The Markdown output replicates Copilot CLI's `/share file` format byte-for-byte (`### 💬/👤/🔧/✅` headings, `<sub>⏱️</sub>` elapsed stamps, `<details>` fold of long tool output, diff fences, `[!NOTE]` header block).

It is read-only against agent state directories. It does **not** write to `.copilot`, `.claude`, or `.codex`, and it does not try to restore sessions back into the original CLIs.

## What you can do

| Goal | Command |
|---|---|
| List known sessions | `recall list --agent all` |
| Search local history | `recall search "keyword" --agent all` |
| Print one session | `recall show <session-id> --agent claude` |
| Export to Markdown (Copilot `/share file` replica) | `recall md <session-id> -o session.md` |
| Export to HTML (Copilot `/share html` replica) | `recall html <session-id> -o session.html` |
| Read a session file from anywhere (scp'd / restored) | `recall html --file /path/to/events.jsonl -o session.html` |
| Search a restored backup cache directory | `recall search "keyword" --file /path/to/restored-cache` |
| Run backup (restic wrapper) | `recall backup --dry-run` |

Supported agents:

- **Copilot CLI**: reads `~/.copilot/session-state/*/events.jsonl`
- **Claude Code**: reads `~/.claude/projects/**/*.jsonl`
- **Codex CLI**: reads `~/.codex/sessions/**/*.jsonl`

Every read command (`list`, `search`, `show`, `html`, `md`) also accepts
`--file <path>` (alias `--events <path>`) to read an explicit `*.jsonl` file — or
a directory walked for them — instead of the live agent homes. The agent format
is auto-detected per file (override with `--agent`). This is how you render a
session copied off another machine, or search a restic-restored backup cache
without first placing files back under `~/.copilot`.

## Install (no npm publish yet)

This package is not on npm. Clone and link locally — this is the supported path until a single-binary release lands:

```bash
git clone https://github.com/TMYTiMidlY/agent-session-exporter.git
cd agent-session-exporter
pnpm install
pnpm build
pnpm --filter @agent-session-exporter/cli exec npm link    # makes `recall` global
recall list --agent all
```

To uninstall:

```bash
pnpm --filter @agent-session-exporter/cli exec npm unlink -g
```

Single-binary releases (`bun build --compile` for macOS / Linux / Windows) and `npm i -g github:...` one-liner install are tracked in [Roadmap](#roadmap).

## Install for development

```bash
pnpm install
pnpm build
```

Run the built CLI directly:

```bash
node packages/cli/dist/index.js list --agent all
```

For local development, use the workspace script:

```bash
pnpm recall -- search "keyword" --agent all
```

## First run

1. Build the project.
2. List sessions for one agent:

   ```bash
   node packages/cli/dist/index.js list --agent copilot
   ```

3. Copy a session id from the second column.
4. Generate HTML:

   ```bash
   node packages/cli/dist/index.js html <session-id> --agent copilot -o report.html
   ```

5. Open `report.html` in a browser.

The HTML file is standalone: search, filters, collapsible entries, sidebar map, compact mode, theme toggle, Markdown tables, and math rendering all work offline.

## CLI reference

### `recall list`

Print discovered sessions as tab-separated rows:

```bash
recall list --agent all
recall list --agent claude --claude-root /path/to/claude/projects
```

### `recall search`

Search user, assistant, reasoning, tool, system, and event text:

```bash
recall search "database migration" --agent all --limit 20
```

### `recall show`

Print a session as text or JSON:

```bash
recall show <session-id> --agent codex
recall show <session-id> --agent codex --format json
```

### `recall html`

Write a self-contained HTML report. Replicates Copilot CLI `/share html` (sticky header, filter pills, sidebar map, search, expand/collapse, jump-to-prev/next user message, theme toggle, compact mode, markdown tables, KaTeX math), plus:

- **Shiki syntax highlighting** for markdown code fences and diff-style tool output, with dual light + dark themes so the page theme toggle re-colours code without a page reload.
- **24-hour timestamps** (`YYYY-MM-DD HH:MM:SS` for session start; `HH:MM:SS` for entries on the same day, `MM-DD HH:MM:SS` when a session spans multiple days) — the en-US 12-hour default (`PM/AM`) misreads too easily.
- **Elapsed pill** in the header derived from `startedAt` → last entry.
- **Agent summary card** pinned above the timeline via `--summary <file.html>` (renders trusted HTML raw; `data-index="summary"` so real entry #1 stays entry #1).
- **Merged tool cards** with five result states (success / failure / rejected / denied / pending), matching border colours and status icons.
- **Subagent / skill / plan entries** parsed from `events.jsonl` and rendered as their own cards + filter pills — the subagent card shows agent name, model, token count, tool-call count, and duration. These match the dredge-up skill and go beyond Copilot's own `/share html` (whose pills stop at compaction / task_complete).
- **Data-source fallback warning pill** shown in the header when the parser had to read something other than the canonical `events.jsonl`.
- **Default-open policy mirrors the Copilot bundle**: `user / assistant / error / task_complete` open, everything else folded.

```bash
recall html <session-id> --agent copilot -o report.html
recall html <session-id> -s agent-summary.html -o report.html   # pin an HTML summary on top
```

### `recall md`

Export a session as Markdown that replicates Copilot CLI `/share file` byte-for-byte (`### 💬/👤/🔧/✅` headings, `<sub>⏱️</sub>` elapsed stamps, `<details>` fold of long tool output, diff fences, `[!NOTE]` header block).

```bash
recall md <session-id> --agent copilot -o report.md
recall md <session-id> --no-reasoning -o report.md             # drop reasoning entries
recall md <session-id> -s summary.md -o report.md              # inject a markdown summary
```

### `recall backup`

Run the restic backup wrapper:

```bash
recall backup --dry-run
recall backup
```

Backup is a source for future recall/search work. Current search reads live local history; a *persistent* index over restored backup caches is tracked separately (issue #1). For ad-hoc work today, restore a snapshot and point any read command at it with `--file`:

```bash
restic restore latest --target /tmp/cache          # restore a snapshot
recall search "keyword" --file /tmp/cache           # search the restored cache
recall html <session-id> --file /tmp/cache -o s.html
```

### Reading sessions from outside the live agent homes

`--file <path>` (alias `--events <path>`) makes `list` / `search` / `show` /
`html` / `md` read an explicit path instead of `~/.copilot`, `~/.claude`, or
`~/.codex`:

```bash
# a single session file copied off another machine (agent auto-detected)
recall show --file ~/dl/events.jsonl --format json
recall html --file ~/dl/events.jsonl -o report.html

# a whole directory (walked for *.jsonl; each file's agent auto-detected)
recall list --file /tmp/restored-cache
recall search "migration" --file /tmp/restored-cache
```

When `--file` points at a single file, the `<session-id>` argument is optional.
When it points at a directory that yields more than one session, pass a
`<session-id>` to pick one (use `recall list --file <dir>` to see the ids).

## Backup setup

> For what actually gets backed up (per-directory), the `rewind-snapshots` exclusion, the
> end-to-end-encryption model, and the network architecture, see [`docs/backup.md`](docs/backup.md).

Copy the template and fill in your own backend:

```bash
cp secrets.env.example secrets.env
chmod 600 secrets.env
```

Required variables:

| Variable | Meaning |
|---|---|
| `RESTIC_REPOSITORY` | restic repository URL, for example an S3-compatible bucket |
| `RESTIC_PASSWORD` | encryption password for the restic repository |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials, only for S3-compatible backends |

Optional:

| Variable | Default |
|---|---|
| `RESTIC_BIN` | `$HOME/.local/bin/restic` |
| `BACKUP_AGENT_DIRS` | `$HOME/.copilot:$HOME/.claude:$HOME/.codex` |
| `BACKUP_EXCLUDE_REWIND` | unset; set to `1` to skip Copilot rewind snapshots |

Initialize a new restic repo once:

```bash
set -a; source secrets.env; set +a
restic init
```

Then run:

```bash
recall backup --dry-run
recall backup
```

Keep `RESTIC_PASSWORD` in a password manager or another device. If you lose it, encrypted backups cannot be read.

## Automatic backup with systemd

Example unit files live in `systemd/`:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/agent-session-exporter.service.example ~/.config/systemd/user/agent-session-exporter.service
cp systemd/agent-session-exporter.timer.example ~/.config/systemd/user/agent-session-exporter.timer
```

Edit `agent-session-exporter.service` so paths point at your checkout, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-session-exporter.timer
systemctl --user list-timers agent-session-exporter.timer
```

If the timer should run while you are logged out, enable user lingering with your OS administrator account.

## Project layout

| Path | Purpose |
|---|---|
| `packages/core` | Agent discovery, parsers, normalized timeline model, search |
| `packages/markdown` | Markdown renderer (replicates Copilot `/share file`) |
| `packages/html` | React-based single-file HTML renderer (replicates Copilot `/share html`) |
| `packages/cli` | `recall` command |
| `fixtures` | Redacted parser and CLI fixtures |
| `tools/copilot` | Copilot export/share HTML research helpers |
| `backup.sh` | restic wrapper used by `recall backup` |

## Prior art / related projects

This problem space is crowded — at least 14 OSS projects target similar
ground. Several have meaningful star counts, and at least one is by a
prominent open-source author. We surveyed them before designing this
tool. A read-only mirror of each project is kept at
`1810:/home/timidly/projects/readonly-repos/<name>/` for local reference.

| Repository | Stars | Lang | Form factor | Agents covered | Notes |
|---|---:|---|---|---|---|
| [simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) | 1586 | Python | CLI → paginated static HTML | Claude | By Simon Willison; mobile-friendly multi-page output |
| [d-kimuson/claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer) | 1233 | TS (web) | Full web client (live + history) | Claude | Not just a viewer; can drive new sessions via Agent SDK |
| [daaain/claude-code-log](https://github.com/daaain/claude-code-log) | 1121 | Python | CLI → HTML/Markdown + Textual TUI | Claude | `uvx claude-code-log` zero-install; project-hierarchy index page |
| [specstoryai/getspecstory](https://github.com/specstoryai/getspecstory) | 1260 | Mixed | Commercial product (CLI partly OSS) | Many IDE/CLI | "Intent is the new source code" — capture + index + skill forge |
| [nateherkai/token-dashboard](https://github.com/nateherkai/token-dashboard) | 605 | Python | Local web dashboard | Claude | Cost / token-usage analytics angle |
| [vibe-log/vibe-log-cli](https://github.com/vibe-log/vibe-log-cli) | 332 | TS | npm CLI (`vibe-log`) | Claude + Codex | Productivity reports + Claude statusline |
| [delexw/claude-code-trace](https://github.com/delexw/claude-code-trace) | 327 | TS+Rust (Tauri) + Python | Native GUI + Web + TUI | Claude | Tauri desktop, `cctrace` CLI; rich live-tail UI |
| [kylesnowschwartz/tail-claude](https://github.com/kylesnowschwartz/tail-claude) | 146 | Go | Bubble Tea TUI | Claude | Single-binary, requires Nerd Font |
| [wesm/archived-agent-session-viewer](https://github.com/wesm/archived-agent-session-viewer) | 88 | Python | Local web app (FastAPI) | Claude + Codex | By Wes McKinney (pandas/Arrow); **archived** in favour of AgentsView |
| [shayne-snap/waylog-cli](https://github.com/shayne-snap/waylog-cli) | 84 | Rust | Auto-sync to `.waylog/` markdown files | Claude + Codex + Gemini | Cargo / Homebrew / Scoop distribution |
| [PixelPaw-Labs/codex-trace](https://github.com/PixelPaw-Labs/codex-trace) | 56 | TS+Rust (Tauri) | Native GUI + Web | Codex | Sibling project to claude-code-trace |
| [monk1337/clicodelog](https://github.com/monk1337/clicodelog) | 47 | Python (FastAPI) | Local web app | Claude + Codex + Gemini | The closest existing multi-agent local viewer |
| [HizTam/codex-history-viewer](https://github.com/HizTam/codex-history-viewer) | 19 | TS | VS Code extension | Claude + Codex | Browse + resume from inside VS Code |
| [dotneet/agent-session-view](https://github.com/dotneet/agent-session-view) | 10 | TS (Bun) | Web + Ink TUI | Claude + Codex | Multiple export formats (text + HTML) |

### Where `agent-session-exporter` is different

1. **GitHub Copilot CLI is a first-class adapter.** None of the projects above currently parse `~/.copilot/session-state/*/events.jsonl`.
2. **Output replicates Copilot CLI's own `/share file` and `/share html` formats.** That means the same Primer dark theme, the same filter pills, the same emoji-prefixed Markdown headings, the same `<sub>⏱️ Xs</sub>` elapsed timestamps, the same `<details>` fold of long tool output, and the same diff fences — so a user already familiar with the bundled `/share` UX gets pixel- and byte-equivalent offline reports for any of the three agents.
3. **Single-file HTML is the default deliverable.** ~1 MB, no server, no build, opens by double-click. (Most peers ship a Tauri app, an Express/FastAPI web app, or a TUI; the only static-HTML peers are Simon's `claude-code-transcripts` (Claude-only) and `daaain/claude-code-log` (Claude-only).)
4. **Library + CLI, not just an app.** `@agent-session-exporter/core`, `/markdown`, `/html` are independently importable for downstream tools that want the parser or renderer without the CLI.
5. **No live agent SDK coupling.** Read-only, no Anthropic / OpenAI / GitHub API calls for normal operation; no ToS surface area like `claude-code-viewer` has had to navigate.

### Things we learned from the field (and intend to adopt)

These are tracked as GitHub issues with explicit `Inspired by …` references in each:

- **Project-hierarchy index page** that links to every session HTML (à la `claude-code-log`).
- **Token / cost analytics view** for sessions (à la `token-dashboard`).
- **Live tail mode** for an open session (à la `claude-code-trace` / `tail-claude`).
- **Project-grouped sidebar** for `recall list` (à la `agent-session-viewer`, `codex-history-viewer`).
- **VS Code extension wrapper** as a separate package (à la `codex-history-viewer`).
- **Static export tarball for Pages hosting** (à la `claude-code-transcripts`).

## Safety before publishing

Before pushing this repository anywhere public, check tracked files only:

```bash
git ls-files
git grep -nE 'PRIVATE|SECRET|TOKEN|PASSWORD|AKIA|/(h[o]me|Users)/|10\\.|192\\.168\\.|172\\.|D[E]SKTOP|[Ww]orkstation'
```

`secrets.env`, `backup.log`, `node_modules/`, and build output are ignored and should stay untracked.

## Roadmap

- **Single-file distribution.** Bundle the CLI with `bun build --compile` and attach native binaries to GitHub Releases; add a `npm i -g github:...` one-liner once workspace bundling is set up.
- **Persistent index/cache search over restic-restored backup snapshots** (originally tracked as issue #1 in the predecessor `session-trace` repo — see `docs/issues/search-restic-backups.md`). Ad-hoc search over a restored cache directory already works via `recall search --file <dir>`; the remaining work is the `recall backup cache` restore helper plus a durable SQLite/FTS index.
- **Move the old `dredge-up` skill into a thin wrapper that calls `recall`.** `recall` now matches the skill's Copilot entry-type coverage (subagent / skill / plan, plus the compaction / task_complete / warning / error types the adapter used to drop) and both of its outputs (`md` + single-file `html`), so this wrapper is unblocked.
- **Improve adapter fidelity for every agent format.**
- **Project-hierarchy index page** (inspired by `daaain/claude-code-log`).
- **Token / cost analytics view** (inspired by `nateherkai/token-dashboard`).
- **Live tail mode** for active sessions (inspired by `delexw/claude-code-trace`, `kylesnowschwartz/tail-claude`).
- **VS Code extension wrapper** (inspired by `HizTam/codex-history-viewer`).
- **Static export tarball for GitHub Pages** (inspired by `simonw/claude-code-transcripts`).
- **Dashboard view across many sessions.**
