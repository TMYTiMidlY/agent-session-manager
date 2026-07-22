import { describe, expect, it } from "vitest";
import { renderSessionHtml } from "./index.js";
import type { ParsedSession } from "@agent-session-manager/core";

function baseSession(entries: ParsedSession["entries"]): ParsedSession {
  return {
    agent: "copilot",
    id: "fixture",
    path: "/tmp/events.jsonl",
    entries,
  };
}

function entryTag(html: string, index: number | "summary"): string {
  return html.match(new RegExp(`<details id="entry-${index}"[^>]*>`))?.[0] ?? "";
}

describe("renderSessionHtml", () => {
  it("renders a standalone HTML document with a single user entry", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "hello chronicle" },
    ]));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("hello chronicle");
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
    expect(html).toContain("Trigger: user");
    // the dead check-circle-2 icon must not resurface
    expect(html).not.toContain("check-circle-2");
  });

  it("renders compaction stats, outcome, and summary in a dedicated card", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "event",
        kind: "compaction",
        text: "Kept the implementation decisions and open questions.",
        data: {
          success: true,
          preTokens: 120000,
          preMessages: 40,
          durationMs: 4000,
          model: "gpt-5.4",
          checkpointNumber: 3,
        },
      },
      {
        index: 1,
        role: "event",
        kind: "compaction",
        text: "Compaction could not complete.",
        data: { success: false },
      },
    ]));
    expect(html).toContain("压缩完成");
    expect(html).toContain("120000 tokens · 40 messages · 4.0s · gpt-5.4 · checkpoint #3");
    expect(html).toContain("Kept the implementation decisions and open questions.");
    expect(entryTag(html, 1)).toContain("compaction-failure");
    expect(html).toContain("压缩失败");
  });

  it("injects an agent summary card above the timeline", async () => {
    const html = await renderSessionHtml(
      baseSession([{ index: 0, role: "user", kind: "message", text: "hi" }]),
      { summary: "<h3>Did stuff</h3><ul><li>one</li></ul>" },
    );
    expect(html).toContain('id="entry-summary"');
    expect(entryTag(html, "summary")).toContain('data-index="summary"');
    expect(html).toContain("Did stuff");
    const summaryIdx = html.indexOf('id="entry-summary"');
    const userIdx = html.indexOf('id="entry-0"');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(summaryIdx);
  });

  it("emits notification card with its complete kind payload", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "event",
        kind: "notification",
        text: "Build completed",
        detail: "build",
        data: {
          kind: {
            type: "build",
            sourcePath: "/repo/package.json",
            triggerFile: "src/index.ts",
            triggerTool: "bash",
            description: "Build hook finished",
          },
        },
      },
    ]));
    expect(html).toContain('data-filter="notification"');
    expect(html).toContain("Build completed");
    expect(html).toContain("Notification Detail");
    expect(html).toContain("/repo/package.json");
    expect(html).toContain("src/index.ts");
    expect(html).toContain("Build hook finished");
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
    expect(entryTag(html, 0)).not.toContain(" open");
  });

  it("styles successful and failed task_complete cards distinctly", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "event", kind: "task_complete", text: "Done", data: { isError: false } },
      { index: 1, role: "event", kind: "task_complete", text: "Tests failed", data: { isError: true } },
    ]));
    expect(html).toContain('data-filter="task_complete"');
    expect(entryTag(html, 0)).toContain("task-complete-success");
    expect(entryTag(html, 1)).toContain("task-complete-error");
    expect(html).toContain("任务完成");
    expect(html).toContain("任务失败");
    expect(entryTag(html, 1)).toContain(" open");
  });

  it("renders tool partial output in a folded detail block", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "done",
        tool: {
          name: "bash",
          arguments: { command: "build" },
          partialOutput: "compiling module one",
          result: { type: "success", log: "done" },
        },
      },
    ]));
    expect(html).toContain("Partial Output");
    expect(html).toContain('<pre class="plain">compiling module one</pre>');
  });

  it("uses the official pill taxonomy order and renders nested groups", async () => {
    const html = await renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "user" },
      { index: 1, role: "assistant", kind: "message", text: "assistant" },
      { index: 2, role: "tool", kind: "tool", text: "tool", tool: { name: "view" } },
      { index: 3, role: "reasoning", kind: "reasoning", text: "reasoning" },
      { index: 4, role: "event", kind: "info", text: "info" },
      { index: 5, role: "event", kind: "warning", text: "warning" },
      { index: 6, role: "event", kind: "error", text: "error" },
      {
        index: 7,
        role: "event",
        kind: "group",
        title: "Grouped work",
        text: "",
        data: {
          children: [
            { index: 70, role: "assistant", kind: "message", text: "nested child content" },
          ],
        },
      },
      { index: 8, role: "event", kind: "notification", text: "notification" },
      { index: 9, role: "event", kind: "handoff", text: "handoff" },
      { index: 10, role: "event", kind: "compaction", text: "compaction", data: { success: true } },
      { index: 11, role: "event", kind: "task_complete", text: "complete" },
      { index: 12, role: "event", kind: "subagent", text: "subagent" },
      { index: 13, role: "event", kind: "skill", text: "skill" },
      { index: 14, role: "event", kind: "plan", text: "plan" },
      { index: 15, role: "system", kind: "system", text: "system" },
    ]), { summary: "<p>summary</p>" });
    const pills = [...html.matchAll(/class="filter [^"]+" data-filter="([^"]+)"/g)].map((match) => match[1]);
    expect(pills).toEqual([
      "user", "assistant", "tool", "reasoning",
      "info", "warning", "error", "group", "notification", "handoff", "compaction", "task_complete",
      "summary", "subagent", "skill", "plan", "system",
    ]);
    expect(entryTag(html, 7)).toContain('data-filter="group"');
    expect(html).toContain("Grouped work · 1 entries");
    expect(html).toContain("nested child content");
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

  it("loads SQL in the Shiki language set", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "assistant",
        kind: "message",
        text: "```sql\nSELECT id FROM sessions WHERE agent = 'copilot';\n```",
      },
    ]));
    expect(html).toMatch(/class="shiki[^"]*"/);
    expect(html).not.toContain('<pre class="plain"><code>SELECT id');
  });

  it("embeds KaTeX woff2 fonts so the standalone document works offline", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "assistant",
        kind: "message",
        text: "Inline math: $E = mc^2$",
      },
    ]));
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toContain("url(fonts/");
    expect(html).not.toContain('format("woff")');
    expect(html).not.toContain('format("truetype")');
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

  it("indexes visible tool, notification, and event metadata for search", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "tool",
        kind: "tool",
        text: "tool",
        rawType: "tool.event",
        tool: {
          callId: "call-search",
          name: "bash",
          intentionSummary: "Inspect search intent",
          arguments: { command: "echo argument-needle" },
          partialOutput: "partial-needle",
          result: { type: "success", log: "result-needle" },
        },
      },
      {
        index: 1,
        role: "event",
        kind: "notification",
        text: "notice",
        detail: "notification-detail",
        rawType: "system.notification",
        data: { kind: { type: "hook", description: "event-metadata-needle" } },
      },
    ]));
    const toolTag = entryTag(html, 0);
    expect(toolTag).toContain("bash");
    expect(toolTag).toContain("inspect search intent");
    expect(toolTag).toContain("argument-needle");
    expect(toolTag).toContain("partial-needle");
    expect(toolTag).toContain("result-needle");
    const notificationTag = entryTag(html, 1);
    expect(notificationTag).toContain("notification-detail");
    expect(notificationTag).toContain("system.notification");
    expect(notificationTag).toContain("event-metadata-needle");
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

  it("renders reasoning as escaped preformatted text instead of markdown", async () => {
    const html = await renderSessionHtml(baseSession([
      {
        index: 0,
        role: "reasoning",
        kind: "reasoning",
        text: "**not bold**\n<script>alert('no')</script>",
      },
    ]));
    expect(html).toContain("<pre class=\"plain\">**not bold**\n&lt;script&gt;alert(&#x27;no&#x27;)&lt;/script&gt;</pre>");
    expect(html).not.toContain("<strong>not bold</strong>");
  });

  it("uses title, first user message, repository, then generic title precedence", async () => {
    const explicit = await renderSessionHtml({
      ...baseSession([{ index: 0, role: "user", kind: "message", text: "first prompt" }]),
      title: "Recorded session summary",
      repository: "octo/repo",
    });
    expect(explicit).toContain("<title>Recorded session summary</title>");
    expect(explicit).toContain("<h1>🌀 Recorded session summary</h1>");

    const firstUser = await renderSessionHtml({
      ...baseSession([{ index: 0, role: "user", kind: "message", text: "Use this prompt title\nmore" }]),
      repository: "octo/repo",
    });
    expect(firstUser).toContain("<title>Use this prompt title</title>");

    const repository = await renderSessionHtml({
      ...baseSession([{ index: 0, role: "event", kind: "info", text: "event" }]),
      repository: "octo/repo",
    });
    expect(repository).toContain("<title>octo/repo</title>");

    const generic = await renderSessionHtml(baseSession([]));
    expect(generic).toContain("<title>copilot session</title>");
  });

  it("keeps theme state, density naming, and keyboard interactions in sync", async () => {
    const html = await renderSessionHtml({
      ...baseSession([
        {
          index: 0,
          role: "user",
          kind: "message",
          text: "timestamped",
          timestamp: "2026-07-22T03:00:00Z",
        },
      ]),
      startedAt: "2026-07-22T03:00:00Z",
    });
    expect(html).toMatch(/id="toggle-theme"[^>]*aria-pressed="true"/);
    expect(html).toContain('data-theme-icon="dark"');
    expect(html).toContain('data-theme-icon="light" hidden=""');
    expect(html).toContain("syncThemeControl");
    expect(html).toContain("button.setAttribute('aria-pressed', String(isDark))");
    expect(html).toContain('title="切换显示密度"');
    expect(html).not.toContain('title="紧凑模式"');
    expect(html).toContain("mark.search-match");
    expect(html).toContain("event.key === 'Escape'");
    expect(html).toContain("event.key === 'j'");
    expect(html).toContain("event.key === 'k'");
    expect(html).toContain("event.key === 'Enter'");
    expect(html).toContain("IntersectionObserver");
    expect(html).toContain("expandHashTarget");
    expect(html).toContain('class="timestamp-link" href="#entry-0"');
    const script = html.match(/<script>([\s\S]*)<\/script><\/body>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
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
