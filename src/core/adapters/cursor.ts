// Cursor Agent read-only session adapter.
//
// Source layout (closed format, reverse-engineered read-only; see
// docs/cursor-format.md): ~/.cursor/chats/<workspaceHash>/<agentUuid>/
// holds meta.json (schemaVersion 1 sidecar) and store.db — a self-contained
// content-addressed SQLite store with exactly two tables:
//   meta(key,value)  — one row key='0', value = hex(utf8(JSON)) with
//                      agentId/latestRootBlobId/name/createdAt/lastUsedModel/
//                      blobEncryptionKey
//   blobs(id,data)   — id = sha256(data) hex; data is either a full JSON
//                      AI-SDK-style message (first byte '{') or a protobuf
//                      envelope. Envelope field 1 (repeated, 32-byte) lists
//                      parent blob ids in message order; field 4 embeds a JSON
//                      message; field 9 carries the cwd as a file:// URI.
// The message order is reconstructed by walking the f1 reference chain from
// meta.latestRootBlobId in post-order (parents first; verified on the local
// stores: yields system,user,...,assistant,tool sequences). NEVER fall back
// to rowid order — that would mix dead/regenerated branches into the trunk.
//
// Fidelity contract (enforced below):
// - read-only everywhere: sqlite URI mode=ro + PRAGMA query_only; no writes,
//   no fabricated per-message timestamps (the source has none).
// - usage is unverified (envelope f5 semantics unproven): recorded as
//   structured diagnostics only, never as UsageMetrics — unknown stays
//   unknown, nothing is approximated into token counts.
// - unknown envelope fields / parts stay structured (block.data capsules),
//   never stringified into searchable text.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AgentKind,
  MessageBlock,
  ParsedSession,
  ParseIssue,
  SessionRef,
  SessionSource,
  ToolDetail,
  ToolResultKind,
} from "../types.js";
import { computeStats, createDocumentBuilder, projectEntries } from "../normalized.js";
import { expandHome, pathExists, readJson, walkFiles } from "../fs.js";
import { contentToText } from "../text.js";

/** Canonical source tags, shared with discovery and CLI aliases. */
export const CURSOR_AGENT: AgentKind = "cursor";
const CURSOR_SOURCE_KIND: SessionSource["kind"] = "cursor-store";

export const CURSOR_DEFAULT_ROOT = "~/.cursor/chats";

const CURSOR_LOSSY_WARNING =
  "cursor-store is a closed format read out read-only: per-message timestamps and request usage/cost are unavailable in the verified layout; "
  + "only the branch reachable from latestRootBlobId is reconstructed (edited/regenerated branches stay unreachable); "
  + "unverified envelope fields are counted in diagnostics, not guessed into content";

const MAX_VARINT_BYTES = 10;
const MAX_UNKNOWN_TYPE_SAMPLES = 10;
const MAX_ISSUE_SAMPLES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Explicit adapter failure. Codes: runtime-unsupported / store-missing / not-a-cursor-store. */
export class CursorAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CursorAdapterError";
  }
}

// ---------------------------------------------------------------------------
// Read-only SQLite access (node:sqlite preferred; bun:sqlite fallback).
// ---------------------------------------------------------------------------

interface RoStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface RoDatabase {
  prepare(sql: string): RoStatement;
  exec(sql: string): unknown;
  close(): void;
}

function wrapDatabase(db: unknown): RoDatabase {
  const native = db as {
    prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
    exec(sql: string): unknown;
    close(): void;
  };
  return {
    prepare: (sql) => ({
      all: (...params) => native.prepare(sql).all(...params) as unknown[],
      get: (...params) => native.prepare(sql).get(...params),
    }),
    exec: (sql) => native.exec(sql),
    close: () => native.close(),
  };
}

async function openReadOnlyDatabase(path: string): Promise<RoDatabase> {
  let open: (() => unknown) | undefined;
  if (process.versions.bun) {
    const specifier = "bun:sqlite";
    try {
      const mod = (await import(specifier)) as { Database?: new (file: string, options: { readonly: boolean }) => unknown };
      if (mod.Database) { const Database = mod.Database; open = () => new Database(path, { readonly: true }); }
    } catch { /* An unavailable runtime is distinct from a broken source database. */ }
  } else {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      open = () => new DatabaseSync(`${pathToFileURL(path).href}?mode=ro`, { readOnly: true });
    } catch { /* Older Node releases do not provide node:sqlite. */ }
  }
  if (!open) throw new CursorAdapterError("runtime-unsupported", "Cursor requires Node node:sqlite or Bun bun:sqlite with read-only support");
  // Once a runtime is available, open/query failures describe the source, not missing capabilities.
  const db = wrapDatabase(open());
  try { db.exec("PRAGMA query_only = ON"); }
  catch (error) { db.close(); throw error; }
  return db;
}

async function withReadOnlyDatabase<T>(path: string, query: (db: RoDatabase) => T): Promise<T> {
  const db = await openReadOnlyDatabase(path);
  try {
    db.exec("BEGIN"); // One read snapshot for the root metadata and referenced blob graph.
    return query(db);
  } finally {
    try { db.exec("ROLLBACK"); } catch { /* Closing also releases an unfinished read transaction. */ }
    try {
      db.close();
    } catch {
      // A failed connection has nothing useful left to close.
    }
  }
}

// ---------------------------------------------------------------------------
// Store metadata + blob payloads
// ---------------------------------------------------------------------------

