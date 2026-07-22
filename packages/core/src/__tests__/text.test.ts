import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCopilot } from "../adapters/copilot.js";
import { searchRefs, sessionToDialogue, sessionToText, timelineEntrySearchText } from "../index.js";
import type { ParsedSession } from "../types.js";

const fixtures = resolve(fileURLToPath(new URL("../../../../fixtures", import.meta.url)));

describe("sessionToText", () => {
  it("renders compact tool arguments and result details", async () => {
    const session = await parseCopilot({
      agent: "copilot",
      id: "core-tool-lifecycle",
      path: resolve(fixtures, "core-tool-lifecycle.events.jsonl"),
    });
    const text = sessionToText(session);
    expect(text).toContain("tool: bash");
    expect(text).toContain("args: {\"command\":\"echo chronological\"}");
    expect(text).toContain("intention: run the chronological command");
    expect(text).toContain("result: success");
    expect(text).toContain("log:\ncommand finished");
  });

  it("renders subagent, skill, plan, and compaction statistics", async () => {
    const session = await parseCopilot({
      agent: "copilot",
      id: "copilot-parity",
      path: resolve(fixtures, "copilot-parity.events.jsonl"),
    });
    const text = sessionToText(session);
    expect(text).toContain("name: Task\nmodel: claude\nfailed: true");
    expect(text).toContain("name: dredge-up\nsource: project\ntrigger: user");
    expect(text).toContain("operation: updated");
    expect(text).toContain("tokens: 120000\nmessages: 40\nduration-ms: 4000");
    expect(text).toContain("summary:\nRecap: delta bug is in parser.");
  });

  it("renders only the conversational spine as dialogue", () => {
    const session: ParsedSession = {
      agent: "copilot",
      id: "dialogue",
      path: "/dev/null",
      startedAt: "2026-07-22T00:00:00.000Z",
      entries: [
        { index: 0, role: "user", kind: "message", text: "User prompt", timestamp: "2026-07-22T00:00:01.000Z" },
        { index: 1, role: "reasoning", kind: "reasoning", text: "REASONING NOISE" },
        {
          index: 2,
          role: "tool",
          kind: "tool",
          text: "TOOL NOISE",
          tool: { name: "bash", result: { type: "success", log: "TOOL NOISE" } },
        },
        {
          index: 3,
          role: "user",
          kind: "decision",
          title: "Which database?",
          text: "User selected: PostgreSQL",
          timestamp: "2026-07-22T00:00:02.000Z",
        },
        {
          index: 4,
          role: "event",
          kind: "compaction",
          text: "Compaction recap",
          timestamp: "2026-07-22T00:00:03.000Z",
        },
        { index: 5, role: "assistant", kind: "message", text: "Assistant reply", timestamp: "2026-07-22T00:00:04.000Z" },
        { index: 6, role: "event", kind: "notification", text: "NOTIFICATION NOISE" },
        { index: 7, role: "assistant", kind: "text", text: "CLAUDE REPLY", timestamp: "2026-07-22T00:00:05.000Z" },
        { index: 8, role: "assistant", kind: "compacted", text: "CODEX RECAP", timestamp: "2026-07-22T00:00:06.000Z" },
      ],
    };

    const text = sessionToDialogue(session);
    expect(text).toContain("## 1. user/message 2026-07-22T00:00:01.000Z");
    expect(text).toContain("## 4. user/decision 2026-07-22T00:00:02.000Z");
    expect(text).toContain("Q: Which database?\nA: User selected: PostgreSQL");
    expect(text).toContain("summary:\nCompaction recap");
    expect(text).toContain("Assistant reply");
    // Cross-adapter spine: Claude carries assistant text as kind "text", Codex
    // recaps as kind "compacted" — both must survive the role-based filter.
    expect(text).toContain("CLAUDE REPLY");
    expect(text).toContain("CODEX RECAP");
    expect(text).not.toContain("TOOL NOISE");
    expect(text).not.toContain("REASONING NOISE");
    expect(text).not.toContain("NOTIFICATION NOISE");
  });
});

describe("timeline search text", () => {
  it("finds a term that appears only in tool arguments", async () => {
    const ref = {
      agent: "copilot" as const,
      id: "core-tool-lifecycle",
      path: resolve(fixtures, "core-tool-lifecycle.events.jsonl"),
    };
    const hits = await searchRefs([ref], "pending.txt");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entry.tool?.callId).toBe("pending");
    expect(hits[0]?.excerpt).toContain("pending.txt");
  });

  it("includes structured entry data", () => {
    const text = timelineEntrySearchText({
      index: 0,
      role: "event",
      kind: "skill",
      text: "",
      data: { source: "project", trigger: "scheduled-run" },
    });
    expect(text).toContain("scheduled-run");
  });
});
