import { basename } from "node:path";
import type { ParsedSession, ParseDiagnostics, SessionRef, TimelineEntry, UsageRecord } from "../types.js";
import { contentToText } from "../text.js";
import { expandHome, readJsonl, walkFiles } from "../fs.js";
import { documentFromParsed } from "../normalized.js";

const DEFAULT_ROOT = "~/.claude/projects";

/**
 * Claude Code native accounting semantics (messages API):
 * - `message.usage.input_tokens` is the UNCACHED input count; cached input is
 *   reported separately as `cache_read_input_tokens` /
 *   `cache_creation_input_tokens` (disjoint buckets, billed input = sum of 3).
 * - One assistant API response = one `message.id`; a message split across
 *   multiple content blocks is metered once, not per block.
 * - Rows sharing a message id but carrying DIFFERENT uuids are independent
 *   partial content rows, not cumulative arrays: each row contributes its NEW
 *   native blocks (identity-keyed, never skipped by index), and blocks already
 *   seen for that id are never re-emitted. A replayed uuid with an identical
 *   payload is a byte-identical copy (skipped whole); a replayed uuid with a
 *   DIFFERENT payload is never silently dropped.
 * - Usage snapshots for one message id are last-wins: a later valid snapshot
 *   replaces the earlier record's contribution (counted=false, raw kept); a
 *   row with missing usage never blocks a later valid one.
 */
interface MessageProgress {
  seenBlocks: Set<string>;
  usage?: UsageRecord;
}