interface CursorStoreMeta {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string | null;
  blobEncryptionKey?: string;
}

interface CursorSidecar {
  schemaVersion?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  cwd?: string;
  hasConversation?: boolean;
  title?: string;
}

interface BlobRecord {
  rowid: number;
  id: string;
  data: Uint8Array;
}

function tableColumns(db: RoDatabase, table: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String((row as Record<string, unknown>).name)),
  );
}

/** A store counts as a Cursor chat store only with the exact meta/blobs schema. */
function isCursorStore(db: RoDatabase): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set(tables.map((row) => String((row as Record<string, unknown>).name)));
  if (!names.has("meta") || !names.has("blobs")) return false;
  const metaCols = tableColumns(db, "meta");
  const blobCols = tableColumns(db, "blobs");
  return metaCols.has("key") && metaCols.has("value") && blobCols.has("id") && blobCols.has("data");
}

function decodeStoreMeta(db: RoDatabase): { meta?: CursorStoreMeta; error?: string } {
  const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
  const value = row?.value;
  if (value === undefined) return { error: "meta row key='0' missing" };
  try {
    let text: string;
    if (typeof value === "string") {
      // Strict hex: Buffer.from(_, "hex") would otherwise silently skip bad
      // nibbles and mis-decode the metadata row.
      if (!/^(?:[0-9a-f]{2})+$/i.test(value)) {
        return { error: "meta row key='0' value is not a non-empty hex string" };
      }
      text = Buffer.from(value, "hex").toString("utf8");
    } else if (value instanceof Uint8Array) {
      text = new TextDecoder().decode(value);
    } else {
      return { error: "meta row key='0' value is neither hex text nor a blob" };
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "meta row key='0' is not a JSON object" };
    }
    // Same strict shape validation as the sidecar: only fields observed with
    // their declared type survive; object/array impostors never reach a ref.
    const record = parsed as Record<string, unknown>;
    const str = (key: keyof CursorStoreMeta): string | undefined => {
      const field = record[key];
      return typeof field === "string" && field.length > 0 ? field : undefined;
    };
    const meta: CursorStoreMeta = {};
    const agentId = str("agentId");
    const latestRootBlobId = str("latestRootBlobId");
    const name = str("name");
    const mode = str("mode");
    const blobEncryptionKey = str("blobEncryptionKey");
    if (agentId !== undefined) meta.agentId = agentId;
    if (latestRootBlobId !== undefined) meta.latestRootBlobId = latestRootBlobId;
    if (name !== undefined) meta.name = name;
    if (mode !== undefined) meta.mode = mode;
    if (blobEncryptionKey !== undefined) meta.blobEncryptionKey = blobEncryptionKey;
    if (typeof record.createdAt === "number" && Number.isFinite(record.createdAt)) meta.createdAt = record.createdAt;
    if (typeof record.lastUsedModel === "string") meta.lastUsedModel = record.lastUsedModel;
    return { meta };
  } catch {
    // JSON SyntaxError messages embed payload excerpts — never forward them.
    return { error: "meta row key='0' is not decodable as hex(utf8(JSON)); payload withheld" };
  }
}

function toUint8(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return undefined;
}

interface LoadedBlobs {
  records: BlobRecord[];
  /** Rowids of rows with a missing/non-string id, undecodable data or bad rowid — skipped, never silently. */
  invalidRowids: number[];
  /** Ids already seen before (possible only in PK-less corrupted tables), one entry per repeated row. */
  duplicateIds: string[];
}

function loadBlobs(db: RoDatabase): LoadedBlobs {
  const rows = db.prepare("SELECT rowid, id, data FROM blobs ORDER BY rowid").all();
  const records: BlobRecord[] = [];
  const seen = new Set<string>();
  const invalidRowids: number[] = [];
  const duplicateIds: string[] = [];
  for (const row of rows) {
    const record = row as { rowid?: unknown; id?: unknown; data?: unknown };
    const id = typeof record.id === "string" ? record.id : undefined;
    const data = toUint8(record.data);
    const rowid = Number(record.rowid);
    if (id === undefined || id.length === 0 || data === undefined || !Number.isSafeInteger(rowid)) {
      invalidRowids.push(Number.isSafeInteger(rowid) ? rowid : -1);
      continue;
    }
    if (seen.has(id)) duplicateIds.push(id);
    seen.add(id);
    records.push({ rowid, id, data });
  }
  return { records, invalidRowids, duplicateIds };
}

// ---------------------------------------------------------------------------
// Lenient protobuf envelope scanner (wire-format bounds enforced)
// ---------------------------------------------------------------------------

interface EnvelopeField {
  field: number;
  wire: number;
  bytes?: Uint8Array;
  value?: bigint;
}

interface BlobClassification {
  kind: "json" | "envelope" | "empty" | "unknown" | "bad-json";
  /** Full valid JSON message (JSON blob, or envelope f4 payload). */
  message?: Record<string, unknown>;
  /** f1 32-byte parent ids in stored order — the message-order backbone. */
  parents: string[];
  /** f9 decoded filesystem path. */
  cwd?: string;
  groupTruncated: boolean;
  malformed: boolean;
  unknownFields: number[];
  f5Count: number;
  invalidEmbeddedJson?: boolean;
}

function readVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } | undefined {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos + i >= buf.length) return undefined;
    const byte = buf[pos + i];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, next: pos + i + 1 };
    shift += 7n;
  }
  return undefined; // longer than 10 bytes: malformed varint
}

