import { basename } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry } from "../types.js";
import { contentToText, stringifyCompact } from "../text.js";
import { expandHome, readJsonl, walkFiles } from "../fs.js";

const DEFAULT_ROOT = "~/.claude/projects";

export async function discoverClaude(root = DEFAULT_ROOT): Promise<SessionRef[]> {
  const files = await walkFiles(expandHome(root), (path) => path.endsWith(".jsonl"));
  return files.map((path) => ({
    agent: "claude",
    id: basename(path).replace(/\.jsonl$/, ""),
    path,
  }));
}

export async function parseClaude(ref: SessionRef): Promise<ParsedSession> {
  const rows = await readJsonl(ref.path);
  const entries: TimelineEntry[] = [];
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let title = ref.title;
  let cwd = ref.cwd;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = row as Record<string, unknown>;
    const type = String(event.type ?? "event");
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    startedAt ??= timestamp;
    updatedAt = timestamp ?? updatedAt;

    if (type === "ai-title" && typeof event.title === "string") {
      title = event.title;
      continue;
    }
    if (typeof event.cwd === "string") cwd = event.cwd;

    if (type === "user" || type === "assistant") {
      const message = (event.message ?? {}) as Record<string, unknown>;
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const record = (part ?? {}) as Record<string, unknown>;
          const partType = String(record.type ?? "item");
          entries.push({
            index: entries.length,
            role: mapClaudeRole(type, partType),
            kind: partType,
            title: typeof record.name === "string" ? record.name : undefined,
            text: contentToText([record]),
            timestamp,
            rawType: `${type}/${partType}`,
          });
        }
      } else {
        entries.push({
          index: entries.length,
          role: type,
          kind: "text",
          text: contentToText(content),
          timestamp,
          rawType: type,
        });
      }
    } else if (type === "system") {
      entries.push({
        index: entries.length,
        role: "system",
        kind: "system",
        text: contentToText(event.content ?? event.message ?? event),
        timestamp,
        rawType: type,
      });
    }
  }

  return { ...ref, startedAt, updatedAt, cwd, title, entries };
}

function mapClaudeRole(topLevel: string, partType: string): TimelineEntry["role"] {
  if (partType === "tool_use" || partType === "tool_result") return "tool";
  if (partType === "thinking") return "reasoning";
  return topLevel === "assistant" ? "assistant" : "user";
}
