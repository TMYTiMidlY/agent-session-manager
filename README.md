# session-recall

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

**Recall old coding-agent sessions.** `session-recall` reads local history from GitHub Copilot CLI, Claude Code, and OpenAI Codex CLI, then lets you search, print, or export a session as a self-contained HTML report.

It is read-only against agent state directories. It does **not** write to `.copilot`, `.claude`, or `.codex`, and it does not try to restore sessions back into the original CLIs.

## What you can do

| Goal | Command |
|---|---|
| List known sessions | `recall list --agent all` |
| Search local history | `recall search "keyword" --agent all` |
| Print one session | `recall show <session-id> --agent claude` |
| Export HTML | `recall html <session-id> --agent codex -o session.html` |
| Run backup | `recall backup --dry-run` |

Supported agents:

- **Copilot CLI**: reads `~/.copilot/session-state/*/events.jsonl`
- **Claude Code**: reads `~/.claude/projects/**/*.jsonl`
- **Codex CLI**: reads `~/.codex/sessions/**/*.jsonl`

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

Write a self-contained HTML report:

```bash
recall html <session-id> --agent copilot -o report.html
```

### `recall backup`

Run the restic backup wrapper:

```bash
recall backup --dry-run
recall backup
```

Backup is a source for future recall/search work. Current search reads live local history; searching inside restored backup caches is tracked separately.

## Backup setup

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
cp systemd/session-recall.service.example ~/.config/systemd/user/session-recall.service
cp systemd/session-recall.timer.example ~/.config/systemd/user/session-recall.timer
```

Edit `session-recall.service` so paths point at your checkout, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now session-recall.timer
systemctl --user list-timers session-recall.timer
```

If the timer should run while you are logged out, enable user lingering with your OS administrator account.

## Project layout

| Path | Purpose |
|---|---|
| `packages/core` | Agent discovery, parsers, normalized timeline model, search |
| `packages/html` | React HTML renderer |
| `packages/cli` | `recall` command |
| `fixtures` | Redacted parser and CLI fixtures |
| `tools/copilot` | Copilot export/share HTML research helpers |
| `backup.sh` | restic wrapper used by `recall backup` |

## Safety before publishing

Before pushing this repository anywhere public, check tracked files only:

```bash
git ls-files
git grep -nE 'PRIVATE|SECRET|TOKEN|PASSWORD|AKIA|/(h[o]me|Users)/|10\\.|192\\.168\\.|172\\.|D[E]SKTOP|[Ww]orkstation'
```

`secrets.env`, `backup.log`, `node_modules/`, and build output are ignored and should stay untracked.

## Roadmap

- Move the old dredge-up skill into a thin wrapper that calls `recall`.
- Improve adapter fidelity for every agent format.
- Add cached search over restic-restored backup snapshots.
- Add a dashboard over many sessions.