function hashRow(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  // Two independent 32-bit FNV-style lanes: 64 effective bits make a cross-row
  // collision (which would silently drop a different-payload replay) negligible.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a ^= code; a = Math.imul(a, 0x01000193) >>> 0;
    b ^= (code + i) & 0xff; b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(36)}-${b.toString(36)}`;
}

/**
 * Stable identity of one native content block within a message id: same-id
 * rows with different uuids are INDEPENDENT partial blocks, so identity is
 * payload-based (tool_use additionally by provider id) — a block already seen
 * for the id is a re-emission and is deduped, while any new payload (whatever
 * its row position) is emitted.
 */
function blockKey(record: Record<string, unknown>): string {
  if (record.type === "tool_use" && typeof record.id === "string") return `tool_use:${record.id}`;
  return `block:${JSON.stringify(record)}`;
}

function sameMetrics(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

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
  const usageLedger: UsageRecord[] = [];
  const uuidHashes = new Map<string, string>();
  const progressById = new Map<string, MessageProgress>();
  const diagnosticCounts = { handled: 0, ignored: 0, unknown: 0 };
  const issues: NonNullable<ParseDiagnostics["issues"]> = [];
  const countIssue = (code: string, message: string, count: number): void => {
    const existing = issues.find((issue) => issue.code === code);
    if (existing) existing.count += count;
    else issues.push({ code, message, count });
  };
  let badJsonRows = 0;
  let replayedUuidConflicts = 0;
  let sidechainRows = 0;
  let mainchainRows = 0;
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let title = ref.title;
  let cwd = ref.cwd;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = row as Record<string, unknown>;
    const type = String(event.type ?? "event");
    if (type === "parse_error") {
      // fs.ts marks unparseable JSONL lines; count them instead of skipping silently.
      badJsonRows++;
      continue;
    }
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    startedAt ??= timestamp;
    updatedAt = timestamp ?? updatedAt;

    if (type === "ai-title" && typeof event.title === "string") {
      title = event.title;
      continue;
    }
    if (typeof event.cwd === "string") cwd = event.cwd;
    if (event.isSidechain === true) sidechainRows++;
    else if (type === "user" || type === "assistant") mainchainRows++;

    if (type === "user" || type === "assistant") {
      // A replayed uuid with an identical payload is a byte-identical copy:
      // skip it whole. A replayed uuid with a DIFFERENT payload must not be
      // silently dropped — it flows through with a diagnostic.
      if (typeof event.uuid === "string" && event.uuid) {
        const hash = hashRow(event);
        const previous = uuidHashes.get(event.uuid);
        if (previous === hash) continue;
        if (previous !== undefined) {
          replayedUuidConflicts++;
          countIssue("replayed-uuid-conflict",
            `uuid 以不同 payload 再次出现，未静默丢弃，按新增内容处理`, 1);
        }
        uuidHashes.set(event.uuid, hash);
      }
      const message = (event.message ?? {}) as Record<string, unknown>;
      const content = message.content;
      const messageId = typeof message.id === "string" && message.id ? message.id : undefined;
      const model = typeof message.model === "string" && message.model ? message.model : undefined;
      const progress = messageId !== undefined
        ? progressById.get(messageId) ?? { seenBlocks: new Set<string>() }
        : undefined;
      if (messageId !== undefined && !progressById.has(messageId)) progressById.set(messageId, progress!);

      // Usage snapshots are last-wins per message id: the final metering of a
      // streamed response replaces the earlier partial snapshot's contribution.
      let usage: UsageRecord | undefined;
      if (type === "assistant") {
        const read = readClaudeUsage(message.usage, messageId, model, timestamp);
        if (read) {
          usage = { ...read, id: `u${usageLedger.length}` };
          const previous = progress?.usage;
          if (previous) {
            if (sameMetrics(previous.metrics as Record<string, number>, usage.metrics as Record<string, number>)) {
              usage.counted = false;
              usage.provenance!.metering!.note = "同 message.id 等值 usage 快照重复观测，不计入";
            } else {
              previous.counted = false;
              previous.provenance!.metering!.note = "同 message.id 后续 usage 快照替换（流式 output 更新），保留原始观测不计入";
              usage.provenance!.metering!.note = "替换同 message.id 先前 usage 快照（last-wins）";
            }
          }
          usageLedger.push(usage);
          if (progress) progress.usage = usage;
        }
        // A row WITHOUT usage never marks the message metered: a later valid
        // snapshot on the same id still replaces nothing and counts.
      }

      if (Array.isArray(content)) {
        let firstEntryOfRow = true;
        for (let partIndex = 0; partIndex < content.length; partIndex++) {
          const record = (content[partIndex] ?? {}) as Record<string, unknown>;
          const partType = String(record.type ?? "item");
          // A row for an already-seen message id contributes only its NEW
          // native blocks — keyed by block identity, never by array index,
          // so later single-part reasoning/text/tool rows are never dropped.
          if (progress) {
            const key = blockKey(record);
            if (progress.seenBlocks.has(key)) continue;
            progress.seenBlocks.add(key);
          }
          const native = nativeBlock(record);
          const tool = claudeToolDetail(record);
          entries.push({
            index: entries.length,
            role: mapClaudeRole(type, partType),
            kind: partType,
            title: typeof record.name === "string" ? record.name : undefined,
            text: contentToText([record]),
            timestamp,
            rawType: `${type}/${partType}`,
            ...(tool !== undefined ? { tool } : {}),
            ...(native !== undefined || (usage && firstEntryOfRow) || type === "user" || event.isSidechain === true ? {
              data: {
                ...(messageId !== undefined ? { messageId } : {}),
                ...(model !== undefined ? { model } : {}),
                // The tool pairing crosses the user-role boundary: record the
                // original row role so the boundary stays auditable.
                sourceRole: type,
                ...(event.isSidechain === true ? { isSidechain: true } : {}),
                ...(native !== undefined ? { native: [native] } : {}),
                ...(usage && firstEntryOfRow ? { usage } : {}),
              },
            } : {}),
          });
          firstEntryOfRow = false;
        }
      } else {
        entries.push({
          index: entries.length,
          role: type,
          kind: "text",
          text: contentToText(content),
          timestamp,
          rawType: type,
          ...(usage ? { data: { ...(messageId !== undefined ? { messageId } : {}), ...(model !== undefined ? { model } : {}), usage } } : {}),
        });
      }
      diagnosticCounts.handled++;
    } else if (type === "system") {
      entries.push({
        index: entries.length,
        role: "system",
        kind: "system",
        text: contentToText(event.content ?? event.message ?? event),
        timestamp,
        rawType: type,
      });
      diagnosticCounts.handled++;
    } else {
      diagnosticCounts.ignored++;
    }
  }

  if (badJsonRows > 0) {
    countIssue("invalid-json-row", `损坏的 JSON 记录已省略（${badJsonRows} 行）`, badJsonRows);
  }

  // Session role comes from the sidechain's own original field, not a hardcoded
  // main: a transcript whose only message rows are sidechain rows is a subagent
  // session; a mixed transcript stays main with the sidechain count preserved.
  const identity = sidechainRows > 0
    ? (mainchainRows > 0
        ? { role: "main" as const, raw: { sidechainRows } }
        : { role: "subagent" as const, raw: { sidechainRows } })
    : { role: "main" as const };
  const warning = [
    ...(badJsonRows > 0 ? [`来源含 ${badJsonRows} 行损坏的 JSON 记录，已省略`] : []),
    ...(replayedUuidConflicts > 0 ? [`${replayedUuidConflicts} 个 uuid 以不同 payload 重放，已按新增内容处理`] : []),
  ].join("；") || undefined;

  const diagnostics: ParseDiagnostics = {
    ...diagnosticCounts,
    unknownTypes: [],
    ...(issues.length ? { issues } : {}),
  };
  const result: ParsedSession = {
    ...ref, startedAt, updatedAt, cwd, title, entries, diagnostics, identity,
    ...(warning !== undefined
      ? { source: { kind: "events" as const, path: ref.path, lossy: true, warning } }
      : {}),
  };
  return { ...result, document: documentFromParsed(result, { identity, usage: usageLedger }) };
}

function mapClaudeRole(topLevel: string, partType: string): TimelineEntry["role"] {
  if (partType === "tool_use" || partType === "tool_result") return "tool";
  if (partType === "thinking") return "reasoning";
  return topLevel === "assistant" ? "assistant" : "user";
}

/** Verified usage fields only (messages API); anything else stays unknown, never zero. */
function readClaudeUsage(value: unknown, responseId: string | undefined, model: string | undefined,
  timestamp: string | undefined): Omit<UsageRecord, "id"> | undefined {
  const usage = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const metrics: Record<string, number> = {};
  const fields = { input_tokens: "inputTokens", cache_read_input_tokens: "cacheReadTokens",
    cache_creation_input_tokens: "cacheWriteTokens", output_tokens: "outputTokens" } as const;
  for (const [wire, local] of Object.entries(fields)) {
    const raw = usage[wire];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return undefined;
    metrics[local] = raw;
  }
  if (!Object.keys(metrics).length) return undefined;
  return {
    ...(responseId !== undefined ? { responseId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    cumulative: false,
    metrics,
    ...(model !== undefined ? { model } : {}),
    provenance: { agent: "claude", rawType: "assistant", metering: { source: "Claude message.usage（单次响应增量，桶不交叉；同 message.id 快照 last-wins）" } },
  };
}

/** Structured block facts without private payloads (base64 media data is never copied). */
function nativeBlock(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = record.type;
  if (type === "tool_use") {
    return { type, id: record.id, name: record.name };
  }
  if (type === "tool_result") {
    return { type, toolUseId: record.tool_use_id, isError: record.is_error === true };
  }
  if (type === "image" || type === "document") {
    const source = record.source !== null && typeof record.source === "object" && !Array.isArray(record.source)
      ? record.source as Record<string, unknown> : {};
    return { type, mediaType: source.type === "base64" ? source.media_type : source.type };
  }
  return undefined;
}

/** Pair tool_use arguments and tool_result outcomes by their provider ids. */
function claudeToolDetail(record: Record<string, unknown>): TimelineEntry["tool"] {
  if (record.type === "tool_use" && typeof record.id === "string" && typeof record.name === "string") {
    return { callId: record.id, name: record.name, arguments: record.input, result: { type: "pending" } };
  }
  if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
    return { callId: record.tool_use_id,
      result: { type: record.is_error === true ? "failure" : "success", log: contentToText(record.content) } };
  }
  return undefined;
}
