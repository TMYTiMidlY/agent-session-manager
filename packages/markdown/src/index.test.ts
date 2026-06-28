import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "./index.js";
import type { ParsedSession } from "@agent-session-exporter/core";

const fixedDate = new Date("2026-01-01T00:01:30.000Z");

function session(entries: ParsedSession["entries"]): ParsedSession {
  return {
    agent: "copilot",
    id: "test",
    path: "/dev/null",
    startedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    entries,
  };
}

describe("renderSessionMarkdown", () => {
  it("emits the Copilot share-file header skeleton", () => {
    const out = renderSessionMarkdown(session([]), { exportedAt: fixedDate });
    expect(out).toContain("# 🤖 Copilot CLI Session");
    expect(out).toContain("**Session ID:** `test`");
    expect(out).toContain("**Duration:** 1m 30s");
    expect(out).toContain("**Cwd:** `/tmp/project`");
  });

  it("renders user/assistant entries with the right emoji headings", () => {
    const out = renderSessionMarkdown(session([
      { index: 0, role: "user", kind: "message", text: "hello", timestamp: "2026-01-01T00:00:10.000Z" },
      { index: 1, role: "assistant", kind: "message", text: "world", timestamp: "2026-01-01T00:00:20.000Z" },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### 👤 User");
    expect(out).toContain("### 💬 Copilot");
    expect(out).toContain("⏱️ 10s");
    expect(out).toContain("⏱️ 20s");
  });

  it("renders merged tool entries with compact arg summary and success emoji", () => {
    const out = renderSessionMarkdown(session([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "hello\nworld",
        timestamp: "2026-01-01T00:00:10.000Z",
        tool: {
          name: "bash",
          arguments: { command: "echo hello" },
          result: { type: "success", log: "hello\nworld" },
        },
      },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### ✅ `bash`");
    expect(out).toContain("`$ echo hello`");
    expect(out).toContain("hello\nworld");
  });

  it("wraps long output in <details>", () => {
    const log = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const out = renderSessionMarkdown(session([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: log,
        tool: { name: "bash", arguments: { command: "do" }, result: { type: "success", log } },
      },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("<details>");
    expect(out).toContain("30 lines");
  });

  it("uses ```diff fence for diff-looking output", () => {
    const log = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
    const out = renderSessionMarkdown(session([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: log,
        tool: { name: "bash", arguments: { command: "git diff" }, result: { type: "success", log } },
      },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("```diff");
  });

  it("handles failure result with ❌", () => {
    const out = renderSessionMarkdown(session([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "boom",
        tool: { name: "bash", arguments: { command: "false" }, result: { type: "failure", log: "boom" } },
      },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### ❌ `bash`");
  });

  it("injects --summary block above entries", () => {
    const out = renderSessionMarkdown(session([
      { index: 0, role: "user", kind: "message", text: "go", timestamp: "2026-01-01T00:00:10.000Z" },
    ]), { exportedAt: fixedDate, summary: "## Summary\n\n- did the thing" });
    const summaryIdx = out.indexOf("## Summary");
    const userIdx = out.indexOf("### 👤 User");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(summaryIdx);
  });

  it("excludes reasoning when includeReasoning=false", () => {
    const out = renderSessionMarkdown(session([
      { index: 0, role: "reasoning", kind: "reasoning", text: "thinking", timestamp: "2026-01-01T00:00:05.000Z" },
      { index: 1, role: "user", kind: "message", text: "hi", timestamp: "2026-01-01T00:00:10.000Z" },
    ]), { exportedAt: fixedDate, includeReasoning: false });
    expect(out).not.toContain("### 💭 Reasoning");
    expect(out).toContain("### 👤 User");
  });
});
