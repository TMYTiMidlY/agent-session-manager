import { basename } from "node:path";
import type { ParsedSession, ParseDiagnostics, SessionRef, TimelineEntry, ToolDetail } from "../types.js";
import { contentToText, stringifyCompact } from "../text.js";
import { expandHome, iterateJsonl, walkFiles } from "../fs.js";
import { documentFromParsed } from "../normalized.js";
import { extractCodexMetadata, type CodexRow } from "./codex-metadata.js";

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

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/**
 * Split a message content array into native blocks: text-bearing blocks
 * join the entry text; image/audio/unknown blocks are preserved raw in
 * `data.blocks` — never flattened into text and never given fabricated
 * content.
 */
function messageContent(content: unknown): { text: string; blocks?: unknown[] } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: contentToText(content) };
  const texts: string[] = [];
  const blocks: unknown[] = [];
  for (const item of content) {
    const itemRecord = record(item);
    const text = str(itemRecord.text);
    if (text !== undefined) {
      texts.push(text);
      continue;
    }
    if (Object.keys(itemRecord).length > 0) blocks.push(item); // native block (image/unknown)
    else texts.push(stringifyCompact(item)); // primitive fragment
  }
  return { text: texts.join("\n\n"), ...(blocks.length > 0 ? { blocks } : {}) };
}

/** Tool-call-shaped response items (function_call, custom_tool_call, …). */
function isToolCall(itemType: string): boolean {
  return itemType.endsWith("_call");
}

/** Tool-result-shaped response items, paired to their call by call_id. */
function isToolOutput(itemType: string): boolean {
  return itemType.endsWith("_output");
}

function toolDetail(payload: Record<string, unknown>): ToolDetail {
  const tool: ToolDetail = {};
  const callId = str(payload.call_id) ?? str(payload.id);
  if (callId !== undefined) tool.callId = callId;
  const name = str(payload.name);
  if (name !== undefined) tool.name = name;
  // Arguments stay exactly as recorded (function_call.arguments is a raw
  // JSON string by design; custom_tool_call.input is the model's raw input).
  const args = payload.arguments !== undefined ? payload.arguments : payload.input;
  if (args !== undefined) tool.arguments = args;
  return tool;
}

