import { basename, dirname } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry, ToolDetail, ToolResultKind } from "../types.js";
import { contentToText } from "../text.js";
import { expandHome, readJsonl, walkFiles } from "../fs.js";
import { listCopilotDbSessions, readCopilotDbSession } from "./copilot-db.js";

const DEFAULT_ROOT = "~/.copilot/session-state";
const DEFAULT_DB = "~/.copilot/session-store.db";

export async function discoverCopilot(root = DEFAULT_ROOT, dbPath = DEFAULT_DB): Promise<SessionRef[]> {
  const resolvedDbPath = expandHome(dbPath);
  const [files, dbSessions] = await Promise.all([
    walkFiles(expandHome(root), (path) => basename(path) === "events.jsonl"),
    listCopilotDbSessions(resolvedDbPath),
  ]);
  const refs = new Map<string, SessionRef>();

  for (const session of dbSessions) {
    refs.set(session.id, {
      agent: "copilot",
      id: session.id,
      path: resolvedDbPath,
      cwd: session.cwd,
      title: session.summary,
      repository: session.repository,
      branch: session.branch,
      source: { kind: "db-turns", path: resolvedDbPath, lossy: true },
    });
  }

  for (const path of files) {
    const id = basename(dirname(path));
    const dbRef = refs.get(id);
    refs.set(id, {
      ...dbRef,
      agent: "copilot",
      id,
      path,
      source: { kind: "events", path, lossy: false },
    });
  }

  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function parseCopilot(ref: SessionRef): Promise<ParsedSession> {
  if (ref.source?.kind === "db-turns" || (basename(ref.path) === "session-store.db" && ref.source?.kind !== "events")) {
    return parseCopilotDb(ref);
  }

  const rows = await readJsonl(ref.path);
  const entries: TimelineEntry[] = [];
  let cwd = ref.cwd;
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let title = ref.title;
  let repository = ref.repository;
  const branch = ref.branch;

  /** tool entries waiting for their matching complete event, keyed by callId */
  const pendingTools = new Map<string, TimelineEntry>();
  /** subagent.started entries waiting for their subagent.completed stats, keyed by toolCallId */
  const pendingSubagents = new Map<string, TimelineEntry>();
  /** timestamp of the last session.compaction_start, to derive compaction duration */
  let pendingCompactionStart: string | undefined;

  function push(entry: Omit<TimelineEntry, "index">): TimelineEntry {
    const full: TimelineEntry = { index: entries.length, ...entry };
    entries.push(full);
    return full;
  }

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = row as Record<string, unknown>;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const type = String(event.type ?? "event");
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    updatedAt = timestamp ?? updatedAt;

    if (type === "session.start") {
      const context = (data.context ?? {}) as Record<string, unknown>;
      cwd = typeof context.cwd === "string" ? context.cwd : cwd;
      startedAt = typeof data.startTime === "string" ? data.startTime : timestamp ?? startedAt;
      repository = typeof context.repository === "string" ? context.repository : repository;
      title ??= repository;
      continue;
    }

    if (type === "user.message") {
      const text = stringOrEmpty(data.content);
      if (!text.trim()) continue;
      push({ role: "user", kind: "message", text, timestamp, rawType: type });
      continue;
    }

    if (type === "assistant.message") {
      const reasoning = stringOrEmpty(data.reasoningText);
      const content = stringOrEmpty(data.content);
      if (reasoning.trim()) {
        push({ role: "reasoning", kind: "reasoning", text: reasoning, timestamp, rawType: type });
      }
      if (content.trim()) {
        const model = typeof data.model === "string" ? data.model : undefined;
        push({
          role: "assistant",
          kind: "message",
          text: content,
          timestamp,
          rawType: type,
          data: model ? { model } : undefined,
        });
      }
      continue;
    }

    if (type === "tool.execution_start") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const entry = push(toolEntryFromStart(data, timestamp, type));
      if (callId) pendingTools.set(callId, entry);
      continue;
    }

    if (type === "tool.execution_complete") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const entry = (callId ? pendingTools.get(callId) : undefined)
        ?? push(toolEntryFromStart(data, timestamp, type));
      if (callId) pendingTools.delete(callId);

      const tool = entry.tool ?? { result: { type: "pending" } };
      tool.callId ??= callId;
      tool.name ??= typeof data.toolName === "string" ? data.toolName : undefined;
      tool.arguments ??= data.arguments;
      tool.intentionSummary ??= typeof data.intentionSummary === "string" ? data.intentionSummary : undefined;
      tool.partialOutput = partialOutput(data.partialOutput) ?? tool.partialOutput;
      tool.result = normaliseToolResult(data);
      entry.tool = tool;
      entry.title = tool.name;
      entry.text = tool.result?.log ?? "";
      entry.rawType = type;
      continue;
    }

    if (type === "system.notification") {
      const kind = (data.kind ?? {}) as Record<string, unknown>;
      const kindType = typeof kind.type === "string" ? kind.type : undefined;
      push({
        role: "event",
        kind: "notification",
        text: stringOrEmpty(data.content) || kindType || "",
        timestamp,
        rawType: type,
        detail: kindType,
        data: { kind },
      });
      continue;
    }

    if (type === "session.info") {
      // Bundle adds a timeline entry per persisted session.info; infoType=model
      // surfaces "Model changed from X to Y" which we want.
      const message = stringOrEmpty(data.message);
      if (message) {
        push({ role: "event", kind: "info", text: message, timestamp, rawType: type });
      }
      continue;
    }

    if (type === "abort") {
      const reason = typeof data.reason === "string" ? data.reason : "user_initiated";
      const text = reason === "user_initiated" || reason === "user initiated"
        ? "Operation cancelled by user"
        : `Operation aborted (${reason})`;
      push({ role: "event", kind: "info", text, timestamp, rawType: type });
      continue;
    }

    if (type === "session.error" || type === "error") {
      push({
        role: "event",
        kind: "error",
        text: stringOrEmpty(data.message ?? data.content ?? data.error),
        timestamp,
        rawType: type,
      });
      continue;
    }

    if (type === "session.warning" || type === "warning") {
      push({
        role: "event",
        kind: "warning",
        text: stringOrEmpty(data.message ?? data.content),
        timestamp,
        rawType: type,
      });
      continue;
    }

    if (type === "handoff") {
      push({
        role: "event",
        kind: "handoff",
        text: stringOrEmpty(data.summary),
        timestamp,
        rawType: type,
        data: data,
      });
      continue;
    }

    if (type === "session.compaction_start") {
      // The start event carries only pre-compaction token counts; the summary
      // lands on the matching complete event. Stash the ts for duration.
      pendingCompactionStart = timestamp;
      continue;
    }

    if (type === "session.compaction_complete" || type === "compaction") {
      // A compaction trims the in-context window; events.jsonl is append-only
      // so every pre-compaction turn still survives above this marker. The
      // entry carries `summaryContent` — the recap seeded into the fresh window.
      // Real field names (grounded against live events.jsonl): the complete
      // event has preCompactionTokens + preCompactionMessagesLength (there is
      // NO postCompactionTokens / messagesRemoved / tokensRemoved), and the
      // authoritative duration is compactionTokensUsed.duration (ms). We fall
      // back to the start→complete timestamp delta only if that's absent.
      const usage = (data.compactionTokensUsed ?? {}) as Record<string, unknown>;
      let durationMs = typeof usage.duration === "number" ? usage.duration : undefined;
      if (durationMs === undefined && timestamp && pendingCompactionStart) {
        durationMs = Date.parse(timestamp) - Date.parse(pendingCompactionStart);
      }
      push({
        role: "event",
        kind: "compaction",
        text: stringOrEmpty(data.summaryContent) || "Conversation compacted",
        timestamp,
        rawType: type,
        data: {
          success: data.success !== false,
          preTokens: data.preCompactionTokens,
          preMessages: data.preCompactionMessagesLength,
          checkpointNumber: data.checkpointNumber,
          model: typeof usage.model === "string" ? usage.model : undefined,
          durationMs,
        },
      });
      pendingCompactionStart = undefined;
      continue;
    }

    if (type === "session.task_complete" || type === "task_complete") {
      push({
        role: "event",
        kind: "task_complete",
        text: stringOrEmpty(data.content ?? data.summary),
        timestamp,
        rawType: type,
        data: { isError: data.success === false },
      });
      continue;
    }

    if (type === "subagent.started" || type === "subagent.selected") {
      const displayName = typeof data.agentDisplayName === "string" ? data.agentDisplayName : undefined;
      const name = typeof data.agentName === "string" ? data.agentName : undefined;
      const entry = push({
        role: "event",
        kind: "subagent",
        title: displayName ?? name,
        text: stringOrEmpty(data.agentDescription),
        timestamp,
        rawType: type,
        data: {
          agentName: name,
          agentDisplayName: displayName,
          description: typeof data.agentDescription === "string" ? data.agentDescription : undefined,
          model: data.model,
        },
      });
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      if (callId) pendingSubagents.set(callId, entry);
      continue;
    }

    if (type === "subagent.completed" || type === "subagent.failed") {
      // Real subagent.completed carries only toolCallId/agentName/agentDisplayName/model
      // — NO totalTokens/totalToolCalls/durationMs. subagent.failed adds `error`.
      // We only record what actually exists: the failed flag + any error text.
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const target = callId ? pendingSubagents.get(callId) : undefined;
      if (callId) pendingSubagents.delete(callId);
      if (target) {
        const failed = type === "subagent.failed" || data.success === false;
        target.data = {
          ...target.data,
          failed,
          error: failed && typeof data.error === "string" ? data.error : undefined,
        };
      }
      continue;
    }

    if (type === "skill.invoked") {
      const name = typeof data.name === "string" ? data.name : undefined;
      push({
        role: "event",
        kind: "skill",
        title: name,
        text: stringOrEmpty(data.description),
        timestamp,
        rawType: type,
        data: {
          name,
          description: typeof data.description === "string" ? data.description : undefined,
          source: data.source,
          trigger: data.trigger,
        },
      });
      continue;
    }

    if (type === "session.plan_changed") {
      const operation = data.operation;
      const opLabel = typeof operation === "string" ? operation : undefined;
      push({
        role: "event",
        kind: "plan",
        text: opLabel ? `Plan ${opLabel}` : "Plan updated",
        timestamp,
        rawType: type,
        data: { operation },
      });
      continue;
    }

    // Intentionally dropped: hook.*, assistant.turn_*, system.message
    // (system prompt is huge and noisy), session.model_change (we prefer
    // the session.info(infoType=model) text version).
  }

  return {
    ...ref,
    startedAt,
    updatedAt,
    cwd,
    title,
    repository,
    branch,
    source: { kind: "events", path: ref.path, lossy: false },
    entries,
  };
}

