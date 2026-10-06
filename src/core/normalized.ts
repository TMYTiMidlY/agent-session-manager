import type {
  AgentKind, BlockProvenance, MessageBlock, MessageBlockType, NormalizedEvent,
  ParsedSession, SessionDocument, SessionIdentity, SessionRef, SessionStats,
  TimelineEntry, TimelineRole, UsageMetrics, UsageRecord,
} from "./types.js";
import { sessionReference } from "./session-metadata.js";

export const SESSION_DOCUMENT_FORMAT = "asmgr.session-document" as const;
export const SESSION_DOCUMENT_VERSION = 1 as const;
export const DSH_FORMAT_BASIS = {
  harness: "dsh", formatVersion: 4,
  commit: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
} as const;

interface Supplement { identity?: Partial<SessionIdentity>; usage: UsageRecord[] }

function blockType(entry: TimelineEntry): MessageBlockType {
  if (entry.tool) return entry.tool.arguments === undefined && /result|output/.test(entry.rawType ?? entry.kind) ? "tool-result" : "tool-call";
  if (entry.role === "reasoning") return "reasoning";
  if (entry.kind === "image" || entry.kind === "file") return entry.kind;
  if (["user", "assistant", "system"].includes(entry.role)) return "text";
  return "unknown";
}

function blockFromEntry(agent: AgentKind, entry: TimelineEntry): MessageBlock {
  const { index, ...fields } = entry;
  const provenance: BlockProvenance = { agent, rawType: entry.rawType };
  const block: MessageBlock = { id: `b${index}`, type: blockType(entry), ...fields, provenance };
  const native = entry.data?.native ?? entry.data?.nativeBlocks ?? entry.data?.blocks;
  if (native !== undefined) block.native = native;
  return block;
}

function entryFromBlock(block: MessageBlock, index: number): TimelineEntry {
  const entry: TimelineEntry = { index, role: block.role, kind: block.kind, text: block.text };
  for (const key of ["timestamp", "title", "rawType", "tool", "detail"] as const) {
    if (block[key] !== undefined) Object.assign(entry, { [key]: block[key] });
  }
  if (block.data) {
    const { native: _native, nativeBlocks: _nativeBlocks, blocks: _blocks, rawSource: _rawSource, usage: _usage, ...visibleData } = block.data;
    if (Object.keys(visibleData).length) entry.data = visibleData;
  }
  return entry;
}

/** Assemble envelopes once after the source adapter finishes its native projection. */
export function finalizeDocument(document: SessionDocument): SessionDocument {
  const events: NormalizedEvent[] = [];
  const timeOf = (timestamp: string | undefined): number | undefined => {
    const time = timestamp === undefined ? NaN : Date.parse(timestamp);
    return Number.isFinite(time) ? time : undefined;
  };
  for (const block of document.blocks) {
    // Native carriers and ledger records have their own fields, not duplicate transcript metadata.
    if (block.data) {
      block.native ??= block.data.native ?? block.data.nativeBlocks ?? block.data.blocks ?? block.data.rawSource;
      const { native: _native, nativeBlocks: _nativeBlocks, blocks: _blocks, rawSource: _rawSource, usage: _usage, ...metadata } = block.data;
      block.data = Object.keys(metadata).length ? metadata : undefined;
    }
    events.push({ type: "message/append", seq: events.length,
      time: timeOf(block.timestamp), provenance: block.provenance, data: { block } });
  }
  for (const usage of document.usage) {
    events.push({ type: "usage/record", seq: events.length,
      time: timeOf(usage.timestamp), provenance: usage.provenance, data: { usage } });
  }
  document.basis = DSH_FORMAT_BASIS;
  document.events = events;
  return document;
}

/** One transcript projection; opaque source data and metering never become searchable text. */
export function projectEntries(document: SessionDocument): TimelineEntry[] {
  const blocks = document.events
    ? document.events.flatMap(event => event.type === "message/append" ? [event.data.block] : [])
    : document.blocks;
  return blocks.map((block, index) => entryFromBlock(block, block.timelineIndex ?? index));
}

/** Filter all transcript carriers together; do not leak excluded roles through raw mixed-role blocks. */
export function filterDocumentRole(document: SessionDocument, role: TimelineRole): SessionDocument {
  const blocks = document.events
    ? document.events.flatMap(event => event.type === "message/append" ? [event.data.block] : []) : document.blocks;
  const filtered: SessionDocument = {
    ...document, view: { role, nativeContent: "omitted" },
    ref: { ...document.ref, identity: document.ref.identity ? { ...document.ref.identity, raw: undefined } : undefined },
    identity: { ...document.identity, raw: undefined },
    blocks: blocks.flatMap((block, index) => block.role === role ? [{ ...block, timelineIndex: block.timelineIndex ?? index, native: undefined }] : []),
    usage: document.usage.map(usage => ({ ...usage, raw: undefined,
      context: usage.context ? { ...usage.context, raw: undefined } : undefined,
      rateLimit: usage.rateLimit ? { ...usage.rateLimit, raw: undefined } : undefined,
    })),
  };
  return finalizeDocument(filtered);
}

