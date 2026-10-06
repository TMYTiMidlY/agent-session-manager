import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodex } from "../adapters/codex.js";
import { codexDisjointMetrics, codexIdentity, extractCodexMetadata, type CodexRow } from "../adapters/codex-metadata.js";
import { computeStats, finalizeDocument, projectEntries } from "../normalized.js";
import type { ParsedSession, SessionRef, SessionStats, UsageRecord } from "../types.js";

const root = resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));

const MAIN_ID = "e0000000-0000-4000-8000-000000000001";
const LEGACY_ID = "e0000000-0000-4000-8000-000000000002";
const CHILD_ID = "e0000000-0000-4000-8000-000000000003";
const PARENT_ID = "e0000000-0000-4000-8000-00000000000a";

function codexRef(id: string, file: string): SessionRef {
  return { agent: "codex", id, path: resolve(root, file) };
}

/** Mirrors parseSession()'s codex branch without depending on in-flight adapters. */
async function parse(ref: SessionRef): Promise<ParsedSession> {
  const parsed = await parseCodex(ref);
  const document = finalizeDocument(parsed.document!);
  return { ...parsed, document, entries: projectEntries(document), stats: computeStats(document) };
}

describe("codex usage ledger", () => {
  it("accounts per-response increments; snapshots stay a separate channel", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    // Unified policy: a metric missing in ANY selected record stays undefined
    // for the total (no partial sums, no zeros) — resp-3 lacks input/cache
    // fields, so only output (200+90) survives; resp-2 is excluded by its
    // conflicting duplicate; snapshots never sum into the response channel.
    expect(session.stats!.totals).toEqual({ outputTokens: 290 });
    expect(session.stats!.accounting).toBe("responses");
    expect(session.stats!.calls).toBe(2); // unique non-conflicting responses (resp-1, resp-3)
    expect(session.stats!.snapshots).toBe(2); // eligible cumulative snapshots
    expect(session.stats!.incomplete).toBe(true); // conflict + partial fields
    const increments = session.document!.usage.filter((u) => u.kind === "response" && u.counted !== false);
    expect(increments.map((u) => u.responseId)).toEqual([
      "resp-1", "resp-2", "resp-2", "resp-1", "resp-3",
    ]);
    const snapshots = session.document!.usage.filter((u) => u.kind === "cumulative");
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((u) => u.provenance?.rawType === "event_msg/token_count.total_token_usage")).toBe(true);
    // raw Codex total_tokens (input+output incl. cached) is preserved verbatim
    // and never mapped to a DSH total
    const inc1 = increments[0]!;
    expect(inc1.metrics.totalTokens).toBeUndefined();
    expect((inc1.raw?.usage as Record<string, unknown>).total_tokens).toBe(1200);
    expect(inc1.conversion?.rule).toBe("input_minus_cached");
  });

  it("reports repeated and conflicting duplicate responses without double counting", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    expect(session.stats!.duplicateResponses).toBe(2); // exact resp-1 replay + conflicting resp-2
    expect(session.stats!.conflictingResponses).toBe(1);
    // resp-1's exact replay counts once; resp-2's conflict is excluded
    // wholesale rather than resolved by guess; metrics absent from the
    // partial resp-3 record stay unknown instead of half-sums.
    expect(session.stats!.totals.inputTokens).toBeUndefined();
    const issue = session.diagnostics?.issues?.find((i) => i.code === "codex/usage-duplicate-response");
    expect(issue?.count).toBe(2);
  });

  it("keeps null/bad usage fields unknown instead of fabricating zeros", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    // cached_input_tokens: null → disjoint input unknowable; the raw 700 stays
    // in `raw`, and no zero is invented
    const partial = session.document!.usage.find((u) => u.responseId === "resp-3");
    expect(partial).toBeDefined();
    expect(partial!.metrics.inputTokens).toBeUndefined();
    expect(partial!.metrics.cacheReadTokens).toBeUndefined();
    expect(partial!.metrics.outputTokens).toBe(90);
    expect((partial!.raw?.usage as Record<string, unknown>).input_tokens).toBe(700);
    expect(partial!.provenance?.metering?.note).toContain("raw input_tokens=700 unmapped");
    // null usage is a bounded diagnostic, not a crash and not a zero record
    expect(session.document!.usage.some((u) => u.responseId === "resp-null")).toBe(false);
    expect(session.diagnostics?.issues?.find((i) => i.code === "codex/usage-invalid")).toBeDefined();
  });

  it("keeps token_usage_record raw as the whole attribution payload, not just usage counts", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    const inc1 = session.document!.usage.find((u) => u.responseId === "resp-1" && u.counted !== false);
    // attribution fields survive verbatim alongside the untouched usage object
    expect(inc1!.raw?.thread_id).toBe(MAIN_ID);
    expect(inc1!.raw?.session_id).toBe(MAIN_ID);
    expect(inc1!.raw?.turn_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(inc1!.raw?.root_turn_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(inc1!.raw?.response_id).toBe("resp-1");
    expect((inc1!.raw?.usage as Record<string, unknown>).input_tokens).toBe(1000);
    expect((inc1!.raw?.thread_token_usage as Record<string, unknown>).total_tokens).toBe(1200);
  });

  it("supports the legacy mixed-version shape: latest cumulative snapshot is its own accounting", async () => {
    const session = await parse(codexRef(LEGACY_ID, "codex-stats-legacy.jsonl"));
    // no response records → the LATEST snapshot alone (900-300 cached);
    // snapshots are never summed (800-input + 900-input would be 1700)
    expect(session.stats!.totals).toEqual({
      inputTokens: 600,
      cacheReadTokens: 300,
      outputTokens: 160,
      reasoningTokens: 10,
    });
    expect(session.stats!.accounting).toBe("latest-snapshot");
    expect(session.stats!.calls).toBe(0);
    expect(session.stats!.snapshots).toBe(2); // the info-less sample preserves nothing
    expect(session.stats!.lastContext?.contextWindow).toBe(64000);
    // legacy metadata without thread_source/source is unknown, never guessed main
    expect(session.document!.identity.role).toBe("unknown");
  });

  it("carries last_token_usage as a dedicated kind=context sample, never a meter", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    const contexts = session.document!.usage.filter((u) => u.kind === "context");
    expect(contexts).toHaveLength(2);
    expect(contexts.every((u) => u.counted === false)).toBe(true);
    expect(contexts.every((u) => Object.keys(u.metrics).length === 0)).toBe(true);
    expect(contexts.map((u) => u.context?.contextWindow)).toEqual([272000, 128000]);
    expect(session.stats!.lastContext?.contextWindow).toBe(128000);
    // the sample's own reported input (incl. cached) + window + raw last usage
    const ctx1 = contexts[0]!;
    expect(ctx1.context?.inputTokens).toBe(1000);
    expect(ctx1.context?.measurement).toBe("reported-input");
    expect(ctx1.context?.raw?.cached_input_tokens).toBe(400);
    expect(ctx1.provenance?.rawType).toBe("event_msg/token_count.last_token_usage");
    // the hint is NOT a note on the cumulative snapshot anymore
    const snap1 = session.document!.usage.find((u) => u.kind === "cumulative" && u.metrics.inputTokens === 600);
    expect(snap1!.provenance?.metering?.note ?? "").not.toContain("last_token_usage");
  });

  it("filters fork-inherited and foreign-thread usage records out of stats, raw retained", async () => {
    const session = await parse(codexRef(CHILD_ID, "codex-stats-subagent.jsonl"));
    // only the child's own response contributes
    expect(session.stats!.totals).toEqual({
      inputTokens: 150,
      cacheReadTokens: 50,
      outputTokens: 60,
      reasoningTokens: 10,
    });
    expect(session.stats!.calls).toBe(1);
    expect(session.stats!.snapshots).toBe(0);
    // raw records survive in the ledger, flagged out of accounting
    const inherited = session.document!.usage.filter((u) => u.inherited === true);
    expect(inherited.length).toBeGreaterThanOrEqual(1);
    expect(inherited.every((u) => u.counted === false)).toBe(true);
    const foreign = session.document!.usage.find((u) => u.responseId === "resp-parent");
    expect(foreign?.ownerSessionId).toBe(PARENT_ID);
    expect(foreign?.counted).toBe(false);
    const issues = session.diagnostics?.issues ?? [];
    expect(issues.find((i) => i.code === "codex/usage-foreign-thread")?.count).toBe(1);
    expect(issues.find((i) => i.code === "codex/usage-inherited")?.count).toBe(1);
  });

  it("preserves rate limits as structured per-window samples with the full raw snapshot", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    const rates = session.document!.usage.filter((u) => u.kind === "rate-limit");
    expect(rates).toHaveLength(3); // primary ×2 + secondary ×1
    expect(rates.map((u) => u.rateLimit?.kind)).toEqual(["primary", "primary", "secondary"]);
    expect(rates.every((u) => u.counted === false)).toBe(true);
    expect(rates.every((u) => Object.keys(u.metrics).length === 0)).toBe(true);
    const p0 = rates[0]!.rateLimit!;
    expect(p0).toMatchObject({
      kind: "primary",
      usedPercent: 42.5,
      windowMinutes: 10080,
      resetAt: "2026-02-02T02:40:00.000Z",
      limitId: "codex",
      planType: "pro",
      creditsBalance: "62500", // original provider string, never parsed
    });
    // no account id exists upstream — never inferred
    expect(p0.accountId).toBeUndefined();
    // the whole original snapshot is structured raw, not a JSON note string
    expect(p0.raw?.credits).toEqual({ has_credits: true, unlimited: false, balance: "62500" });
    expect(p0.raw?.secondary).toBeNull();
    expect(p0.raw?.individual_limit).toBeNull();
    const s1 = rates[2]!.rateLimit!;
    expect(s1).toMatchObject({ kind: "secondary", usedPercent: 12.5, windowMinutes: 300 });
    // second sample: credits present but balance null → omitted, not zero
    expect(rates[1]!.rateLimit!.creditsBalance).toBeUndefined();
    expect(rates[1]!.rateLimit!.raw?.credits).toEqual({ has_credits: false, unlimited: false, balance: null });
    // no JSON-stringified rate_limits dumped into a metering note
    expect(rates.every((u) => !(u.provenance?.metering?.note ?? "").includes("rate_limits="))).toBe(true);
  });

  it("keeps bad rows as bounded diagnostics while later good rows still parse", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    const bad = session.diagnostics?.issues?.find((i) => i.code === "codex/bad-row");
    expect(bad?.count).toBe(1);
    expect(bad?.row).toBe(13);
    expect(session.entries.at(-1)?.text).toBe("row after the bad line still parses");
  });
});

