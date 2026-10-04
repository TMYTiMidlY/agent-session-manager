import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { detectAgent, discoverPath, discoverSessions, parseSession, refFromFile } from "../index.js";
import { discoverDsh, selectDshGenerations } from "../adapters/dsh.js";

const directories: string[] = [];
const header = (version = 3, id = "dsh-fixture") => ({ type: "session", version, id, createdAt: 1,
  cwd: "/fixture/workspace", delegationDepth: 0, ...(version >= 2 ? { isSeeded: false } : {}) });

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "asmgr-dsh-source-"));
  directories.push(path);
  return path;
}

async function session(path: string, version = 3, id = "dsh-fixture"): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(header(version, id)) + "\n";
  await writeFile(path, path.endsWith(".zstd") ? zstdCompressSync(text) : text);
  return path;
}

describe("DSH sources", () => {
  it("detects only a DSH header rather than dotted plugin payloads", () => {
    expect(detectAgent([header()])).toBe("dsh");
    expect(detectAgent([{ type: "session", unrelated: true }])).toBeUndefined();
  });

  it.each(["session.v3.jsonl", "session.v3.jsonl.zstd", "session.v4.jsonl", "renamed.log"])("reads the authoritative header from %s", async (name) => {
    const path = await session(join(await root(), name), name.includes("v4") ? 4 : 3);
    const ref = await refFromFile(path);
    expect(ref).toMatchObject({ agent: "dsh", id: "dsh-fixture", cwd: "/fixture/workspace", startedAt: "1970-01-01T00:00:00.001Z" });
    expect((await parseSession(ref)).entries).toEqual([]);
    await expect(refFromFile(path, "copilot")).rejects.toThrow(/不匹配/);
  });

  it("selects the highest generation per session without duplicating historical files", async () => {
    const directory = await root();
    await session(join(directory, "project", "a", "session.jsonl.zstd"), 0);
    await session(join(directory, "project", "a", "session.v3.jsonl.zstd"));
    const current = await session(join(directory, "project", "a", "session.v4.jsonl.zstd"), 4);
    await writeFile(join(directory, "project", "a", "session.v5.jsonl.zstd.tmp"), "not a session");
    const refs = await discoverDsh(directory);
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe(current);
    expect(await discoverPath(directory)).toEqual(refs);
  });

  it("selects future generations without falling back to stale archives", async () => {
    const directory = await root();
    const old = await session(join(directory, "project", "a", "session.jsonl"), 0);
    await session(join(directory, "project", "a", "session.v4.jsonl"), 4);
    const future = await session(join(directory, "project", "a", "session.v99.jsonl"), 99);
    const refs = await discoverDsh(directory);
    expect(refs.map(ref => ref.path)).toEqual([future]);
    expect((await parseSession(refs[0])).source?.warning).toContain("v99");
    // An explicit file still means that precise historical artifact.
    expect((await parseSession(await refFromFile(old))).id).toBe("dsh-fixture");
  });

  it("refuses filename/header version mismatches and ambiguous encodings", async () => {
    const path = await session(join(await root(), "session.v2.jsonl"));
    await expect(refFromFile(path)).rejects.toThrow(/文件名版本 v2.*文件头 v3/);
    expect(() => selectDshGenerations(["/a/session.v3.jsonl", "/a/session.v3.jsonl.zstd"])).toThrow(/两种编码/);
  });

  it("uses DSH_HOME unless an explicit sessions root overrides it", async () => {
    const home = await root();
    const override = await root();
    await session(join(home, "sessions", "project", "a", "session.v3.jsonl"), 3, "from-home");
    await session(join(override, "project", "b", "session.v3.jsonl"), 3, "from-override");
    vi.stubEnv("DSH_HOME", home);
    expect((await discoverSessions(["dsh"]))[0].id).toBe("from-home");
    expect((await discoverSessions(["dsh"], { dsh: override }))[0].id).toBe("from-override");
  });
});
