import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseDsh, refFromDshFile } from "../adapters/dsh.js";
import { parseClaude } from "../adapters/claude.js";
import { parseCopilot } from "../adapters/copilot.js";
import { parseSession } from "../parse.js";
import { computeStats } from "../normalized.js";
import { timelineEntrySearchText } from "../text.js";
import type { ParsedSession, SessionRef, UsageRecord } from "../types.js";

// Cross-source native accounting, second round: DSH settlement metering
// mirrors the upstream token-meter fold exactly (same-(turn,step) last-wins
// replacement, llm/retry-started slot close, stream-final fallback), fork seed
// inheritance is counted=false rather than a note, native content blocks ride
// block.native without polluting search, Claude same-id partial rows are
// identity-deduped (never index-skipped) with last-wins usage snapshots, and
// Copilot compaction input maps only through locally verified tokenDetails.

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asmgr-native-test-"));
  directories.push(directory);
  return directory;
}

async function write(rows: readonly unknown[], name: string): Promise<string> {
  const path = join(await temporaryDirectory(), name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

function dshHeader(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "session", version: 4, id: "native-dsh", createdAt: EPOCH, cwd: "/native", isSeeded: false, ...extra };
}

function dshAssistant(content: unknown[], seqBase: { row: number }, usage?: Record<string, number>, options: { interrupted?: boolean; id?: string; turn?: number; step?: number; stream?: unknown[] } = {}): Record<string, unknown> {
  const row = seqBase.row++;
  return { type: "assistant/message", seq: row, time: EPOCH + row * 1000, surfaceOp: "append", data: {
    turn: options.turn ?? 1, step: options.step ?? 1,
    message: { id: options.id ?? `m${row}`, role: "assistant", source: { kind: "model", provider: "deepseek", model: "test-model" }, content },
    stream: options.stream ?? [],
    ...(usage ? { usage } : {}),
    ...(options.interrupted ? { interrupted: true } : {}),
  } };
}

function dshAttempt(stream: unknown[], seqBase: { row: number }, options: { turn?: number; step?: number } = {}): Record<string, unknown> {
  const row = seqBase.row++;
  return { type: "assistant/attempt", seq: row, time: EPOCH + row * 1000, data: { turn: options.turn ?? 1, step: options.step ?? 1, stream } };
}

// Legacy/damaged envelope: a committed assistant settlement WITHOUT seq. The
// reader still assigns it a stable nonblank row number (and an
// invalid-envelope diagnostic), so its position relative to a seed marker
// stays known — a missing seq must never leak parent usage into the child.
function dshAssistantNoSeq(content: unknown[], row: number, usage: Record<string, number>, options: { turn?: number; step?: number; id?: string } = {}): Record<string, unknown> {
  return { type: "assistant/message", time: EPOCH + row * 1000, surfaceOp: "append", data: {
    turn: options.turn ?? 1, step: options.step ?? 1,
    message: { id: options.id ?? `m${row}`, role: "assistant", source: { kind: "model", provider: "deepseek", model: "test-model" }, content },
    stream: [], usage,
  } };
}

function dshEvent(type: string, data: unknown, seqBase: { row: number }): Record<string, unknown> {
  const row = seqBase.row++;
  return { type, seq: row, time: EPOCH + row * 1000, data };
}

// ---------------------------------------------------------------------------
// Upstream token-meter fold (usage-projection @5badb15), reimplemented here as
// the parity oracle: same-(turn,step) settlements replace (addReplacing),
// llm/retry-started closes the slot, missing cache buckets fold as 0.
// ---------------------------------------------------------------------------

interface FoldEvent { type: "assistant/message" | "assistant/attempt" | "llm/retry-started"; turn: number; step: number; usage?: Record<string, number> }

function tokenMeterFold(events: FoldEvent[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  type Buckets = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  const equal = (a: Buckets, b: Buckets) => a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens;
  let totals: Buckets = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let last: { turn: number; step: number; buckets: Buckets } | null = null;
  for (const event of events) {
    if (event.type === "llm/retry-started") {
      if (last !== null && last.turn === event.turn && last.step === event.step) last = null;
      continue;
    }
    if (event.usage === undefined) continue;
    const buckets: Buckets = { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0,
      cacheReadTokens: event.usage.cacheReadTokens ?? 0, cacheWriteTokens: event.usage.cacheWriteTokens ?? 0 };
    const previous = last !== null && last.turn === event.turn && last.step === event.step ? last.buckets : undefined;
    if (previous !== undefined && equal(previous, buckets)) continue;
    totals = {
      inputTokens: totals.inputTokens - (previous?.inputTokens ?? 0) + buckets.inputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + buckets.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + buckets.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + buckets.cacheWriteTokens,
    };
    last = { turn: event.turn, step: event.step, buckets };
  }
  return totals;
}

describe("DSH native accounting", () => {
  it("meters committed assistant messages once per call with disjoint buckets", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Answer body" }], seq,
        { inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 60, reasoningTokens: 12, totalTokens: 700 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      cumulative: false,
      metrics: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 60, reasoningTokens: 12, totalTokens: 700 },
      scope: { turn: 1, step: 1 },
      responseId: "m3",
      model: "test-model",
      context: { provider: "deepseek", model: "test-model" },
    });
    expect(usage[0].raw).toEqual({ usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 60, reasoningTokens: 12, totalTokens: 700 } });
    expect(usage[0].conversion?.rule).toContain("缺 cache 字段保持 undefined");
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 60, reasoningTokens: 12, totalTokens: 700 });
    expect(stats.calls).toBe(1);
  });

  it("does not guess zeros for missing usage fields and keeps absent usage absent", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Partial metering" }], seq, { inputTokens: 10, outputTokens: 5 }),
      dshAssistant([{ type: "text", text: "No metering at all" }], seq),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0].metrics).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect("totalTokens" in usage[0].metrics).toBe(false);
    expect("cacheReadTokens" in usage[0].metrics).toBe(false);
  });

  it("replaces an unsettled attempt's usage with the final settlement (no retry: only final counts)", async () => {
    const seq = { row: 1 };
    const stream = [
      { type: "chunk", time: EPOCH, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } },
      { type: "text-chunks", time0: EPOCH, index: 0, dt: [], texts: ["ATTEMPT PRIVATE TEXT"] },
      { type: "chunk", time: EPOCH + 10, chunk: { type: "usage", usage: { inputTokens: 30, outputTokens: 8 } } },
    ];
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAttempt(stream, seq),
      dshAssistant([{ type: "text", text: "Committed body" }], seq, { inputTokens: 100, outputTokens: 40 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(2);
    // Attempt observations carry real (turn,step) scope — never {}.
    expect(usage[0]).toMatchObject({ provenance: { rawType: "assistant/attempt" }, scope: { turn: 1, step: 1 } });
    expect(usage[0].metrics).toEqual({ inputTokens: 30, outputTokens: 8 });
    expect(usage[0].counted).toBe(false);
    expect(usage[0].provenance?.metering?.note).toContain("替换");
    expect(usage[1]).toMatchObject({ provenance: { rawType: "assistant/message" } });
    expect(usage[1].counted).toBeUndefined();
    // Attempts never enter the visible transcript.
    expect(JSON.stringify(parsed.entries)).not.toContain("ATTEMPT PRIVATE TEXT");
    // Parity: upstream fold totals = final settlement only.
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(tokenMeterFold([
      { type: "assistant/attempt", turn: 1, step: 1, usage: { inputTokens: 30, outputTokens: 8 } },
      { type: "assistant/message", turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 40 } },
    ])).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("accumulates retried attempts across llm/retry-started and replaces only the open slot", async () => {
    const seq = { row: 1 };
    const usageAt = (input: number, output: number) => ({ inputTokens: input, outputTokens: output });
    const fold: FoldEvent[] = [];
    const rows: unknown[] = [dshHeader()];
    let step = 1;
    const attempt = (usage: Record<string, number>) => {
      fold.push({ type: "assistant/attempt", turn: 1, step, usage });
      rows.push(dshAttempt([
        { type: "chunk", time: EPOCH, chunk: { type: "usage", usage } },
      ], seq, { turn: 1, step }));
    };
    const retry = () => {
      fold.push({ type: "llm/retry-started", turn: 1, step });
      rows.push(dshEvent("llm/retry-started", { retryId: "r", turn: 1, step, provider: "deepseek", retry: 1 }, seq));
    };
    const message = (usage: Record<string, number>) => {
      fold.push({ type: "assistant/message", turn: 1, step, usage });
      rows.push(dshAssistant([{ type: "text", text: `body ${step}` }], seq, usage, { turn: 1, step }));
    };
    attempt(usageAt(10, 2));      // failed attempt — accumulates
    retry();                      // closes the replacement slot
    attempt(usageAt(20, 4));      // retried attempt — accumulates again
    message(usageAt(100, 40));    // final settlement — replaces only the retried attempt
    step = 2;
    message(usageAt(7, 3));       // independent slot — accumulates
    const parsed = await parseDsh(await refFromDshFile(await write(rows, "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(4);
    expect(usage.map((record) => record.counted)).toEqual([undefined, false, undefined, undefined]);
    const oracle = tokenMeterFold(fold);
    const stats = computeStats(parsed.document!);
    // Strict ledger: cache buckets stay undefined when every source omitted
    // them; the harness fold projects 0 there (documented semantic gap).
    expect(stats.totals.inputTokens).toBe(oracle.inputTokens);
    expect(stats.totals.outputTokens).toBe(oracle.outputTokens);
    expect(stats.totals.cacheReadTokens ?? 0).toBe(oracle.cacheReadTokens);
    expect(stats.totals.cacheWriteTokens ?? 0).toBe(oracle.cacheWriteTokens);
    // 10+2 replaced? No: attempt1 kept (retry), attempt2 replaced by final.
    expect(stats.totals).toEqual({ inputTokens: 117, outputTokens: 45 });
  });

  it("meters a committed message lacking data.usage from its final stream usage sample", async () => {
    const seq = { row: 1 };
    const stream = [
      { type: "chunk", time: EPOCH, chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } } },
      { type: "chunk", time: EPOCH + 5, chunk: { type: "usage", usage: { inputTokens: 42, outputTokens: 9 } } },
    ];
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Stream-final body" }], seq, undefined, { stream }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0].metrics).toEqual({ inputTokens: 42, outputTokens: 9 });
    expect(usage[0].provenance?.metering?.source).toContain("流内最后 usage 采样");
    expect(usage[0].raw).toEqual({ usage: { inputTokens: 42, outputTokens: 9 } });
    expect(computeStats(parsed.document!).totals).toEqual({ inputTokens: 42, outputTokens: 9 });
  });

  it("marks usage recorded before the fork seed cut inherited and excluded from stats", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      { ...dshHeader({ isSeeded: true, parentSession: "parent-session", origin: "subagent", delegationDepth: 1 }), id: "fork-child" },
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Inherited answer" }], seq, { inputTokens: 10, outputTokens: 4 }),
      dshEvent("session/end-seed", { inherited: true }, seq),
      dshEvent("turn/start", { turn: 2 }, seq),
      dshEvent("step/start", { turn: 2, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Own answer" }], seq, { inputTokens: 20, outputTokens: 6 }, { turn: 2, step: 1 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(2);
    expect(usage[0].inherited).toBe(true);
    expect(usage[0].counted).toBe(false);
    expect(usage[1].inherited).toBeUndefined();
    expect(usage[1].counted).toBeUndefined();
    // Session-graph identity: seeded parent → forkOf; transcript keeps seed history.
    expect(parsed.document?.identity).toEqual({
      role: "subagent", parentSession: "parent-session", forkOf: "parent-session", delegationDepth: 1,
    });
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Inherited answer", "Own answer"]);
    // Stats count only the thread's own consumption.
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 20, outputTokens: 6 });
    expect(stats.calls).toBe(1);
  });

  it("uses the LAST tagged end-seed marker as the cut across multi-layer seeds", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader({ isSeeded: true, parentSession: "layer0" }),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "grandparent usage" }], seq, { inputTokens: 1, outputTokens: 1 }),
      dshEvent("session/end-seed", { inherited: true }, seq),
      dshEvent("turn/start", { turn: 2 }, seq),
      dshEvent("step/start", { turn: 2, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "parent usage" }], seq, { inputTokens: 10, outputTokens: 2 }, { turn: 2, step: 1 }),
      dshEvent("session/end-seed", { inherited: true }, seq),
      dshEvent("turn/start", { turn: 3 }, seq),
      dshEvent("step/start", { turn: 3, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "own usage" }], seq, { inputTokens: 100, outputTokens: 20 }, { turn: 3, step: 1 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage.map((record) => record.inherited)).toEqual([true, true, undefined]);
    expect(computeStats(parsed.document!).totals).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("cuts inherited usage by row order even when the parent-lineage record lacks seq", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      { ...dshHeader({ isSeeded: true, parentSession: "parent-session", origin: "subagent", delegationDepth: 1 }), id: "fork-child" },
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      // Parent-lineage settlement WITHOUT seq, on its own (turn,step) so no
      // replacement slot can mask the misattribution.
      dshAssistantNoSeq([{ type: "text", text: "Inherited answer" }], 4, { inputTokens: 10, outputTokens: 4 }),
      dshEvent("session/end-seed", { inherited: true }, seq),
      dshEvent("turn/start", { turn: 2 }, seq),
      dshEvent("step/start", { turn: 2, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Own answer" }], seq, { inputTokens: 20, outputTokens: 6 }, { turn: 2, step: 1 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      inherited: true, counted: false,
      metrics: { inputTokens: 10, outputTokens: 4 },
      scope: { turn: 1, step: 1 },
    });
    expect(usage[0].provenance?.metering?.note).toContain("fork 继承");
    expect(usage[1].inherited).toBeUndefined();
    expect(usage[1].counted).toBeUndefined();
    // The child's own consumption is fully measurable: totals only 20/6.
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 20, outputTokens: 6 });
    expect(stats.calls).toBe(1);
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Inherited answer", "Own answer"]);
  });

  it("anchors the seed cut on the marker's row when the marker itself lacks seq", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader({ isSeeded: true, parentSession: "parent-session" }),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "parent usage" }], seq, { inputTokens: 10, outputTokens: 4 }),
      // Tagged marker WITHOUT seq: previously it defined no cut, and the
      // seeded-fork-no-marker blanket (everything counted=false) was the only
      // fallback. The stable row still defines the cut.
      { type: "session/end-seed", time: EPOCH + 5000, data: { inherited: true } },
      dshEvent("turn/start", { turn: 2 }, seq),
      dshEvent("step/start", { turn: 2, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "own usage" }], seq, { inputTokens: 20, outputTokens: 6 }, { turn: 2, step: 1 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage.map((record) => record.inherited)).toEqual([true, undefined]);
    expect(usage[0].counted).toBe(false);
    expect(usage[1].counted).toBeUndefined();
    expect(computeStats(parsed.document!).totals).toEqual({ inputTokens: 20, outputTokens: 6 });
    // A seq-less marker is still a marker — the no-marker blanket never fires.
    expect(parsed.diagnostics?.issues ?? []).not.toContainEqual(expect.objectContaining({ code: "seeded-fork-no-marker" }));
  });

  it("cuts at the LAST marker across multi-layer seeds even with seq-less records and markers", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader({ isSeeded: true, parentSession: "layer0" }),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistantNoSeq([{ type: "text", text: "grandparent usage" }], 4, { inputTokens: 1, outputTokens: 1 }),
      { type: "session/end-seed", time: EPOCH + 5000, data: { inherited: true } },
      dshEvent("turn/start", { turn: 2 }, seq),
      dshEvent("step/start", { turn: 2, step: 1 }, seq),
      dshAssistantNoSeq([{ type: "text", text: "parent usage" }], 7, { inputTokens: 10, outputTokens: 2 }, { turn: 2, step: 1 }),
      dshEvent("session/end-seed", { inherited: true }, seq),
      dshEvent("turn/start", { turn: 3 }, seq),
      dshEvent("step/start", { turn: 3, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "own usage" }], seq, { inputTokens: 100, outputTokens: 20 }, { turn: 3, step: 1 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage.map((record) => record.inherited)).toEqual([true, true, undefined]);
    expect(usage.every((record) => record.counted !== undefined ? record.counted === false : true)).toBe(true);
    expect(computeStats(parsed.document!).totals).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("refuses to attribute any usage when a seeded header lacks the end-seed marker", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader({ isSeeded: true, parentSession: "absent-parent" }),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "ambiguous ownership" }], seq, { inputTokens: 10, outputTokens: 4 }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0].counted).toBe(false);
    expect(usage[0].inherited).toBeUndefined();
    expect(parsed.diagnostics?.issues).toContainEqual(expect.objectContaining({ code: "seeded-fork-no-marker", count: 1 }));
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({});
    expect(stats.incomplete).toBe(true);
  });

  it("keeps ownership and unknown origins distinct in lightweight identity", async () => {
    const seq = { row: 1 };
    const unseeded = await refFromDshFile(await write([
      { ...dshHeader({ parentSession: "owner-session", delegationDepth: 2 }), id: "owned-child" },
    ], "session.v4.jsonl"));
    // An unseeded parentSession is ownership (subagent delegation), not a fork.
    expect(unseeded.identity).toEqual({ role: "main", parentSession: "owner-session", delegationDepth: 2 });

    const futureOrigin = await refFromDshFile(await write([
      { ...dshHeader({ origin: "guardian-v2" }), id: "future-child" },
    ], "session.v4.jsonl"));
    // Unrecognized origin stays raw evidence — never guessed into main.
    expect(futureOrigin.identity).toEqual({ role: "unknown", raw: { origin: "guardian-v2" } });

    const parsed = await parseDsh(futureOrigin);
    expect(parsed.identity).toEqual({ role: "unknown", raw: { origin: "guardian-v2" } });
    expect(parsed.document?.identity).toEqual({ role: "unknown", raw: { origin: "guardian-v2" } });
  });

  it("preserves committed source content blocks natively without polluting search", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      { type: "user/message", seq: 4, row: 4, time: EPOCH + 4000, surfaceOp: "append", data: {
        role: "user", source: { kind: "user" },
        content: [
          { type: "text", text: "See this file" },
          { type: "file", attachment: { name: "report.pdf", mediaType: "application/pdf", data: "SGVsbG8gQmFzZTY0IFBBSUxPA==" } },
          { type: "future-plugin", prompt: "PRIVATE PLUGIN PAYLOAD", nested: { secret: true } },
        ],
      } },
      dshAssistant([{ type: "text", text: "Here is the answer" }], seq, { inputTokens: 10, outputTokens: 4 }),
    ], "session.v4.jsonl")));
    const blocks = parsed.document?.blocks ?? [];
    const userBlock = blocks.find((block) => block.role === "user");
    expect(userBlock?.native).toEqual([
      { type: "text", seq: 4, row: 4, time: EPOCH + 4000, text: "See this file" },
      { type: "file", seq: 4, row: 4, time: EPOCH + 4000,
        attachment: { mediaType: "application/pdf", name: "report.pdf", omitted: expect.stringContaining("未随转录复制") } },
      { type: "future-plugin", seq: 4, row: 4, time: EPOCH + 4000,
        note: expect.stringContaining("有损保留"), keys: ["nested", "prompt", "type"] },
    ]);
    // Binary payload and unknown plugin content never copy into the document.
    expect(JSON.stringify(parsed.document)).not.toContain("SGVsbG8gQmFzZTY0");
    expect(JSON.stringify(parsed.document)).not.toContain("PRIVATE PLUGIN PAYLOAD");
    // And never leak into the searchable projection of the same document.
    const session = await parseSession({ agent: "dsh", id: "native-dsh", path: parsed.path });
    for (const entry of session.entries) {
      expect(timelineEntrySearchText(entry)).not.toContain("SGVsbG8gQmFzZTY0");
      expect(timelineEntrySearchText(entry)).not.toContain("PRIVATE PLUGIN PAYLOAD");
    }
    expect(session.entries.find((entry) => entry.role === "user")?.text).toBe("See this file[附件：report.pdf]");
  });

  it("types result-only tool carriers as tool-result blocks", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshEvent("tool/call", { callId: "t1", name: "read", arguments: "{}" }, seq),
      { type: "tool/result", seq: 5, row: 5, time: EPOCH + 5000, surfaceOp: "append", sourceEventSeqs: [4], data: {
        message: { role: "tool", toolCallId: "t1", isError: false, content: [{ type: "text", text: "tool body" }] } } },
    ], "session.v4.jsonl")));
    const toolBlock = parsed.document?.blocks.find((block) => block.tool?.callId === "t1");
    // A merged call+result entry keeps tool-call; the identity is call-centric.
    expect(toolBlock?.type).toBe("tool-call");
    const orphan = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      { type: "tool/result", seq: 4, row: 4, time: EPOCH + 4000, surfaceOp: "append", data: {
        message: { role: "tool", toolCallId: "missing", isError: true, content: [{ type: "text", text: "orphan result" }] } } },
    ], "session.v4.jsonl")));
    // A result with no matching call is a tool-result block, not a tool-call.
    expect(orphan.document?.blocks.find((block) => block.role === "tool")?.type).toBe("tool-result");
  });

  it("keeps request/context as a metering-free sample and interrupted prefixes separate", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("request/context", { provider: "deepseek", model: "test-model", contextWindow: 131072 }, seq),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "Prefix" }], seq, { inputTokens: 7, outputTokens: 3 }, { interrupted: true }),
    ], "session.v4.jsonl")));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(2);
    expect(usage[0].metrics).toEqual({});
    expect(usage[0].context).toEqual({ provider: "deepseek", model: "test-model", contextWindow: 131072 });
    expect(usage[1].provenance?.metering?.source).toContain("中断");
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(stats.lastContext?.contextWindow).toBe(131072);
  });
});