describe("codexDisjointMetrics fidelity", () => {
  it("rejects non-integer token counts as unverifiable instead of mapping them", () => {
    const { metrics, issues } = codexDisjointMetrics({
      input_tokens: 100.5, cached_input_tokens: 10, output_tokens: 5.25, total_tokens: 116,
    });
    expect(metrics.inputTokens).toBeUndefined(); // fractional input → no disjoint input
    expect(metrics.cacheReadTokens).toBe(10); // 10 is a valid integer count
    expect(metrics.outputTokens).toBeUndefined(); // fractional output omitted
    expect(issues.some((i) => i.code === "codex/usage-invalid-token-count")).toBe(true);
  });

  it("keeps cached>input contradictions raw instead of clamping them into plausible usage", () => {
    const { metrics, notes, issues } = codexDisjointMetrics({
      input_tokens: 10, cached_input_tokens: 50, output_tokens: 5, total_tokens: 65,
    });
    // a clamp to 0 would disguise contradictory data as legitimate uncached usage
    expect(metrics.inputTokens).toBeUndefined();
    expect(metrics.cacheReadTokens).toBe(50);
    expect(metrics.outputTokens).toBe(5);
    expect(issues.some((i) => i.code === "codex/usage-inconsistent-cache")).toBe(true);
    expect(notes.join("; ")).toContain("cached_input_tokens=50 > input_tokens=10");
  });

  it("never maps cache_write_input_tokens into the disjoint cacheWriteTokens bucket", () => {
    const { metrics, notes } = codexDisjointMetrics({
      input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 100,
      output_tokens: 200, reasoning_output_tokens: 80, total_tokens: 1200,
    });
    expect(metrics).toEqual({
      inputTokens: 600, cacheReadTokens: 400, outputTokens: 200, reasoningTokens: 80,
    });
    expect(metrics.cacheWriteTokens).toBeUndefined();
    // raw value + conversion explanation preserved
    expect(notes.join("; ")).toContain("cache_write_input_tokens=100 preserved raw only");
    expect(notes.join("; ")).toContain("unverified");
  });
});

