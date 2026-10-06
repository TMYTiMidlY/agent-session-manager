import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    if (!path.startsWith(join(tmpdir(), "asmgr-review-"))) throw new Error("unexpected test cleanup path");
    await rm(path, { recursive: true, force: true });
  }
});
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "asmgr-review-"));
  directories.push(path); return path;
}
async function session(dir: string, id: string, role = "user", parent?: string): Promise<string> {
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, [
    { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id, thread_source: role, parent_thread_id: parent, cwd: "/synthetic" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_USER_BODY" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible-needle" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  return path;
}
async function run(args: string[]): Promise<string> {
  let output = "";
  const log = vi.spyOn(console, "log").mockImplementation((...values) => { output += values.join(" ") + "\n"; });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += chunk.toString(); return true; });
  try { await buildProgram().exitOverride().parseAsync(args, { from: "user" }); }
  finally { log.mockRestore(); write.mockRestore(); }
  return output;
}

describe("independent-review regressions", () => {
  it("resolves session ambiguity before excluding guardian noise", async () => {
    const dir = await root();
    await session(dir, "shared-main");
    await session(dir, "shared-guardian", "guardian_review", "shared-main");
    await expect(run(["search", "needle", "--file", dir, "--session", "shared", "--no-cache", "-j", "1", "--quiet"])).rejects.toThrow("ambiguous session id");
    const output = await run(["search", "needle", "--file", dir, "--session", "shared-guardian", "--no-cache", "-j", "1", "--quiet"]);
    expect(output).toContain("shared-guardian");
    expect(output).toContain("visible-needle");
  });
  it("filters every JSON transcript carrier and marks the reduced native view", async () => {
    const dir = await root();
    const file = await session(dir, "main");
    const value = JSON.parse(await run(["show", "--file", file, "--role", "assistant", "--no-guardian", "-f", "json"]));
    expect(value.entries.map((entry: { role: string }) => entry.role)).toEqual(["assistant"]);
    expect(value.entries[0].index).toBe(1);
    expect(value.document.blocks.map((block: { role: string }) => block.role)).toEqual(["assistant"]);
    expect(value.document.view).toEqual({ role: "assistant", nativeContent: "omitted" });
    expect(JSON.stringify(value)).not.toContain("PRIVATE_USER_BODY");
  });
  it("returns a valid empty JSON array without opening a zero-limit source", async () => {
    expect(JSON.parse(await run(["list", "--file", "/nonexistent-review-source", "--stats", "--limit", "0", "-f", "json"]))).toEqual([]);
    await expect(run(["list", "--stats", "--by", "agent", "--limit", "0"])).rejects.toThrow("cannot be combined");
  });
  it("marks deep tree truncation instead of recursing without a bound", async () => {
    const dir = await root();
    for (let n = 0; n < 5; n++) await session(dir, `depth-${n}`, n ? "subagent" : "user", n ? `depth-${n - 1}` : undefined);
    const value = JSON.parse(await run(["tree", "depth-0", "--file", dir, "--max-depth", "2", "--json"]));
    expect(value.node.children[0].children[0].childrenTruncated).toBe(true);
    expect(value.node.children[0].children[0].children).toEqual([]);
    expect(await run(["tree", "depth-0", "--file", dir, "--max-depth", "2"])).toContain("children truncated");
  });
});
