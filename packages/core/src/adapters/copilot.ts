import { basename, dirname, join } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry, ToolDetail, ToolResultKind } from "../types.js";
import { contentToText } from "../text.js";
import { expandHome, readJsonl, walkFiles } from "../fs.js";

const DEFAULT_ROOT = "~/.copilot/session-state";

export async function discoverCopilot(root = DEFAULT_ROOT): Promise<SessionRef[]> {
  const files = await walkFiles(expandHome(root), (path) => basename(path) === "events.jsonl");
  return files.map((path) => ({
    agent: "copilot",
    id: basename(dirname(path)),
    path,
  }));
}

export async function parseCopilot(ref: SessionRef): Promise<ParsedSession> {
  const rows = await readJsonl(ref.path);
  const entries: TimelineEntry[] = [];
  let cwd = ref.cwd;
  let startedAt = ref.startedAt;
  let title = ref.title;

  /** start events waiting for their matching complete event, keyed by callId */
  const pendingStarts = new Map<string, { name?: string; args?: unknown; intentionSummary?: string; partialOutput?: string; timestamp?: string }>();

  function push(entry: Omit<TimelineEntry, "index">) {
    entries.push({ index: entries.length, ...entry });
  }

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = row as Record<string, unknown>;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const type = String(event.type ?? "event");
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;

    if (type === "session.start") {
      const context = (data.context ?? {}) as Record<string, unknown>;
      cwd = typeof context.cwd === "string" ? context.cwd : cwd;
      startedAt = typeof data.startTime === "string" ? data.startTime : timestamp ?? startedAt;
      title = typeof context.repository === "string" ? context.repository : title;
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
      if (callId) {
        pendingStarts.set(callId, {
          name: typeof data.toolName === "string" ? data.toolName : undefined,
          args: data.arguments,
          intentionSummary: typeof data.intentionSummary === "string" ? data.intentionSummary : undefined,
          partialOutput: typeof data.partialOutput === "string" ? data.partialOutput : undefined,
          timestamp,
        });
      } else {
        // orphan start (no callId): emit a tool entry now so it isn't lost
        push(toolEntryFromStart(data, timestamp, type));
      }
      continue;
    }

    if (type === "tool.execution_complete") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const start = callId ? pendingStarts.get(callId) : undefined;
      if (callId) pendingStarts.delete(callId);
      const tool: ToolDetail = {
        callId,
        name: start?.name ?? (typeof data.toolName === "string" ? data.toolName : undefined),
        arguments: start?.args ?? data.arguments,
        intentionSummary: start?.intentionSummary ?? (typeof data.intentionSummary === "string" ? data.intentionSummary : undefined),
        partialOutput: start?.partialOutput,
        result: normaliseToolResult(data),
      };
      push({
        role: "tool",
        kind: "tool",
        title: tool.name,
        text: tool.result?.log ?? "",
        timestamp: start?.timestamp ?? timestamp,
        rawType: type,
        tool,
      });
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

    if (type === "error") {
      push({
        role: "event",
        kind: "error",
        text: stringOrEmpty(data.message ?? data.content ?? data.error),
        timestamp,
        rawType: type,
      });
      continue;
    }

    if (type === "warning") {
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

    if (type === "compaction") {
      push({
        role: "event",
        kind: "compaction",
        text: "Conversation compacted",
        timestamp,
        rawType: type,
        data,
      });
      continue;
    }

    if (type === "task_complete") {
      push({
        role: "event",
        kind: "task_complete",
        text: stringOrEmpty(data.content ?? data.summary),
        timestamp,
        rawType: type,
        data,
      });
      continue;
    }

    // Intentionally dropped: hook.*, assistant.turn_*, system.message
    // (system prompt is huge and noisy), session.model_change (we prefer
    // the session.info(infoType=model) text version).
  }

  // any leftover orphan starts (complete event never arrived) — show them as pending tools
  for (const [callId, start] of pendingStarts) {
    push({
      role: "tool",
      kind: "tool",
      title: start.name,
      text: "",
      timestamp: start.timestamp,
      rawType: "tool.execution_start",
      tool: {
        callId,
        name: start.name,
        arguments: start.args,
        intentionSummary: start.intentionSummary,
        partialOutput: start.partialOutput,
        result: { type: "pending" },
      },
    });
  }

  return {
    ...ref,
    startedAt,
    updatedAt: entries.at(-1)?.timestamp,
    cwd,
    title,
    entries,
  };
}

function stringOrEmpty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return contentToText(value);
}

function toolEntryFromStart(data: Record<string, unknown>, timestamp: string | undefined, rawType: string): Omit<TimelineEntry, "index"> {
  const name = typeof data.toolName === "string" ? data.toolName : undefined;
  return {
    role: "tool",
    kind: "tool",
    title: name,
    text: "",
    timestamp,
    rawType,
    tool: {
      name,
      arguments: data.arguments,
      intentionSummary: typeof data.intentionSummary === "string" ? data.intentionSummary : undefined,
      result: { type: "pending" },
    },
  };
}

function normaliseToolResult(data: Record<string, unknown>): ToolDetail["result"] {
  const success = data.success !== false;
  if (!success && typeof data.error === "string") {
    return { type: "failure", log: data.error };
  }
  const raw = data.result;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    let log: string | undefined;
    const content = obj.content;
    if (typeof content === "string") {
      log = content;
    } else if (Array.isArray(content)) {
      log = content.map((chunk) => {
        if (chunk && typeof chunk === "object" && "text" in chunk && typeof (chunk as { text?: unknown }).text === "string") {
          return (chunk as { text: string }).text;
        }
        return contentToText(chunk);
      }).join("\n");
    } else if (Object.keys(obj).length > 0) {
      log = contentToText(obj);
    }
    return {
      type: success ? "success" : "failure",
      log,
      markdown: obj.markdown === true,
    };
  }
  if (typeof raw === "string") {
    return { type: success ? "success" : "failure", log: raw };
  }
  return { type: success ? "success" : "pending" };
}

export function copilotRoots(root?: string): string {
  return root ?? join("~", ".copilot", "session-state");
}