function scanEnvelope(data: Uint8Array): { fields: EnvelopeField[]; group: boolean; malformed: boolean } {
  const fields: EnvelopeField[] = [];
  let pos = 0;
  let group = false;
  let malformed = false;
  while (pos < data.length) {
    const tag = readVarint(data, pos);
    if (tag === undefined || tag.value === 0n) {
      malformed = true;
      break;
    }
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    const body = tag.next;
    if (field === 0) {
      malformed = true;
      break;
    }
    if (wire === 0) {
      const value = readVarint(data, body);
      if (value === undefined) {
        malformed = true;
        break;
      }
      fields.push({ field, wire, value: value.value });
      pos = value.next;
    } else if (wire === 1) {
      if (body + 8 > data.length) {
        malformed = true;
        break;
      }
      fields.push({ field, wire, bytes: data.subarray(body, body + 8) });
      pos = body + 8;
    } else if (wire === 2) {
      const lengthField = readVarint(data, body);
      if (lengthField === undefined) {
        malformed = true;
        break;
      }
      const length = Number(lengthField.value);
      if (!Number.isSafeInteger(length) || length < 0 || lengthField.next + length > data.length) {
        malformed = true;
        break;
      }
      fields.push({ field, wire, bytes: data.subarray(lengthField.next, lengthField.next + length) });
      pos = lengthField.next + length;
    } else if (wire === 5) {
      if (body + 4 > data.length) {
        malformed = true;
        break;
      }
      fields.push({ field, wire, bytes: data.subarray(body, body + 4) });
      pos = body + 4;
    } else if (wire === 3 || wire === 4) {
      // Legacy group (wt 3/4): semantics unknown — stop scanning this blob
      // (leading fields stay valid) and diagnose; never hard-scan for JSON
      // fragments inside the remainder.
      group = true;
      break;
    } else {
      malformed = true; // wire types 6/7 are invalid
      break;
    }
  }
  return { fields, group, malformed };
}

function parseFullJson(bytes: Uint8Array): Record<string, unknown> | undefined {
  // Complete-payload JSON only: no regex/substring salvage of message bodies.
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function classifyBlob(data: Uint8Array): BlobClassification {
  if (data.length === 0) {
    return { kind: "empty", parents: [], groupTruncated: false, malformed: false, unknownFields: [], f5Count: 0 };
  }
  if (data[0] === 0x7b /* '{' */) {
    const message = parseFullJson(data);
    return message !== undefined
      ? { kind: "json", message, parents: [], groupTruncated: false, malformed: false, unknownFields: [], f5Count: 0 }
      : { kind: "bad-json", parents: [], groupTruncated: false, malformed: false, unknownFields: [], f5Count: 0 };
  }
  const { fields, group, malformed } = scanEnvelope(data);
  const parents: string[] = [];
  const unknownFields = new Set<number>();
  let message: Record<string, unknown> | undefined;
  let cwd: string | undefined;
  let f5Count = 0;
  let invalidEmbeddedJson = false;
  for (const field of fields) {
    if (field.field === 1 && field.wire === 2 && field.bytes?.length === 32) {
      parents.push(Buffer.from(field.bytes).toString("hex"));
      continue;
    }
    if (field.field === 4 && field.wire === 2 && field.bytes !== undefined && message === undefined) {
      message = parseFullJson(field.bytes);
      if (!message) invalidEmbeddedJson = true;
      continue;
    }
    if (field.field === 9 && field.wire === 2 && field.bytes !== undefined && cwd === undefined) {
      const text = new TextDecoder().decode(field.bytes);
      if (text.startsWith("file://")) {
        try {
          cwd = fileURLToPath(text);
        } catch {
          cwd = undefined;
        }
      }
      continue;
    }
    if (field.field === 5) f5Count += 1;
    unknownFields.add(field.field);
  }
  // A payload with no recognized structure that also hit a wire-format
  // violation is opaque (possibly encrypted under meta.blobEncryptionKey).
  if (parents.length === 0 && message === undefined && cwd === undefined && malformed) {
    return { kind: "unknown", parents, groupTruncated: group, malformed, unknownFields: [...unknownFields], f5Count, invalidEmbeddedJson };
  }
  return { kind: "envelope", message, parents, cwd, groupTruncated: group, malformed, unknownFields: [...unknownFields], f5Count, invalidEmbeddedJson };
}

// ---------------------------------------------------------------------------
// Chain reconstruction: post-order DFS over f1 refs from latestRootBlobId.
// Parents are emitted before children; f1 order is preserved (verified on
// live stores: system,user,...,assistant,tool sequences). Cycles are cut with
// gray/black coloring; duplicate refs dedupe via black marking.
// ---------------------------------------------------------------------------

interface ChainResult {
  order: string[];
  cycles: string[];
  missing: string[];
}

/**
 * Post-order DFS over f1 refs from latestRootBlobId. Parents are emitted
 * before children; f1 order is preserved (verified on live stores:
 * system,user,...,assistant,tool sequences). Cycles are cut with gray/black
 * coloring; duplicate refs dedupe via black marking. Exported for direct
 * tests: a genuine cycle cannot exist among sha256-verified content-addressed
 * blobs, so the guard is only reachable through corrupted stores.
 */
export function linearizeCursorChain(rootId: string, parentsById: Map<string, string[]>): ChainResult {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const order: string[] = [];
  const cycles: string[] = [];
  const missing: string[] = [];
  if (!parentsById.has(rootId)) {
    missing.push(rootId);
    return { order, cycles, missing };
  }
  const parentsOf = (id: string): string[] => parentsById.get(id) ?? [];
  const stack: { id: string; parents: string[]; next: number }[] = [
    { id: rootId, parents: parentsOf(rootId), next: 0 },
  ];
  while (stack.length > 0 && order.length <= parentsById.size) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.parents.length) {
      const parentId = frame.parents[frame.next++];
      if (!parentsById.has(parentId)) {
        missing.push(parentId);
        continue;
      }
      const state = color.get(parentId) ?? WHITE;
      if (state === GRAY) {
        cycles.push(parentId);
        continue;
      }
      if (state === BLACK) continue; // shared ancestor: already emitted exactly once
      color.set(parentId, GRAY);
      stack.push({ id: parentId, parents: parentsOf(parentId), next: 0 });
    } else {
      stack.pop();
      color.set(frame.id, BLACK);
      order.push(frame.id);
    }
  }
  return { order, cycles, missing };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