describe("Claude native accounting", () => {
  const claudeRef = (path: string): SessionRef => ({ agent: "claude", id: "claude-native", path });

  it("keeps later single-part rows of the same message id (identity dedupe, not index skip)", async () => {
    const path = await write([
      { type: "user", message: { role: "user", content: "Question" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" },
      // Same message id, different uuids: independent partial content rows.
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-4",
        content: [{ type: "text", text: "First block" }],
        usage: { input_tokens: 12, cache_read_input_tokens: 300, cache_creation_input_tokens: 45, output_tokens: 10 } } },
      { type: "assistant", uuid: "a2", timestamp: "2026-01-01T00:00:03.000Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-4",
        content: [{ type: "thinking", thinking: "planning" }] } },
      { type: "assistant", uuid: "a3", timestamp: "2026-01-01T00:00:04.000Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-4",
        content: [{ type: "text", text: "Second block" }] } },
      { type: "assistant", uuid: "a4", timestamp: "2026-01-01T00:00:05.000Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-4",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }] } },
      // Re-emitted snapshot repeats earlier blocks: contributes nothing new.
      { type: "assistant", uuid: "a5", timestamp: "2026-01-01T00:00:06.000Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-4",
        content: [{ type: "text", text: "First block" }, { type: "text", text: "Second block" }] } },
    ], "claude.jsonl");
    const parsed = await parseClaude(claudeRef(path));
    const texts = parsed.entries.filter((entry) => entry.rawType?.startsWith("assistant/")).map((entry) => entry.text);
    expect(texts[0]).toBe("First block");
    expect(texts[1]).toContain("planning");
    expect(texts[2]).toBe("Second block");
    expect(texts[3]).toContain("README.md");
    // The re-emitted two-block snapshot contributed nothing new.
    expect(texts).toHaveLength(4);
    // ...and the tool_use block survived as a structured call.
    expect(parsed.entries.find((entry) => entry.rawType === "assistant/tool_use")?.tool)
      .toMatchObject({ callId: "toolu_1", name: "Read" });
  });

  it("replaces an earlier usage snapshot of the same message id (final output wins)", async () => {
    const path = await write([
      { type: "user", message: { role: "user", content: "Question" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "partial" }], usage: { input_tokens: 12, output_tokens: 10 } } },
      { type: "assistant", uuid: "a2", timestamp: "2026-01-01T00:00:03.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "partial" }, { type: "text", text: "final" }], usage: { input_tokens: 12, output_tokens: 30 } } },
    ], "claude.jsonl");
    const parsed = await parseClaude(claudeRef(path));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(2);
    expect(usage[0].counted).toBe(false);
    expect(usage[0].provenance?.metering?.note).toContain("替换");
    expect(usage[1].counted).toBeUndefined();
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 12, outputTokens: 30 });
  });

  it("does not let a usage-less row block a later valid snapshot, and dedupes identical replays", async () => {
    const path = await write([
      { type: "user", message: { role: "user", content: "Question" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "no usage yet" }] } },
      { type: "assistant", uuid: "a2", timestamp: "2026-01-01T00:00:03.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "no usage yet" }, { type: "text", text: "done" }],
        usage: { input_tokens: 5, output_tokens: 6 } } },
      // Byte-identical replay of a2: skipped whole.
      { type: "assistant", uuid: "a2", timestamp: "2026-01-01T00:00:03.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "no usage yet" }, { type: "text", text: "done" }],
        usage: { input_tokens: 5, output_tokens: 6 } } },
    ], "claude.jsonl");
    const parsed = await parseClaude(claudeRef(path));
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0].counted).toBeUndefined();
    expect(computeStats(parsed.document!).totals).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("never silently drops a replayed uuid carrying a different payload", async () => {
    const path = await write([
      { type: "user", message: { role: "user", content: "Question" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "before rewrite" }] } },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "rewritten payload" }] } },
    ], "claude.jsonl");
    const parsed = await parseClaude(claudeRef(path));
    expect(parsed.entries.filter((entry) => entry.rawType === "assistant/text").map((entry) => entry.text))
      .toEqual(["before rewrite", "rewritten payload"]);
    expect(parsed.diagnostics?.issues).toContainEqual(expect.objectContaining({ code: "replayed-uuid-conflict", count: 1 }));
    expect(parsed.source?.lossy).toBe(true);
  });

  it("pairs tool arguments and results across the user-role boundary with the boundary recorded", async () => {
    const path = await write([
      { type: "user", message: { role: "user", content: "Check the file" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "msg_tool", role: "assistant", content: [
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
      ] } },
      { type: "user", uuid: "u2", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "42 lines", is_error: false },
      ] } },
    ], "claude.jsonl");
    const parsed = await parseClaude(claudeRef(path));
    const call = parsed.entries.find((entry) => entry.rawType === "assistant/tool_use");
    expect(call?.tool).toMatchObject({ callId: "toolu_1", name: "Read", arguments: { file_path: "README.md" } });
    expect(call?.data?.sourceRole).toBe("assistant");
    const result = parsed.entries.find((entry) => entry.rawType === "user/tool_result");
    expect(result?.tool).toMatchObject({ callId: "toolu_1", result: { type: "success", log: "42 lines" } });
    // The result crossed a user-role row: the original boundary stays recorded.
    expect(result?.data?.sourceRole).toBe("user");
    expect(parsed.document?.blocks.find((block) => block.tool?.callId === "toolu_1" && block.role === "tool" && block.kind === "tool_result")?.type)
      .toBe("tool-result");
    // No usage fields existed: the ledger stays empty, never zero-filled.
    expect(parsed.document?.usage).toEqual([]);
    expect(computeStats(parsed.document!).totals).toEqual({});
  });

  it("derives session identity from the sidechain field instead of hardcoding main", async () => {
    const sidechainOnly = await write([
      { type: "user", message: { role: "user", content: "delegate" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z", isSidechain: true },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", isSidechain: true, message: { id: "msg_1", role: "assistant",
        content: [{ type: "text", text: "subagent work" }] } },
    ], "claude.jsonl");
    const subagent = await parseClaude(claudeRef(sidechainOnly));
    expect(subagent.document?.identity).toEqual({ role: "subagent", raw: { sidechainRows: 2 } });
    expect(subagent.entries.every((entry) => entry.data?.isSidechain !== true)).toBe(false);

    const mixed = await write([
      { type: "user", message: { role: "user", content: "main question" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", isSidechain: true, message: { id: "msg_s", role: "assistant",
        content: [{ type: "text", text: "sidechain fragment" }] } },
    ], "claude.jsonl");
    const main = await parseClaude(claudeRef(mixed));
    expect(main.document?.identity).toEqual({ role: "main", raw: { sidechainRows: 1 } });
  });

  it("counts bad JSON rows as diagnostics with a source warning", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "claude.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "user", message: { role: "user", content: "good row" }, uuid: "u1", timestamp: "2026-01-01T00:00:01.000Z" }),
      "{not valid json",
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "m1", role: "assistant",
        content: [{ type: "text", text: "still parsed" }] } }),
    ].join("\n") + "\n");
    const parsed = await parseClaude(claudeRef(path));
    expect(parsed.diagnostics?.issues).toContainEqual(expect.objectContaining({ code: "invalid-json-row", count: 1 }));
    expect(parsed.source).toMatchObject({ lossy: true });
    expect(parsed.source?.warning).toContain("损坏的 JSON");
    expect(parsed.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  });
});

