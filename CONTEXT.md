# Context

## Glossary

### Session
A single conversation persisted by an agent CLI. A session may be identified by a UUID, a JSONL file path, or an agent-specific local database row.

### Agent adapter
Code that knows how to discover and parse one agent's persisted session format. Current adapters target GitHub Copilot CLI, Claude Code, and OpenAI Codex CLI.

### Recall
Read-only retrieval of historical sessions: search, text display, JSON export, and human-readable HTML generation. Recall does not restore sessions back into the original agent's live state.

### Archive source
A place where session files can be read from. Archive sources include the live local agent directories and a restic-restored cache of backed-up session files.

### Event
A raw record in an agent's persisted stream. For Copilot, events are stored in
`events.jsonl` and are the input to offline timeline reconstruction; they are
not the objects rendered directly by live `/share html`.

### Timeline entry
A presentational item in a session timeline, such as a user message, assistant
response, reasoning block, or tool call. Copilot keeps live timeline entries in
memory; `recall` reconstructs normalized entries from persisted events. Timeline
entries are the shared model consumed by search and renderers.

See [`docs/copilot-timeline.md`](docs/copilot-timeline.md) for the Copilot event
to timeline-entry mapping and its offline fidelity limits.