describe("codex identity", () => {
  it("maps subagent thread_spawn metadata onto the session graph", async () => {
    const session = await parse(codexRef(CHILD_ID, "codex-stats-subagent.jsonl"));
    const identity = session.document!.identity;
    expect(identity).toMatchObject({
      role: "subagent",
      parentSession: PARENT_ID,
      forkOf: PARENT_ID,
      delegationDepth: 1,
      nickname: "Probe", // nickname is its own field, not an agent preset
      agentPath: "/root/probe",
    });
    expect(identity.agentPreset).toBeUndefined();
    // original string/dict identity evidence preserved raw
    expect(identity.raw?.thread_source).toBe("subagent");
    expect(identity.raw?.parent_thread_id).toBe(PARENT_ID);
    expect(identity.raw?.forked_from_id).toBe(PARENT_ID);
    expect(identity.raw?.thread_spawn).toMatchObject({ depth: 1, agent_nickname: "Probe", agent_role: null });
  });

  it("maps a user thread_source to main and keeps git provenance", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    expect(session.document!.identity.role).toBe("main");
    expect(session.branch).toBe("feature");
    expect(session.repository).toBe("example/acme");
  });

  it("accepts verified legacy string sources as main, but never guesses on unknown thread sources", () => {
    // upstream SessionSource: cli/vscode/exec(/mcp) are root sessions
    expect(codexIdentity({ source: "cli" }).role).toBe("main");
    expect(codexIdentity({ source: "vscode" }).role).toBe("main");
    expect(codexIdentity({ source: "exec" }).role).toBe("main");
    // a non-empty unrecognized thread_source maps to Feature(..) upstream —
    // its role semantics are unknown, so it must NOT be guessed as main
    expect(codexIdentity({ thread_source: "some-feature-x" }).role).toBe("unknown");
    expect(codexIdentity({ thread_source: "user", source: "cli" }).role).toBe("main");
    expect(codexIdentity({}).role).toBe("unknown");
  });
});

