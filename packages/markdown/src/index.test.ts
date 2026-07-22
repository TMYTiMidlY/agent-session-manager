import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "./index.js";
import type { ParsedSession } from "@agent-session-manager/core";

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

  it("renders subagent / skill / plan entries (dredge-up parity)", () => {
    const out = renderSessionMarkdown(session([
      { index: 0, role: "event", kind: "subagent", title: "Explore", text: "scout the repo",
        data: { model: "claude", failed: false } },
      { index: 1, role: "event", kind: "skill", title: "dredge-up", text: "session recap", data: { source: "project", trigger: "user" } },
      { index: 2, role: "event", kind: "plan", text: "Plan updated", data: { operation: "updated" } },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### 🤖 Subagent: Explore");
    expect(out).toContain("claude");
    expect(out).toContain("### ✨ Skill: dredge-up");
    expect(out).toContain("**Source:** project");
    expect(out).toContain("**Trigger:** user");
    expect(out).toContain("### 📋 Plan");
  });

  it("renders compaction status, stats, and the summary in a fenced block", () => {
    const out = renderSessionMarkdown(session([
      {
        index: 0,
        role: "event",
        kind: "compaction",
        text: "Recap: the parser needs a fix.",
        data: {
          success: true,
          preTokens: 120000,
          preMessages: 40,
          durationMs: 4250,
          model: "claude",
        },
      },
      {
        index: 1,
        role: "event",
        kind: "compaction",
        text: "No summary was installed.",
        data: { success: false },
      },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### ◌ Conversation Compacted");
    expect(out).toContain("<sub>120000 tokens · 40 messages · 4.25s · claude</sub>");
    expect(out).toContain("```\nRecap: the parser needs a fix.\n```");
    expect(out).toContain("### ✗ Compaction Failed");
    expect(out).toContain("```\nNo summary was installed.\n```");
  });

  it("distinguishes failed task completion", () => {
    const out = renderSessionMarkdown(session([
      { index: 0, role: "event", kind: "task_complete", text: "done", data: { isError: false } },
      { index: 1, role: "event", kind: "task_complete", text: "broken", data: { isError: true } },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### ✓ Task Complete\n\ndone");
    expect(out).toContain("### ✗ Task Complete (failed)\n\nbroken");
  });

  it("falls back to notification kind data when detail is absent", () => {
    const out = renderSessionMarkdown(session([
      {
        index: 0,
        role: "event",
        kind: "notification",
        text: "Approval required",
        data: { kind: { type: "permission_request" } },
      },
    ]), { exportedAt: fixedDate });
    expect(out).toContain("### ℹ️ Notification");
    expect(out).toContain("permission_request");
  });

  it("shows a fallback source note only for non-canonical sources", () => {
    const fallback = renderSessionMarkdown(session([]), {
      exportedAt: fixedDate,
      sourceLabel: "db.turns (fallback)",
    });
    const canonical = renderSessionMarkdown(session([]), {
      exportedAt: fixedDate,
      sourceLabel: "events.jsonl",
    });
    expect(fallback).toContain("[!WARNING]");
    expect(fallback).toContain("db.turns (fallback)");
    expect(canonical).not.toContain("[!WARNING]");
  });
});