async function parseCopilotDb(ref: SessionRef): Promise<ParsedSession> {
  const stored = await readCopilotDbSession(ref.path, ref.id);
  const entries: TimelineEntry[] = [];

  function push(role: "user" | "assistant", text: string, turnIndex: number): void {
    if (!text.trim()) return;
    entries.push({
      index: entries.length,
      role,
      kind: "message",
      text,
      rawType: role === "user" ? "turns.user_message" : "turns.assistant_response",
      data: { turnIndex },
    });
  }

  for (const turn of stored?.turns ?? []) {
    if (turn.userMessage) push("user", turn.userMessage, turn.turnIndex);
    if (turn.assistantResponse) push("assistant", turn.assistantResponse, turn.turnIndex);
  }

  return {
    ...ref,
    cwd: stored?.session.cwd ?? ref.cwd,
    title: stored?.session.summary ?? ref.title,
    repository: stored?.session.repository ?? ref.repository,
    branch: stored?.session.branch ?? ref.branch,
    source: { kind: "db-turns", path: ref.path, lossy: true },
    entries,
  };
}

function stringOrEmpty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return contentToText(value);
}

function toolEntryFromStart(data: Record<string, unknown>, timestamp: string | undefined, rawType: string): Omit<TimelineEntry, "index"> {
  const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
  const name = typeof data.toolName === "string" ? data.toolName : undefined;
  return {
    role: "tool",
    kind: "tool",
    title: name,
    text: "",
    timestamp,
    rawType,
    tool: {
      callId,
      name,
      arguments: data.arguments,
      intentionSummary: typeof data.intentionSummary === "string" ? data.intentionSummary : undefined,
      partialOutput: partialOutput(data.partialOutput),
      result: { type: "pending" },
    },
  };
}