describe("codex compaction fill_to_context_window marker", () => {
  // Upstream protocol.rs fill_to_context_window(): on compaction the running
  // total_token_usage is REPLACED with all-zero buckets and
  // total_tokens = context window — a "context filled" flag, not a request
  // meter. Legacy rollouts without token_usage_record rows fall back to the
  // latest cumulative snapshot, so an unidentified marker would read as a
  // confident zero.
  const WINDOW = 272000;
  const FILL = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: WINDOW };

  function statsFor(usage: UsageRecord[]): SessionStats {
    return computeStats({
      format: "asmgr.session-document", version: 1,
      ref: { agent: "codex", id: "t1", path: "/tmp/rollout-t1.jsonl" },
      identity: { role: "main" }, meta: {}, blocks: [], usage,
    });
  }

  function tokenCountRow(row: number, total: Record<string, unknown>, last: Record<string, unknown> | undefined, window: number): CodexRow {
    return { row, value: { timestamp: "2026-05-01T00:00:00.000Z", type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}), model_context_window: window } } } };
  }

  function usageRecordRow(row: number, responseId: string, usage: Record<string, number>): CodexRow {
    return { row, value: { timestamp: "2026-05-01T00:00:00.000Z", type: "token_usage_record",
      payload: { thread_id: "t1", response_id: responseId, usage: { cached_input_tokens: 0, ...usage } } } };
  }

  it("excludes a marker-only rollout from accounting instead of reading a confident zero", () => {
    const meta = extractCodexMetadata([
      { row: 1, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", thread_source: "user" } } },
      tokenCountRow(2, FILL, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: WINDOW }, WINDOW),
    ], "t1");
    const snapshot = meta.usage.find((u) => u.kind === "cumulative");
    expect(snapshot).toBeDefined();
    expect(snapshot!.counted).toBe(false);
    expect(snapshot!.raw?.total_tokens).toBe(WINDOW);
    expect(snapshot!.provenance?.metering?.note).toContain("fill_to_context_window");
    expect(meta.issues.find((i) => i.code === "codex/usage-compaction-fill-marker")).toBeDefined();
    const stats = statsFor(meta.usage);
    expect(stats.accounting).toBe("unavailable");
    expect(stats.totals).toEqual({});
    expect(stats.incomplete).toBe(true);
    expect(stats.snapshots).toBe(0); // the marker is not eligible evidence
    // The same artifact's zeroed last input is not a reported request sample:
    // raw preserved, measurement downgraded, inputTokens not fabricated.
    const context = meta.usage.find((u) => u.kind === "context");
    expect(context).toBeDefined();
    expect(context!.context?.inputTokens).toBeUndefined();
    expect(context!.context?.measurement).toBe("estimated-context");
    expect(context!.context?.contextWindow).toBe(WINDOW);
    expect(context!.context?.raw).toMatchObject({ input_tokens: 0, total_tokens: WINDOW });
  });

  it("does not let a trailing marker zero out a prior real cumulative snapshot", () => {
    const real = { input_tokens: 900, cached_input_tokens: 300, output_tokens: 160, reasoning_output_tokens: 10, total_tokens: 1060 };
    const meta = extractCodexMetadata([
      { row: 1, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", thread_source: "user" } } },
      tokenCountRow(2, real, { input_tokens: 900, cached_input_tokens: 300, output_tokens: 160 }, 64000),
      tokenCountRow(3, FILL, { input_tokens: 0, total_tokens: WINDOW }, WINDOW),
    ], "t1");
    const snapshots = meta.usage.filter((u) => u.kind === "cumulative");
    expect(snapshots.map((u) => u.counted)).toEqual([undefined, false]);
    // Latest ELIGIBLE snapshot is still the real one — the marker cannot
    // reset odometer evidence that precedes it.
    const stats = statsFor(meta.usage);
    expect(stats.accounting).toBe("latest-snapshot");
    expect(stats.totals).toEqual({ inputTokens: 600, cacheReadTokens: 300, outputTokens: 160, reasoningTokens: 10 });
    expect(stats.snapshots).toBe(1);
  });

  it("keeps real response accounting untouched when a marker follows it", () => {
    const meta = extractCodexMetadata([
      { row: 1, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", thread_source: "user" } } },
      usageRecordRow(2, "resp-1", { input_tokens: 150, output_tokens: 60, total_tokens: 210 }),
      tokenCountRow(3, FILL, { input_tokens: 0, total_tokens: WINDOW }, WINDOW),
    ], "t1");
    const stats = statsFor(meta.usage);
    expect(stats.accounting).toBe("responses");
    expect(stats.totals).toEqual({ inputTokens: 150, cacheReadTokens: 0, outputTokens: 60 });
    expect(stats.calls).toBe(1);
    expect(stats.incomplete).toBe(false);
  });

  it("does not misidentify a genuine zero request as a fill marker", () => {
    const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const meta = extractCodexMetadata([
      { row: 1, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", thread_source: "user" } } },
      tokenCountRow(2, zero, { input_tokens: 0, output_tokens: 0 }, 64000),
    ], "t1");
    const snapshot = meta.usage.find((u) => u.kind === "cumulative");
    // total_tokens 0 ≠ positive window: a real zero request stays counted.
    expect(snapshot!.counted).toBeUndefined();
    expect(meta.issues.find((i) => i.code === "codex/usage-compaction-fill-marker")).toBeUndefined();
    const stats = statsFor(meta.usage);
    expect(stats.accounting).toBe("latest-snapshot");
    expect(stats.totals).toEqual({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
    expect(stats.incomplete).toBe(false);
  });
});

describe("codex rate_limits account carrier (windows null/missing)", () => {
  const metaRow = (rateLimits: unknown): CodexRow[] => [
    { row: 1, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", thread_source: "user" } } },
    {
      row: 2,
      value: {
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: undefined, rate_limits: rateLimits },
      },
    },
  ];

  it("emits one kind=rate-limit account carrier when credits/plan exist but both windows are null/missing", () => {
    const snapshot = {
      limit_id: "li-9",
      plan_type: "pro",
      credits: { has_credits: true, unlimited: false, balance: "$5.00" },
      primary: null,
      secondary: null,
    };
    const meta = extractCodexMetadata(metaRow(snapshot), "t1");
    const carriers = meta.usage.filter((u) => u.kind === "rate-limit");
    expect(carriers).toHaveLength(1);
    const carrier = carriers[0]!;
    expect(carrier.counted).toBe(false);
    expect(carrier.metrics).toEqual({});
    expect(carrier.timestamp).toBe("2026-06-01T00:00:00.000Z");
    expect(carrier.rateLimit).toMatchObject({
      kind: "account",
      limitId: "li-9",
      planType: "pro",
      creditsBalance: "$5.00", // provider string verbatim, never parsed
    });
    // no fabricated quota percentage; no guessed account id
    expect(carrier.rateLimit!.usedPercent).toBeUndefined();
    expect(carrier.rateLimit!.accountId).toBeUndefined();
    // the whole original snapshot survives as structured raw
    expect(carrier.rateLimit!.raw).toEqual(snapshot);
  });

  it("carries a plan-only snapshot (no credits object)", () => {
    const meta = extractCodexMetadata(metaRow({ plan_type: "plus" }), "t1");
    const carriers = meta.usage.filter((u) => u.kind === "rate-limit");
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.rateLimit).toMatchObject({ kind: "account", planType: "plus" });
    expect(carriers[0]!.rateLimit!.creditsBalance).toBeUndefined();
  });

  it("keeps a null credits.balance unknown instead of coercing it", () => {
    const snapshot = { credits: { has_credits: false, unlimited: false, balance: null } };
    const meta = extractCodexMetadata(metaRow(snapshot), "t1");
    const carrier = meta.usage.find((u) => u.kind === "rate-limit")!;
    expect(carrier).toBeDefined();
    expect(carrier.rateLimit!.creditsBalance).toBeUndefined(); // null stays unknown
    expect((carrier.rateLimit!.raw!.credits as Record<string, unknown>).balance).toBeNull(); // raw preserved
  });

  it("emits no account carrier when the snapshot carries no account-level fields", () => {
    // limit_id alone is a quota bucket, not account metadata — nothing to
    // preserve, and no carrier may invent carry-forward evidence.
    const meta = extractCodexMetadata(metaRow({ limit_id: "li-1" }), "t1");
    expect(meta.usage.filter((u) => u.kind === "rate-limit")).toHaveLength(0);
  });

  it("emits no account carrier when a window sample exists", () => {
    const meta = extractCodexMetadata(metaRow({
      plan_type: "pro",
      credits: { balance: "$1.00" },
      primary: { used_percent: 10, window_minutes: 60 },
      secondary: null,
    }), "t1");
    const rates = meta.usage.filter((u) => u.kind === "rate-limit");
    expect(rates).toHaveLength(1); // normal primary window record only
    expect(rates[0]!.rateLimit!.kind).toBe("primary");
    expect(rates[0]!.rateLimit!.usedPercent).toBe(10);
  });
});

describe("codex inherited-prefix ordinal semantics", () => {
  it("falls back to the nonblank row index when rows carry no ordinal", () => {
    // Legacy rows omit ordinal; the subagent boundary still has to filter.
    // Paginated ordinals are the 0-based nonblank-record counter upstream,
    // so row-1 realigned to the first observed ordinal is the fallback.
    const rows: CodexRow[] = [
      { row: 1, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", subagent_history_start_ordinal: 2 } } },
      { row: 2, value: { type: "token_usage_record", payload: { thread_id: "t1", response_id: "r-parent", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 } } } },
      { row: 3, value: { type: "token_usage_record", payload: { thread_id: "t1", response_id: "r-own", usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5, total_tokens: 55 } } } },
    ];
    const meta = extractCodexMetadata(rows, "t1");
    expect(meta.counts.inherited).toBe(1);
    const inherited = meta.usage.find((u) => u.responseId === "r-parent");
    const own = meta.usage.find((u) => u.responseId === "r-own");
    expect(inherited?.inherited).toBe(true);
    expect(inherited?.counted).toBe(false);
    expect(own?.inherited).toBeUndefined();
    expect(own?.counted).toBeUndefined();
  });

  it("realrows ordinal-less rows against an explicit ordinal base when present", () => {
    // First ordinal observed is 40 at row 1 → offset 40; a boundary at 42
    // marks ordinal 41 inherited. The ordinal-less row 3 lands exactly on
    // the boundary (42) and is therefore the child's own record.
    const rows: CodexRow[] = [
      { row: 1, ordinal: 40, value: { type: "session_meta", payload: { id: "t1", session_id: "t1", subagent_history_start_ordinal: 42 } } },
      { row: 2, ordinal: 41, value: { type: "token_usage_record", payload: { thread_id: "t1", response_id: "r-p1", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } } } },
      { row: 3, value: { type: "token_usage_record", payload: { thread_id: "t1", response_id: "r-p2", usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, total_tokens: 3 } } } },
      { row: 4, value: { type: "token_usage_record", payload: { thread_id: "t1", response_id: "r-own", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, total_tokens: 4 } } } },
    ];
    const meta = extractCodexMetadata(rows, "t1");
    expect(meta.usage.find((u) => u.responseId === "r-p1")?.inherited).toBe(true);
    expect(meta.usage.find((u) => u.responseId === "r-p2")?.inherited).toBeUndefined();
    expect(meta.usage.find((u) => u.responseId === "r-own")?.inherited).toBeUndefined();
  });
});

