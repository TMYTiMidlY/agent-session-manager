import { describe, expect, it } from "vitest";
import { renderSessionHtml } from "./index.js";
import type { ParsedSession } from "@session-recall/core";

describe("renderSessionHtml", () => {
  it("renders a standalone HTML document", () => {
    const session: ParsedSession = {
      agent: "copilot",
      id: "fixture",
      path: "/tmp/events.jsonl",
      entries: [{ index: 0, role: "user", kind: "message", text: "hello recall" }],
    };
    const html = renderSessionHtml(session);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("hello recall");
    expect(html).toContain("id=\"search\"");
    expect(html).toContain("data-filter=\"user\"");
    expect(html).toContain("copilot");
    expect(html).toContain("fixture");
  });
});
