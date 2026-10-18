import { describe, expect, it } from "vitest";
import { computeStats, createDocumentBuilder, documentFromParsed, dedupeUsage, finalizeDocument, projectEntries, filterDocumentRole, tailDocument, DSH_FORMAT_BASIS } from "../normalized.js";
import type { TimelineEntry, UsageRecord } from "../types.js";

const usage = (id: string, metrics: UsageRecord["metrics"], extra: Partial<UsageRecord> = {}): UsageRecord =>
  ({ id, cumulative: false, metrics, ...extra });
const document = (records: UsageRecord[] = []) => documentFromParsed(
  { agent: "codex", id: "s", path: "/synthetic", entries: [] }, { usage: records });

describe("unified session envelopes", () => {
  it("preserves the legacy transcript field-for-field in one event projection", () => {
    const entries: TimelineEntry[] = [
      { index: 0, role: "user", kind: "decision", text: "yes", title: "Question", data: { questionId: "q" } },
      { index: 1, role: "tool", kind: "tool", text: "ok", timestamp: "2026-01-01T00:00:00Z", rawType: "tool/result", tool: { callId: "c", name: "bash", arguments: { command: "true" }, result: { type: "success", log: "ok" } } },
      { index: 2, role: "reasoning", kind: "thinking", text: "why", detail: "detail" },
    ];
    const doc = finalizeDocument(documentFromParsed({ agent: "dsh", id: "s", path: "/synthetic", entries }));
    expect(projectEntries(doc)).toEqual(entries);
    expect(doc.basis).toEqual(DSH_FORMAT_BASIS);
    expect(doc.events!.map(event => event.seq)).toEqual([0, 1, 2]);
    expect(doc.events![1].time).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(doc.events![0].time).toBeUndefined();
    doc.blocks = [];
    expect(projectEntries(doc)).toEqual(entries); // envelopes are authoritative after finalization
  });
  it("supports native blocks while retaining opaque content out of search text", () => {
    const builder = createDocumentBuilder({ agent: "claude", id: "s", path: "/synthetic" });
    builder.setIdentity({ role: "subagent", parentSession: "parent" });
    builder.setMeta({ title: "Synthetic" });
    builder.addBlock({ type: "image", role: "user", kind: "image", text: "[image]", native: { type: "image", source: { secret: "not searchable" } } });
    builder.addUsage({ cumulative: false, responseId: "r", metrics: { inputTokens: 2, outputTokens: 1 } });
    const doc = finalizeDocument(builder.build());
    expect(doc.identity.parentSession).toBe("parent");
    expect(doc.blocks[0].native).toBeDefined();
    expect(JSON.stringify(projectEntries(doc))).not.toContain("not searchable");
    expect(doc.events![1].type).toBe("usage/record");
  });
});

describe("tail document views", () => {
  const source = () => finalizeDocument(documentFromParsed({
    agent: "codex", id: "s", path: "/synthetic",
    identity: { role: "main", raw: { hidden: "identity-secret" } },
    entries: [
      { index: 0, role: "user", kind: "message", text: "first", data: { native: "old-native" } },
      { index: 1, role: "tool", kind: "tool", text: "tool" },
      { index: 2, role: "user", kind: "message", text: "last", data: { native: "last-native" } },
    ],
  }, { usage: [usage("u", { inputTokens: 1 }, { raw: { opaque: "usage-secret" },
    context: { raw: { opaque: "context-secret" } }, rateLimit: { raw: { opaque: "quota-secret" } } })] }));

  it("keeps blocks, events and entries aligned without opaque content or mutation", () => {
    const original = source();
    const reduced = tailDocument(original, 1);
    expect(projectEntries(reduced)).toEqual([{ index: 2, role: "user", kind: "message", text: "last" }]);
    expect(reduced.blocks).toHaveLength(1);
    expect(reduced.events!.filter(event => event.type === "message/append")).toHaveLength(1);
    expect(reduced.view).toEqual({ tail: 1, nativeContent: "omitted" });
    expect(JSON.stringify(reduced)).not.toMatch(/old-native|last-native|identity-secret|usage-secret|context-secret|quota-secret/);
    expect(JSON.stringify(original)).toContain("last-native");
    expect(projectEntries(original)).toHaveLength(3);
    expect(reduced.usage[0].metrics).toEqual({ inputTokens: 1 });
  });

  it("applies after role filtering and preserves original timeline coordinates", () => {
    const reduced = tailDocument(filterDocumentRole(source(), "user"), 1);
    expect(reduced.view).toEqual({ role: "user", tail: 1, nativeContent: "omitted" });
    expect(projectEntries(reduced).map(entry => entry.index)).toEqual([2]);
    expect(projectEntries(tailDocument(source(), 0))).toEqual([]);
    expect(projectEntries(tailDocument(source(), 100))).toHaveLength(3);
  });

  it("omits opaque data before finalization can promote it back into native", () => {
    const builder = createDocumentBuilder({ agent: "claude", id: "s", path: "/synthetic" });
    builder.addBlock({ type: "text", role: "user", kind: "text", text: "visible",
      data: { native: "OPAQUE_NATIVE", nativeBlocks: "OPAQUE_BLOCKS", blocks: "OPAQUE_BLOCKS2", rawSource: "OPAQUE_SOURCE", usage: "OPAQUE_USAGE", visible: true } });
    const staging = builder.build();
    for (const reduced of [tailDocument(staging, 1), filterDocumentRole(staging, "user")]) {
      expect(reduced.view?.nativeContent).toBe("omitted");
      expect(JSON.stringify(reduced)).not.toContain("OPAQUE_");
      expect(projectEntries(reduced)[0]?.data).toEqual({ visible: true });
    }
    expect(staging.blocks[0]?.data?.native).toBe("OPAQUE_NATIVE");
  });

  it("rejects invalid numeric counts", () => {
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => tailDocument(source(), value)).toThrow(/non-negative safe integer/);
    }
  });
});

