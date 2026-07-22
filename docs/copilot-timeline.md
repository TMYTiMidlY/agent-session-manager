# Copilot timeline and persisted events

GitHub Copilot CLI has two related, but different, representations of a
session. Keeping them separate is essential when maintaining an offline
exporter.

## Live timeline versus `events.jsonl`

Copilot CLI's `/share html` renders the live session's in-memory timeline by
calling `session.getTimelineEntries()`. It does **not** read
`events.jsonl` directly. If that timeline has no entries, the official bundle
emits the literal message:

> The session is empty.

`session-state/<id>/events.jsonl` is the persistence layer. Events are appended
while the session runs and read back when a session is resumed. Compaction can
truncate or rewrite the persisted stream at an event-id boundary rather than
leaving a forever-append-only file; the exact boundary and timing should be
re-verified against current Copilot CLI releases.

The two export paths are therefore:

- **Official live export:** runtime event → Copilot's event-to-entry mapper →
  in-memory timeline → `/share html`.
- **Offline `chronicle` export:** persisted event in `events.jsonl` → `chronicle`'s
  event-to-entry mapper → normalized timeline entry → HTML or Markdown.

The core maintenance hazard follows directly:

> **If the offline mapper misses one event branch, that entire entry class is
> silently dropped.**

This caused earlier compaction and `task_complete` under-rendering bugs. The
[Copilot parser diagnostics](../packages/core/src/adapters/copilot.ts) count
handled, intentionally ignored, and unknown raw events so schema drift is
visible instead of disappearing unnoticed.

## Official filter classes

The official `/share html` bundle has a fixed set of 12 filter classes:

`user`, `copilot`, `tool`, `reasoning`, `info`, `warning`, `error`, `group`,
`notification`, `handoff`, `compaction`, and `task_complete`.

`chronicle` additionally exposes `subagent`, `skill`, and `plan` entries, and can
pin a summary card above the reconstructed timeline. These are deliberate
extensions beyond the official filter set.

### Reasoning is an offline extension

Persisted `assistant.message` events can contain `reasoningText`, but Copilot's
live event-to-entry mapping does not add that field to the official timeline.
Consequently, observed official exports report zero reasoning entries for this
data. `chronicle` deliberately splits `reasoningText` into a separate reasoning
entry during offline reconstruction.

## Data that offline export cannot recover

Some entries exist only in live memory and are never persisted in
`events.jsonl`. An offline exporter cannot reconstruct them:

- the mascot startup banner;
- the `/share` success receipt (`Session shared successfully to: …`);
- ephemeral retry notices.

This is a hard source-data limit, not a renderer bug.

## Operator pitfalls

- The current Copilot session id is the
  `~/.copilot/session-state/<id>/` **folder name**. Do not copy an id merely
  because it appears inside the conversation text.
- The live `session-store.db` commonly lags the latest turn or two. The most
  recent turn may not have reached the database yet, so it is a lossy fallback
  for current-session export.

## Raw event-type policy

The Copilot parser classifies every raw event as **handled**,
**intentionally ignored**, or **unknown**:

- **Handled** means the event emits an entry, updates session metadata, or is
  paired with another event. Current handled families include `session.start`,
  `user.message`, `assistant.message`, `tool.execution_start`,
  `tool.execution_complete`, `system.notification`, `session.info`, `abort`,
  error and warning events, `handoff`, compaction start/complete events,
  `task_complete`, subagent lifecycle events, `skill.invoked`, and
  `session.plan_changed`.
- **Intentionally ignored** means the type is known but should not create an
  offline timeline entry. `session.model_change` is dropped in favour of the
  user-facing `session.info` event with `infoType=model`. Other deliberate
  drops are `session.resume`, `session.shutdown`, `session.mode_changed`,
  `session.context_changed`, `session.workspace_file_changed`,
  `session.binary_asset`, `session.permissions_changed`, `session.schedule_*`,
  `session.truncation`, `session.usage_checkpoint`, all `hook.*` and
  `assistant.turn_*` events, and `system.message`.
- **Unknown** means no mapping or explicit ignore rule exists. Unknown counts
  are a drift alarm and should be investigated when Copilot CLI changes.

An intentionally ignored event must remain explicit in the parser policy;
otherwise a newly introduced event and a consciously dropped event are
indistinguishable.

## Confidence and re-verification

Confidence is high for the `/share html` use of `getTimelineEntries()`, the
empty-session message, the 12 filter classes, the `reasoningText` asymmetry,
and the listed live-memory-only entries. Persistence behaviour is well
supported by reverse engineering, but the exact file-truncation mechanics at
compaction deserve re-verification. After Copilot CLI upgrades, also re-run the
[bundle asset drift oracle](../tools/copilot/README.md) and inspect unknown
event diagnostics.
