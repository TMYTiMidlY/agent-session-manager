import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, stat, writeFile, readFile, copyFile } from "node:fs/promises";
import { timelineEntrySearchText } from "../text.js";
import { basename, dirname, join } from "node:path";
import { CursorAdapterError, discoverCursor, linearizeCursorChain, parseCursor, refFromCursorFile } from "../adapters/cursor.js";
import type { ParsedSession } from "../types.js";

// Synthetic fixtures only — never live ~/.cursor/chats data.
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const encoder = new TextEncoder();

function blobId(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function varintNum(n: number): number[] {
  const out: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
}

function lenDelim(field: number, payload: Uint8Array | number[] | string): number[] {
  const bytes = typeof payload === "string" ? [...encoder.encode(payload)] : payload instanceof Uint8Array ? [...payload] : payload;
  return [...varintNum((field << 3) | 2), ...varintNum(bytes.length), ...bytes];
}

function hexToBytes(hex: string): number[] {
  return [...Buffer.from(hex, "hex")];
}

interface EnvelopeOptions {
  parents?: string[];
  message?: unknown;
  /** Raw f4 bytes (e.g. truncated JSON) — used instead of `message`. */
  messageBytes?: Uint8Array;
  cwd?: string;
  usage?: { input: number; max: number };
  unknownField?: { field: number; bytes: string };
  groupStop?: boolean;
  trailing?: number[];
}

/** Synthetic protobuf envelope: f1 parents, f4 embedded JSON message, f5 usage-like pair, f9 cwd. */
function envelope(options: EnvelopeOptions): Uint8Array {
  const out: number[] = [];
  for (const parent of options.parents ?? []) {
    out.push(...lenDelim(1, hexToBytes(parent)));
  }
  if (options.messageBytes !== undefined) {
    out.push(...lenDelim(4, options.messageBytes));
  } else if (options.message !== undefined) {
    out.push(...lenDelim(4, JSON.stringify(options.message)));
  }
  if (options.usage !== undefined) {
    const inner = [...varintNum((1 << 3) | 0), ...varintNum(options.usage.input), ...varintNum((2 << 3) | 0), ...varintNum(options.usage.max)];
    out.push(...lenDelim(5, inner));
  }
  if (options.cwd !== undefined) {
    out.push(...lenDelim(9, options.cwd));
  }
  if (options.unknownField !== undefined) {
    out.push(...lenDelim(options.unknownField.field, options.unknownField.bytes));
  }
  if (options.groupStop) {
    out.push((12 << 3) | 3); // legacy group start, intentionally unterminated
  }
  out.push(...(options.trailing ?? []));
  return Uint8Array.from(out);
}

function jsonBlob(message: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}

interface BlobSpec {
  data: Uint8Array;
  id?: string; // override to simulate a hash mismatch
}

interface StoreSpec {
  meta: Record<string, unknown>;
  blobs: BlobSpec[];
  root?: string; // defaults to last blob id
}

interface BuiltStore {
  dbPath: string;
  rootId: string;
  ids: string[];
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
  `);
}

function fillStore(db: DatabaseSync, spec: StoreSpec): BuiltStore {
  createSchema(db);
  const ids: string[] = [];
  for (const blob of spec.blobs) {
    const id = blob.id ?? blobId(blob.data);
    ids.push(id);
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(id, blob.data);
  }
  const rootId = spec.root ?? ids[ids.length - 1];
  const meta = { latestRootBlobId: rootId, agentId: "test-agent", ...spec.meta };
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
  return { dbPath: "", rootId, ids };
}

interface SessionSpec {
  hash?: string;
  uuid?: string;
  metaJson?: Record<string, unknown> | null; // null = deliberately absent
  store?: StoreSpec;
}

async function createSession(root: string, spec: SessionSpec): Promise<{ dir: string; store?: BuiltStore }> {
  const hash = spec.hash ?? "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  const uuid = spec.uuid ?? "11111111-2222-4333-8444-555555555555";
  const dir = join(root, hash, uuid);
  await mkdir(dir, { recursive: true });
  if (spec.metaJson !== null) {
    await writeFile(join(dir, "meta.json"), JSON.stringify(spec.metaJson ?? {}));
  }
  if (spec.store !== undefined) {
    const dbPath = join(dir, "store.db");
    const db = new DatabaseSync(dbPath);
    const built = fillStore(db, { ...spec.store, meta: { agentId: uuid, ...spec.store.meta } });
    db.close();
    return { dir, store: { ...built, dbPath } };
  }
  return { dir };
}

const T0 = 1790000000000;
const T1 = 1790000060000;

function asAgent(value: unknown): string {
  return String(value);
}

function entrySummary(session: ParsedSession): Array<[string, string, string]> {
  return session.entries.map((entry) => [entry.role, entry.kind, entry.text]);
}

describe("Cursor store discovery", () => {
  it("discovers store.db sessions, meta.json-only sessions, and quarantines bad stores with warnings", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    await createSession(scratch, {
      hash: "a".repeat(32),
      uuid: "11111111-2222-4333-8444-555555555555",
      metaJson: { schemaVersion: 1, createdAtMs: T0, updatedAtMs: T1, cwd: "/tmp/proj", hasConversation: true, title: "Test Chat" },
      store: {
        meta: { name: "Test Chat", createdAt: T0, lastUsedModel: "grok-test" },
        blobs: [{ data: envelope({ message: { role: "user", content: "hi" } }) }],
      },
    });
    await createSession(scratch, {
      hash: "b".repeat(32),
      uuid: "33333333-2222-4333-8444-555555555555",
      metaJson: { schemaVersion: 1, createdAtMs: T0, updatedAtMs: T1, cwd: "/tmp/empty", hasConversation: false, title: "Never started" },
    });
    // Bad store: valid SQLite, wrong schema — must stay discoverable but quarantined.
    await createSession(scratch, {
      hash: "c".repeat(32),
      uuid: "44444444-2222-4333-8444-555555555555",
      metaJson: { schemaVersion: 1, createdAtMs: T0, cwd: "/tmp/broken", title: "Broken" },
    }).then(async ({ dir }) => {
      const db = new DatabaseSync(join(dir, "store.db"));
      db.exec("CREATE TABLE unrelated (id TEXT)");
      db.close();
    });

    const refs = await discoverCursor(scratch);
    expect(refs.map((ref) => ref.id).sort()).toEqual([
      "11111111-2222-4333-8444-555555555555",
      "33333333-2222-4333-8444-555555555555",
      "44444444-2222-4333-8444-555555555555",
    ]);
    for (const ref of refs) {
      expect(asAgent(ref.agent)).toBe("cursor");
      expect(ref.source?.kind).toBe("cursor-store" as never);
      expect(ref.source?.lossy).toBe(true);
      expect(ref.source?.warning).toBeTruthy();
    }

    const good = refs.find((ref) => ref.id.startsWith("1111"));
    expect(good?.path.endsWith("store.db")).toBe(true);
    expect(good?.cwd).toBe("/tmp/proj");
    expect(good?.title).toBe("Test Chat");
    expect(good?.startedAt).toBe(new Date(T0).toISOString());
    expect(good?.updatedAt).toBe(new Date(T1).toISOString());
    expect(typeof good?.size).toBe("number");
    expect(good?.mtime).toBeTruthy();

    const metaOnly = refs.find((ref) => ref.id.startsWith("3333"));
    expect(metaOnly?.path.endsWith("meta.json")).toBe(true);
    expect(metaOnly?.cwd).toBe("/tmp/empty");

    const bad = refs.find((ref) => ref.id.startsWith("4444"));
    expect(bad?.path.endsWith("store.db")).toBe(true); // Sidecar metadata is not a transcript fallback.
    expect(bad?.source?.warning).toContain("quarantined");
    await expect(parseCursor(bad!)).rejects.toMatchObject({ code: "not-a-cursor-store" });
  });

  it("returns [] for an absent root", async () => {
    const refs = await discoverCursor(join(await mkdtemp(join(process.cwd(), ".core-cursor-")), "does-not-exist"));
    expect(refs).toEqual([]);
  });
});

describe("Cursor store parsing (JSON + protobuf trunk)", () => {
  it("reconstructs message order along latestRootBlobId, pairs tool calls, and records provenance", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    // Realistic layout (verified on live stores): messages are JSON blobs,
    // and a root envelope lists them in order via f1. JSON blobs cannot
    // carry parent refs themselves, so the trunk flows through the root.
    const system = jsonBlob({ role: "system", content: "You are Cursor." });
    const user = jsonBlob({ role: "user", content: [{ type: "text", text: "hello cursor" }], providerOptions: { cursor: { requestId: "r-1" } } });
    const systemId = blobId(system);
    const userId = blobId(user);
    const assistant = jsonBlob({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "hi there" },
        { type: "tool-call", toolCallId: "call-1", toolName: "Read", args: { path: "/tmp/x" } },
      ],
    });
    const assistantId = blobId(assistant);
    const usageCarrier = envelope({ parents: [assistantId], usage: { input: 1234, max: 256000 } });
    const usageId = blobId(usageCarrier);
    const toolResult = jsonBlob({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "Read", result: { content: "file body" } }],
    });
    const toolResultId = blobId(toolResult);
    const root = envelope({ parents: [systemId, userId, assistantId, usageId, toolResultId] });
    const rootId = blobId(root);
    // Dead branch + unreachable blob: must NOT leak into the trunk.
    const stale = envelope({ parents: [userId], message: { role: "assistant", content: "stale regeneration" } });
    const orphan = jsonBlob({ role: "user", content: "orphaned draft" });

    const { dir, store } = await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0, updatedAtMs: T1, cwd: "/tmp/proj", hasConversation: true, title: "Test Chat" },
      store: {
        meta: { name: "Test Chat", createdAt: T0, lastUsedModel: "grok-test" },
        blobs: [
          { data: system },
          { data: user },
          { data: stale },
          { data: assistant },
          { data: usageCarrier },
          { data: toolResult },
          { data: root },
          { data: orphan },
        ],
        root: rootId,
      },
    });
    void dir;

    const refs = await discoverCursor(scratch);
    const ref = refs.find((r) => r.id.startsWith("1111"))!;
    const session = await parseCursor(ref);

    expect(asAgent(session.agent)).toBe("cursor");
    expect(session.source?.kind).toBe("cursor-store" as never);
    expect(session.source?.lossy).toBe(true);
    expect(session.cwd).toBe("/tmp/proj");
    expect(session.title).toBe("Test Chat");
    expect(session.diagnostics?.formatVersion).toBe(1);

    expect(entrySummary(session)).toEqual([
      ["system", "message", "You are Cursor."],
      ["user", "message", "hello cursor"],
      ["reasoning", "reasoning", "thinking..."],
      ["assistant", "message", "hi there"],
      ["tool", "tool", "file body"],
    ]);
    // Dead branches and orphans stay out of the searchable text.
    const allText = session.entries.map((entry) => entry.text).join("\n");
    expect(allText).not.toContain("stale");
    expect(allText).not.toContain("orphaned");

    const toolEntry = session.entries[4];
    expect(toolEntry.tool?.callId).toBe("call-1");
    expect(toolEntry.tool?.name).toBe("Read");
    expect(toolEntry.tool?.arguments).toEqual({ path: "/tmp/x" });
    expect(toolEntry.tool?.result?.type).toBe("success");
    expect(toolEntry.tool?.result?.log).toBe("file body");

    // Blob provenance on every block; no fabricated per-message timestamps.
    for (const block of session.document?.blocks ?? []) {
      expect(typeof block.data?.blobId).toBe("string");
      expect(block.timestamp).toBeUndefined();
    }
    for (const entry of session.entries) {
      expect(entry.timestamp).toBeUndefined();
    }
    expect((session.document?.blocks ?? []).map((b) => b.provenance?.blobId ?? b.data?.blobId).every(Boolean)).toBe(true);
    expect(session.document?.identity.role).toBe("main");

    // Usage stays unknown: f5 is counted in diagnostics, never in metrics.
    expect(session.document?.usage).toEqual([]);
    expect(session.stats?.totals).toEqual({});
    expect(session.stats?.calls).toBe(0);
    const issueCodes = (session.diagnostics?.issues ?? []).map((issue) => issue.code);
    expect(issueCodes).toContain("cursor-f5-usage-unverified");
    expect(issueCodes).toContain("cursor-unreachable-blobs");
    expect(issueCodes).toContain("cursor-model-session-level");
    expect(session.diagnostics?.handled).toBe(4); // system, user, assistant, tool blobs
    expect(session.diagnostics?.ignored).toBeGreaterThanOrEqual(4); // root + usage carriers + 2 unreachable
    expect(store?.rootId).toBe(rootId);
  });

  it("supports cumulative-list roots (single envelope referencing ordered JSON blobs)", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const msgs = [
      jsonBlob({ role: "system", content: "sys" }),
      jsonBlob({ role: "user", content: "one" }),
      jsonBlob({ role: "assistant", content: "two" }),
    ];
    const ids = msgs.map((m) => blobId(m));
    const root = envelope({ parents: ids });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0, cwd: "/tmp/cumulative" },
      store: { meta: {}, blobs: [...msgs.map((m) => ({ data: m })), { data: root }], root: blobId(root) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(entrySummary(session)).toEqual([
      ["system", "message", "sys"],
      ["user", "message", "one"],
      ["assistant", "message", "two"],
    ]);
  });

  it("dedupes shared ancestors in DAG merges", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const base = jsonBlob({ role: "user", content: "base" });
    const baseId = blobId(base);
    const left = envelope({ parents: [baseId], message: { role: "assistant", content: "left" } });
    const leftId = blobId(left);
    const right = envelope({ parents: [baseId], message: { role: "assistant", content: "right" } });
    const rightId = blobId(right);
    const merge = envelope({ parents: [leftId, rightId] });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: base }, { data: left }, { data: right }, { data: merge }], root: blobId(merge) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    const texts = session.entries.map((entry) => entry.text);
    expect(texts.filter((t) => t === "base")).toHaveLength(1); // shared ancestor emitted exactly once
    expect(texts).toContain("left");
    expect(texts).toContain("right");
    expect(texts.indexOf("base")).toBeLessThan(texts.indexOf("left"));
    expect(texts.indexOf("left")).toBeLessThan(texts.indexOf("right"));
  });

  it("cuts cycles with bounded diagnostics (chain walker, direct)", () => {
    // A true cycle cannot exist among sha256-verified content-addressed blobs
    // (a cycle needs non-content ids, which the hash check quarantines), so
    // the guard is exercised on the walker directly. The corrupted-store
    // consequence (id overrides failing the hash check) is covered below by
    // the missing/hash-mismatch suite.
    const graph = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["a"]],
    ]);
    const result = linearizeCursorChain("c", graph);
    expect([...result.order].sort()).toEqual(["a", "b", "c"]); // every node once — no infinite walk
    expect([...result.cycles].sort()).toEqual(["a"]);
    // f1 order is preserved: post-order emits parents before children.
    const linear = linearizeCursorChain("r", new Map([["r", ["p1", "p2"]], ["p1", []], ["p2", []]]));
    expect(linear.order).toEqual(["p1", "p2", "r"]);
  });

  it("diagnoses missing parents and hash-mismatched blobs without dropping the rest", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const good = jsonBlob({ role: "user", content: "present" });
    const goodId = blobId(good);
    const mismatched = envelope({ parents: [goodId], message: { role: "assistant", content: "hidden by bad hash" } });
    const head = envelope({ parents: ["f".repeat(64)] , message: { role: "assistant", content: "head" } });
    const headId = blobId(head);
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: {
        meta: {},
        blobs: [{ data: good }, { data: mismatched, id: "0".repeat(64) }, { data: head }],
        root: headId,
      },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    const codes = (session.diagnostics?.issues ?? []).map((i) => i.code);
    expect(codes).toContain("cursor-blob-hash-mismatch");
    expect(codes).toContain("cursor-chain-missing-blob");
    expect(session.entries.map((e) => e.text)).toEqual(["head"]); // mismatched blob quarantined; missing parent diagnosed
  });

  it("skips invalid JSON blobs whole (no substring salvage) and continues the chain", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const bad = encoder.encode('{"role":"user","content":"sec');
    const head = envelope({ parents: [blobId(bad)], message: { role: "assistant", content: "after bad json" } });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: bad }, { data: head }], root: blobId(head) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    const codes = (session.diagnostics?.issues ?? []).map((i) => i.code);
    expect(codes).toContain("cursor-blob-json-invalid");
    expect(session.entries.map((e) => e.text)).toEqual(["after bad json"]);
    expect(session.entries.map((e) => e.text).join("")).not.toContain("sec");
  });

  it("treats key + opaque payloads as encrypted/unknown with bounded diagnostics and no text leak", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const opaque = Uint8Array.from([0x0a, ...Array.from({ length: 12 }, () => 0xff)]); // varint overruns 10 bytes
    const head = envelope({ parents: [blobId(opaque)], message: { role: "assistant", content: "post-encrypted" } });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: {
        meta: { blobEncryptionKey: "a".repeat(64) },
        blobs: [{ data: opaque }, { data: head }],
        root: blobId(head),
      },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    const codes = (session.diagnostics?.issues ?? []).map((i) => i.code);
    expect(codes).toContain("cursor-blob-unknown");
    expect(session.diagnostics?.unknown).toBeGreaterThanOrEqual(1);
    expect(session.entries.map((e) => e.text)).toEqual(["post-encrypted"]);
  });

  it("keeps unknown message parts as structured placeholders, not searchable text", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const secret = "private-context-payload";
    const msg = jsonBlob({
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        { type: "mystery-part", payload: { secret } },
      ],
    });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: msg }], root: blobId(msg) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(session.entries.map((e) => [e.role, e.text])).toEqual([
      ["assistant", "visible answer"],
      ["assistant", ""], // unknown part: empty text
    ]);
    const unknownEntry = session.entries[1];
    expect(unknownEntry.kind).toBe("unknown");
    expect(unknownEntry.title).toBe("mystery-part");
    expect(unknownEntry.data?.partType).toBe("mystery-part");
    expect(session.document?.blocks[1].native).toEqual({ type: "mystery-part", payload: { secret } });
    expect(unknownEntry.data?.rawSource).toBeUndefined();
    expect(session.diagnostics?.unknownTypes).toContain("part:mystery-part");
    // The complete searchable projection stays clean, not only its text field.
    expect(timelineEntrySearchText(unknownEntry)).not.toContain(secret);
  });

  it("recovers cwd from envelope f9 when the sidecar is missing", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const msg = envelope({
      message: { role: "user", content: "where am I" },
      cwd: "file:///tmp/f9%20dir",
    });
    await createSession(scratch, {
      metaJson: null,
      store: { meta: {}, blobs: [{ data: msg }], root: blobId(msg) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(session.cwd).toBe("/tmp/f9 dir");
    expect(session.document?.meta.cwd).toBe("/tmp/f9 dir");
  });

  it("stops at legacy groups and malformed varints while keeping leading fields", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const user = jsonBlob({ role: "user", content: "seed" });
    const userId = blobId(user);
    const withGroup = envelope({
      parents: [userId],
      message: { role: "assistant", content: "grouped" },
      groupStop: true,
      trailing: [0x22, 0x02, 0x61, 0x62], // bytes after the group stop are never scanned
    });
    const malformed = envelope({
      parents: [blobId(withGroup)],
      message: { role: "assistant", content: "malformed tail" },
      unknownField: { field: 7, bytes: "x" },
      trailing: [...Array.from({ length: 12 }, () => 0xff)],
    });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: user }, { data: withGroup }, { data: malformed }], root: blobId(malformed) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(session.entries.map((e) => e.text)).toEqual(["seed", "grouped", "malformed tail"]);
    const codes = (session.diagnostics?.issues ?? []).map((i) => i.code);
    expect(codes).toContain("cursor-proto-group");
    expect(codes).toContain("cursor-proto-malformed");
    expect(session.diagnostics?.unknownTypes).toContain("proto-field:7");
  });

  it("parses metadata-only sessions without a transcript and treats failures as tool results", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0, updatedAtMs: T1, cwd: "/tmp/never", hasConversation: false, title: "Never started" },
    });
    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(session.entries).toEqual([]);
    expect(session.title).toBe("Never started");
    expect(session.cwd).toBe("/tmp/never");
    expect(session.source?.warning).toContain("no store.db");
    expect(session.document?.blocks).toEqual([]);

    // tool-result carrying an error object maps to a failure result.
    const failure = jsonBlob({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c9", toolName: "Shell", args: { cmd: "ls" } }],
    });
    const failureId = blobId(failure);
    const result = envelope({
      parents: [failureId],
      message: {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c9", toolName: "Shell", result: { error: "exit 1" } }],
      },
    });
    await createSession(scratch, {
      hash: "d".repeat(32),
      uuid: "66666666-2222-4333-8444-555555555555",
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: failure }, { data: result }], root: blobId(result) },
    });
    const all = await discoverCursor(scratch);
    const withTools = await parseCursor(all.find((r) => r.id.startsWith("6666"))!);
    const tool = withTools.entries.find((e) => e.tool !== undefined);
    expect(tool?.tool?.result?.type).toBe("failure");
    expect(tool?.tool?.result?.log).toBe("exit 1");
  });

  it("never writes to the store: file bytes and mtime stay identical", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const msg = jsonBlob({ role: "user", content: "read only" });
    const { dir } = await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: msg }], root: blobId(msg) },
    });
    const dbPath = join(dir, "store.db");
    const before = await readFile(dbPath);
    const beforeStat = await statFile(dbPath);
    const refs = await discoverCursor(scratch);
    await parseCursor(refs[0]);
    const after = await readFile(dbPath);
    const afterStat = await statFile(dbPath);
    expect(before.equals(after)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
  });

  it("rejects an explicit non-cursor SQLite file and a missing store", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const { dir } = await createSession(scratch, { metaJson: { schemaVersion: 1, createdAtMs: T0 } });
    const dbPath = join(dir, "store.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE turns (id INTEGER)");
    db.close();

    await expect(parseCursor({ agent: "cursor" as never, id: "x", path: dbPath })).rejects.toMatchObject({
      name: "CursorAdapterError",
      code: "not-a-cursor-store",
    } satisfies Partial<CursorAdapterError>);
    await expect(
      parseCursor({ agent: "cursor" as never, id: "x", path: join(dir, "absent.db") }),
    ).rejects.toBeInstanceOf(CursorAdapterError);
  });
});

describe("review regressions: damaged stores stay diagnosable, payloads stay private", () => {
  /** Store built by hand (schema/meta under the caller's control), placed as a session's sibling store.db. */
  async function rawSession(scratch: string, uuid: string, setup: (db: DatabaseSync) => void, metaJson?: Record<string, unknown> | null) {
    const dir = join(scratch, "f".repeat(32), uuid);
    await mkdir(dir, { recursive: true });
    if (metaJson !== null) await writeFile(join(dir, "meta.json"), JSON.stringify(metaJson ?? { schemaVersion: 1 }));
    const db = new DatabaseSync(join(dir, "store.db"));
    setup(db);
    db.close();
    return dir;
  }

  const issueByCode = (session: ParsedSession, code: string) =>
    (session.diagnostics?.issues ?? []).find((issue) => issue.code === code);

  it("diagnoses a truncated f4 embedded JSON without leaking its payload; the good parent message survives", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const secret = "top-secret-f4-fragment";
    const badF4 = envelope({ messageBytes: encoder.encode(`{"role":"user","content":"${secret}"`) }); // truncated JSON
    const head = envelope({ parents: [blobId(badF4)], message: { role: "assistant", content: "after bad f4" } });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: badF4 }, { data: head }], root: blobId(head) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(issueByCode(session, "cursor-envelope-json-invalid")).toMatchObject({ count: 1 });
    expect(session.entries.map((e) => e.text)).toEqual(["after bad f4"]);
    // No channel leaks the truncated payload: not entry text, not diagnostics.
    expect(session.entries.map((e) => e.text).join("")).not.toContain(secret);
    expect(JSON.stringify(session.diagnostics)).not.toContain(secret);
    expect(JSON.stringify(session.document)).not.toContain(secret);
  });

  it("keeps duplicate-callId results unbound: both calls stay pending, the result stays independent, diagnostics report it", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const callRead = jsonBlob({ role: "assistant", content: [{ type: "tool-call", toolCallId: "dup", toolName: "Read", args: { path: "/a" } }] });
    const callGrep = jsonBlob({ role: "assistant", content: [{ type: "tool-call", toolCallId: "dup", toolName: "Grep", args: { q: "x" } }] });
    const result = jsonBlob({ role: "tool", content: [{ type: "tool-result", toolCallId: "dup", toolName: "Grep", result: { content: "grep out" } }] });
    const root = envelope({ parents: [blobId(callRead), blobId(callGrep), blobId(result)] });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: callRead }, { data: callGrep }, { data: result }, { data: root }], root: blobId(root) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(issueByCode(session, "cursor-tool-call-duplicate")).toMatchObject({ count: 1 });
    expect(issueByCode(session, "cursor-tool-unresolved")).toMatchObject({ count: 2 });
    // The result may not arbitrarily bind to the second registration.
    expect(issueByCode(session, "cursor-tool-result-mismatch")).toBeUndefined();
    const tools = session.entries.filter((e) => e.tool !== undefined);
    expect(tools[0].tool?.name).toBe("Read");
    expect(tools[0].tool?.result?.type).toBe("pending");
    expect(tools[1].tool?.name).toBe("Grep");
    expect(tools[1].tool?.result?.type).toBe("pending");
    expect(tools[2].tool?.result?.type).toBe("success");
    expect(tools[2].tool?.result?.log).toBe("grep out");
    expect(tools[2].tool?.name).toBe("Grep");
  });

  it("keeps a name-mismatched result independent of its single pending call and diagnoses both facts", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const call = jsonBlob({ role: "assistant", content: [{ type: "tool-call", toolCallId: "mm", toolName: "Read", args: {} }] });
    const result = jsonBlob({ role: "tool", content: [{ type: "tool-result", toolCallId: "mm", toolName: "Grep", result: { content: "other tool output" } }] });
    const root = envelope({ parents: [blobId(call), blobId(result)] });
    await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0 },
      store: { meta: {}, blobs: [{ data: call }, { data: result }, { data: root }], root: blobId(root) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(issueByCode(session, "cursor-tool-result-mismatch")).toMatchObject({ count: 1 });
    expect(issueByCode(session, "cursor-tool-unresolved")).toMatchObject({ count: 1 });
    const tools = session.entries.filter((e) => e.tool !== undefined);
    expect(tools[0].tool?.name).toBe("Read");
    expect(tools[0].tool?.result?.type).toBe("pending"); // not silently completed by a foreign result
    expect(tools[1].tool?.name).toBe("Grep");
    expect(tools[1].tool?.result?.type).toBe("success");
    expect(tools[1].tool?.result?.log).toBe("other tool output");
  });

  it("strictly validates sidecar/store meta fields: impostor objects never enter the ref, invalid sidecar time falls back to store meta", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const msg = jsonBlob({ role: "user", content: "meta shapes" });
    await createSession(scratch, {
      hash: "a".repeat(32),
      uuid: "88888888-2222-4333-8444-555555555555",
      metaJson: { schemaVersion: 1, createdAtMs: { evil: true }, updatedAtMs: Number.NaN, cwd: 42, title: ["impostor"] },
      store: { meta: { createdAt: T0, name: "Store Title" }, blobs: [{ data: msg }], root: blobId(msg) },
    });
    await createSession(scratch, {
      hash: "b".repeat(32),
      uuid: "99999999-2222-4333-8444-555555555555",
      metaJson: null,
      store: { meta: { name: { nope: 1 }, createdAt: { deep: 2 } }, blobs: [{ data: msg }], root: blobId(msg) },
    });

    const refs = await discoverCursor(scratch);
    const first = refs.find((r) => r.id.startsWith("8888"))!;
    // Invalid sidecar createdAtMs (object) must not mask the valid store meta time.
    expect(first.startedAt).toBe(new Date(T0).toISOString());
    expect(first.cwd).toBeUndefined(); // not the number 42
    expect(first.title).toBe("Store Title"); // sidecar array title rejected, store name used
    const parsedFirst = await parseCursor(first);
    expect(parsedFirst.startedAt).toBe(new Date(T0).toISOString());
    expect(parsedFirst.cwd).toBeUndefined();
    expect(parsedFirst.title).toBe("Store Title");
    expect(parsedFirst.updatedAt).toBeUndefined(); // NaN updatedAtMs rejected, nothing fabricated

    const second = refs.find((r) => r.id.startsWith("9999"))!;
    expect(second.title).toBeUndefined(); // object name never stringified into the ref
    expect(second.startedAt).toBeUndefined(); // object createdAt rejected, unknown stays unknown
    const parsedSecond = await parseCursor(second);
    expect(parsedSecond.title).toBeUndefined();
    expect(parsedSecond.startedAt).toBeUndefined();
    expect(parsedSecond.entries.map((e) => e.text)).toEqual(["meta shapes"]);
  });

  it("diagnoses a future sidecar schemaVersion while still parsing known fields", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const msg = jsonBlob({ role: "user", content: "future proof" });
    await createSession(scratch, {
      metaJson: { schemaVersion: 2, createdAtMs: T0, cwd: "/tmp/future", title: "Future" },
      store: { meta: {}, blobs: [{ data: msg }], root: blobId(msg) },
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(session.diagnostics?.formatVersion).toBe(2);
    expect(issueByCode(session, "cursor-schema-future")).toMatchObject({ count: 1 });
    expect(session.cwd).toBe("/tmp/future"); // known fields still parsed
    expect(session.entries.map((e) => e.text)).toEqual(["future proof"]);
  });

  it("rejects non-hex and undecodable meta rows with bounded, payload-free diagnostics", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    // Not hex at all.
    await rawSession(scratch, "aaaa1111-2222-4333-8444-555555555555", (db) => {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
      db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run('{"agentId":"zz"}');
    });
    // Hex, but the JSON is truncated mid-string — SyntaxError messages would embed the payload.
    const marker = "TOPSECRET-ENCODING-KEY-9876543210";
    await rawSession(scratch, "bbbb2222-2222-4333-8444-555555555555", (db) => {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
      const truncated = `{"agentId":"x","blobEncryptionKey":"${marker}"`;
      db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(truncated).toString("hex"));
    });

    const refs = await discoverCursor(scratch);
    for (const ref of refs) {
      const session = await parseCursor(ref);
      const decode = issueByCode(session, "cursor-meta-decode");
      expect(decode).toBeDefined();
      expect(decode?.message).not.toContain(marker);
      expect(JSON.stringify(session.diagnostics)).not.toContain(marker);
      expect(issueByCode(session, "cursor-root-missing")).toBeDefined(); // no usable meta: transcript not guessed
      expect(session.entries).toEqual([]);
    }
  });

  it("reports invalid rows and duplicate ids in a PK-less blobs table instead of dropping them silently", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const good = envelope({ message: { role: "user", content: "good body" } });
    const goodId = blobId(good);
    const divergent = jsonBlob({ role: "user", content: "divergent bytes same id" });
    await rawSession(scratch, "cccc3333-2222-4333-8444-555555555555", (db) => {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT, data BLOB)"); // no PK: duplicates possible
      const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
      insert.run(goodId, good);
      insert.run(goodId, good); // true duplicate: identical bytes, same id
      insert.run(goodId, divergent); // same id, different bytes: cannot pass the hash check
      insert.run(null, good); // invalid: null id
      insert.run(goodId, null); // invalid: null data
      const meta = { latestRootBlobId: goodId, agentId: "cccc3333-2222-4333-8444-555555555555" };
      db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
    });

    const refs = await discoverCursor(scratch);
    const session = await parseCursor(refs[0]);
    expect(issueByCode(session, "cursor-blob-row-invalid")).toMatchObject({ count: 2 });
    expect(issueByCode(session, "cursor-blob-duplicate-id")).toMatchObject({ count: 2 });
    expect(issueByCode(session, "cursor-blob-hash-mismatch")).toMatchObject({ count: 1 }); // divergent bytes quarantined
    // Identical duplicate rows collapse to one node — no phantom dead branch.
    expect(issueByCode(session, "cursor-unreachable-blobs")).toBeUndefined();
    expect(session.entries.map((e) => e.text)).toEqual(["good body"]);
    expect(session.entries.map((e) => e.text).join("")).not.toContain("divergent");
  });
});

describe("refFromCursorFile", () => {
  it("builds a ref for a cursor store.db and rejects non-cursor files", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-cursor-"));
    scratchDirectories.push(scratch);

    const msg = jsonBlob({ role: "user", content: "ref" });
    const { dir } = await createSession(scratch, {
      metaJson: { schemaVersion: 1, createdAtMs: T0, cwd: "/tmp/ref", title: "Ref Test" },
      store: { meta: {}, blobs: [{ data: msg }], root: blobId(msg) },
    });
    const dbPath = join(dir, "store.db");

    const ref = await refFromCursorFile(dbPath);
    expect(ref).toBeDefined();
    expect(asAgent(ref!.agent)).toBe("cursor");
    expect(ref!.id).toBe(basename(dir));
    expect(ref!.cwd).toBe("/tmp/ref");
    const session = await parseCursor(ref!);
    expect(session.entries.map((e) => e.text)).toEqual(["ref"]);

    // meta.json path resolves to the same session via its sibling store.
    const viaMeta = await refFromCursorFile(join(dir, "meta.json"));
    expect(viaMeta?.id).toBe(ref!.id);
    expect(dirname(viaMeta!.path)).toBe(dir);

    // Arbitrary SQLite is never blessed as a cursor store.
    const alienDir = join(scratch, "e".repeat(32), "77777777-2222-4333-8444-555555555555");
    await mkdir(alienDir, { recursive: true });
    const alienPath = join(alienDir, "store.db");
    const alien = new DatabaseSync(alienPath);
    alien.exec("CREATE TABLE whatever (x TEXT)");
    alien.close();
    expect(await refFromCursorFile(alienPath)).toBeUndefined();
    expect(await refFromCursorFile(join(alienDir, "meta.json"))).toBeUndefined(); // uuid layout but no store

    // Archives copied outside the native UUID/hash layout still use source metadata.
    const copied = join(scratch, "copied-conversation.db");
    await copyFile(dbPath, copied);
    const copiedRef = await refFromCursorFile(copied);
    expect(copiedRef?.id).toBe(ref!.id);
    expect((await parseCursor(copiedRef!)).entries.map(entry => entry.text)).toEqual(["ref"]);
    expect(await refFromCursorFile(join(dir, "prompt_history.json"))).toBeUndefined();
    const loose = join(scratch, "notauuid", "store.db");
    await mkdir(dirname(loose), { recursive: true });
    await writeFile(loose, new Uint8Array([1, 2, 3]));
    expect(await refFromCursorFile(loose)).toBeUndefined();
  });
});

async function statFile(path: string): Promise<{ mtimeMs: number; size: number }> {
  const info = await stat(path);
  return { mtimeMs: info.mtimeMs, size: info.size };
}