/** Compatibility normalization; native adapters supply source blocks and ledger in one read. */
export function documentFromParsed(parsed: ParsedSession, supplement?: Supplement): SessionDocument {
  return {
    format: SESSION_DOCUMENT_FORMAT, version: SESSION_DOCUMENT_VERSION,
    ref: sessionReference(parsed), identity: { role: "unknown", ...parsed.identity, ...supplement?.identity },
    meta: { title: parsed.title, startedAt: parsed.startedAt, updatedAt: parsed.updatedAt,
      cwd: parsed.cwd, repository: parsed.repository, branch: parsed.branch },
    blocks: parsed.entries.map(entry => blockFromEntry(parsed.agent, entry)),
    usage: supplement?.usage ?? [],
  };
}

const METRICS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hasMetrics = (usage: UsageRecord) => METRICS.some(key => usage.metrics[key] !== undefined);

/** Responses and cumulative snapshots are alternative accounting evidence, never additive. */
export function computeStats(document: SessionDocument): SessionStats {
  const ledger = document.events
    ? document.events.flatMap(event => event.type === "usage/record" ? [event.data.usage] : [])
    : document.usage;
  const eligible = ledger.filter(usage => usage.counted !== false && !usage.inherited
    && (!usage.ownerSessionId || usage.ownerSessionId === document.ref.id)
    && usage.kind !== "context" && usage.kind !== "rate-limit" && hasMetrics(usage));
  const snapshots = eligible.filter(usage => usage.cumulative);
  const increments = eligible.filter(usage => !usage.cumulative);
  const seen = new Map<string, UsageRecord>();
  const conflicts = new Set<string>();
  let duplicates = 0;
  for (const usage of increments) {
    if (!usage.responseId) continue;
    const prior = seen.get(usage.responseId);
    if (prior) {
      duplicates++;
      if (METRICS.some(key => prior.metrics[key] !== usage.metrics[key])) conflicts.add(usage.responseId);
    } else seen.set(usage.responseId, usage);
  }
  const unique = dedupeUsage(increments).filter(usage => !usage.responseId || !conflicts.has(usage.responseId));
  // The last observed snapshot is a separate fallback for old logs without response records.
  const selected = increments.length ? unique : snapshots.slice(-1);
  const totals: UsageMetrics = {};
  let incomplete = !selected.length || conflicts.size > 0;
  for (const metric of METRICS) {
    const values = selected.map(usage => usage.metrics[metric]);
    if (!values.length || values.every(value => value === undefined)) continue;
    if (!values.every(count)) { incomplete = true; continue; }
    const sum = values.reduce((n, value) => n + value, 0);
    if (count(sum)) totals[metric] = sum;
    else incomplete = true;
  }
  if (selected.some(usage => !count(usage.metrics.inputTokens) || !count(usage.metrics.outputTokens))) incomplete = true;
  const last = ledger.filter(usage => usage.context?.contextWindow !== undefined).at(-1);
  return {
    totals, calls: unique.length, snapshots: snapshots.length, incomplete,
    accounting: increments.length ? "responses" : snapshots.length ? "latest-snapshot" : "unavailable",
    duplicateResponses: duplicates, conflictingResponses: conflicts.size,
    ...(last?.context ? { lastContext: { ...last.context, observedAt: last.timestamp } } : {}),
  };
}

export interface DocumentBuilder extends SessionDocument {
  addBlock(block: Omit<MessageBlock, "id"> & { id?: string }): MessageBlock;
  addUsage(usage: Omit<UsageRecord, "id"> & { id?: string }): UsageRecord;
  setIdentity(identity: Partial<SessionIdentity>): void;
  setMeta(meta: Partial<SessionDocument["meta"]>): void;
  build(): SessionDocument;
}

export function createDocumentBuilder(ref: SessionRef): DocumentBuilder {
  const document: SessionDocument = {
    format: SESSION_DOCUMENT_FORMAT, version: SESSION_DOCUMENT_VERSION, ref,
    identity: { role: "unknown", ...ref.identity }, meta: {}, blocks: [], usage: [],
  };
  return {
    ...document,
    addBlock(block) {
      const value = { ...block, id: block.id ?? `b${document.blocks.length}` };
      document.blocks.push(value); return value;
    },
    addUsage(usage) {
      const value = { ...usage, id: usage.id ?? `u${document.usage.length}` };
      document.usage.push(value); return value;
    },
    setIdentity(identity) { document.identity = { ...document.identity, ...identity }; },
    setMeta(meta) { document.meta = { ...document.meta, ...meta }; },
    build() { return document; },
  };
}

/** Response identity is scoped to its owner; equal counts alone are never a dedupe key. */
export function dedupeUsage(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  return records.filter(usage => {
    const category = usage.kind ?? (usage.cumulative ? "cumulative" : "response");
    const key = usage.responseId !== undefined
      ? `${category}:${usage.ownerSessionId ?? ""}:response:${usage.responseId}`
      : usage.provenance?.row !== undefined
        ? `${category}:row:${usage.provenance.agent}:${usage.provenance.rawType}:${usage.provenance.row}` : undefined;
    if (key === undefined) return true;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