function normaliseToolResult(data: Record<string, unknown>): ToolDetail["result"] {
  const success = data.success !== false;
  const raw = data.result;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
  const explicitType = toolResultKind(obj?.type);
  const type = explicitType ?? (success ? "success" : "failure");
  const error = !success ? data.error ?? obj?.error : undefined;
  const logSource = error ?? obj?.content ?? obj?.detailedContent ?? (typeof raw === "string" ? raw : undefined);
  let log = logSource === undefined ? undefined : stringOrEmpty(logSource);

  if (log === undefined && obj && Object.keys(obj).some((key) => key !== "type" && key !== "markdown")) {
    log = contentToText(obj);
  }

  if (obj) {
    return {
      type,
      log,
      markdown: obj.markdown === true,
    };
  }
  return { type, log };
}

function partialOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  return stringOrEmpty(value);
}

function toolResultKind(value: unknown): ToolResultKind | undefined {
  // No distinct rejected/denied event encoding has been observed. Preserve
  // those states only when a completion explicitly supplies result.type.
  if (value === "success" || value === "failure" || value === "rejected" || value === "denied" || value === "pending") {
    return value;
  }
  return undefined;
}

export function copilotRoots(root?: string): string {
  return root ?? DEFAULT_ROOT;
}

export function copilotDbRoot(root?: string): string {
  return root ?? DEFAULT_DB;
}