describe("codex message blocks", () => {
  it("associates tool calls with their outputs by call_id", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    const call = session.entries.find((e) => e.kind === "custom_tool_call");
    const output = session.entries.find((e) => e.kind === "custom_tool_call_output");
    expect(call?.tool?.callId).toBe("call-1");
    expect(call?.tool?.name).toBe("probe");
    expect(call?.tool?.arguments).toBe('{"depth":2}');
    expect(output?.tool?.callId).toBe("call-1");
    expect(output?.text).toBe("probe ok: 3 samples");
    // no fabricated success/failure status
    expect(call?.tool?.result).toBeUndefined();
    expect(output?.tool?.result).toBeUndefined();
  });

  it("preserves image blocks as native raw instead of flattening them into text", async () => {
    const session = await parse(codexRef(MAIN_ID, "codex-stats-main.jsonl"));
    const user = session.entries.find((e) => e.role === "user");
    expect(user?.text).toBe("run the stats probe");
    expect(user?.data).toBeUndefined(); // opaque blocks stay out of the visible projection
    // the image block survives verbatim in the block's native slot
    const block = session.document!.blocks.find((b) => b.role === "user");
    const blocks = block?.native as unknown[];
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks[0] as Record<string, unknown>).type).toBe("input_image");
    expect((blocks[0] as Record<string, unknown>).image_url).toBe("data:image/png;base64,AAAA");
  });
});