class IssueLog {
  private readonly map = new Map<string, ParseIssue & { samples?: string[] }>();

  add(code: string, message: string, sample?: string): void {
    const existing = this.map.get(code);
    if (existing === undefined) {
      this.map.set(code, { code, message, count: 1, ...(sample !== undefined ? { samples: [sample] } : {}) });
      return;
    }
    existing.count += 1;
    if (sample !== undefined && (existing.samples?.length ?? 0) < MAX_ISSUE_SAMPLES) {
      existing.samples = [...(existing.samples ?? []), sample];
    }
  }

  list(): ParseIssue[] {
    return [...this.map.values()].map(({ samples, ...issue }) => {
      if (samples === undefined || samples.length === 0) return issue;
      return { ...issue, message: `${issue.message} (e.g. ${samples.join(", ")})` };
    });
  }
}

// ---------------------------------------------------------------------------
// Message → document blocks
// ---------------------------------------------------------------------------

interface BlockOrigin {
  blobId: string;
  rowid: number;
  via: "json" | "envelope-f4";
}

function providerOptionKeys(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cursor = (value as { cursor?: unknown }).cursor;
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const keys = Object.keys(cursor as Record<string, unknown>);
  return keys.length > 0 ? keys.sort() : undefined;
}

function isoFromMs(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function toolResultDetail(result: unknown): { type: ToolResultKind; log: string | undefined } {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (record.error !== undefined && record.error !== null) {
      return { type: "failure", log: contentToText(record.error) || undefined };
    }
    if (record.type === "error") {
      return { type: "failure", log: contentToText(result) || undefined };
    }
    if (typeof record.content === "string" && record.content.length > 0) {
      return { type: "success", log: record.content };
    }
  }
  // Cursor tool-results carry no explicit status; a present result means the
  // call completed without a recorded error.
  return { type: "success", log: result === undefined ? undefined : contentToText(result) || undefined };
}

interface EmitStats {
  handled: number;
  ignored: number;
  unknown: number;
  unknownTypes: Set<string>;
}

class CursorDocumentEmitter {
  private readonly builder;
  private readonly pendingTools = new Map<string, MessageBlock[]>();
  private toolCompletions = 0;

  constructor(
    ref: SessionRef,
    private readonly stats: EmitStats,
    private readonly issues: IssueLog,
  ) {
    this.builder = createDocumentBuilder(ref);
    // Cursor records no subagent graph: each agent uuid directory is one
    // self-contained conversation store, so the main role follows from the
    // session layout itself — nothing is guessed beyond that.
    this.builder.setIdentity({ role: "main" });
  }

  get blockCount(): number {
    return this.builder.blocks.length;
  }

  /** Tool completions since the last drain — a blob completing a pending call did work even without adding a block. */
  drainToolCompletions(): number {
    const count = this.toolCompletions;
    this.toolCompletions = 0;
    return count;
  }

  addSessionMeta(meta: { title?: string; startedAt?: string; updatedAt?: string; cwd?: string }): void {
    this.builder.setMeta(meta);
  }

  emitMessage(message: Record<string, unknown>, origin: BlockOrigin): void {
    const role = message.role;
    if (typeof role !== "string" || !["system", "user", "assistant", "tool"].includes(role)) {
      this.stats.unknown += 1;
      this.stats.unknownTypes.add(`message-role:${String(role)}`);
      this.issues.add("cursor-message-role", "blob message with unrecognized role skipped structurally", origin.blobId.slice(0, 12));
      return;
    }
    const messageRole = role as "system" | "user" | "assistant" | "tool";
    const content = message.content !== undefined ? message.content : message.parts;
    const providerKeys = providerOptionKeys(message.providerOptions);
    let providerKeysPending = providerKeys;
    if (typeof content === "string") {
      this.emitStringContent(content, messageRole, origin, providerKeysPending);
      return;
    }
    if (!Array.isArray(content)) {
      return; // content missing/null: structural carrier only
    }
    for (const part of content) {
      const keys = providerKeysPending;
      providerKeysPending = undefined; // message-level capsule lands on the first block only
      this.emitPart(part, messageRole, origin, keys);
    }
  }

  private emitStringContent(
    text: string,
    role: "system" | "user" | "assistant" | "tool",
    origin: BlockOrigin,
    providerKeys: string[] | undefined,
  ): void {
    if (!text) return;
    this.builder.addBlock({
      type: "text",
      role,
      kind: "message",
      text,
      data: {
        blobId: origin.blobId,
        ...(providerKeys !== undefined ? { providerOptionKeys: providerKeys } : {}),
      },
      provenance: { agent: CURSOR_AGENT, rawType: `cursor:${origin.via}:${role}`, row: origin.rowid, blobId: origin.blobId },
    });
  }

