import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedSession, SessionRef } from "../types.js";
import { searchRefs } from "../search.js";
import { parseSession } from "../parse.js";

vi.mock("../parse.js", () => ({ parseSession: vi.fn() }));
const parse = vi.mocked(parseSession);
const refs: SessionRef[] = Array.from({ length: 9 }, (_, i) => ({
  agent: "dsh", id: `session-${i}`, path: `/synthetic/${i}`, mtime: new Date(i * 1000).toISOString(),
}));
const parsed = (ref: SessionRef): ParsedSession => ({ ...ref,
  entries: [{ index: 7, role: "user", kind: "message", text: "Needle text" }],
});
beforeEach(() => { parse.mockReset(); parse.mockImplementation(async ref => parsed(ref)); });

describe("bounded canonical search", () => {
  it("orders by file activity, stops at the cap and bounds read-ahead", async () => {
    const hits = await searchRefs(refs, "needle", 1, { concurrency: 2 });
    expect(hits.map(hit => hit.session.id)).toEqual(["session-8"]);
    expect(parse.mock.calls.map(([ref]) => ref.id)).toEqual(["session-8", "session-7"]);
    expect(hits[0].entry.index).toBe(7);
  });

  it("full-scan escape hatch scans everything without exceeding output limit", async () => {
    const hits = await searchRefs(refs, "needle", 2, { concurrency: 2, earlyExit: false });
    expect(hits.map(hit => hit.session.id)).toEqual(["session-8", "session-7"]);
    expect(parse).toHaveBeenCalledTimes(9);
  });

  it("preserves ordering despite out-of-order parser completion", async () => {
    const completed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    parse.mockImplementation(async ref => {
      if (ref.id === "session-8") await gate;
      else release();
      completed.push(ref.id);
      return parsed(ref);
    });
    const hits = await searchRefs(refs, "needle", 2, { concurrency: 2 });
    expect(completed).toEqual(["session-7", "session-8"]);
    expect(hits.map(hit => hit.session.id)).toEqual(["session-8", "session-7"]);
  });

  it("skips unreadable siblings and exposes structured diagnostics without console output", async () => {
    parse.mockRejectedValueOnce(new Error("broken"));
    const diagnostic = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hits = await searchRefs(refs, "needle", 1, { concurrency: 2, onDiagnostic: diagnostic });
      expect(hits[0].session.id).toBe("session-7");
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "unreadable", message: "broken" }));
      expect(stderr).not.toHaveBeenCalled();
    } finally { stderr.mockRestore(); }
  });

  it("distinguishes expected attachment notices from compatibility defects even with no hits", async () => {
    parse.mockImplementation(async ref => ({ ...parsed(ref),
      source: { kind: "events", path: ref.path, lossy: true, warning: "attachment", notices: ["attachment"] },
      diagnostics: { handled: 0, ignored: 0, unknown: 1, unknownTypes: ["future"],
        issues: [{ code: "unknown-event", message: "future event", count: 1 }] },
    }));
    const diagnostic = vi.fn();
    expect(await searchRefs([refs[0]], "absent", 20, { onDiagnostic: diagnostic })).toEqual([]);
    expect(diagnostic.mock.calls.map(([event]) => event.kind)).toEqual(["notice", "warning"]);
  });

  it("filters normalized roles without renumbering entries", async () => {
    parse.mockImplementation(async ref => ({ ...parsed(ref), entries: [
      { index: 0, role: "assistant", kind: "message", text: "needle assistant" },
      { index: 8, role: "user", kind: "decision", text: "needle decision" },
    ] }));
    const hits = await searchRefs([refs[0]], "needle", 20, { role: "user" });
    expect(hits.map(hit => hit.entry.index)).toEqual([8]);
  });

  it("zero limit does no reads and rejects invalid limits/queries/concurrency", async () => {
    expect(await searchRefs(refs, "needle", 0)).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    for (const value of [-1, NaN, 1.2, Infinity]) await expect(searchRefs(refs, "needle", value)).rejects.toThrow("limit");
    await expect(searchRefs(refs, " ")).rejects.toThrow("query");
    for (const value of [0, 33, 1.5, NaN]) await expect(searchRefs(refs, "needle", 20, { concurrency: value })).rejects.toThrow("concurrency");
  });
});
