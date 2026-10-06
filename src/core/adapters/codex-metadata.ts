import type { ParseIssue, SessionIdentity, UsageMetrics, UsageRecord } from "../types.js";
import { stringifyCompact } from "../text.js";

/**
 * Codex rollout metadata extraction (usage ledger + session-graph identity).
 *
 * Sources verified against upstream rorepos/codex @ 822e58cc:
 * - `codex-rs/protocol/src/protocol.rs`: TokenUsage (all fields i64),
 *   TokenUsageRecord, TokenUsageInfo, TokenCountEvent, RateLimitSnapshot,
 *   RateLimitWindow, CreditsSnapshot, SessionMeta, ThreadSource,
 *   SessionSource, SubAgentSource, GitInfo.
 * - `codex-rs/codex-api/src/sse/responses.rs`: TokenUsage is built verbatim
 *   from the Responses API `response.completed` usage — `input_tokens`
 *   INCLUDES `cached_tokens` (subset, confirmed); `reasoning_tokens` is an
 *   `output_tokens_details` subset; `cache_write_input_tokens` is carried
 *   verbatim from `input_tokens_details.cache_write_tokens` with NO code
 *   anywhere upstream establishing its subset/disjoint relation to
 *   `input_tokens` — therefore it is NEVER mapped into the DSH disjoint
 *   `cacheWriteTokens` bucket, only preserved raw with a conversion note.
 *   Provider `total_tokens` is preserved raw and is NOT a DSH-style disjoint
 *   total.
 * - `codex-rs/core/src/session/mod.rs`: `token_usage_record` rows are
 *   persisted once per observed response completion; `event_msg/token_count`
 *   carries the running `total_token_usage` snapshot (cumulative), the
 *   per-response `last_token_usage`, `model_context_window`, and
 *   `rate_limits`.
 * - `codex-rs/rollout/src/ordinal.rs` + `codex-rs/history/src/lib.rs`
 *   `RolloutLine`: `ordinal` is `Option<u64>` — Legacy history mode never
 *   serializes it; Paginated mode writes a sequential counter that advances
 *   once per written record, i.e. it is aligned with the 0-based nonblank
 *   JSONL record index (continued across appends via the reverse scanner).
 *
 * No value is ever fabricated: missing fields stay undefined, never zero.
 */

/** One scanned nonblank rollout row; `bad` marks an unparseable line. */
export interface CodexRow {
  /** One-based nonblank JSONL record number (header is 1). */
  row: number;
  /** Rollout ordinal when the row carries one (fork-prefix detection). */
  ordinal?: number;
  value: unknown;
  bad?: boolean;
}

export interface CodexGit {
  branch?: string;
  repository?: string;
  commitHash?: string;
}

export interface CodexMetadata {
  identity: Partial<SessionIdentity>;
  usage: UsageRecord[];
  issues: ParseIssue[];
  git?: CodexGit;
  /** Canonical agent path for AgentControl-spawned sub-agents. */
  agentPath?: string;
  counts: {
    increments: number;
    snapshots: number;
    duplicateResponses: number;
    foreignThread: number;
    inherited: number;
    invalidUsage: number;
  };
}

const MAX_ISSUE_CODES = 8;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const int = (value: unknown): number | undefined => {
  const valueNum = num(value);
  return valueNum !== undefined && Number.isSafeInteger(valueNum) ? valueNum : undefined;
};

/**
 * Token counts are i64 upstream (protocol.rs TokenUsage); anything that is
 * not a non-negative safe integer is not a token count we can confirm.
 */
const tokens = int;