  private emitPart(
    part: unknown,
    messageRole: "system" | "user" | "assistant" | "tool",
    origin: BlockOrigin,
    providerKeys: string[] | undefined,
  ): void {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      this.stats.unknown += 1;
      this.stats.unknownTypes.add("part:non-object");
      return;
    }
    const record = part as Record<string, unknown>;
    const type = record.type;
    // Raw source capsule: every block carries its blob provenance and the
    // original part object so no fidelity is lost to flattening.
    const capsule = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      blobId: origin.blobId,
      ...(providerKeys !== undefined ? { providerOptionKeys: providerKeys } : {}),
      ...extra,
    });

    if (type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (!text) return;
      this.builder.addBlock({
        type: "text",
        role: messageRole,
        kind: "message",
        text,
        native: record,
        data: capsule({ rawSource: record }),
        provenance: { agent: CURSOR_AGENT, rawType: `cursor:${origin.via}:${messageRole}/text`, row: origin.rowid, blobId: origin.blobId },
      });
      return;
    }

    if (type === "reasoning") {
      const text = typeof record.text === "string" ? record.text : "";
      if (!text) return;
      this.builder.addBlock({
        type: "reasoning",
        role: "reasoning",
        kind: "reasoning",
        text,
        native: record,
        data: capsule({ rawSource: record }),
        provenance: { agent: CURSOR_AGENT, rawType: `cursor:${origin.via}:reasoning`, row: origin.rowid, blobId: origin.blobId },
      });
      return;
    }

    if (type === "tool-call") {
      const callId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      const name = typeof record.toolName === "string" ? record.toolName : undefined;
      const tool: ToolDetail = {
        ...(callId !== undefined ? { callId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(record.args !== undefined ? { arguments: record.args } : {}),
        result: { type: "pending" },
      };
      const block = this.builder.addBlock({
        type: "tool-call",
        role: "tool",
        kind: "tool",
        title: name,
        text: "",
        tool,
        native: record,
        data: capsule({ rawSource: record }),
        provenance: { agent: CURSOR_AGENT, rawType: `cursor:${origin.via}:tool-call`, row: origin.rowid, blobId: origin.blobId },
      });
      if (callId !== undefined) {
        const candidates = this.pendingTools.get(callId) ?? [];
        if (candidates.length) this.issues.add("cursor-tool-call-duplicate", "multiple pending calls share an id; result association is ambiguous");
        candidates.push(block);
        this.pendingTools.set(callId, candidates);
      }
      return;
    }

    if (type === "tool-result") {
      const callId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      const name = typeof record.toolName === "string" ? record.toolName : undefined;
      const detail = toolResultDetail(record.result);
      const candidates = callId !== undefined ? this.pendingTools.get(callId) ?? [] : [];
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      const pending = candidate && (!name || !candidate.tool?.name || candidate.tool.name === name) ? candidate : undefined;
      if (candidate && !pending) this.issues.add("cursor-tool-result-mismatch", "result tool name differs from its pending call; kept independently");
      if (pending && callId !== undefined) this.pendingTools.delete(callId);
      if (pending !== undefined) {
        this.toolCompletions += 1;
        const tool = pending.tool ?? {};
        if (tool.callId === undefined && callId !== undefined) tool.callId = callId;
        if (tool.name === undefined && name !== undefined) {
          tool.name = name;
          pending.title = name;
        }
        tool.result = detail;
        pending.text = detail.log ?? "";
        pending.native = { call: pending.native ?? pending.data?.rawSource, result: record };
        pending.data = { ...pending.data, resultProvenance: { blobId: origin.blobId, row: origin.rowid } };
        return;
      }
      const tool: ToolDetail = {
        ...(callId !== undefined ? { callId } : {}),
        ...(name !== undefined ? { name } : {}),
        result: detail,
      };
      this.builder.addBlock({
        type: "tool-result",
        role: "tool",
        kind: "tool",
        title: name,
        text: detail.log ?? "",
        tool,
        native: record,
        data: capsule({ rawSource: record }),
        provenance: { agent: CURSOR_AGENT, rawType: `cursor:${origin.via}:tool-result`, row: origin.rowid, blobId: origin.blobId },
      });
      return;
    }

    // Unknown part: structured placeholder — the payload stays in data,
    // never stringified into searchable text.
    this.stats.unknown += 1;
    this.stats.unknownTypes.add(`part:${String(type)}`);
    this.builder.addBlock({
      type: "unknown",
      role: messageRole,
      kind: "unknown",
      title: typeof type === "string" ? type : "unknown-part",
      text: "",
      native: record,
      data: capsule({ partType: typeof type === "string" ? type : "unknown", rawSource: record }),
      provenance: { agent: CURSOR_AGENT, rawType: `cursor:${origin.via}:unknown-part`, row: origin.rowid, blobId: origin.blobId },
    });
  }

  build() {
    for (const candidates of this.pendingTools.values()) {
      for (const _candidate of candidates) this.issues.add("cursor-tool-unresolved", "call has no unambiguous recorded result; status remains pending");
    }
    return this.builder.build();
  }
}

// ---------------------------------------------------------------------------
// Session reference construction (shared by discovery + refFromCursorFile)
// ---------------------------------------------------------------------------