describe("faithful usage aggregation", () => {
  it("selects response increments instead of adding cumulative snapshots", () => {
    const stats = computeStats(document([
      usage("a", { inputTokens: 10, cacheReadTokens: 20, outputTokens: 4, reasoningTokens: 2 }, { responseId: "r" }),
      usage("b", { inputTokens: 999, outputTokens: 999 }, { cumulative: true }),
      usage("c", { inputTokens: 5, cacheReadTokens: 0, outputTokens: 3, reasoningTokens: 1 }, { responseId: "r2" }),
    ]));
    expect(stats.totals).toEqual({ inputTokens: 15, cacheReadTokens: 20, outputTokens: 7, reasoningTokens: 3 });
    expect(stats.accounting).toBe("responses");
    expect(stats.snapshots).toBe(1);
  });
  it("uses only the latest cumulative snapshot in old logs", () => {
    const stats = computeStats(document([
      usage("a", { inputTokens: 10, outputTokens: 1 }, { cumulative: true }),
      usage("b", { inputTokens: 15, outputTokens: 2 }, { cumulative: true }),
    ]));
    expect(stats.totals).toEqual({ inputTokens: 15, outputTokens: 2 });
    expect(stats.accounting).toBe("latest-snapshot");
  });
  it("never treats missing fields as zero or reports partial sums as full totals", () => {
    const stats = computeStats(document([usage("a", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 }), usage("b", { inputTokens: 3 })]));
    expect(stats.totals).toEqual({ inputTokens: 13 });
    expect(stats.incomplete).toBe(true);
    expect(computeStats(document()).accounting).toBe("unavailable");
    expect(computeStats(document()).totals).toEqual({});
  });
  it("deduplicates response IDs but excludes conflicting observations", () => {
    const records = [usage("a", { inputTokens: 10, outputTokens: 2 }, { responseId: "r" }), usage("b", { inputTokens: 10, outputTokens: 2 }, { responseId: "r" })];
    expect(computeStats(document(records)).totals.inputTokens).toBe(10);
    expect(dedupeUsage(records)).toHaveLength(1);
    const conflict = computeStats(document([...records, usage("c", { inputTokens: 11, outputTokens: 2 }, { responseId: "r" })]));
    expect(conflict.totals).toEqual({});
    expect(conflict.conflictingResponses).toBe(1);
  });
  it("does not aggregate context samples, rate limits or inherited/foreign usage", () => {
    const stats = computeStats(document([
      usage("sample", { inputTokens: 12345 }, { kind: "context", context: { contextWindow: 20000, inputTokens: 12345 } }),
      usage("quota", {}, { kind: "rate-limit", rateLimit: { usedPercent: 25 } }),
      usage("inherited", { inputTokens: 200, outputTokens: 10 }, { inherited: true }),
      usage("foreign", { inputTokens: 100, outputTokens: 1 }, { ownerSessionId: "parent" }),
      usage("r", { inputTokens: 5, outputTokens: 2 }),
    ]));
    expect(stats.totals).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(stats.lastContext?.contextWindow).toBe(20000);
  });
  it("refuses fractional, negative and overflowing aggregate token counts", () => {
    expect(computeStats(document([usage("a", { inputTokens: 1.5, outputTokens: -1 })])).totals).toEqual({});
    expect(computeStats(document([usage("a", { inputTokens: Number.MAX_SAFE_INTEGER }), usage("b", { inputTokens: 1 })])).totals.inputTokens).toBeUndefined();
  });
});
