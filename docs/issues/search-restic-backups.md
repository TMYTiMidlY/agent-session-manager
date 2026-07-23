# Search sessions from restic backup cache

GitHub issue: https://github.com/TMYTiMidlY/agent-session-manager/issues (re-filed after rename from session-trace)

## Summary

`asmgr search/show/html` currently reads live local agent history directories. Add support for searching historical sessions restored from restic snapshots.

## Progress (2026-07-22)

Partially addressed. Every read command now accepts `--file <path>` (alias
`--events <path>`), which reads an explicit `*.jsonl` file or a directory walked
for them, auto-detecting each file's agent. So the **ad-hoc** flow already works:

```bash
restic restore latest --target /tmp/cache
asmgr search "keyword" --file /tmp/cache
asmgr html <session-id> --file /tmp/cache -o report.html
```

Still open (the durable half of this issue):

- `asmgr backup cache latest` convenience wrapper that restores the relevant
  agent paths into a cache directory.
- `asmgr index --source cache` building a persistent SQLite/FTS index.
- `--source cache` as a named source alias (today you pass the concrete path via
  `--file`).

## Desired behavior

- `asmgr backup cache latest` restores the relevant agent history paths from the latest restic snapshot into a local cache directory.
- `asmgr index --source cache` builds or refreshes a SQLite/FTS index from that cache.
- `asmgr search <query> --source cache` searches cached backup history.
- `asmgr show <session-id> --source cache` and `asmgr html <session-id> --source cache` read original files from the cache, not from the live agent directories.

## Constraints

- Do not write to `.copilot`, `.claude`, or `.codex`.
- Cache paths must be local and user-controlled.
- The index stores only normalized searchable text and file pointers; HTML rendering should still read the original cached JSONL/events/db files for fidelity.

## Acceptance criteria

- Works for Copilot, Claude Code, and Codex fixtures.
- Works against a real restic snapshot restored into a temporary cache.
- Search results identify agent, session id, source snapshot/cache, entry number, role, and excerpt.
- The live-source path remains the default.
