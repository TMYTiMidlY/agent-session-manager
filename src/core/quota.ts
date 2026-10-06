import type { SessionRef, UsageRecord } from "./types.js";
import { parseSession } from "./parse.js";
import { hourBucket } from "./timezone.js";

/**
 * Codex rate-limit accounting. Samples come ONLY from the unified session
 * document (`parseSession(ref)` → `document.usage` records of
 * `kind: "rate-limit"` carrying a structured `rateLimit` payload:
 * primary/secondary window kind, usedPercent, windowMinutes, resetAt,
 * limitId, planType, creditsBalance, accountId and the original raw snapshot).
 * Raw `rate_limits` JSON is never re-scanned or re-parsed from notes.
 *
 * Semantics:
 * - Rates are only sampled when requests happen: gaps are unknown, never
 *   zero, and `used_percent` keeps the source's f64 precision (no rounding).
 * - `limit_id` identifies a QUOTA BUCKET, not an account. Samples without an
 *   `accountId` may span accounts and are never presented as one identified
 *   account; only an explicit accountId forms an independent account group.
 * - Ordering compares parsed instants (Date.parse), so mixed UTC offsets in
 *   source timestamps order correctly.
 * - Reset evidence is observed only: a used_percent watermark drop or a
 *   later/changed reset window — never a global "reset happened" claim.
 * - The credits snapshot is whole-snapshot semantics: the latest observation
 *   that actually carried credits fields wins as a unit; stale fields are
 *   never field-wise merged onto a newer observedAt, and a snapshot without
 *   balance fields leaves the balance unknown (no carry-forward).
 */

export type QuotaWindow = "primary" | "secondary";

/** Where a sample was observed — kept on every sample for cross-session auditing. */
export interface QuotaOrigin {
  agent: "codex";
  id: string;
  path: string;
}

export interface QuotaSample {
  timestamp: string;
  window: QuotaWindow;
  /** 0-100, source f64 precision preserved. */
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
  limitId?: string;
  limitName?: string;
  accountId?: string;
  planType?: string;
  /** The original rate-limit snapshot this sample was read from. */
  raw?: Record<string, unknown>;
  origin: QuotaOrigin;
}

/** Account-level facts from the last snapshot that actually carried them. */
export interface QuotaAccountInfo {
  /** Present only when a sample stated an account identity. */
  accountId?: string;
  limitId?: string;
  limitName?: string;
  /** Codex reports balance as a string; never coerced to a number. */
  creditsBalance?: string;
  creditsUnlimited?: boolean;
  hasCredits?: boolean;
  planType?: string;
  observedAt?: string;
  /** The whole raw snapshot the facts came from. */
  raw?: Record<string, unknown>;
}

/** Account-level facts observed from a window-less snapshot (credits/plan only, no watermark). */
export interface QuotaAccountObservation {
  timestamp: string;
  limitId?: string;
  limitName?: string;
  planType?: string;
  /** Codex reports balance as a string; never coerced to a number. */
  creditsBalance?: string;
  creditsUnlimited?: boolean;
  hasCredits?: boolean;
  /** The original rate-limit snapshot this observation was read from. */
  raw?: Record<string, unknown>;
  origin: QuotaOrigin;
}

export interface QuotaLedger {
  ref: SessionRef;
  samples: QuotaSample[];
  /**
   * Account-level snapshots from rate-limit records that carried credits/plan
   * metadata but no usable window watermark (e.g. primary/secondary both
   * null/missing). They never enter the hourly curve.
   */
  accountSnapshots: QuotaAccountObservation[];
  /** Bounded diagnostics from the parse (bad rows etc.); surfaced, never swallowed. */
  issues: { code: string; message: string; row?: number; count: number }[];
}

export type ResetEventKind = "observed-watermark-drop" | "reset-window-changed";

export interface QuotaResetEvent {
  at: string;
  kind: ResetEventKind;
}

export interface QuotaHourRow {
  /** Hour bucket label incl. UTC offset (DST-repeated hours stay distinct). */
  hour: string;
  window: QuotaWindow;
  min: number;
  max: number;
  last: number;
  lastAt: string;
  samples: number;
  lastResetsAt?: string;
  /** Observed-only reset evidence; NOT a claim of a global reset. */
  resetEvents: QuotaResetEvent[];
}

