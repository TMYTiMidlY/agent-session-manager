import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = resolve("src/cli/index.ts");
const tsx = resolve("node_modules/.bin/tsx");
let root: string;
const run = (args: string[], env = process.env) => exec(tsx, [cli, ...args], { env: { ...env, ASMGR_CACHE_HOME: join(root, "cache") } });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "asmgr-cli-discovery-"));
  for (const [id, cwd, time] of [["a-old", "/other", 1], ["z-new", "/workspace", 10]] as const) {
    const directory = join(root, id);
    await mkdir(directory);
    const path = join(directory, "session.v4.jsonl");
    await writeFile(path, [
      { type: "session", version: 4, id: `session-${id}`, cwd, createdAt: 1 },
      { type: "user/message", seq: 0, time: 2, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "needle user" }, { type: "image" }] } },
      { type: "assistant/message", seq: 1, time: 3, surfaceOp: "append", data: { message: { role: "assistant", content: [{ type: "text", text: "needle assistant" }] } } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await utimes(path, time, time);
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const source = () => ["--agent", "dsh", "--dsh-root", root];

describe("session discovery and search CLI usability", { timeout: 20000 }, () => {
  it("keeps the old TSV columns, adds mtime/size/cwd and defaults to newest-first", async () => {
    const { stdout } = await run(["list", ...source()]);
    const rows = stdout.trim().split("\n").map(row => row.split("\t"));
    expect(rows.map(row => row[1])).toEqual(["session-z-new", "session-a-old"]);
    expect(rows[0]).toHaveLength(6);
    expect(rows[0][3]).toBe("1970-01-01T00:00:10.000Z");
    expect(Number(rows[0][4])).toBeGreaterThan(0);
    expect(rows[0][5]).toBe("/workspace");
  });

  it("supports exact normalized cwd, JSON, explicit sorting and limits", async () => {
    const filtered = await run(["list", ...source(), "--cwd", "/workspace/", "--json"]);
    expect(JSON.parse(filtered.stdout).map((ref: { id: string }) => ref.id)).toEqual(["session-z-new"]);
    const sorted = await run(["list", ...source(), "--sort", "id", "-l", "1", "--json"]);
    expect(JSON.parse(sorted.stdout)[0].id).toBe("session-a-old");
  });

  it("keeps default attachment notices silent and verbose notices aggregated", async () => {
    const normal = await run(["search", "needle", ...source()]);
    expect(normal.stderr).toBe("");
    expect(normal.stdout.trim().split("\n")).toHaveLength(4);
    const verbose = await run(["search", "absent", ...source(), "--verbose"]);
    expect(verbose.stdout).toBe("");
    expect(verbose.stderr).toContain("2 个会话：图片和文件附件");
    const quiet = await run(["search", "needle", ...source(), "--verbose", "--quiet"]);
    expect(quiet.stderr).toBe("");
  });

  it("searches exact cwd/role, uses latest session first, and retains the cap in full scan", async () => {
    for (const extra of [[], ["--no-early-exit"]]) {
      const { stdout } = await run(["search", "needle", ...source(), "--cwd", "/workspace", "--role", "user", "-l", "1", ...extra]);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(stdout).toContain("session-z-new\t#1\tuser/message");
    }
  });

  it("filters dialogue by role without renumbering the source indices", async () => {
    const { stdout } = await run(["show", "z-new", ...source(), "-f", "dialogue", "--role", "assistant"]);
    expect(stdout).toContain("## 2. assistant/message");
    expect(stdout).not.toContain("needle user");
  });

  it("current uses injected identity and refuses to guess newest when it is absent", async () => {
    const current = await run(["current"], { ...process.env, DSH_SESSION_ID: "session-a-old" });
    expect(current.stdout.trim()).toBe("session-a-old");
    const json = await run(["current", "--json", "--dsh-root", root], { ...process.env, DSH_SESSION_ID: "session-a-old" });
    expect(JSON.parse(json.stdout).cwd).toBe("/other");
    await expect(run(["current"], { ...process.env, DSH_SESSION_ID: "" })).rejects.toThrow("DSH_SESSION_ID is not set");
  });

  it("isolates corrupt headers in directory discovery/search but refuses an explicit bad file", async () => {
    const directory = join(root, "broken");
    await mkdir(directory);
    const path = join(directory, "session.v4.jsonl");
    await writeFile(path, "not JSON\n");
    const searched = await run(["search", "needle", ...source()]);
    expect(searched.stdout).toContain("needle user");
    expect(searched.stderr).toContain("跳过无法解析的会话：1 个");
    const quiet = await run(["search", "needle", ...source(), "-q"]);
    expect(quiet.stderr).toBe("");
    await expect(run(["show", "--file", path, "--agent", "dsh"])).rejects.toThrow("无效的 DSH session 文件头");
  });

  it("rejects ambiguous prefixes and invalid limits/concurrency, and zero means no search", async () => {
    await expect(run(["search", "needle", ...source(), "--session", "session-"])).rejects.toThrow("ambiguous session id");
    for (const [flag, value] of [["-l", "-1"], ["-l", "wat"], ["-l", "1.5"], ["-j", "0"], ["--role", "random"]]) {
      await expect(run(["search", "needle", ...source(), flag, value])).rejects.toThrow();
    }
    expect((await run(["search", "needle", "--file", "/missing", "-l", "0"])).stdout).toBe("");
  }, 20000);
});
