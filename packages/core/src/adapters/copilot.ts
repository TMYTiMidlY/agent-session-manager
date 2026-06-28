import { basename, dirname, join } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry } from "../types.js";
import { contentToText, stringifyCompact } from "../text.js";
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
      entries.push({
        index: entries.length,
        role: "user",
        kind: "message",
        text: String(data.content ?? data.transformedContent ?? ""),
        timestamp,
        rawType: type,
      });
    } else if (type === "assistant.message") {
      const content = String(data.content ?? "");
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      const toolText = toolRequests.length > 0 ? `\n\n[tool requests]\n${stringifyCompact(toolRequests)}` : "";
      entries.push({
        index: entries.length,
        role: "assistant",
        kind: "message",
        text: `${content}${toolText}`.trim(),
        timestamp,
        rawType: type,
      });
    } else if (type === "tool.execution_start") {
      entries.push({
        index: entries.length,
        role: "tool",
        kind: `tool:start:${String(data.toolName ?? "unknown")}`,
        text: stringifyCompact(data.arguments),
        timestamp,
        rawType: type,
      });
    } else if (type === "tool.execution_complete") {
      const result = (data.result ?? {}) as Record<string, unknown>;
      entries.push({
        index: entries.length,
        role: "tool",
        kind: "tool:complete",
        text: contentToText(result.detailedContent ?? result.content ?? result),
        timestamp,
        rawType: type,
      });
    } else if (type.includes("reasoning")) {
      entries.push({
        index: entries.length,
        role: "reasoning",
        kind: type,
        text: stringifyCompact(data),
        timestamp,
        rawType: type,
      });
    }
  }

  return { ...ref, startedAt, updatedAt: entries.at(-1)?.timestamp, cwd, title, entries };
}

export function copilotRoots(root?: string): string {
  return root ?? join("~", ".copilot", "session-state");
}