async function readSidecar(sessionDir: string): Promise<CursorSidecar | undefined> {
  let value: unknown;
  try {
    value = await readJson(join(sessionDir, "meta.json"));
  } catch {
    return undefined; // sidecar is non-essential; absence is not an error
  }
  return normalizeSidecar(value);
}

/**
 * Validate sidecar fields against their actual JSON types: an object/array
 * timestamp, cwd or title never enters a ref as-is — only fields observed
 * with their declared shape survive, everything else stays absent (unknown,
 * never coerced to 0 or ""). Returns undefined for a non-object sidecar.
 */
function normalizeSidecar(value: unknown): CursorSidecar | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const str = (key: keyof CursorSidecar): string | undefined => {
    const field = record[key];
    return typeof field === "string" && field.length > 0 ? field : undefined;
  };
  const num = (key: keyof CursorSidecar): number | undefined => {
    const field = record[key];
    return typeof field === "number" && Number.isFinite(field) ? field : undefined;
  };
  const out: CursorSidecar = {};
  const schemaVersion = num("schemaVersion");
  const createdAtMs = num("createdAtMs");
  const updatedAtMs = num("updatedAtMs");
  const cwd = str("cwd");
  const title = str("title");
  if (schemaVersion !== undefined) out.schemaVersion = schemaVersion;
  if (createdAtMs !== undefined) out.createdAtMs = createdAtMs;
  if (updatedAtMs !== undefined) out.updatedAtMs = updatedAtMs;
  if (cwd !== undefined) out.cwd = cwd;
  if (title !== undefined) out.title = title;
  return out;
}

interface StoreProbe {
  valid: boolean;
  storeMeta?: CursorStoreMeta;
  warning?: string;
}

/** Read-only probe: schema autodetection + meta row. Never throws for a bad store. */
async function probeStore(dbPath: string): Promise<StoreProbe> {
  try {
    return await withReadOnlyDatabase(dbPath, (db) => {
      if (!isCursorStore(db)) {
        return { valid: false, warning: "store.db present but its schema is not a Cursor chat store (meta/blobs tables missing); quarantined" };
      }
      const decoded = decodeStoreMeta(db);
      if (decoded.meta === undefined) {
        return { valid: true, warning: `store.db meta row unreadable: ${decoded.error}` };
      }
      return { valid: true, storeMeta: decoded.meta };
    });
  } catch (error) {
    if (error instanceof CursorAdapterError) throw error; // runtime-unsupported must surface
    return { valid: false, warning: `store.db unreadable: ${(error as Error).message}` };
  }
}

