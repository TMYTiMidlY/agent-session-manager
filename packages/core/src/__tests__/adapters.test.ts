import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCopilot } from "../adapters/copilot.js";
import { parseClaude } from "../adapters/claude.js";
import { parseCodex } from "../adapters/codex.js";

const root = resolve(fileURLToPath(new URL("../../../../fixtures", import.meta.url)));

describe("agent adapters", () => {
  it("parses Copilot events", async () => {
    const session = await parseCopilot({ agent: "copilot", id: "copilot-fixture", path: resolve(root, "copilot.events.jsonl") });
    expect(session.cwd).toBe("/tmp/project");
    expect(session.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(session.entries[0]?.text).toContain("alpha");
  });

  it("parses Claude JSONL", async () => {
    const session = await parseClaude({ agent: "claude", id: "claude-fixture", path: resolve(root, "claude.jsonl") });
    expect(session.entries.some((entry) => entry.text.includes("beta"))).toBe(true);
    expect(session.entries.some((entry) => entry.role === "tool")).toBe(true);
  });

  it("parses Codex rollout JSONL", async () => {
    const session = await parseCodex({ agent: "codex", id: "codex-fixture", path: resolve(root, "codex.jsonl") });
    expect(session.cwd).toBe("/tmp/project");
    expect(session.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(session.entries[1]?.text).toContain("gamma");
  });

  it("maps raw Copilot event names to entries the dredge-up script renders", async () => {
    const session = await parseCopilot({ agent: "copilot", id: "copilot-parity", path: resolve(root, "copilot-parity.events.jsonl") });
    const byKind = new Map(session.entries.map((entry) => [entry.kind, entry]));
    // these were silently dropped before (wrong raw type strings / no handler)
    for (const kind of ["skill", "subagent", "plan", "warning", "compaction", "error", "task_complete"]) {
      expect(byKind.has(kind), `missing kind: ${kind}`).toBe(true);
    }
    // subagent.started + subagent.completed merge into one entry (real completed
    // events carry NO token/tool-call/duration stats — only name/displayName/model)
    const subagents = session.entries.filter((e) => e.kind === "subagent");
    expect(subagents[0]?.title).toBe("Explore");
    expect(subagents[0]?.data?.model).toBe("claude");
    // a failed subagent is flagged with its error
    const failed = session.entries.find((e) => e.kind === "subagent" && e.data?.failed === true);
    expect(failed?.data?.error).toBe("build failed");
    // compaction carries the injected recap + REAL fields (preTokens/preMessages/durationMs)
    const compaction = byKind.get("compaction");
    expect(compaction?.text).toContain("delta bug");
    expect(compaction?.data?.preTokens).toBe(120000);
    expect(compaction?.data?.preMessages).toBe(40);
    expect(compaction?.data?.durationMs).toBe(4000);
    expect(byKind.get("skill")?.title).toBe("dredge-up");
    expect(byKind.get("skill")?.data?.trigger).toBe("user");
    expect(byKind.get("task_complete")?.text).toContain("resolved");
    expect(byKind.get("warning")).toMatchObject({
      text: "[context] context is getting large",
      detail: "context",
      data: { warningType: "context" },
    });
    expect(byKind.get("error")).toMatchObject({
      text: "[network] transient network error",
      detail: "network",
      data: {
        errorType: "network",
        stack: expect.stringContaining("at fetch"),
      },
    });
  });

  it("keeps tools at their start position and mutates lifecycle details in place", async () => {
    const session = await parseCopilot({
      agent: "copilot",
      id: "core-tool-lifecycle",
      path: resolve(root, "core-tool-lifecycle.events.jsonl"),
    });
    expect(session.entries.map((entry) => [entry.role, entry.tool?.callId, entry.text])).toEqual([
      ["tool", "complete", "command finished"],
      ["user", undefined, "message between tool start and completion"],
      ["tool", "pending", ""],
      ["user", undefined, "message after pending tool"],
      ["tool", "failure", expect.stringContaining("\"code\": 7")],
      ["tool", "explicit", "explicit failure result"],
    ]);

    const completed = session.entries[0];
    expect(completed?.timestamp).toBe("2026-07-22T00:00:01.000Z");
    expect(completed?.tool?.partialOutput).toBe("complete output");
    expect(completed?.tool?.result?.type).toBe("success");

    const pending = session.entries[2];
    expect(pending?.tool?.partialOutput).toBe("pending output");
    expect(pending?.tool?.result?.type).toBe("pending");

    const failure = session.entries[4];
    expect(failure?.tool?.result?.type).toBe("failure");
    expect(failure?.tool?.result?.log).toContain("command failed");

    const explicit = session.entries[5];
    expect(explicit?.tool?.result?.type).toBe("failure");
    expect(session.updatedAt).toBe("2026-07-22T00:00:09.000Z");
  });

  it("reports handled, intentionally ignored, and unknown Copilot event types", async () => {
    const session = await parseCopilot({
      agent: "copilot",
      id: "core-copilot-diagnostics",
      path: resolve(root, "core-copilot-diagnostics.events.jsonl"),
    });
    expect(session.diagnostics).toEqual({
      handled: 2,
      ignored: 5,
      unknown: 2,
      unknownTypes: ["future.event"],
    });
    expect(session.entries.map((entry) => entry.text)).toEqual(["known event"]);
  });
});
