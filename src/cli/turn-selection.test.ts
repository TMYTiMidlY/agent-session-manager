import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program.js";

const exec = promisify(execFile);
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(here, "../..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const cliEntry = resolve(here, "index.ts");
/** Real process: commander reports option-parse errors through exit, not exceptions. */
const runCli = (args: string[]) => exec(tsx, [cliEntry, ...args]);

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    if (!path.startsWith(join(tmpdir(), "asmgr-turn-"))) throw new Error("unexpected test cleanup path");
    await rm(path, { recursive: true, force: true });
  }
});
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "asmgr-turn-"));
  directories.push(path); return path;
}
async function writeRows(path: string, rows: unknown[]): Promise<string> {
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

const PROMPT_ONE = [
  "帮我看下这个报错：",
  "",
  "```",
  "Error: EACCES permission denied",
  "```",
  "第二步才出现。",
].join("\n");

/** Real-world Codex shape: AGENTS instructions and skill bodies arrive as user-role items. */
function codexRows(id: string): unknown[] {
  return [
    { type: "session_meta", timestamp: "2026-01-01T00:00:00.000Z", payload: { id, cwd: "/synthetic" } },
    { timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions for /synthetic\n\n<INSTRUCTIONS>\nuse pnpm\n</INSTRUCTIONS>" }] } },
    { timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: PROMPT_ONE }] } },
    { timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "这是权限问题，先看文件属主。" }] } },
    { timestamp: "2026-01-01T00:00:04.000Z", type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "<skill>\n<name>demo</name>\n</skill>\n" }] } },
    { timestamp: "2026-01-01T00:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "已加载技能，继续排查。" }] } },
    { timestamp: "2026-01-01T00:00:06.000Z", type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>' }] } },
    { timestamp: "2026-01-01T00:00:07.000Z", type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "修好了，谢谢。" }] } },
    { timestamp: "2026-01-01T00:00:08.000Z", type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "不客气。" }] } },
  ];
}

/** Claude shape: injected context rides user rows flagged isMeta / isCompactSummary. */
function claudeRows(): unknown[] {
  return [
    { type: "user", timestamp: "2026-01-01T00:00:01Z", isMeta: true,
      message: { role: "user", content: "<system-context>caveat</system-context>" } },
    { type: "user", timestamp: "2026-01-01T00:00:02Z",
      message: { role: "user", content: "claude prompt one" } },
    { type: "assistant", timestamp: "2026-01-01T00:00:03Z",
      message: { role: "assistant", content: [{ type: "text", text: "claude reply" }] } },
    { type: "user", timestamp: "2026-01-01T00:00:04Z", isCompactSummary: true,
      message: { role: "user", content: "早前对话已压缩成摘要" } },
    { type: "user", timestamp: "2026-01-01T00:00:05Z",
      message: { role: "user", content: "claude prompt two" } },
  ];
}

async function run(args: string[]): Promise<string> {
  let output = "";
  const log = vi.spyOn(console, "log").mockImplementation((...values) => { output += values.join(" ") + "\n"; });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += chunk.toString(); return true; });
  try { await buildProgram().exitOverride().parseAsync(args, { from: "user" }); }
  finally { log.mockRestore(); write.mockRestore(); }
  return output;
}