describe("Copilot native accounting", () => {
  it("maps the full disjoint decomposition when tokenDetails verifies arithmetically", async () => {
    // Shape observed on this machine (326 local compaction records, 296 with
    // complete four-bucket details, 0 identity mismatches):
    // inputTokens = input + cache_read + cache_write.
    const path = await write([
      { type: "session.start", timestamp: "2026-01-01T00:00:00.000Z", data: { context: { cwd: "/tmp/project" } } },
      { type: "session.compaction_start", timestamp: "2026-01-01T00:00:03.000Z", data: { conversationTokens: 10 } },
      { type: "session.compaction_complete", timestamp: "2026-01-01T00:00:04.000Z", data: {
        preCompactionTokens: 141897, preCompactionMessagesLength: 97, summaryContent: "recap", serviceRequestId: "req-1",
        compactionTokensUsed: { inputTokens: 191901, outputTokens: 6095, cacheReadTokens: 0, cacheWriteTokens: 0,
          copilotUsage: { tokenDetails: [
            { tokenType: "input", tokenCount: 6 },
            { tokenType: "cache_read", tokenCount: 0 },
            { tokenType: "cache_write", tokenCount: 191895 },
            { tokenType: "output", tokenCount: 6095 },
          ] } } } },
    ], "events.jsonl");
    const parsed = await parseCopilot({ agent: "copilot", id: "copilot-native", path });
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      responseId: "req-1",
      metrics: { inputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 191895, outputTokens: 6095 },
      raw: { compactionTokensUsed: { inputTokens: 191901, outputTokens: 6095 } },
    });
    expect(usage[0].conversion?.rule).toContain("含缓存的提示总量");
    // Billed input = 6 + 0 + 191895 — the top-level 191901 is NOT uncached input.
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ inputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 191895, outputTokens: 6095 });
  });

  it("keeps input unknown when tokenDetails is absent (never maps the cache-inclusive total)", async () => {
    const path = await write([
      { type: "session.start", timestamp: "2026-01-01T00:00:00.000Z", data: { context: { cwd: "/tmp/project" } } },
      { type: "user.message", timestamp: "2026-01-01T00:00:01.000Z", data: { content: "hello" } },
      { type: "session.compaction_complete", timestamp: "2026-01-01T00:00:04.000Z", data: {
        preCompactionTokens: 120000, preCompactionMessagesLength: 40, summaryContent: "recap",
        compactionTokensUsed: { inputTokens: 1000, outputTokens: 500, duration: 4000, model: "claude" } } },
      // Unverified usage carriers stay raw-unknown: no record is minted.
      { type: "session.usage_checkpoint", timestamp: "2026-01-01T00:00:05.000Z", data: { totalTokens: 999 } },
    ], "events.jsonl");
    const parsed = await parseCopilot({ agent: "copilot", id: "copilot-native", path });
    const usage = parsed.document?.usage ?? [];
    expect(usage).toHaveLength(1);
    expect(usage[0].metrics).toEqual({ outputTokens: 500 });
    expect("inputTokens" in usage[0].metrics).toBe(false);
    expect(usage[0].raw?.compactionTokensUsed).toMatchObject({ inputTokens: 1000, outputTokens: 500, model: "claude" });
    expect(usage[0].conversion?.rule).toContain("input 保持 unknown");
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({ outputTokens: 500 });
    expect(stats.incomplete).toBe(true);
    expect(JSON.stringify(usage)).not.toContain("999");
  });

  it("counts bad JSON rows as diagnostics with a source warning", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session.start", timestamp: "2026-01-01T00:00:00.000Z", data: { context: { cwd: "/tmp/project" } } }),
      "{broken json",
    ].join("\n") + "\n");
    const parsed = await parseCopilot({ agent: "copilot", id: "copilot-native", path });
    expect(parsed.diagnostics?.issues).toContainEqual(expect.objectContaining({ code: "invalid-json-row", count: 1 }));
    expect(parsed.source).toMatchObject({ lossy: true });
    expect(parsed.source?.warning).toContain("损坏的 JSON");
  });
});

