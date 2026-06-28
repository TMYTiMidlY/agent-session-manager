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
  it("renders a standalone HTML document with a single user entry", () => {
    const html = renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "hello recall" },
    ]));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("hello recall");
    expect(html).toContain('id="search"');
    expect(html).toContain('data-filter="user"');
  });

  it("renders a merged tool card with status-success border + inline arg summary", () => {
    const html = renderSessionHtml(baseSession([
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

  it("renders a failure tool card with status-failure class", () => {
    const html = renderSessionHtml(baseSession([
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

  it("injects an agent summary card above the timeline", () => {
    const html = renderSessionHtml(
      baseSession([{ index: 0, role: "user", kind: "message", text: "hi" }]),
      { summary: "<h3>Did stuff</h3><ul><li>one</li></ul>" },
    );
    expect(html).toContain('id="entry-summary"');
    expect(html).toContain("Did stuff");
    // summary entry is rendered before the user entry in source order
    const summaryIdx = html.indexOf('id="entry-summary"');
    const userIdx = html.indexOf('id="entry-0"');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(summaryIdx);
  });

  it("emits notification card with detail block", () => {
    const html = renderSessionHtml(baseSession([
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

  it("emits handoff card with repository field", () => {
    const html = renderSessionHtml(baseSession([
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

  it("emits task_complete card", () => {
    const html = renderSessionHtml(baseSession([
      { index: 0, role: "event", kind: "task_complete", text: "Done", data: { content: "Done" } },
    ]));
    expect(html).toContain('data-filter="task_complete"');
  });

  it("inlines lucide SVGs for all rendered icons", () => {
    const html = renderSessionHtml(baseSession([
      { index: 0, role: "user", kind: "message", text: "hi" },
    ]));
    // Each Icon component produces an inline <svg>; at minimum the
    // toolbar (search + 7 buttons) + user pill + sidebar each have icons.
    const svgCount = (html.match(/<svg/g) ?? []).length;
    expect(svgCount).toBeGreaterThan(5);
  });
});

