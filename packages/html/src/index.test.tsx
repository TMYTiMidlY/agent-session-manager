import { describe, expect, it } from "vitest";
import { renderSessionHtml } from "./index.js";
import type { ParsedSession } from "@agent-session-exporter/core";

function baseSession(entries: ParsedSession["entries"]): ParsedSession {
  return {
    agent: "copilot",
    id: "fixture",
    path: "/tmp/events.jsonl",
    entries,
  };
}

describe("renderSessionHtml", () => {
  it("renders a standalone HTML document with a single user entry", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "hello recall" },
    ]));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("hello recall");
    expect(html).toContain('id="search"');
    expect(html).toContain('data-filter="user"');
  });

  it("renders a merged tool card with status-success border + inline arg summary", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "ok",
        title: "bash",
        tool: {
          name: "bash",
          arguments: { command: "ls /tmp" },
          result: { type: "success", log: "ok" },
        },
      },
    ]));
    expect(html).toContain("tool-success");
    expect(html).toContain("$ ls /tmp");
    expect(html).toContain('data-filter="tool"');
  });

  it("renders a failure tool card with status-failure class", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "boom",
        tool: { name: "bash", arguments: { command: "false" }, result: { type: "failure", log: "boom" } },
      },
    ]));
    expect(html).toContain("tool-failure");
  });

  it("renders subagent / skill / plan cards + pills (dredge-up parity)", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "event", kind: "subagent", title: "Explore", text: "scout",
        data: { model: "claude", failed: false } },
      { index: 1, role: "event", kind: "skill", title: "dredge-up", text: "recap", data: { source: "project", trigger: "user" } },
      { index: 2, role: "event", kind: "plan", text: "Plan updated", data: { operation: "updated" } },
    ]));
    expect(html).toContain('data-filter="subagent"');
    expect(html).toContain('data-filter="skill"');
    expect(html).toContain('data-filter="plan"');
    expect(html).toContain("claude");
    // the dead check-circle-2 icon must not resurface
    expect(html).not.toContain("check-circle-2");
  });

  it("injects an agent summary card above the timeline", async () => {
    const html = await renderSessionHtml(
      baseSession([{ index: 0, role: "user", kind: "message", text: "hi" }]),
      { summary: "<h3>Did stuff</h3><ul><li>one</li></ul>" },
    );
    expect(html).toContain('id="entry-summary"');
    expect(html).toContain("Did stuff");
    const summaryIdx = html.indexOf('id="entry-summary"');
    const userIdx = html.indexOf('id="entry-0"');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(summaryIdx);
  });

  it("emits notification card with detail block", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "event",
        kind: "notification",
        text: "Build completed",
        detail: "stdout: ok\nstderr: (empty)",
      },
    ]));
    expect(html).toContain('data-filter="notification"');
    expect(html).toContain("Build completed");
    expect(html).toContain("stdout: ok");
  });

  it("emits handoff card with repository field", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "event",
        kind: "handoff",
        text: "go",
        data: { repository: { owner: "octo", name: "demo", branch: "main" }, summary: "did the thing" },
      },
    ]));
    expect(html).toContain('data-filter="handoff"');
    expect(html).toContain("octo/demo");
    expect(html).toContain("did the thing");
  });

  it("emits task_complete card", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "event", kind: "task_complete", text: "Done", data: { content: "Done" } },
    ]));
    expect(html).toContain('data-filter="task_complete"');
  });

  it("inlines lucide SVGs for all rendered icons", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "hi" },
    ]));
    const svgCount = (html.match(/<svg/g) ?? []).length;
    expect(svgCount).toBeGreaterThan(5);
  });

  it("highlights markdown code fences through Shiki with dual light+dark themes", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "assistant",
        kind: "message",
        text: "look at this:\n\n```bash\necho \"hello\"\n```\n",
      },
    ]));
    expect(html).toMatch(/class="shiki[^"]*"/);
    // Dual theme: shiki emits inline CSS variables `--shiki-light` + `--shiki-dark`
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("--shiki-light");
  });

  it("keeps non-diff tool output as plain <pre> (skips Shiki bloat)", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "a\nb\nc",
        tool: {
          name: "bash",
          arguments: { command: "seq 1 3" },
          result: { type: "success", log: "a\nb\nc" },
        },
      },
    ]));
    // ToolResult renders plain output as <pre class="plain">, not as a shiki block.
    expect(html).toContain('<pre class="plain">a\nb\nc</pre>');
    // No shiki block was emitted for this tool's output. (The args JSON block
    // is folded and hidden because we used the inline `$ seq 1 3` summary.)
    const shikiForToolOutput = (html.match(/pre class="shiki/g) ?? []).length;
    expect(shikiForToolOutput).toBe(0);
  });

  it("highlights a diff-looking tool result as diff", async () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: diff,
        tool: { name: "bash", arguments: { command: "git diff" }, result: { type: "success", log: diff } },
      },
    ]));
    // Shiki output for `diff` should include token spans; loosely check we produced <span>s
    expect(html).toMatch(/class="shiki/);
  });

  it("shows fallback warning pill when sourceLabel is not events.jsonl", async () => {
    const html = await renderSessionHtml(
      baseSession([{ index: 0, role: "user", kind: "message", text: "hi" }]),
      { sourceLabel: "db.turns (fallback)" },
    );
    expect(html).toContain("fallback-warning");
    expect(html).toContain("db.turns (fallback)");
  });

  it("uses 24-hour YYYY-MM-DD HH:MM:SS format for session start", async () => {
    const html = await renderSessionHtml({
      agent: "copilot",
      id: "t",
      path: "/dev/null",
      startedAt: "2026-01-01T05:04:03Z",
      entries: [{ index: 0, role: "user", kind: "message", text: "hi", timestamp: "2026-01-01T05:04:03Z" }],
    });
    // Expect a date-like string in the meta header. Cannot pin exact HH because
    // the render uses local time; just confirm the numeric pattern is present.
    expect(html).toMatch(/2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("keeps user + error entries open by default and folds reasoning + info", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "u" },
      { index: 1, role: "reasoning", kind: "reasoning", text: "r" },
      { index: 2, role: "event", kind: "error", text: "boom" },
      { index: 3, role: "event", kind: "info", text: "note" },
    ]));
    // details open by default has `open` attribute; folded ones don't
    expect(html).toMatch(/id="entry-0"[^>]*open/);
    expect(html).not.toMatch(/id="entry-1"[^>]*open/);
    expect(html).toMatch(/id="entry-2"[^>]*open/);
    expect(html).not.toMatch(/id="entry-3"[^>]*open/);
  });
});

