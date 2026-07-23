import { basename } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry } from "../types.js";
import { contentToText, stringifyCompact } from "../text.js";
import { expandHome, readJsonl, walkFiles } from "../fs.js";

const DEFAULT_ROOT = "~/.codex/sessions";

export async function discoverCodex(root = DEFAULT_ROOT): Promise<SessionRef[]> {
  const files = await walkFiles(expandHome(root), (path) => path.endsWith(".jsonl"));
  return files.map((path) => {
    const name = basename(path).replace(/\.jsonl$/, "");
    const match = name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
    return {
      agent: "codex",
      id: match?.[1] ?? name,
      path,
    };
  });
}

export async function parseCodex(ref: SessionRef): Promise<ParsedSession> {
  const rows = await readJsonl(ref.path);
  const entries: TimelineEntry[] = [];
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let cwd = ref.cwd;
  let title = ref.title;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = row as Record<string, unknown>;
    const type = String(event.type ?? "event");
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    startedAt ??= timestamp;
    updatedAt = timestamp ?? updatedAt;

    if (type === "session_meta") {
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      startedAt = typeof payload.timestamp === "string" ? payload.timestamp : startedAt;
      title = typeof payload.cwd === "string" ? payload.cwd : title;
      continue;
    }
    if (type === "turn_context") {
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      continue;
    }
    if (type === "compacted") {
      entries.push({
        index: entries.length,
        role: "assistant",
        kind: "compacted",
        text: String(payload.message ?? ""),
        timestamp,
        rawType: type,
      });
      continue;
    }
    if (type === "event_msg") {
      const eventType = String(payload.type ?? "event");
      if (eventType.includes("error") || eventType.includes("review") || eventType.includes("task")) {
        entries.push({
          index: entries.length,
          role: "event",
          kind: eventType,
          text: stringifyCompact(payload),
          timestamp,
          rawType: type,
        });
      }
      continue;
    }
    if (type !== "response_item") continue;

    const itemType = String(payload.type ?? "item");
    if (itemType === "message") {
      const role = String(payload.role ?? "event");
      if (role !== "user" && role !== "assistant") continue;
      entries.push({
        index: entries.length,
        role,
        kind: "message",
        text: contentToText(payload.content),
        timestamp,
        rawType: `${type}/${itemType}/${role}`,
      });
    } else if (itemType.includes("reasoning")) {
      entries.push({
        index: entries.length,
        role: "reasoning",
        kind: itemType,
        text: contentToText(payload.summary ?? payload.content ?? payload),
        timestamp,
        rawType: `${type}/${itemType}`,
      });
    } else if (itemType.includes("call") || itemType.includes("tool")) {
      entries.push({
        index: entries.length,
        role: "tool",
        kind: itemType,
        title: typeof payload.name === "string" ? payload.name : undefined,
        text: stringifyCompact(payload),
        timestamp,
        rawType: `${type}/${itemType}`,
      });
    }
  }

  return { ...ref, startedAt, updatedAt, cwd, title, entries };
}