export interface QuotaGroup {
  /** Present only when every sample stated this account identity. */
  accountId?: string;
  /** Quota bucket id; a bucket is NOT an account identity. */
  limitId?: string;
  limitName?: string;
  /** True when this group's samples carry no accountId — may span accounts. */
  maySpanAccounts: boolean;
  /** Plan type stated by this quota group's own samples (latest wins). */
  planType?: string;
  window: QuotaWindow;
  rows: QuotaHourRow[];
  /** Per-sample provenance for auditing (JSON output; not rendered as text). */
  samples: QuotaSample[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const optionalString = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** resetAt may arrive as an ISO string (unified RateLimitSample) or unix seconds (raw). */
function normalizeResetAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = optionalString(value);
  if (text === undefined) return undefined;
  return Number.isNaN(Date.parse(text)) ? undefined : text;
}

/**
 * Read one Codex session's rate-limit samples from its unified document.
 * Account-level snapshots (credits/plan without a window watermark) are
 * collected FIRST as their own channel; hourly watermark samples follow per
 * primary/secondary window. Read failures propagate (an empty ledger must
 * never impersonate a scanned one); bounded per-row parse diagnostics come
 * back as `issues`.
 */
export async function collectCodexQuota(ref: SessionRef): Promise<QuotaLedger> {
  const parsed = await parseSession(ref); // unreadable/corrupt-at-structure level errors surface here
  const document = parsed.document;
  if (!document) throw new Error(`no unified document for Codex session ${ref.agent}:${ref.id} (${ref.path})`);
  const origin: QuotaOrigin = { agent: "codex", id: ref.id, path: ref.path };
  const samples: QuotaSample[] = [];
  const accountSnapshots: QuotaAccountObservation[] = [];
  // Bounded, payload-free counter for rate-limit records whose timestamp is
  // missing/invalid: they cannot be placed on a time axis and are excluded
  // from BOTH the hourly curve and account-snapshot ordering. Content is
  // never echoed (rate-limit rows sit next to private transcripts).
  let unplaceableTimeCount = 0;
  let unplaceableTimeRow: number | undefined;
  const accountIssues = new Map<string, { message: string; row?: number; count: number }>();
  for (const event of document.events ?? []) {
    if (event.type !== "usage/record") continue;
    const usage: UsageRecord = event.data.usage;
    if (usage.kind !== "rate-limit") continue;
    const rate = usage.rateLimit;
    if (!rate) continue;
    const timestamp = optionalString(usage.timestamp);
    const timestampOk = timestamp !== undefined && !Number.isNaN(Date.parse(timestamp));
    if (!timestampOk) {
      // No instant → cannot bucket, order, or race for "latest snapshot".
      if (unplaceableTimeCount === 0) unplaceableTimeRow = usage.provenance?.row;
      unplaceableTimeCount++;
      continue;
    }
    const raw = record(rate.raw);
    if (rate.kind === "account") {
      // Window-less account snapshot: credits/plan metadata only. It never
      // enters the hourly curve; a quota percentage is never fabricated.
      const observation: QuotaAccountObservation = { timestamp, origin };
      if (Object.keys(raw).length > 0) observation.raw = raw;
      const limitId = rate.limitId ?? optionalString(raw.limit_id);
      if (limitId !== undefined) observation.limitId = limitId;
      const limitName = optionalString(raw.limit_name);
      if (limitName !== undefined) observation.limitName = limitName;
      const planType = rate.planType ?? optionalString(raw.plan_type);
      if (planType !== undefined) observation.planType = planType;
      // Balance stays the source's string verbatim; null/absent stays unknown.
      const credits = record(raw.credits);
      const balance = typeof credits.balance === "string" ? credits.balance : undefined;
      if (balance !== undefined) observation.creditsBalance = balance;
      if (typeof credits.unlimited === "boolean") observation.creditsUnlimited = credits.unlimited;
      if (typeof credits.has_credits === "boolean") observation.hasCredits = credits.has_credits;
      // Account identity is never guessed from elsewhere in the payload.
      accountSnapshots.push(observation);
      continue;
    }
    // The structured record names its window (primary/secondary); a record
    // without one cannot be placed and is skipped — never duplicated into
    // both windows.
    const window = rate.kind === "primary" || rate.kind === "secondary" ? rate.kind : optionalString(raw.window);
    if (window !== "primary" && window !== "secondary") continue;
    const usedPercent = rate.usedPercent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) continue;
    const sample: QuotaSample = { timestamp, window, usedPercent, origin };
    if (Object.keys(raw).length > 0) sample.raw = raw;
    if (typeof rate.windowMinutes === "number" && Number.isSafeInteger(rate.windowMinutes) && rate.windowMinutes >= 0) {
      sample.windowMinutes = rate.windowMinutes;
    }
    const resetsAt = normalizeResetAt(rate.resetAt);
    if (resetsAt !== undefined) sample.resetsAt = resetsAt;
    const limitId = rate.limitId ?? optionalString(raw.limit_id);
    if (limitId !== undefined) sample.limitId = limitId;
    const limitName = optionalString(raw.limit_name);
    if (limitName !== undefined) sample.limitName = limitName;
    const accountId = rate.accountId;
    if (accountId !== undefined) sample.accountId = accountId;
    const planType = rate.planType ?? optionalString(raw.plan_type);
    if (planType !== undefined) sample.planType = planType;
    samples.push(sample);
  }
  if (unplaceableTimeCount > 0) {
    const issue = {
      message: `rate-limit record(s) without a usable timestamp (missing/invalid) excluded from the hourly curve and account snapshot ordering; content not echoed`,
      ...(unplaceableTimeRow !== undefined ? { row: unplaceableTimeRow } : {}),
      count: unplaceableTimeCount,
    };
    accountIssues.set("quota/unplaceable-time", issue);
  }
  return {
    ref,
    samples,
    accountSnapshots,
    issues: [
      ...(parsed.diagnostics?.issues ?? []).map(({ code, message, row, count }) => ({ code, message, row, count })),
      ...[...accountIssues.entries()].map(([code, { message, row, count }]) => ({ code, message, row, count })),
    ],
  };
}