async function buildSessionRef(
  sessionDir: string,
  id: string,
  files: { storeDb?: string; metaJson?: string },
): Promise<SessionRef> {
  const sidecar = files.metaJson !== undefined ? await readSidecar(sessionDir) : undefined;
  let probe: StoreProbe = { valid: false };
  if (files.storeDb !== undefined) probe = await probeStore(files.storeDb);

  const storeMeta = probe.storeMeta;
  // A bad database remains the transcript source: sidecar metadata is not a transcript fallback.
  const path = files.storeDb ?? files.metaJson ?? sessionDir;
  const warnings: string[] = [];
  if (probe.warning !== undefined) warnings.push(probe.warning);
  let fileStat: { mtime: string; size: number } | undefined;
  try {
    const info = await stat(path);
    fileStat = { mtime: new Date(info.mtimeMs).toISOString(), size: info.size };
  } catch {
    fileStat = undefined; // Retain disappearing sources so parsing can report them.
  }
  // An invalid sidecar timestamp (0/negative/NaN) must not mask a valid store
  // meta fallback: validate each candidate, then choose.
  const startedAt = isoFromMs(sidecar?.createdAtMs) ?? isoFromMs(storeMeta?.createdAt);
  const updatedAt = isoFromMs(sidecar?.updatedAtMs);
  const title = sidecar?.title ?? storeMeta?.name;
  return {
    agent: CURSOR_AGENT,
    id: typeof storeMeta?.agentId === "string" && storeMeta.agentId ? storeMeta.agentId : id,
    path,
    identity: { role: "main" },
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(fileStat !== undefined ? fileStat : {}),
    ...(sidecar?.cwd !== undefined ? { cwd: sidecar.cwd } : {}),
    ...(title !== undefined ? { title } : {}),
    source: {
      kind: CURSOR_SOURCE_KIND,
      path,
      lossy: true,
      warning: warnings.length > 0 ? `${CURSOR_LOSSY_WARNING}; ${warnings.join("; ")}` : CURSOR_LOSSY_WARNING,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function discoverCursor(root = CURSOR_DEFAULT_ROOT): Promise<SessionRef[]> {
  const resolvedRoot = expandHome(root);
  const files = await walkFiles(resolvedRoot, (path) => {
    const name = basename(path);
    return name === "store.db" || name === "meta.json";
  });
  const dirs = new Map<string, { storeDb?: string; metaJson?: string }>();
  for (const file of files) {
    const dir = dirname(file);
    const entry = dirs.get(dir) ?? {};
    if (basename(file) === "store.db") entry.storeDb = file;
    else entry.metaJson = file;
    dirs.set(dir, entry);
  }
  const refs: SessionRef[] = [];
  for (const [dir, entry] of [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    refs.push(await buildSessionRef(dir, basename(dir), entry));
  }
  return refs;
}

export async function refFromCursorFile(path: string): Promise<SessionRef | undefined> {
  const resolved = expandHome(path);
  const name = basename(resolved);
  if (!(await pathExists(resolved))) return undefined;
  const sessionDir = dirname(resolved);
  const id = basename(sessionDir);
  // Explicit archives are identified by SQLite metadata, not their copied path.
  if (name === "meta.json" && !UUID_PATTERN.test(id)) return undefined;
  const siblingStore = join(sessionDir, "store.db");
  const siblingMeta = join(sessionDir, "meta.json");
  const files: { storeDb?: string; metaJson?: string } = {};
  if (name !== "meta.json") {
    // Explicit autodetection: never bless an arbitrary SQLite file as Cursor.
    const probe = await probeStore(resolved);
    if (!probe.valid) return undefined;
    files.storeDb = resolved;
  } else if (await pathExists(siblingStore)) {
    const probe = await probeStore(siblingStore);
    if (probe.valid) files.storeDb = siblingStore;
  }
  if (name === "meta.json") files.metaJson = resolved;
  else if (await pathExists(siblingMeta)) files.metaJson = siblingMeta;
  return buildSessionRef(sessionDir, id, files);
}

export async function parseCursor(ref: SessionRef): Promise<ParsedSession> {
  const storeName = basename(ref.path);
  const sessionDir = dirname(ref.path);
  const storePath = storeName !== "meta.json" ? ref.path : join(sessionDir, "store.db");
  const sidecar = await readSidecar(sessionDir);
  const hasStore = await pathExists(storePath);

  if (!hasStore) {
    if (storeName !== "meta.json") {
      throw new CursorAdapterError("store-missing", `cursor store.db not found: ${storePath}`);
    }
    // meta.json-only session (hasConversation=false): metadata without a
    // transcript — reading it must not require walking any blob chain.
    const emptyRef: SessionRef = {
      ...ref,
      ...(isoFromMs(sidecar?.createdAtMs) !== undefined ? { startedAt: isoFromMs(sidecar?.createdAtMs)! } : {}),
      ...(isoFromMs(sidecar?.updatedAtMs) !== undefined ? { updatedAt: isoFromMs(sidecar?.updatedAtMs)! } : {}),
      ...(sidecar?.cwd !== undefined ? { cwd: sidecar.cwd } : {}),
      ...(sidecar?.title !== undefined ? { title: sidecar.title } : {}),
      source: {
        kind: CURSOR_SOURCE_KIND,
        path: ref.path,
        lossy: true,
        warning: `${CURSOR_LOSSY_WARNING}; no store.db in this session directory (conversation never started)`,
      },
    };
    const builder = createDocumentBuilder(emptyRef);
    builder.setIdentity({ role: "main" });
    builder.setMeta({
      ...(emptyRef.title !== undefined ? { title: emptyRef.title } : {}),
      ...(emptyRef.startedAt !== undefined ? { startedAt: emptyRef.startedAt } : {}),
      ...(emptyRef.updatedAt !== undefined ? { updatedAt: emptyRef.updatedAt } : {}),
      ...(emptyRef.cwd !== undefined ? { cwd: emptyRef.cwd } : {}),
    });
    const document = builder.build();
    return {
      ...emptyRef,
      entries: projectEntries(document),
      document,
      stats: computeStats(document),
      diagnostics: { handled: 0, ignored: 0, unknown: 0, unknownTypes: [] },
    };
  }

  return withReadOnlyDatabase(storePath, (db): ParsedSession => {
    if (!isCursorStore(db)) {
      throw new CursorAdapterError("not-a-cursor-store", `${storePath} is not a Cursor chat store (expected meta/blobs schema)`);
    }
    const issues = new IssueLog();
    const stats: EmitStats = { handled: 0, ignored: 0, unknown: 0, unknownTypes: new Set() };

    const decoded = decodeStoreMeta(db);
    if (decoded.meta === undefined) {
      issues.add("cursor-meta-decode", `store meta row unreadable: ${decoded.error}`);
    }
    const storeMeta = decoded.meta;

    // Content-addressed integrity check + classification of every blob.
    const loaded = loadBlobs(db);
    for (const rowid of loaded.invalidRowids) {
      issues.add("cursor-blob-row-invalid", "blobs row with missing/non-string id, undecodable data or bad rowid skipped", `row:${rowid}`);
    }
    for (const id of loaded.duplicateIds) {
      issues.add("cursor-blob-duplicate-id", "duplicate blob id row (PK-less corrupted table); identical bytes collapse to one node, diverging bytes fail the hash check", id.slice(0, 12));
    }
    const classified = new Map<string, { rec: BlobRecord; cls: BlobClassification }>();
    const parentsById = new Map<string, string[]>();
    for (const rec of loaded.records) {
      const digest = createHash("sha256").update(rec.data).digest("hex");
      if (digest !== rec.id) {
        issues.add("cursor-blob-hash-mismatch", "blob id does not match sha256(data); blob quarantined", `${rec.id.slice(0, 12)}!=${digest.slice(0, 12)}`);
        continue;
      }
      const cls = classifyBlob(rec.data);
      classified.set(rec.id, { rec, cls });
      parentsById.set(rec.id, cls.parents);
    }

    // Trunk reconstruction along f1 refs from latestRootBlobId.
    let chain: ChainResult = { order: [], cycles: [], missing: [] };
    if (storeMeta?.latestRootBlobId !== undefined) {
      chain = linearizeCursorChain(storeMeta.latestRootBlobId, parentsById);
    } else {
      issues.add("cursor-root-missing", "meta.latestRootBlobId absent; transcript not reconstructed");
    }
    for (const id of chain.missing) {
      issues.add("cursor-chain-missing-blob", "chain references a blob id absent from the store (or hash-quarantined)", id.slice(0, 12));
    }
    for (const id of chain.cycles) {
      issues.add("cursor-chain-cycle", "cycle in f1 reference chain cut at first revisit", id.slice(0, 12));
    }
    const unreachable = classified.size - chain.order.length;
    if (unreachable > 0) {
      issues.add("cursor-unreachable-blobs", "blobs not reachable from latestRootBlobId (dead/edited branches) intentionally omitted from the trunk", String(unreachable));
      stats.ignored += unreachable;
    }

    const startedAt = isoFromMs(sidecar?.createdAtMs) ?? isoFromMs(storeMeta?.createdAt);
    const updatedAt = isoFromMs(sidecar?.updatedAtMs);
    const title = sidecar?.title ?? storeMeta?.name;
    const parsedRef: SessionRef = {
      ...ref,
      agent: CURSOR_AGENT,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(sidecar?.cwd !== undefined ? { cwd: sidecar.cwd } : {}),
      ...(title !== undefined ? { title } : {}),
      source: { kind: CURSOR_SOURCE_KIND, path: storePath, lossy: true, warning: CURSOR_LOSSY_WARNING },
    };
    const emitter = new CursorDocumentEmitter(parsedRef, stats, issues);

    let chainCwd: string | undefined;
    for (const id of chain.order) {
      const entry = classified.get(id);
      if (entry === undefined) continue;
      const { rec, cls } = entry;
      if (cls.cwd !== undefined && chainCwd === undefined) chainCwd = cls.cwd;
      for (const field of cls.unknownFields) stats.unknownTypes.add(`proto-field:${field}`);
      if (cls.groupTruncated) {
        issues.add("cursor-proto-group", "legacy group field stopped envelope scan; leading fields kept", rec.id.slice(0, 12));
      }
      if (cls.malformed) {
        issues.add("cursor-proto-malformed", "wire-format violation (varint/bounds) stopped envelope scan; leading fields kept", rec.id.slice(0, 12));
      }
      if (cls.f5Count > 0) {
        // f5 semantics are unverified — counts only, never token metrics.
        issues.add("cursor-f5-usage-unverified", "envelope field-5 token-like payload observed; semantics unverified, not recorded as usage", rec.id.slice(0, 12));
      }
      if (cls.invalidEmbeddedJson) {
        issues.add("cursor-envelope-json-invalid", "embedded field-4 JSON is invalid; payload omitted without substring salvage", rec.id.slice(0, 12));
      }
      if (cls.kind === "bad-json") {
        issues.add("cursor-blob-json-invalid", "JSON blob is not complete valid JSON; content skipped (no substring salvage)", rec.id.slice(0, 12));
        stats.ignored += 1;
        continue;
      }
      if (cls.kind === "unknown") {
        issues.add("cursor-blob-unknown", "blob payload is opaque (malformed protobuf, no recognized fields; possibly encrypted under meta.blobEncryptionKey)", rec.id.slice(0, 12));
        stats.unknown += 1;
        stats.unknownTypes.add("payload:opaque");
        continue;
      }
      if (cls.kind === "empty" || cls.message === undefined) {
        // Structural envelope/empty carrier: no message content.
        stats.ignored += 1;
        continue;
      }
      const before = emitter.blockCount;
      emitter.emitMessage(cls.message, { blobId: rec.id, rowid: rec.rowid, via: cls.kind === "json" ? "json" : "envelope-f4" });
      if (emitter.blockCount > before || emitter.drainToolCompletions() > 0) stats.handled += 1;
      else stats.ignored += 1;
    }
    if (sidecar?.cwd === undefined && chainCwd !== undefined) {
      parsedRef.cwd = chainCwd;
    }
    emitter.addSessionMeta({
      ...(title !== undefined ? { title } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(parsedRef.cwd !== undefined ? { cwd: parsedRef.cwd } : {}),
    });
    if (typeof sidecar?.schemaVersion === "number" && sidecar.schemaVersion > 1) {
      issues.add(
        "cursor-schema-future",
        `sidecar schemaVersion=${sidecar.schemaVersion} is newer than the verified v1 layout; known fields are still parsed, unverified semantics stay diagnostics-only`,
      );
    }
    if (typeof storeMeta?.lastUsedModel === "string" && storeMeta.lastUsedModel.length > 0) {
      issues.add(
        "cursor-model-session-level",
        `lastUsedModel=${storeMeta.lastUsedModel} is session-level metadata only; the source records no per-message model binding`,
      );
    }

    const document = emitter.build();
    const unknownTypes = [...stats.unknownTypes].sort();
    return {
      ...parsedRef,
      entries: projectEntries(document),
      document,
      stats: computeStats(document),
      diagnostics: {
        handled: stats.handled,
        ignored: stats.ignored,
        unknown: stats.unknown,
        unknownTypes,
        ...(unknownTypes.length > MAX_UNKNOWN_TYPE_SAMPLES
          ? { unknownTypesTruncated: true, unknownTypes: unknownTypes.slice(0, MAX_UNKNOWN_TYPE_SAMPLES) }
          : {}),
        ...(typeof sidecar?.schemaVersion === "number" ? { formatVersion: sidecar.schemaVersion } : {}),
        issues: issues.list(),
      },
    };
  });
}