describe("show --turn and --format plain", () => {
  it("prints the first human turn's user text verbatim, excluding injected context", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    const output = await run(["show", "--file", file, "--turn", "1", "--role", "user", "-f", "plain"]);
    // Exact body, byte for byte: no session header, indices, timestamps, or titles.
    expect(output).toBe(`${PROMPT_ONE}\n`);
  });

  it("keeps original numbering in the selected turn's dialogue and drops injections", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    const output = await run(["show", "--file", file, "--turn", "1", "-f", "dialogue"]);
    expect(output).toContain("## 2. user/message 2026-01-01T00:00:02.000Z");
    expect(output).toContain("## 3. assistant/message");
    expect(output).toContain("## 5. assistant/message");
    expect(output).not.toContain("## 1.");
    expect(output).not.toContain("## 4.");
    expect(output).not.toContain("AGENTS.md instructions");
    expect(output).not.toContain("<skill>");
    expect(output).not.toContain("修好了");
  });

  it("numbers turns over the full timeline so --role cannot shift them", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    expect(await run(["show", "--file", file, "--turn", "2", "--role", "user", "-f", "plain"])).toBe("修好了，谢谢。\n");
    const value = JSON.parse(await run(["show", "--file", file, "--turn", "1", "--role", "user", "-f", "json", "--no-guardian"]));
    expect(value.document.view).toEqual({ turn: 1, role: "user", nativeContent: "omitted" });
    expect(value.entries.map((entry: { index: number }) => entry.index)).toEqual([1]);
    const whole = JSON.stringify(value);
    expect(whole).not.toContain("AGENTS.md instructions");
    expect(whole).not.toContain("<name>demo</name>");
  });

  it("marks the reduced JSON document view with the selected turn", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    const value = JSON.parse(await run(["show", "--file", file, "--turn", "1", "-f", "json", "--no-guardian"]));
    expect(value.document.view).toEqual({ turn: 1, nativeContent: "omitted" });
    expect(value.entries.map((entry: { index: number }) => entry.index)).toEqual([1, 2, 4]);
  });

  it("rejects out-of-range and malformed turn values", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    await expect(run(["show", "--file", file, "--turn", "3"])).rejects.toThrow(/session has 2 user turns/);
    for (const value of ["0", "1.5", "wat"]) {
      await expect(runCli(["show", "--file", file, "--turn", value])).rejects.toThrow(/positive integer/);
    }
  }, 30000);

  it("validates the format choice instead of silently rendering text", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    await expect(runCli(["show", "--file", file, "-f", "bogus"])).rejects.toThrow(/invalid/);
  }, 30000);

  it("never merges guardian sub-threads under --turn", async () => {
    const dir = await root();
    await writeRows(join(dir, "turn-main.jsonl"), codexRows("turn-main"));
    await writeRows(join(dir, "turn-guardian.jsonl"), [
      { type: "session_meta", timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "turn-guardian", cwd: "/synthetic", thread_source: "guardian_review", parent_thread_id: "turn-main" } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: "guardian private body" }] } },
    ]);
    const turned = await run(["show", "turn-main", "--file", dir, "--turn", "1", "-f", "dialogue"]);
    expect(turned).not.toContain("guardian sub-thread");
    expect(turned).not.toContain("guardian private body");
    const merged = await run(["show", "turn-main", "--file", dir, "-f", "dialogue"]);
    expect(merged).toContain("guardian sub-thread");
    expect(merged).toContain("guardian private body");
  });

  it("treats claude isMeta and compact-summary rows as context, not turns", async () => {
    const dir = await root();
    const file = await writeRows(join(dir, "claude-turns.jsonl"), claudeRows());
    expect(await run(["show", "--file", file, "--turn", "1", "--role", "user", "-f", "plain"])).toBe("claude prompt one\n");
    expect(await run(["show", "--file", file, "--turn", "2", "--role", "user", "-f", "plain"])).toBe("claude prompt two\n");
  });

  it("sends lossy-source warnings to stderr so plain stdout stays clean", async () => {
    let stderr = "";
    const error = vi.spyOn(console, "error").mockImplementation((...values) => { stderr += values.join(" ") + "\n"; });
    try {
      const output = await run(["show", "--file", join(repoRoot, "fixtures/chatgpt-fixture.chatgpt-share.json"), "-f", "plain"]);
      expect(output).not.toContain("warning:");
      expect(output).not.toContain("session:");
      expect(output).not.toContain("## ");
      expect(stderr).toMatch(/^warning: /);
    } finally { error.mockRestore(); }
  });
});
