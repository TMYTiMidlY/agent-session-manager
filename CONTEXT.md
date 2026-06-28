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

### Timeline entry
A normalized item in a session timeline, such as a user message, assistant response, reasoning block, or tool call. Timeline entries are the shared model consumed by search and HTML rendering.
