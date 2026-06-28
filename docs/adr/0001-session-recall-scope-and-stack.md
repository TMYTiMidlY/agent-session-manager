# ADR 0001: Scope and stack for session-recall

## Status

Accepted

## Context

This repository started as `copilot-backup`, a restic wrapper for backing up `~/.copilot`. The intended scope is now broader: retrieve historical coding-agent sessions by id, search old sessions, and generate human-readable HTML for GitHub Copilot CLI, Claude Code, and OpenAI Codex CLI.

The backup layer remains useful, but only as one archive source. We are not trying to restore deleted sessions into the original agent CLIs so they can resume them.

## Decision

Use the repository name `session-recall` and expose a short CLI binary named `recall`.

Implement the project as a pnpm-managed TypeScript workspace:

- `packages/core`: agent adapters, discovery, parsing, and search.
- `packages/html`: React-based single-file HTML rendering from normalized timeline entries.
- `packages/cli`: the `recall` command.
- `fixtures`: small redacted samples for parser tests.

The HTML path is React-only. The old vanilla Copilot `/share html` replication path and Copilot bundle asset extractor are legacy and should not be maintained in the new design.

## Consequences

- All three initial agents must support `search`, `show`, and `html` in v1.
- Search and HTML generation are read-only against `~/.copilot`, `~/.claude`, and `~/.codex`.
- Backup commands may still call restic, but backup is not the primary product boundary.
- Community projects such as `claude-code-trace`, `codex-trace`, and `code-chat-viewer` are references for schema coverage and UX, not dependencies to embed.
