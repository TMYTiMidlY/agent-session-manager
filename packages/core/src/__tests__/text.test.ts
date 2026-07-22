import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCopilot } from "../adapters/copilot.js";
import { sessionToText } from "../index.js";

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
});