describe("ChatGPT native accounting", () => {
  it("treats absent share usage as unknown, not zero, and keeps native block facts on block.native", async () => {
    const snapshot = {
      format: "asmgr.chatgpt-share",
      version: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      requestedUrl: "https://chatgpt.com/share/abc123",
      sourceUrl: "https://chatgpt.com/share/abc123",
      data: {
        conversation_id: "abc123",
        title: "Shared talk",
        create_time: 1,
        update_time: 2,
        linear_conversation: [
          { id: "n0", message: { id: "m0", author: { role: "user" }, create_time: 1,
            content: { content_type: "multimodal_text", parts: [
              { content_type: "text", text: "look at this" },
              { content_type: "image_asset_pointer", asset_pointer: "file:///img.png", width: 10, height: 20 },
            ] } } },
          { id: "n1", message: { id: "m1", author: { role: "assistant" }, create_time: 2,
            content: { content_type: "text", parts: ["here you go"] } } },
        ],
      },
    };
    const path = await write([snapshot], "share.chatgpt-share.json");
    const parsed: ParsedSession = await parseSession({ agent: "chatgpt", id: "abc123", path });
    expect(parsed.document?.usage).toEqual([]);
    const stats = computeStats(parsed.document!);
    expect(stats.totals).toEqual({});
    expect(stats.calls).toBe(0);
    const userBlock = parsed.document?.blocks.find((block) => block.role === "user");
    expect(userBlock?.native).toEqual([
      { contentType: "text" },
      { contentType: "image_asset_pointer", assetPointer: "file:///img.png", width: 10, height: 20 },
    ]);
    // Native facts live on the block, outside the searchable entry projection.
    const user = parsed.entries.find((entry) => entry.role === "user");
    expect(user?.data?.nativeBlocks).toBeUndefined();
    expect(timelineEntrySearchText(user!)).not.toContain("image_asset_pointer");
  });
});

