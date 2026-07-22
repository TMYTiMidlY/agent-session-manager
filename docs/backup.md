# Backing up agent session history

`chronicle backup` (a thin wrapper over `backup.sh`) takes an encrypted, deduplicated,
incremental backup of your coding-agent history with [restic](https://restic.net).
It is the archive source behind the planned "search restored snapshots" feature
(see `docs/issues/search-restic-backups.md`).

All deployment-specific values — the restic repository URL, credentials, and the exact
network path to your storage backend — live in `secrets.env` (gitignored, mode `600`).
This document describes the **architecture** and **what gets backed up**; your concrete
endpoint and network hops are recorded in the `secrets.env` header comment.

## What gets backed up

`backup.sh` reads `BACKUP_AGENT_DIRS` (default `~/.copilot:~/.claude:~/.codex`) and backs
up whichever of those agent homes exist. For GitHub Copilot CLI (`~/.copilot`):

| Path | Typical size | What it is | Change pattern | Backed up? |
|---|---|---|---|---|
| `session-state/<id>/events.jsonl` | large (GBs total) | Persisted per-session event stream — replayed on resume and mapped into offline `chronicle` entries; live `/share html` renders the in-memory timeline instead | append-heavy; may be truncated or rewritten at compaction | ✅ core |
| `session-state/<id>/{checkpoints,files,research}/` | small–medium | Per-session artifacts (checkpoints, attached files, research notes) | grows | ✅ |
| `session-store.db` | tens of MB | SQLite index over all sessions (summaries, turns, file/ref index, FTS) | rewritten in place | ✅ — WAL is checkpointed first so the copy is self-consistent |
| `session-store.db-wal` / `-shm` | small | SQLite write-ahead log / shared memory (hot files) | churns constantly | ❌ excluded (`exclude.txt`) |
| `*.lock` (e.g. `inuse.<pid>.lock`) | tiny | runtime lock files | ephemeral | ❌ excluded (`exclude.txt`) |
| `logs/` | very large (GBs) | CLI process logs | append-only | ❌ excluded (always, in `backup.sh`) — high volume, low recovery value |
| `session-state/<id>/rewind-snapshots/` | large (GBs) | Snapshots that power the `/rewind` undo feature (see below) | grows | ⚠️ optional — excluded when `BACKUP_EXCLUDE_REWIND=1` |
| `config.json`, `settings.json`, `mcp-config.json`, `servers/` | tiny | CLI + MCP configuration | rare | ✅ |

Claude Code (`~/.claude`) and Codex (`~/.codex`) homes are backed up wholesale when present.

### `rewind-snapshots/` — what it is, and why it's optional

Copilot CLI's `/rewind` command lets you undo edits made during a session. To support
that, the CLI keeps filesystem snapshots under
`~/.copilot/session-state/<id>/rewind-snapshots/` (an `index.json` plus snapshot data).

Setting `BACKUP_EXCLUDE_REWIND=1` drops these from the backup. It saves more space than
any other single exclusion and does **not** affect `/share html`, `--resume`, or
`chronicle` / dredge-up. Live `/share html` renders the current in-memory timeline;
resume and offline exporters reconstruct from `events.jsonl`, which is always backed
up. The only thing you lose is the ability to `/rewind` a *restored* session. See
the [Copilot timeline model](copilot-timeline.md) for the distinction.

## Architecture (generic)

restic runs on a **client** machine, encrypts everything **end-to-end (AES-256)** before
it leaves the host, and writes to an **S3-compatible endpoint**
(`RESTIC_REPOSITORY=s3:<endpoint>/<bucket>`; any restic backend works —
rustfs / MinIO / SeaweedFS / AWS S3 / B2 / R2 / local path / sftp / rest). The backend
only ever sees ciphertext, so a compromised storage host does not expose your history.

The flip side: `RESTIC_PASSWORD` is the *only* key to the whole repository. If you lose
it, every snapshot is permanently unreadable. Copy it to a password manager / another
device immediately after `restic init`.

Depending on where the client and the storage live, reaching the endpoint can require
several network hops (e.g. a mesh overlay → a host port-proxy → WSL2 port forwarding →
a container port). That hop chain is deployment-specific and contains internal
addresses, so the concrete chain for the current deployment is documented in the
`secrets.env` header comment, **not in this tracked file** — this keeps the repository
free of internal IPs/hostnames (see "Safety before publishing" in the README). To
re-deploy on another machine, edit `secrets.env` only; `backup.sh`, `exclude.txt`, and
this document are generic.

## Retention

Each run tags its snapshot `agent-session-manager` + `$(hostname)` and then applies:

```
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

> Migration note: the snapshot tag has changed over time (`session-recall` →
> `agent-session-exporter` → `agent-session-manager`). If you point a new checkout
> at an existing repository, reconcile the tag (e.g. `restic tag --set
> agent-session-manager --tag agent-session-exporter`, or add a matching
> `--keep-tag`) so `forget` prunes the intended lineage rather than orphaning the
> old snapshots.

## Running it

```bash
cp secrets.env.example secrets.env && chmod 600 secrets.env   # fill in your backend
set -a; source secrets.env; set +a && restic init            # once, for a new repo
chronicle backup --dry-run                                       # preview
chronicle backup                                                 # for real
```

## Automatic runs (systemd user timer)

To run the backup daily, install a user-level `oneshot` service + timer. Create the two
unit files below (adjust the `ExecStart`/log paths to your `agent-session-manager`
checkout — `%h` expands to your home directory):

`~/.config/systemd/user/agent-session-manager.service`

```ini
[Unit]
Description=agent-session-manager agent history backup (restic)
Documentation=https://github.com/restic/restic

[Service]
Type=oneshot
# Point these at your checkout:
ExecStart=%h/projects/agent-session-manager/backup.sh
StandardOutput=append:%h/projects/agent-session-manager/backup.log
StandardError=append:%h/projects/agent-session-manager/backup.log
# Be gentle on an HDD-backed store:
Nice=10
IOSchedulingClass=idle
```

`~/.config/systemd/user/agent-session-manager.timer`

```ini
[Unit]
Description=Daily agent-session-manager backup timer

[Timer]
# Once a day, with 0-10 min jitter so it doesn't fire exactly at midnight:
OnCalendar=daily
RandomizedDelaySec=600
# Catch up a missed run after the machine was off:
Persistent=true

[Install]
WantedBy=timers.target
```

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-session-manager.timer
systemctl --user list-timers agent-session-manager.timer   # verify next/last run
```

If the timer must run while you are logged out, enable lingering:
`sudo loginctl enable-linger "$USER"`.

> Only one machine should own the timer. If you are migrating from an older deployment
> whose units pointed at a previous checkout (e.g. a `copilot-backup/` directory) and/or
> tagged snapshots `session-recall`, disable and delete those old units first
> (`systemctl --user disable --now <old>.timer`, then remove the unit files) so you do
> not run two backups or split the retention lineage (see "Retention" above).
