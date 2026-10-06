import type { ParsedSession, SessionDocument, SessionStats, UsageRecord } from "./types.js";
import { computeStats, dedupeUsage } from "./normalized.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Extended aggregates derived from a session's unified usage ledger.
 * Everything in {@link SessionStats} plus the values the CLI sorts on.
 * Missing values stay undefined — never 0.
 *
 * Metering basis (stated explicitly wherever these are displayed):
 * - `billedInputTokens` is the EXACT aggregate prompt denominator, derived
 *   per source semantics; a missing bucket never folds to 0:
 *   - disjoint ledgers (Claude/DSH/Copilot): uncached input + cache read +
 *     cache write, only when ALL three buckets are known;
 *   - Codex: Σ `raw.input_tokens` over the SELECTED response records
 *     (same eligibility/dedupe/conflict policy as `computeStats()`), or the
 *     latest cumulative snapshot's `raw.input_tokens` when no responses
 *     exist — Codex `input_tokens` already includes cached input, and the
 *     unverified `cache_write_input_tokens` is never added on top;
 *   - DSH alternative: `totalTokens − outputTokens` (the provider total is
 *     the exact full-call count and reasoning ⊆ output).
 * - `cacheReadRatio` = cacheReadTokens ÷ billedInputTokens ("cache%"). It is
 *   only defined when the denominator above is exact.
 * - `cacheTokens` = cacheRead + cacheWrite, only when both are known.
 * - `peakContextWindow` is the largest sampled `contextWindow` (a route
 *   property, not a token count).
 * - `peakContextTokens` is the max `context.inputTokens` over the ledger's
 *   context samples (`kind: "context"` carriers with
 *   `measurement: "reported-input"` — e.g. Codex
 *   `token_count.info.last_token_usage.input_tokens`). It is read from the
 *   structured ledger only; `provenance` notes are never re-parsed.
 * - `peakContextUtilization` pairs THE max-input sample with ITS OWN
 *   `contextWindow` — when that sample has no window the utilization is
 *   unknown; a smaller-input sample that happens to carry a window is never
 *   substituted, and the utilization maximum is never selected independently
 *   of the token maximum.
 * - `compactions` counts compaction/compacted transcript blocks; a fully
 *   parsed document yields the exact count including 0.
 * - Base totals defer to `computeStats()`: per-response increments and
 *   cumulative snapshots are ALTERNATIVE accounting evidence (responses win;
 *   the latest snapshot is the fallback), never additive.
 */
export interface DerivedStats extends SessionStats {
  /** Exact aggregate prompt (see basis above); unknown when any bucket is missing. */
  billedInputTokens?: number;
  /** Cache read + cache write (when both are known). */
  cacheTokens?: number;
  /** cache% = cache read ÷ exact aggregate prompt (0-1). */
  cacheReadRatio?: number;
  /** Largest sampled context window. */
  peakContextWindow?: number;
  /** Max reported-input context sample (e.g. Codex last_token_usage.input_tokens). */
  peakContextTokens?: number;
  /** The max sample's input ÷ ITS OWN context window (0-1); paired exactly. */
  peakContextUtilization?: number;
  /** Compaction events recorded in the transcript blocks (exact, incl. 0). */
  compactions?: number;
}

function ledgerOf(document: SessionDocument): UsageRecord[] {
  return document.events
    ? document.events.flatMap((event) => (event.type === "usage/record" ? [event.data.usage] : []))
    : document.usage;
}

/**
 * Records eligible for this session's accounting — mirrors the
 * `computeStats()` eligibility filter so extended fields never disagree with
 * the base totals: uncounted/inherited observations, context/rate-limit
 * carriers, and `last_token_usage` hints are excluded.
 */
function eligibleLedger(document: SessionDocument): UsageRecord[] {
  const id = document.ref.id;
  return ledgerOf(document).filter((usage) => usage.counted !== false && !usage.inherited
    && (!usage.ownerSessionId || usage.ownerSessionId === id)
    && usage.kind !== "context" && usage.kind !== "rate-limit"
    && !usage.provenance?.rawType?.includes("last_token_usage"));
}

const METRIC_KEYS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;
const hasMetrics = (usage: UsageRecord) => METRIC_KEYS.some((key) => usage.metrics[key] !== undefined);

/** The records `computeStats()` would sum: deduped responses, else the latest snapshot. */
function selectedAccountingRecords(document: SessionDocument): UsageRecord[] {
  const eligible = eligibleLedger(document).filter(hasMetrics);
  const increments = eligible.filter((usage) => !usage.cumulative);
  if (!increments.length) {
    const snapshots = eligible.filter((usage) => usage.cumulative);
    return snapshots.length ? [snapshots[snapshots.length - 1]!] : [];
  }
  const conflicts = new Set<string>();
  const seen = new Map<string, UsageRecord>();
  for (const usage of increments) {
    if (!usage.responseId) continue;
    const prior = seen.get(usage.responseId);
    if (prior) {
      if (METRIC_KEYS.some((key) => prior.metrics[key] !== usage.metrics[key])) conflicts.add(usage.responseId);
    } else seen.set(usage.responseId, usage);
  }
  return dedupeUsage(increments).filter((usage) => !usage.responseId || !conflicts.has(usage.responseId));
}

const exactCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Exact aggregate prompt (billed input), per source semantics. Codex raw
 * `input_tokens` includes cached input and is the precise denominator; the
 * unverified cache-write field is never added. Disjoint ledgers require every
 * bucket. DSH may fall back to its exact provider total minus output.
 */
function aggregatePrompt(document: SessionDocument, stats: SessionStats, selected: UsageRecord[]): number | undefined {
  if (document.ref.agent === "codex") {
    // Response records keep the WHOLE TokenUsageRecord payload (usage counts
    // under `raw.usage`); cumulative snapshots keep the usage object itself.
    const rawInput = (usage: UsageRecord) => {
      const whole = record(usage.raw?.usage);
      const value = whole.input_tokens ?? usage.raw?.input_tokens;
      return exactCount(value) ? value : undefined;
    };
    if (selected.length) {
      let sum = 0;
      for (const usage of selected) {
        const value = rawInput(usage);
        if (value === undefined) return undefined; // one unknown bucket spoils the exact total
        sum += value;
      }
      return sum;
    }
    // No selected records, or the caller's selection already fell back to the
    // latest cumulative snapshot (whose raw.input_tokens was summed above).
    return undefined;
  }
  const totals = stats.totals;
  const input = totals.inputTokens;
  const cacheRead = totals.cacheReadTokens;
  const cacheWrite = totals.cacheWriteTokens;
  if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
    return input + cacheRead + cacheWrite;
  }
  if (document.ref.agent === "dsh"
    && exactCount(totals.totalTokens) && exactCount(totals.outputTokens)
    && totals.totalTokens! >= totals.outputTokens!) {
    return totals.totalTokens! - totals.outputTokens!;
  }
  return undefined;
}

/** Extended stats over the unified document; base accounting via computeStats(). */
export function deriveStatsFromDocument(document: SessionDocument): DerivedStats {
  const stats: DerivedStats = { ...computeStats(document) };
  const selected = selectedAccountingRecords(document);

  const prompt = aggregatePrompt(document, stats, selected);
  if (prompt !== undefined) stats.billedInputTokens = prompt;
  const { cacheReadTokens, cacheWriteTokens } = stats.totals;
  if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined) {
    stats.cacheTokens = cacheReadTokens + cacheWriteTokens;
  }
  if (prompt !== undefined && cacheReadTokens !== undefined && prompt > 0) {
    stats.cacheReadRatio = cacheReadTokens / prompt;
  }

  // Peak context: structured context samples only (never provenance notes).
  // Context carriers are `counted: false` by design, so the accounting
  // eligibility filter must NOT gate this scan; ownership/inherited still do.
  let peakContextWindow: number | undefined;
  let peakContextTokens: number | undefined;
  let pairedWindow: number | undefined;
  for (const record of ledgerOf(document)) {
    if (record.inherited) continue;
    if (record.ownerSessionId !== undefined && record.ownerSessionId !== document.ref.id) continue;
    const context = record.context;
    if (!context) continue;
    const window = context.contextWindow;
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      if (peakContextWindow === undefined || window > peakContextWindow) peakContextWindow = window;
    }
    const input = context.inputTokens;
    if (exactCount(input)) {
      // Strictly greater: ties keep the FIRST max sample and ITS window.
      if (peakContextTokens === undefined || input > peakContextTokens) {
        peakContextTokens = input;
        pairedWindow = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
      }
    }
  }
  if (peakContextWindow !== undefined) stats.peakContextWindow = peakContextWindow;
  if (peakContextTokens !== undefined) stats.peakContextTokens = peakContextTokens;
  if (peakContextTokens !== undefined && pairedWindow !== undefined) {
    stats.peakContextUtilization = peakContextTokens / pairedWindow;
  }

  let compactions = 0;
  for (const block of document.blocks) {
    if (block.kind === "compaction" || block.kind === "compacted") compactions++;
  }
  // A parsed document is a complete source: an exact zero is a fact, not unknown.
  stats.compactions = compactions;
  return stats;
}

/**
 * Derive extended stats for an already-parsed session. `parseSession()`
 * output always carries `document`; hand-built sessions fall back to their
 * `stats`. Returns undefined when neither is present.
 */
export function deriveStats(parsed: ParsedSession): DerivedStats | undefined {
  if (parsed.document) return deriveStatsFromDocument(parsed.document);
  if (parsed.stats) return { ...parsed.stats };
  return undefined;
}