const isoFromSeconds = (value: unknown): string | undefined => {
  const seconds = num(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/** Metric-level fidelity problem found while mapping one raw TokenUsage. */
export interface CodexMetricIssue {
  code: string;
  message: string;
}

/**
 * Bounded, payload-free issue log: one ParseIssue per code, `count`
 * aggregated, `row` anchored to the first occurrence. Malformed content is
 * never echoed — Codex rollouts can embed private transcripts.
 */
class IssueLog {
  private readonly byCode = new Map<string, ParseIssue>();

  add(code: string, message: string, row: number, type?: string): void {
    const existing = this.byCode.get(code);
    if (existing) {
      existing.count++;
      return;
    }
    if (this.byCode.size >= MAX_ISSUE_CODES) return; // bounded code sample
    this.byCode.set(code, { code, message, ...(type ? { type } : {}), row, count: 1 });
  }

  list(): ParseIssue[] {
    return [...this.byCode.values()].map((issue) => ({ ...issue }));
  }
}

/**
 * Map a raw Codex TokenUsage onto DSH disjoint semantics.
 * - Token counts must be safe integers (upstream i64). Fractional/negative/
 *   out-of-range values are unrecognized: the metric is omitted, the raw
 *   value stays in `raw`, and an issue is reported.
 * - `input_tokens` includes `cached_input_tokens` (confirmed subset), so the
 *   disjoint input is `input - cached`. When `cached > input` the pair is
 *   self-contradictory: upstream display code clamps with `.max(0)`, but a
 *   clamp here would disguise contradictory data as a legitimate uncached
 *   usage — instead the disjoint input is omitted as unverifiable, the raw
 *   counts are preserved, and an issue is reported.
 * - `cache_write_input_tokens` is NEVER mapped to `cacheWriteTokens`: no
 *   upstream code establishes its subset/disjoint relation to input (it is
 *   carried verbatim from `input_tokens_details.cache_write_tokens`), so
 *   folding it into the disjoint cache bucket would assert an unverified
 *   accounting identity. It survives in `raw` plus a conversion note only.
 * - `reasoning_output_tokens` is a subset of `output_tokens` (never added).
 * - raw `total_tokens` is NOT mapped to DSH `totalTokens`; it is preserved
 *   verbatim via a note (Codex/OpenAI basis, not a DSH disjoint total).
 */
export function codexDisjointMetrics(raw: unknown): {
  metrics: UsageMetrics;
  notes: string[];
  issues: CodexMetricIssue[];
} {
  const usage = record(raw);
  const metrics: UsageMetrics = {};
  const notes: string[] = [];
  const issues: CodexMetricIssue[] = [];

  // Token fields must be safe integers (upstream i64); anything else is
  // unrecognized and stays raw-only.
  const invalidFields: string[] = [];
  const checkedToken = (field: string): number | undefined => {
    const value = usage[field];
    if (value === undefined || value === null) return undefined;
    const tokenValue = tokens(value);
    if (tokenValue === undefined) invalidFields.push(field);
    return tokenValue;
  };
  const input = checkedToken("input_tokens");
  const cached = checkedToken("cached_input_tokens");
  const output = checkedToken("output_tokens");
  const reasoning = checkedToken("reasoning_output_tokens");
  if (invalidFields.length > 0) {
    issues.push({
      code: "codex/usage-invalid-token-count",
      message: `token count(s) not safe non-negative integers, omitted as unverifiable: ${invalidFields.join(", ")}`,
    });
  }

  if (input !== undefined && cached !== undefined) {
    if (cached > input) {
      // Contradiction: clamping to 0 would disguise it as legitimate
      // uncached usage. Omit the disjoint input, keep raw + diagnostic.
      issues.push({
        code: "codex/usage-inconsistent-cache",
        message: "cached_input_tokens exceeds input_tokens; disjoint uncached input unverifiable (no clamp), raw preserved",
      });
      notes.push(`cached_input_tokens=${cached} > input_tokens=${input}: disjoint input omitted (raw preserved, not clamped to 0)`);
    } else {
      metrics.inputTokens = input - cached;
    }
  } else if (input !== undefined) {
    // cached unknown → disjoint input unknowable; preserve the raw count.
    notes.push(`raw input_tokens=${input} unmapped (cached_input_tokens missing)`);
  }
  if (cached !== undefined) metrics.cacheReadTokens = cached;

  if (usage.cache_write_input_tokens !== undefined && usage.cache_write_input_tokens !== null) {
    const cacheWrite = usage.cache_write_input_tokens;
    notes.push(
      `cache_write_input_tokens=${stringifyCompact(cacheWrite)} preserved raw only; subset/disjoint relation to input_tokens unverified upstream (sse/responses.rs carries it verbatim) — not mapped to cacheWriteTokens`,
    );
  }

  if (output !== undefined) metrics.outputTokens = output;
  if (reasoning !== undefined) metrics.reasoningTokens = reasoning;
  const total = usage.total_tokens;
  if (total !== undefined) notes.push(`raw total_tokens=${stringifyCompact(total)} preserved verbatim (Codex basis, not DSH total)`);
  return { metrics, notes, issues };
}

const hasMetrics = (metrics: UsageMetrics): boolean => Object.keys(metrics).length > 0;

/**
 * Upstream `SessionSource` string forms verified as root/main sessions
 * (protocol.rs `SessionSource::is_non_root_agent()` is false for these):
 * cli, vscode, exec, mcp. Custom strings and "unknown" are not confirmed
 * main; dict forms are handled structurally below.
 */
const MAIN_SOURCE_STRINGS = new Set(["cli", "vscode", "exec", "mcp"]);

/** Extract session-graph identity from a chosen session_meta payload. */
export function codexIdentity(meta: Record<string, unknown>): Partial<SessionIdentity> {
  const identity: Partial<SessionIdentity> = {};
  const threadSourceRaw = meta.thread_source;
  const threadSource = typeof threadSourceRaw === "string" && threadSourceRaw
    ? threadSourceRaw
    : str(record(threadSourceRaw).type) ?? str(record(threadSourceRaw).kind);
  const sourceRaw = meta.source;
  const source = record(sourceRaw);
  const subagent = record(source.subagent);
  const isSubagentSource = "subagent" in source;
  const internal = str(source.internal);
  const spawn = record(subagent.thread_spawn);
  const subagentOther = str(subagent.other);
  const hasReview = "review" in subagent || threadSource === "guardian_review";

  let role: SessionIdentity["role"] | undefined;
  if (subagentOther === "guardian" || internal === "guardian" || hasReview) role = "guardian";
  else if (threadSource === "subagent" || threadSource === "memory_consolidation"
    || isSubagentSource || internal !== undefined) role = "subagent";
  else if (threadSource === "user") role = "main";
  else if (threadSource === undefined && typeof sourceRaw === "string"
    && MAIN_SOURCE_STRINGS.has(sourceRaw)) {
    // Legacy main-session compatibility: a bare string source verified as a
    // root SessionSource upstream. Only when thread_source is absent — a
    // non-empty unrecognized thread_source maps to Feature(..) upstream and
    // must never be guessed as main.
    role = "main";
  }
  else role = "unknown"; // absent or unrecognized (version drift) — never guessed as main
  identity.role = role;

  const parent = str(meta.parent_thread_id) ?? str(spawn.parent_thread_id);
  if (parent !== undefined) identity.parentSession = parent;
  const fork = str(meta.forked_from_id);
  if (fork !== undefined) identity.forkOf = fork;
  const depth = int(spawn.depth);
  if (depth !== undefined) identity.delegationDepth = depth;
  // Nickname is its own identity field (not an agent preset); agent_role has
  // no DSH counterpart and stays in raw.thread_spawn only.
  const nickname = str(meta.agent_nickname) ?? str(spawn.agent_nickname);
  if (nickname !== undefined) identity.nickname = nickname;
  const agentPath = str(meta.agent_path) ?? str(spawn.agent_path);
  if (agentPath !== undefined) identity.agentPath = agentPath;

  // Original identity evidence, preserved as-is (string or dict layouts).
  const raw: Record<string, unknown> = {};
  if (threadSourceRaw !== undefined) raw.thread_source = threadSourceRaw;
  if (sourceRaw !== undefined) raw.source = sourceRaw;
  if (meta.parent_thread_id !== undefined) raw.parent_thread_id = meta.parent_thread_id;
  if (meta.forked_from_id !== undefined) raw.forked_from_id = meta.forked_from_id;
  if (Object.keys(spawn).length > 0) raw.thread_spawn = spawn;
  if (Object.keys(raw).length > 0) identity.raw = raw;
  return identity;
}

/** owner/name slug from a git remote URL, when deterministically parseable. */
function repositorySlug(url: string): string | undefined {
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1];
}

function gitInfo(meta: Record<string, unknown>): CodexGit | undefined {
  const git = record(meta.git);
  const branch = str(git.branch);
  const url = str(git.repository_url);
  const commitHash = str(git.commit_hash);
  if (branch === undefined && url === undefined && commitHash === undefined) return undefined;
  const repository = url !== undefined ? repositorySlug(url) : undefined;
  return { ...(branch ? { branch } : {}), ...(repository ? { repository } : {}), ...(commitHash ? { commitHash } : {}) };
}

function isTokenCountRow(rowValue: Record<string, unknown>): Record<string, unknown> | undefined {
  if (rowValue.type !== "event_msg") return undefined;
  const payload = record(rowValue.payload);
  return payload.type === "token_count" ? payload : undefined;
}

function isUsageRecordRow(rowValue: Record<string, unknown>): Record<string, unknown> | undefined {
  if (rowValue.type === "token_usage_record") return record(rowValue.payload);
  // event_msg-carried variant: same TokenUsageRecord shape; supported for
  // parity though native observation only shows the dedicated top-level type.
  if (rowValue.type === "event_msg") {
    const payload = record(rowValue.payload);
    if (payload.type === "token_usage_record") return payload;
  }
  return undefined;
}

/** One structured rate-limit sample (primary or secondary window). */
function rateLimitSample(
  windowKind: "primary" | "secondary",
  windowRaw: unknown,
  snapshot: Record<string, unknown>,
): { rateLimit: NonNullable<UsageRecord["rateLimit"]> } | undefined {
  if (windowRaw === null || windowRaw === undefined) return undefined;
  const window = record(windowRaw);
  if (windowRaw !== null && typeof windowRaw !== "object") return undefined;
  const usedPercent = num(window.used_percent);
  const windowMinutes = int(window.window_minutes);
  const resetAt = isoFromSeconds(window.resets_at);
  const limitId = str(snapshot.limit_id);
  const planType = str(snapshot.plan_type);
  // Credits balance is a provider-formatted string upstream
  // (CreditsSnapshot.balance: Option<String>) — kept verbatim, never parsed
  // into a number. has_credits/unlimited stay readable inside `raw.credits`.
  const balanceRaw = record(snapshot.credits).balance;
  const creditsBalance = typeof balanceRaw === "string" ? balanceRaw : undefined;
  // RateLimitSnapshot has NO account id field upstream — accountId is never
  // set, and never guessed from elsewhere in the payload.
  return {
    rateLimit: {
      kind: windowKind,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(limitId !== undefined ? { limitId } : {}),
      ...(planType !== undefined ? { planType } : {}),
      ...(creditsBalance !== undefined ? { creditsBalance } : {}),
      // The entire original rate_limits object (primary + secondary +
      // credits + individual_limit + spend markers) preserved as structured
      // raw — never flattened into a JSON note string.
      raw: { ...snapshot },
    },
  };
}

/**
 * Account-level metadata carrier for a rate_limits snapshot whose
 * primary/secondary windows are both null/missing. The snapshot's credits /
 * plan fields would otherwise be dropped entirely (no window record exists to
 * piggyback on), so one `kind: "account"` rate-limit carrier preserves them.
 * No quota percentage is fabricated — there is no window to read one from.
 */
function rateLimitAccountSample(
  snapshot: Record<string, unknown>,
): { rateLimit: NonNullable<UsageRecord["rateLimit"]> } {
  const limitId = str(snapshot.limit_id);
  const planType = str(snapshot.plan_type);
  const balanceRaw = record(snapshot.credits).balance;
  const creditsBalance = typeof balanceRaw === "string" ? balanceRaw : undefined;
  // Account id does not exist in RateLimitSnapshot upstream — never guessed.
  return {
    rateLimit: {
      kind: "account",
      ...(limitId !== undefined ? { limitId } : {}),
      ...(planType !== undefined ? { planType } : {}),
      ...(creditsBalance !== undefined ? { creditsBalance } : {}),
      raw: { ...snapshot },
    },
  };
}

/** Account-level fields that make a window-less snapshot worth preserving. */
function carriesAccountFields(snapshot: Record<string, unknown>): boolean {
  return "credits" in snapshot || "plan_type" in snapshot;
}

/**
 * Build the Codex usage ledger. Channels, strictly separated:
 * 1. `token_usage_record` rows → per-response increments (`kind: "response"`).
 *    Thread ownership is enforced via `ownerSessionId`/`counted: false`:
 *    fork-replay-inherited rows are marked `inherited`; other threads'
 *    records keep their raw owner. Stats exclude both; the raw stays.
 *    `raw` is the WHOLE TokenUsageRecord payload — attribution fields
 *    (thread/turn/session/root_turn/response ids) and the verbatim usage
 *    counts, not just the counters.
 * 2. `event_msg/token_count.total_token_usage` → cumulative snapshots
 *    (`kind: "cumulative"`; fallback accounting when no response records
 *    exist — snapshots are never summed with each other).
 * 3. `event_msg/token_count.last_token_usage.input_tokens` → its own
 *    `kind: "context"` carrier (counted: false, metrics: {}): the response's
 *    reported source-input count with the sample's own context window,
 *    `measurement: "reported-input"`. It is never folded into a note, never
 *    counted as a meter, and never treated as a peak-context total.
 * 4. `event_msg/token_count.rate_limits` → one structured `kind:
 *    "rate-limit"` record per primary/secondary window (counted: false,
 *    metrics: {}), each carrying the full original snapshot in
 *    `rateLimit.raw`.
 */
export function extractCodexMetadata(rows: readonly CodexRow[], fallbackThreadId: string): CodexMetadata {
  const issues = new IssueLog();
  const counts = { increments: 0, snapshots: 0, duplicateResponses: 0, foreignThread: 0, inherited: 0, invalidUsage: 0 };
  const usage: UsageRecord[] = [];
  let order = 0;

  // Pass 1: choose the owning session_meta (prefer the one whose thread id
  // matches the rollout filename; inherited parent headers follow it in
  // fork/subagent replays) and derive identity from it.
  let ownMeta: Record<string, unknown> | undefined;
  let firstMeta: Record<string, unknown> | undefined;
  for (const { value } of rows) {
    const rowValue = record(value);
    if (rowValue.type !== "session_meta") continue;
    const payload = record(rowValue.payload);
    firstMeta ??= payload;
    if (str(payload.id) === fallbackThreadId || str(payload.session_id) === fallbackThreadId) {
      ownMeta = payload;
      break;
    }
  }
  ownMeta ??= firstMeta;
  const identity = ownMeta ? codexIdentity(ownMeta) : {};
  const git = ownMeta ? gitInfo(ownMeta) : undefined;
  const spawnPath = str(record(record(record(ownMeta?.source).subagent).thread_spawn).agent_path);
  const agentPath = str(ownMeta?.agent_path) ?? spawnPath;
  // Records with ordinal < subagent_history_start_ordinal are inherited
  // parent-prefix replay (upstream SessionMeta doc) and stay out of stats.
  const historyStart = ownMeta !== undefined ? int(ownMeta.subagent_history_start_ordinal) : undefined;
  const ownThreadIds = new Set<string>([fallbackThreadId]);
  for (const id of [str(ownMeta?.id), str(ownMeta?.session_id)]) {
    if (id !== undefined) ownThreadIds.add(id);
  }

  // Ordinal fallback: paginated rollouts write `ordinal` as a sequential
  // counter per written record (rollout/src/ordinal.rs), aligned with the
  // 0-based nonblank JSONL record index. Legacy rows omit it entirely — when
  // a subagent boundary exists but rows lack ordinals, realign the nonblank
  // row index against the first observed ordinal so the inherited-prefix
  // filter still fires instead of silently never filtering.
  let ordinalOffset = 0;
  for (const { ordinal, row } of rows) {
    if (ordinal !== undefined) {
      ordinalOffset = ordinal - (row - 1);
      break;
    }
  }
  const effectiveOrdinal = (ordinal: number | undefined, row: number): number =>
    ordinal ?? (row - 1 + ordinalOffset);

  const seenResponses = new Set<string>();
  const conversion = {
    rule: "input_minus_cached",
    sourceFields: ["input_tokens", "cached_input_tokens"],
    reference: "codex-rs/protocol/src/protocol.rs TokenUsage::non_cached_input (upstream 822e58cc)",
  };

  for (const { row, ordinal, value } of rows) {
    const rowValue = record(value);
    const timestamp = str(rowValue.timestamp);

    const rowOrdinal = effectiveOrdinal(ordinal, row);
    const inheritedRow = historyStart !== undefined && rowOrdinal < historyStart;

    const usagePayload = isUsageRecordRow(rowValue);
    if (usagePayload !== undefined) {
      const threadId = str(usagePayload.thread_id);
      if (threadId === undefined) {
        counts.invalidUsage++;
        issues.add("codex/usage-unattributed", "token_usage_record without thread_id skipped (attribution unverifiable)", row, "token_usage_record");
        continue;
      }
      const owned = ownThreadIds.has(threadId);
      if (!owned && !inheritedRow) {
        counts.foreignThread++;
        issues.add("codex/usage-foreign-thread", "token_usage_record belongs to another thread (fork replay / other thread); kept raw via ownerSessionId, excluded from stats", row, "token_usage_record");
      } else if (inheritedRow) {
        counts.inherited++;
        issues.add("codex/usage-inherited", "token_usage_record inside inherited fork prefix; kept raw via inherited flag, excluded from stats", row, "token_usage_record");
      }
      const responseId = str(usagePayload.response_id);
      const dedupeKey = `${threadId}:${responseId ?? `row:${row}`}`;
      if (seenResponses.has(dedupeKey)) {
        counts.duplicateResponses++;
        // The duplicate stays in the ledger verbatim; accounting policy
        // (dedupe + conflict handling) belongs to the unified core.
        issues.add("codex/usage-duplicate-response", "duplicate token_usage_record for the same thread/response_id retained raw; unified stats dedupe applies", row, "token_usage_record");
      } else {
        seenResponses.add(dedupeKey);
      }
      if (usagePayload.usage === null || usagePayload.usage === undefined
        || typeof usagePayload.usage !== "object" || Array.isArray(usagePayload.usage)) {
        counts.invalidUsage++;
        issues.add("codex/usage-invalid", "token_usage_record with null/absent usage skipped (no fabricated zeros)", row, "token_usage_record");
        continue;
      }
      const { metrics, notes, issues: metricIssues } = codexDisjointMetrics(usagePayload.usage);
      for (const issue of metricIssues) issues.add(issue.code, issue.message, row, "token_usage_record");
      if (!hasMetrics(metrics)) {
        counts.invalidUsage++;
        issues.add("codex/usage-invalid", "token_usage_record usage carried no recognizable metric", row, "token_usage_record");
      }
      usage.push({
        id: `u${order++}`,
        ...(responseId !== undefined ? { responseId } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        cumulative: false,
        kind: "response",
        ownerSessionId: threadId,
        ...(owned && !inheritedRow ? {} : { counted: false }),
        ...(inheritedRow ? { inherited: true } : {}),
        metrics,
        // Whole TokenUsageRecord: attribution (thread/turn/session/root_turn/
        // response ids) + verbatim usage + turn/thread cumulative columns.
        raw: { ...usagePayload },
        conversion,
        provenance: {
          agent: "codex",
          rawType: "token_usage_record",
          row,
          metering: {
            source: "Codex token_usage_record.usage (per-response request increment; input_tokens includes cached_input_tokens)",
            ...(notes.length ? { note: notes.join("; ") } : {}),
          },
        },
      });
      counts.increments++;
      continue;
    }

    const tokenCount = isTokenCountRow(rowValue);
    if (tokenCount !== undefined) {
      if (inheritedRow) {
        counts.inherited++;
        issues.add("codex/usage-inherited", "token_count inside inherited fork prefix; kept raw via inherited flag, excluded from stats", row, "event_msg/token_count");
      }
      const infoPresent = tokenCount.info !== null && tokenCount.info !== undefined;
      const info = record(tokenCount.info);
      const window = infoPresent ? int(info.model_context_window) : undefined;

      // (2) Cumulative snapshot — only when it carries a recognizable meter.
      let fillMarker = false;
      if (infoPresent) {
        const totalRaw = record(info.total_token_usage);
        const { metrics, notes, issues: metricIssues } = codexDisjointMetrics(info.total_token_usage);
        for (const issue of metricIssues) issues.add(issue.code, issue.message, row, "event_msg/token_count");
        const metered = hasMetrics(metrics);
        if (!metered) {
          counts.invalidUsage++;
          issues.add("codex/usage-invalid", "token_count snapshot carried no recognizable token metric; context/rate-limit carriers only", row, "event_msg/token_count");
        } else {
          // Compaction fill_to_context_window marker (upstream
          // protocol.rs fill_to_context_window, invoked by the context
          // manager on compaction): total_token_usage is REPLACED with an
          // all-zero TokenUsage whose total_tokens = context window — a
          // "context filled" flag, not a request meter. Strict identity so a
          // genuinely zero request never matches: KNOWN-zero raw counts
          // (present 0, not missing) on input and output, no nonzero cached,
          // and total equal to a POSITIVE model_context_window (a real zero
          // request carries total_tokens 0, never the window size).
          fillMarker = window !== undefined && window > 0
            && tokens(totalRaw.total_tokens) === window
            && tokens(totalRaw.input_tokens) === 0
            && tokens(totalRaw.output_tokens) === 0
            && (tokens(totalRaw.cached_input_tokens) ?? 0) === 0;
          if (fillMarker) {
            notes.push("all-zero snapshot with total=model_context_window: compaction fill_to_context_window marker, not a meter reading; excluded from accounting (counted=false), raw preserved verbatim");
            issues.add("codex/usage-compaction-fill-marker",
              "token_count total_token_usage is a compaction fill_to_context_window marker (known-zero counts, total=model_context_window), not a consumption reading; excluded from accounting, raw preserved",
              row, "event_msg/token_count");
          }
          usage.push({
            id: `u${order++}`,
            ...(timestamp !== undefined ? { timestamp } : {}),
            cumulative: true,
            kind: "cumulative",
            ...(inheritedRow || fillMarker ? { counted: false } : {}),
            ...(inheritedRow ? { inherited: true } : {}),
            metrics,
            raw: record(info.total_token_usage),
            conversion,
            provenance: {
              agent: "codex",
              rawType: "event_msg/token_count.total_token_usage",
              row,
              metering: {
                source: "Codex token_count total_token_usage (cumulative snapshot; fallback accounting when no response records exist — snapshots are never summed)",
                ...(notes.length ? { note: notes.join("; ") } : {}),
              },
            },
          });
          counts.snapshots++;
        }
      }

      // (3) last_token_usage → dedicated context carrier (never a meter,
      // never a note-only hint, never a peak-context total).
      if (infoPresent) {
        const lastUsage = record(info.last_token_usage);
        const lastInput = tokens(lastUsage.input_tokens);
        // On a fill_to_context_window marker row the zeroed last input is an
        // artifact of the same compaction fill, not a reported request input:
        // never fabricate a "reported-input" sample for it — keep the raw
        // usage and the genuine window, downgraded to estimated-context.
        const reportInput = !(fillMarker && lastInput === 0);
        if (lastInput !== undefined || window !== undefined) {
          usage.push({
            id: `u${order++}`,
            ...(timestamp !== undefined ? { timestamp } : {}),
            cumulative: false,
            kind: "context",
            counted: false,
            ...(inheritedRow ? { inherited: true } : {}),
            metrics: {},
            ...(lastInput !== undefined || window !== undefined
              ? {
                  context: {
                    ...(reportInput && lastInput !== undefined ? { inputTokens: lastInput } : {}),
                    ...(window !== undefined ? { contextWindow: window } : {}),
                    measurement: reportInput ? "reported-input" : "estimated-context",
                    ...(Object.keys(lastUsage).length > 0 ? { raw: lastUsage } : {}),
                  },
                }
              : {}),
            provenance: {
              agent: "codex",
              rawType: "event_msg/token_count.last_token_usage",
              row,
              metering: {
                source: "Codex token_count last_token_usage.input_tokens (per-response reported source-input count incl. cached; not a meter and not a peak-context total)",
              },
            },
          });
        }
      }

      // (4) rate_limits → one structured record per primary/secondary window;
      //     when both windows are null/missing but the snapshot carries
      //     credits/plan fields, one `kind: "account"` carrier keeps that
      //     metadata from being dropped entirely (no fabricated percent).
      const rateSnapshot = record(tokenCount.rate_limits);
      if (tokenCount.rate_limits !== null && tokenCount.rate_limits !== undefined) {
        let windowSamples = 0;
        for (const windowKind of ["primary", "secondary"] as const) {
          const sample = rateLimitSample(windowKind, rateSnapshot[windowKind], rateSnapshot);
          if (sample === undefined) continue;
          windowSamples++;
          usage.push({
            id: `u${order++}`,
            ...(timestamp !== undefined ? { timestamp } : {}),
            cumulative: false,
            kind: "rate-limit",
            counted: false,
            ...(inheritedRow ? { inherited: true } : {}),
            metrics: {},
            ...sample,
            provenance: {
              agent: "codex",
              rawType: "event_msg/token_count.rate_limits",
              row,
              metering: {
                source: "Codex token_count rate_limits window sample (never aggregated into token totals; no account id exists upstream — never inferred)",
              },
            },
          });
        }
        if (windowSamples === 0 && carriesAccountFields(rateSnapshot)) {
          usage.push({
            id: `u${order++}`,
            ...(timestamp !== undefined ? { timestamp } : {}),
            cumulative: false,
            kind: "rate-limit",
            counted: false,
            ...(inheritedRow ? { inherited: true } : {}),
            metrics: {},
            ...rateLimitAccountSample(rateSnapshot),
            provenance: {
              agent: "codex",
              rawType: "event_msg/token_count.rate_limits",
              row,
              metering: {
                source: "Codex token_count rate_limits account snapshot (primary/secondary both null/missing; credits/plan metadata preserved, no quota percentage fabricated; no account id exists upstream — never inferred)",
              },
            },
          });
        }
      }
      if (!infoPresent && (tokenCount.rate_limits === null || tokenCount.rate_limits === undefined)) {
        counts.invalidUsage++;
        issues.add("codex/usage-invalid", "token_count with neither info nor rate_limits; nothing to preserve", row, "event_msg/token_count");
      }
      continue;
    }
  }

  return {
    identity,
    usage,
    issues: issues.list(),
    ...(git !== undefined ? { git } : {}),
    ...(agentPath !== undefined ? { agentPath } : {}),
    counts,
  };
}
