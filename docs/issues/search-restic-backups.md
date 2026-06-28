# Search sessions from restic backup cache

GitHub issue: https://github.com/TMYTiMidlY/session-trace/issues/1

## Summary

`recall search/show/html` currently reads live local agent history directories. Add support for searching historical sessions restored from restic snapshots.

## Desired behavior

- `recall backup cache latest` restores the relevant agent history paths from the latest restic snapshot into a local cache directory.
- `recall index --source cache` builds or refreshes a SQLite/FTS index from that cache.
- `recall search <query> --source cache` searches cached backup history.
- `recall show <session-id> --source cache` and `recall html <session-id> --source cache` read original files from the cache, not from the live agent directories.

## Constraints

- Do not write to `.copilot`, `.claude`, or `.codex`.
- Cache paths must be local and user-controlled.
- The index stores only normalized searchable text and file pointers; HTML rendering should still read the original cached JSONL/events/db files for fidelity.

## Acceptance criteria

- Works for Copilot, Claude Code, and Codex fixtures.
- Works against a real restic snapshot restored into a temporary cache.
- Search results identify agent, session id, source snapshot/cache, entry number, role, and excerpt.
- The live-source path remains the default.
