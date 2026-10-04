import { mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSession } from "../parse.js";
import { DatabaseSync } from "node:sqlite";
import { readSearchSession, SEARCH_CACHE_VERSION } from "../session-cache.js";
import { searchRefs } from "../search.js";
import type { SessionRef } from "../types.js";

vi.mock("../parse.js", { spy: true });
let root: string;
let ref: SessionRef;
let cache: string;
const transcript = (text: string) => [
  { type: "session", version: 4, id: "session-cache", createdAt: 1, cwd: "/synthetic" },
  { type: "user/message", seq: 0, time: 2, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text }, { type: "image" }] } },
].map(row => JSON.stringify(row)).join("\n") + "\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "asmgr-cache-test-"));
  ref = { agent: "dsh", id: "session-cache", path: join(root, "session.v4.jsonl") };
  cache = join(root, "cache");
  await writeFile(ref.path, transcript("original"));
  vi.mocked(parseSession).mockClear();
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const namespace = () => join(cache, "search", SEARCH_CACHE_VERSION);
const cachedFile = async () => join(namespace(), (await readdir(namespace())).find(name => name.endsWith(".json.gz"))!);
const manifestFile = async () => join(namespace(), (await readdir(namespace())).find(name => name.endsWith(".meta.json"))!);
const read = (query = "absent", cacheRoot: string | undefined = cache) => readSearchSession(ref, query, cacheRoot);

describe("private canonical search-text index", () => {
  it("skips negative reads, retains provenance/notices, uses private permissions and one slot", async () => {
    const first = (await read()).parsed;
    const second = (await read()).parsed;
    expect(second.entries).toEqual([]);
    expect(second.source).toEqual(first.source);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(parseSession).toHaveBeenCalledTimes(1);
    if (process.platform !== "win32") {
      expect((await stat(namespace())).mode & 0o777).toBe(0o700);
      expect((await stat(await cachedFile())).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(namespace())).toHaveLength(2);
    expect(await readFile(ref.path, "utf8")).toBe(transcript("original"));
  });

  it("invalidates edits even when source size and mtime are restored", async () => {
    await read();
    const before = await stat(ref.path);
    await writeFile(ref.path, transcript("modified"));
    await utimes(ref.path, before.atime, before.mtime);
    expect((await read("modified")).parsed.entries[0].text).toContain("modified");
    expect(parseSession).toHaveBeenCalledTimes(2);
    expect(await readdir(namespace())).toHaveLength(2);
  });

  it("repairs corrupt caches, bypasses unavailable roots and does not require a cache", async () => {
    await read();
    await writeFile(await cachedFile(), "corrupt gzip");
    expect((await read("original")).parsed.entries[0].text).toContain("original");
    expect((await read("absent", ref.path)).parsed.entries[0].text).toContain("original");
    expect((await readSearchSession(ref, "absent", undefined)).parsed.entries[0].text).toContain("original");
    expect(parseSession).toHaveBeenCalledTimes(4);
  });

  it("does not cache a changing source and preserves genuine parse errors", async () => {
    vi.mocked(parseSession).mockImplementationOnce(async source => {
      const session = await vi.importActual<typeof import("../parse.js")>("../parse.js").then(module => module.parseSession(source));
      await writeFile(source.path, transcript("changed during read"));
      return session;
    });
    await read();
    await expect(stat(namespace())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readSearchSession({ ...ref, path: join(root, "missing") }, "absent", cache)).rejects.toThrow("无法解析");
    expect(parseSession).toHaveBeenCalledTimes(2);
  });

  it("matches escaped strings, case folding and UTF16 surrogate queries without false negatives", async () => {
    await writeFile(ref.path, transcript('QUOTED "value" \\ path\n下一行\t🙂 Σ'));
    await read();
    for (const query of ['quoted "value"', "\\ path\n下", "\t🙂", "\ud83d", "\ude42", "σ"]) {
      const uncached = await searchRefs([ref], query, 20);
      const cached = await searchRefs([ref], query, 20, { cacheDir: cache });
      expect(cached).toEqual(uncached);
      expect(cached).toHaveLength(1);
    }
  });

  it("rejects malformed diagnostic manifests and repairs missing or corrupt sidecars", async () => {
    await writeFile(ref.path, transcript("original") + JSON.stringify({ type: "future/event", seq: 1, time: 3, data: {} }) + "\n");
    await read();
    const manifest = await manifestFile();
    const header = JSON.parse(await readFile(manifest, "utf8"));
    header.diagnostics.issues = {};
    await writeFile(manifest, JSON.stringify(header));
    const report = vi.fn();
    expect(await searchRefs([ref], "absent sentinel", 20, { cacheDir: cache, onDiagnostic: report })).toEqual([]);
    expect(report.mock.calls.some(([event]) => event.kind === "unreadable")).toBe(false);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning", code: "unknown-event" }));
    await unlink(manifest);
    await read();
    expect((await stat(manifest)).size).toBeGreaterThan(0);
    const good = JSON.parse(await readFile(manifest, "utf8"));
    good.bloom = "corrupt";
    await writeFile(manifest, JSON.stringify(good));
    expect((await read("original")).parsed.entries[0].text).toContain("original");
  });

  it("a validated Bloom negative need not read a corrupt text index; short queries do", async () => {
    await read();
    await writeFile(await cachedFile(), "corrupt gzip");
    expect((await read("absent sentinel")).parsed.entries).toEqual([]);
    expect(parseSession).toHaveBeenCalledTimes(1);
    expect((await read("or")).parsed.entries[0].text).toContain("original");
    expect(parseSession).toHaveBeenCalledTimes(2);
  });

  it("bypasses live SQLite WAL indexes so main-DB stat equality cannot hide new turns", async () => {
    const path = join(root, "session-store.db");
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,repository TEXT,branch TEXT,summary TEXT);
        CREATE TABLE turns(session_id TEXT,turn_index INTEGER,user_message TEXT,assistant_response TEXT);
        INSERT INTO sessions VALUES('wal-session','/synthetic',NULL,NULL,'WAL session');
        INSERT INTO turns VALUES('wal-session',1,'original','answer');
        PRAGMA wal_checkpoint(TRUNCATE);`);
      const source: SessionRef = { agent: "copilot", id: "wal-session", path,
        source: { kind: "db-turns", path, lossy: true } };
      const before = await stat(path, { bigint: true });
      expect(await searchRefs([source], "wal-needle", 20, { cacheDir: cache })).toEqual([]);
      db.exec("INSERT INTO turns VALUES('wal-session',2,'wal-needle','new answer')");
      const after = await stat(path, { bigint: true });
      expect([after.size, after.mtimeNs, after.ctimeNs]).toEqual([before.size, before.mtimeNs, before.ctimeNs]);
      expect(await searchRefs([source], "wal-needle", 20, { cacheDir: cache })).toHaveLength(1);
      await expect(stat(namespace())).rejects.toMatchObject({ code: "ENOENT" });
    } finally { db.close(); }
  });

  it("positive candidates still return canonical tool details instead of synthetic cached entries", async () => {
    await writeFile(ref.path, transcript("original") + JSON.stringify({ type: "tool/call", seq: 1, time: 3,
      data: { callId: "read", name: "read", arguments: JSON.stringify({ path: "needle.txt" }) } }) + "\n");
    await read();
    const hits = await searchRefs([ref], "needle.txt", 20, { cacheDir: cache });
    expect(hits[0].entry.tool?.callId).toBe("read");
  });
});
