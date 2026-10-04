/** Exercise the published CLI contract under Node or an actual compiled Bun binary. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";

const artifact = resolve(process.argv[2] ?? "dist/asmgr.mjs");
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const directory = await mkdtemp(join(tmpdir(), "asmgr-artifact-smoke-"));
const frame = text => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const run = args => spawnSync(artifact.endsWith(".mjs") ? process.execPath : artifact,
  artifact.endsWith(".mjs") ? [artifact, ...args] : args,
  { encoding: "utf8", timeout: 20_000, env: { ...process.env, DSH_SESSION_ID: "session-smoke", ASMGR_CACHE_HOME: join(directory, "cache") } });
const success = args => {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result;
};
try {
  const valid = join(directory, "valid");
  await mkdir(valid);
  const path = join(valid, "session.v4.jsonl.zstd");
  const rows = [
    { type: "session", version: 4, id: "session-smoke", createdAt: 1, cwd: directory },
    { type: "user/message", seq: 0, time: 2, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "smoke question" }, { type: "image" }] } },
    { type: "assistant/message", seq: 1, time: 3, surfaceOp: "append", data: { message: { role: "assistant", content: [{ type: "text", text: "smoke final answer" }] } } },
  ];
  const frames = rows.map(row => frame(JSON.stringify(row) + "\n"));
  await writeFile(path, Buffer.concat(frames));
  assert.equal(success(["--version"]).stdout.trim(), version);
  assert.equal(success(["current"]).stdout.trim(), "session-smoke");
  const source = ["--agent", "dsh", "--dsh-root", valid];
  const listed = JSON.parse(success(["list", ...source, "--cwd", directory, "--json"]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "session-smoke");
  assert.equal(typeof listed[0].size, "number");
  const searched = success(["search", "smoke", ...source, "--role", "assistant", "-l", "1"]);
  assert.match(searched.stdout, /#2\tassistant\/message\t[^\n]*smoke final answer/);
  assert.equal(searched.stderr, "");
  const parsed = JSON.parse(success(["show", "--file", path, "-f", "json"]).stdout);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[1].text, "smoke final answer");
  // Negative prefilter correctness and invalidation under the actual runtime.
  assert.equal(success(["search", "cache question", "--file", path]).stdout, "");
  const previous = await stat(path);
  const changedRows = JSON.parse(JSON.stringify(rows));
  changedRows[1].data.content[0].text = "cache question";
  const changed = Buffer.concat(changedRows.map(row => frame(JSON.stringify(row) + "\n")));
  await writeFile(path, changed);
  await utimes(path, previous.atime, previous.mtime);
  assert.match(success(["search", "cache question", "--file", path]).stdout, /cache question/);
  for (let i = 1; i <= 4; i++) {
    const sibling = join(valid, `sibling-${i}`);
    await mkdir(sibling);
    await writeFile(join(sibling, "session.v4.jsonl.zstd"), Buffer.concat([
      frame(JSON.stringify({ ...rows[0], id: `session-smoke-${i}` }) + "\n"), ...frames.slice(1),
    ]));
  }
  const parallel = success(["search", "smoke final answer", ...source, "-j", "2", "-l", "1", "--no-cache", "--verbose"]);
  assert.equal(parallel.stdout.trim().split("\n").length, 1);
  assert.match(parallel.stderr, /search backend: (workers \(2\)|in-process fallback)/);
  if (artifact.endsWith(".mjs")) assert.match(parallel.stderr, /search backend: workers \(2\)/);
  for (const [label, tail] of [
    ["truncated", frames[2].subarray(0, frames[2].length - 1)],
    ["partial-magic", frames[2].subarray(0, 3)],
    ["checksum", Buffer.from(frames[2])],
  ]) {
    if (label === "checksum") tail[tail.length - 1] ^= 0xff;
    const bad = join(directory, `${label}.jsonl.zstd`);
    await writeFile(bad, Buffer.concat([frames[0], frames[1], tail]));
    assert.equal(run(["show", "--file", bad, "--agent", "dsh"]).status, 1, `${label} must fail full parsing`);
    // Metadata sampling is intentionally allowed to read just the valid header.
    assert.equal(JSON.parse(success(["list", "--file", bad, "--agent", "dsh", "--json"]).stdout).length, 1);
  }
  console.log(`[smoke] ${artifact}: version, discovery, multi-frame dialogue/search, notices, checksum and truncated tails passed`);
} finally {
  assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), "asmgr-artifact-smoke-")), "cleanup must target this smoke test's temporary directory");
  await rm(directory, { recursive: true, force: true });
}