export async function parseCodex(ref: SessionRef): Promise<ParsedSession> {
  // Row-numbered scan: bad lines surface as bounded diagnostics while good
  // rows after them keep parsing (fs yields a parse_error sentinel per bad
  // line and never stops the stream).
  const rows: CodexRow[] = [];
  let rowNumber = 0;
  let badRows = 0;
  let firstBadRow: number | undefined;
  for await (const value of iterateJsonl(ref.path)) {
    rowNumber += 1;
    const rowRecord = record(value);
    const bad = rowRecord.type === "parse_error" && typeof rowRecord.text === "string";
    if (bad) {
      badRows++;
      firstBadRow ??= rowNumber;
      rows.push({ row: rowNumber, value: null, bad: true });
      continue;
    }
    const ordinal = typeof rowRecord.ordinal === "number" && Number.isSafeInteger(rowRecord.ordinal)
      ? rowRecord.ordinal
      : undefined;
    rows.push({ row: rowNumber, ordinal, value: rowRecord });
  }

  const metadata = extractCodexMetadata(rows, ref.id);

  const entries: TimelineEntry[] = [];
  const pendingTools = new Map<string, TimelineEntry>();
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let cwd = ref.cwd;
  let title = ref.title;
  let handled = 0;
  let ignored = 0;
  const unknownTypes = new Set<string>();

  for (const { value } of rows) {
    if (value === null) continue; // bad row, counted above
    const event = value as Record<string, unknown>;
    const type = str(event.type) ?? "event";
    const payload = record(event.payload);
    const timestamp = str(event.timestamp);
    startedAt ??= timestamp;
    updatedAt = timestamp ?? updatedAt;

    if (type === "session_meta" || type === "turn_context") {
      cwd = str(payload.cwd) ?? cwd;
      if (type === "session_meta") {
        startedAt = str(payload.timestamp) ?? startedAt;
        title = str(payload.cwd) ?? title;
      }
      handled++;
      continue;
    }
    if (type === "token_usage_record") {
      // Usage-ledger channel — no timeline entry (raw row retained in source).
      handled++;
      continue;
    }
    if (type === "compacted") {
      // CompactedItem.message is a plain string; anything else stays opaque.
      entries.push({
        index: entries.length,
        role: "assistant",
        kind: "compacted",
        text: str(payload.message) ?? "",
        timestamp,
        rawType: type,
      });
      handled++;
      continue;
    }
    if (type === "event_msg") {
      const eventType = str(payload.type) ?? "event";
      if (eventType === "token_count") {
        // Cumulative-snapshot channel — no timeline entry.
        handled++;
        continue;
      }
      if (eventType.includes("error") || eventType.includes("review") || eventType.includes("task")) {
        // The payload is unknown-shape JSON that can embed private context —
        // it is never stringified into searchable text. The opaque object
        // rides data.native into the block's native raw slot and stays out
        // of the visible entries projection; text stays empty rather than
        // fabricated.
        entries.push({
          index: entries.length,
          role: "event",
          kind: eventType,
          text: "",
          timestamp,
          rawType: type,
          ...(Object.keys(payload).length > 0 ? { data: { native: payload } } : {}),
        });
        handled++;
        continue;
      }
      ignored++;
      continue;
    }
    if (type !== "response_item") {
      if (type !== "parse_error") unknownTypes.add(type);
      continue;
    }

    const itemType = str(payload.type) ?? "item";
    if (itemType === "message") {
      const role = str(payload.role) ?? "event";
      if (role !== "user" && role !== "assistant") {
        ignored++;
        continue;
      }
      const { text, blocks } = messageContent(payload.content);
      entries.push({
        index: entries.length,
        role,
        kind: "message",
        text,
        timestamp,
        rawType: `${type}/${itemType}/${role}`,
        ...(blocks !== undefined ? { data: { blocks } } : {}),
      });
      handled++;
    } else if (itemType.includes("reasoning")) {
      entries.push({
        index: entries.length,
        role: "reasoning",
        kind: itemType,
        text: contentToText(payload.summary ?? payload.content ?? payload),
        timestamp,
        rawType: `${type}/${itemType}`,
      });
      handled++;
    } else if (isToolOutput(itemType)) {
      // Result side of a call↔output pair: associated through the shared
      // call_id. Output content is preserved verbatim; Codex rollouts record
      // no success/failure flag, so no result status is fabricated.
      const output = payload.output;
      const text = typeof output === "string" ? output : stringifyCompact(output);
      const tool = toolDetail(payload);
      const entry: TimelineEntry = {
        index: entries.length,
        role: "tool",
        kind: itemType,
        text,
        timestamp,
        rawType: `${type}/${itemType}`,
        ...(Object.keys(tool).length > 0 ? { tool } : {}),
      };
      entries.push(entry);
      const callId = tool.callId;
      if (callId !== undefined) pendingTools.delete(callId);
      handled++;
    } else if (isToolCall(itemType)) {
      const tool = toolDetail(payload);
      const entry: TimelineEntry = {
        index: entries.length,
        role: "tool",
        kind: itemType,
        title: tool.name,
        text: stringifyCompact(payload),
        timestamp,
        rawType: `${type}/${itemType}`,
        ...(Object.keys(tool).length > 0 ? { tool } : {}),
      };
      entries.push(entry);
      if (tool.callId !== undefined) pendingTools.set(tool.callId, entry);
      handled++;
    } else {
      unknownTypes.add(`${type}/${itemType}`);
    }
  }
  // Calls whose output never arrived stay as-is (pending pairing is lossless:
  // both sides keep the native payload and call_id).

  const diagnostics: ParseDiagnostics = {
    handled,
    ignored,
    unknown: unknownTypes.size,
    unknownTypes: [...unknownTypes].sort(),
    unknownTypesTruncated: false,
    ...(badRows > 0
      ? {
          issues: [
            ...(metadata.issues),
            {
              code: "codex/bad-row",
              message: "unparseable JSONL row(s) skipped; subsequent rows still parsed (payload never echoed)",
              row: firstBadRow,
              count: badRows,
            },
          ],
        }
      : { issues: metadata.issues }),
  };

  const parsed: ParsedSession = {
    ...ref,
    startedAt,
    updatedAt,
    cwd,
    title,
    ...(metadata.git?.repository !== undefined ? { repository: metadata.git.repository } : {}),
    ...(metadata.git?.branch !== undefined ? { branch: metadata.git.branch } : {}),
    entries,
    diagnostics,
  };
  // Native document: blocks are the entries projection; the usage ledger and
  // session-graph identity come from the verified Codex extraction.
  const document = documentFromParsed(parsed, { identity: metadata.identity, usage: metadata.usage });
  return { ...parsed, document };
}