/**
 * Cross-session dedupe key. Identical snapshots replayed by fork/subagent
 * rollouts collapse, but samples never dedupe across differing limit ids,
 * accounts, windows, window lengths or reset windows.
 */
function sampleKey(sample: QuotaSample): string {
  return [sample.timestamp, sample.window, sample.usedPercent, sample.windowMinutes ?? "",
    sample.resetsAt ?? "", sample.limitId ?? "", sample.accountId ?? "", sample.planType ?? ""].join("|");
}

/** Dedupe across sessions, keeping first-seen order stable. */
export function dedupeQuotaSamples(samples: readonly QuotaSample[]): QuotaSample[] {
  const seen = new Set<string>();
  return samples.filter((sample) => {
    const key = sampleKey(sample);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cross-session dedupe for account observations: byte-identical snapshots
 * replayed by fork/subagent rollouts collapse (first-seen origin wins).
 */
export function dedupeQuotaAccountSnapshots(observations: readonly QuotaAccountObservation[]): QuotaAccountObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = [observation.timestamp, observation.limitId ?? "", observation.limitName ?? "",
      observation.planType ?? "", observation.creditsBalance ?? "",
      observation.creditsUnlimited ?? "", observation.hasCredits ?? "",
      JSON.stringify(observation.raw ?? null)].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Structural input of latestAccountSnapshots: anything carrying account-level facts. */
type AccountFactSource = {
  timestamp: string;
  accountId?: string;
  limitId?: string;
  limitName?: string;
  planType?: string;
  raw?: Record<string, unknown>;
};

/** Whole-snapshot account facts: the latest observation that carried any credits field, kept as a unit. */
export function latestAccountSnapshots(sources: readonly AccountFactSource[]): QuotaAccountInfo[] {
  type Snapshot = { timestamp: string; epoch: number; sample: AccountFactSource; raw: Record<string, unknown> | undefined };
  const byAccount = new Map<string, Snapshot>();
  for (const sample of sources) {
    const raw = sample.raw;
    // Only snapshots carrying account-level fields (credits/plan) can refresh
    // account facts; a bare limit_id is a quota-bucket field, not an account
    // observation, and must not retire an earlier credits snapshot.
    const carriesCredits = raw !== undefined && ("credits" in raw || "plan_type" in raw);
    if (!carriesCredits) continue; // no account-level fields → cannot refresh any fact
    const time = Date.parse(sample.timestamp);
    if (Number.isNaN(time)) continue;
    const key = sample.accountId ?? "(unidentified)";
    const prior = byAccount.get(key);
    if (prior === undefined || time > prior.epoch) {
      byAccount.set(key, { timestamp: sample.timestamp, epoch: time, sample, raw });
    }
  }
  const accounts: QuotaAccountInfo[] = [];
  for (const [key, snapshot] of byAccount) {
    const credits = record(snapshot.raw?.credits);
    const account: QuotaAccountInfo = {
      observedAt: snapshot.timestamp,
      ...(snapshot.sample.accountId !== undefined ? { accountId: snapshot.sample.accountId } : {}),
      ...(snapshot.sample.limitId !== undefined ? { limitId: snapshot.sample.limitId } : {}),
      ...(snapshot.sample.limitName !== undefined ? { limitName: snapshot.sample.limitName } : {}),
      ...(optionalString(credits.balance) !== undefined ? { creditsBalance: optionalString(credits.balance)! } : {}),
      ...(typeof credits.unlimited === "boolean" ? { creditsUnlimited: credits.unlimited } : {}),
      ...(typeof credits.has_credits === "boolean" ? { hasCredits: credits.has_credits } : {}),
      ...((snapshot.sample.planType ?? optionalString(snapshot.raw?.plan_type)) !== undefined
        ? { planType: (snapshot.sample.planType ?? optionalString(snapshot.raw?.plan_type))! }
        : {}),
      ...(snapshot.raw !== undefined ? { raw: snapshot.raw } : {}),
    };
    if (key === "(unidentified)") delete account.accountId;
    accounts.push(account);
  }
  accounts.sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? ""));
  return accounts;
}

function groupKey(sample: QuotaSample): string {
  return [sample.accountId ?? "", sample.limitId ?? "", sample.window].join("|");
}

const epochOf = (timestamp: string): number => Date.parse(timestamp);

/**
 * Hourly min/max/last per (accountId, limit_id, window). "last" is by real
 * event instant (epoch comparison — mixed UTC offsets order correctly), not
 * file or string order. Reset events are observed evidence only.
 */
export function summarizeQuotaHourly(samples: readonly QuotaSample[], zone = "UTC"): QuotaGroup[] {
  const groups = new Map<string, QuotaSample[]>();
  for (const sample of samples) {
    const key = groupKey(sample);
    const bucket = groups.get(key) ?? [];
    bucket.push(sample);
    groups.set(key, bucket);
  }
  const result: QuotaGroup[] = [];
  for (const [key, bucket] of groups) {
    const [accountId, limitKey, window] = key.split("|") as [string, string, QuotaWindow];
    const rows: QuotaHourRow[] = [];
    // Order the whole group by real event instant first: reset evidence is
    // read across hour boundaries and attributed to the later sample's hour.
    const ordered = [...bucket].sort((a, b) => {
      const left = epochOf(a.timestamp);
      const right = epochOf(b.timestamp);
      return left === right ? 0 : left < right ? -1 : 1;
    });
    const resetEventsByHour = new Map<string, QuotaResetEvent[]>();
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      let kind: ResetEventKind | undefined;
      if (current.usedPercent < previous.usedPercent) kind = "observed-watermark-drop";
      else if (previous.resetsAt !== undefined && current.resetsAt !== undefined
        && epochOf(current.resetsAt) > epochOf(previous.resetsAt)) {
        kind = "reset-window-changed";
      }
      if (kind === undefined) continue;
      const hour = hourBucket(current.timestamp, zone);
      if (hour === undefined) continue;
      const events = resetEventsByHour.get(hour) ?? [];
      events.push({ at: current.timestamp, kind });
      resetEventsByHour.set(hour, events);
    }
    const byHour = new Map<string, QuotaSample[]>();
    for (const sample of ordered) {
      const hour = hourBucket(sample.timestamp, zone);
      if (hour === undefined) continue;
      const rowsInHour = byHour.get(hour) ?? [];
      rowsInHour.push(sample);
      byHour.set(hour, rowsInHour);
    }
    for (const [hour, inHour] of byHour) {
      const last = inHour[inHour.length - 1]!;
      // Loop min/max: spread on huge hour buckets would overflow the arg stack.
      let min = inHour[0]!.usedPercent;
      let max = min;
      for (const sample of inHour) {
        if (sample.usedPercent < min) min = sample.usedPercent;
        if (sample.usedPercent > max) max = sample.usedPercent;
      }
      const row: QuotaHourRow = {
        hour,
        window,
        min,
        max,
        last: last.usedPercent,
        lastAt: last.timestamp,
        samples: inHour.length,
        ...(last.resetsAt !== undefined ? { lastResetsAt: last.resetsAt } : {}),
        resetEvents: resetEventsByHour.get(hour) ?? [],
      };
      rows.push(row);
    }
    rows.sort((a, b) => (epochOf(a.hour) < epochOf(b.hour) ? -1 : epochOf(a.hour) > epochOf(b.hour) ? 1 : 0));
    const maySpanAccounts = accountId === "";
    const group: QuotaGroup = {
      window,
      maySpanAccounts,
      rows,
      samples: ordered,
    };
    if (!maySpanAccounts) group.accountId = accountId;
    if (limitKey !== "") group.limitId = limitKey;
    // planType for THIS quota group only: its own latest sample that stated one.
    const withPlan = [...ordered].reverse().find((sample) => sample.planType !== undefined);
    if (withPlan?.planType !== undefined) group.planType = withPlan.planType;
    const named = ordered.find((sample) => sample.limitName !== undefined);
    if (named?.limitName !== undefined) group.limitName = named.limitName;
    result.push(group);
  }
  return result;
}