describe("codex unknown-shape event payloads", () => {
  it("keeps error/review/task event_msg payloads as native raw, never searchable text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-opaque-"));
    const file = join(dir, "rollout-opaque.jsonl");
    const secret = "PRIVATE-CONTEXT-DO-NOT-INDEX";
    await writeFile(file, [
      JSON.stringify({ timestamp: "2026-05-01T00:00:00.000Z", type: "session_meta", payload: { id: "opaque-1", session_id: "opaque-1", timestamp: "2026-05-01T00:00:00.000Z", cwd: "/tmp", originator: "codex-tui", thread_source: "user" } }),
      JSON.stringify({ timestamp: "2026-05-01T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: secret, extra: { nested: true } } }),
      "",
    ].join("\n"), "utf8");
    try {
      const session = await parse({ agent: "codex", id: "opaque-1", path: file });
      const event = session.entries.find((e) => e.kind === "error");
      // no fabricated text, nothing opaque leaked into the visible projection
      expect(event?.text).toBe("");
      expect(event?.data).toBeUndefined();
      expect(JSON.stringify(session.entries)).not.toContain(secret);
      // the unknown-shape payload survives verbatim in the block's native raw
      const block = session.document!.blocks.find((b) => b.kind === "error");
      const payload = block?.native as Record<string, unknown>;
      expect(payload?.message).toBe(secret);
      expect(payload?.extra).toEqual({ nested: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
