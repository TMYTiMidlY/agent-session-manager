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
    const session = await parseCopilot({ agent: "copilot", id: "copilot-rich", path: resolve(root, "copilot-rich.events.jsonl") });
    const byKind = new Map(session.entries.map((entry) => [entry.kind, entry]));
    // these were silently dropped before (wrong raw type strings / no handler)
    for (const kind of ["skill", "subagent", "plan", "warning", "compaction", "error", "task_complete"]) {
      expect(byKind.has(kind), `missing kind: ${kind}`).toBe(true);
    }
    // subagent.started + subagent.completed merge into one entry with stats
    const subagent = byKind.get("subagent");
    expect(subagent?.title).toBe("Explore");
    expect(subagent?.data?.totalTokens).toBe(1234);
    expect(subagent?.data?.totalToolCalls).toBe(9);
    // compaction carries the injected recap + token deltas + duration
    const compaction = byKind.get("compaction");
    expect(compaction?.text).toContain("delta bug");
    expect(compaction?.data?.durationSec).toBe(4);
    expect(compaction?.data?.tokensRemoved).toBe(90000);
    expect(byKind.get("skill")?.title).toBe("dredge-up");
    expect(byKind.get("task_complete")?.text).toContain("resolved");
  });
});