describe("cross-source invariants", () => {
  it("keeps every ledger record non-cumulative and identified by source", async () => {
    const seq = { row: 1 };
    const dsh = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshAssistant([{ type: "text", text: "body" }], seq, { inputTokens: 1, outputTokens: 1 }),
    ], "session.v4.jsonl")));
    for (const record of (dsh.document?.usage ?? []) as UsageRecord[]) {
      expect(record.cumulative).toBe(false);
      expect(record.provenance?.agent).toBe("dsh");
      expect(record.id).toMatch(/^u\d+$/);
    }
  });

  it("keeps attempt text, non-user injections and unknown plugins out of DSH search", async () => {
    const seq = { row: 1 };
    const parsed = await parseDsh(await refFromDshFile(await write([
      dshHeader(),
      dshEvent("turn/start", { turn: 1 }, seq),
      dshEvent("step/start", { turn: 1, step: 1 }, seq),
      dshEvent("assistant/attempt", { turn: 1, step: 1, stream: [
        { type: "text-chunks", time0: EPOCH, index: 0, dt: [], texts: ["FAILED ATTEMPT SECRET"] },
      ] }, seq),
      { type: "user/message", seq: 5, row: 5, time: EPOCH + 5000, surfaceOp: "append", data: {
        role: "user", source: { kind: "checkpoint", checkpoint: "MODEL-ONLY INJECTION" }, content: [{ type: "text", text: "hidden" }] } },
      dshEvent("custom/plugin", { prompt: "UNKNOWN PLUGIN SECRET" }, seq),
      dshAssistant([{ type: "text", text: "visible answer" }], seq, { inputTokens: 1, outputTokens: 1 }),
    ], "session.v4.jsonl")));
    const session = await parseSession({ agent: "dsh", id: "native-dsh", path: parsed.path });
    const searchable = session.entries.map((entry) => timelineEntrySearchText(entry)).join("\n");
    expect(searchable).not.toContain("FAILED ATTEMPT SECRET");
    expect(searchable).not.toContain("MODEL-ONLY INJECTION");
    expect(searchable).not.toContain("UNKNOWN PLUGIN SECRET");
    expect(searchable).toContain("visible answer");
  });
});
