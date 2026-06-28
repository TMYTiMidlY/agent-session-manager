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
});
