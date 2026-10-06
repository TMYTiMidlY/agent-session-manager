export type AgentKind = "copilot" | "claude" | "codex" | "chatgpt" | "dsh" | "cursor";

export interface AgentRoots {
  copilot?: string;
  copilotDb?: string;
  claude?: string;
  codex?: string;
  chatgpt?: string;
  dsh?: string;
  cursor?: string;
}

export interface SessionRef {
  agent: AgentKind;
  id: string;
  path: string;
  startedAt?: string;
  updatedAt?: string;
  /** Filesystem activity, distinct from event timestamps. */
  mtime?: string;
  /** Session source file size in bytes (compressed size for .zstd). */
  size?: number;
  cwd?: string;
  title?: string;
  /** Repository slug (owner/name), when the agent records one. */
  repository?: string;
  /** Git branch, when recorded. */
  branch?: string;
  /** Where this parsed session was read from, and whether that source is lossy. */
  source?: SessionSource;
  /** Lightweight lineage, sampled from source metadata without building a transcript. */
  identity?: SessionIdentity;
}

/**
 * Provenance for a parsed session. `events` is the canonical append-only event
 * log; `db-turns` is the lossy fallback reconstructed from the session-store.db
 * `turns` table when a session's events.jsonl is absent (e.g. pruned/old).
 */
export interface SessionSource {
  kind: "events" | "db-turns" | "chatgpt-share" | "cursor-store";
  path: string;
  lossy: boolean;
  /** Human-readable caveat explaining exactly what the source omitted. */
  warning?: string;
  /** Expected text-rendering limitations, not parsing/integrity defects. */
  notices?: string[];
  /** Original remote URL when `path` points at a locally imported snapshot. */
  origin?: string;
}

export type TimelineRole = "user" | "assistant" | "tool" | "reasoning" | "system" | "event";

export type ToolResultKind = "success" | "failure" | "rejected" | "denied" | "pending" | "redacted";

export interface ToolDetail {
  callId?: string;
  name?: string;
  arguments?: unknown;
  intentionSummary?: string;
  partialOutput?: string;
  result?: {
    type: ToolResultKind;
    log?: string;
    markdown?: boolean;
  };
}

export interface TimelineEntry {
  index: number;
  role: TimelineRole;
  kind: string;
  text: string;
  timestamp?: string;
  title?: string;
  rawType?: string;
  /** Populated for merged tool entries (start+complete paired by callId). */
  tool?: ToolDetail;
  /** Optional detail/expandable body (e.g. system.notification `kind` payload). */
  detail?: string;
  /** Extra structured payload — used by handoff / task_complete / group / compaction. */
  data?: Record<string, unknown>;
}

export interface ParseDiagnostics {
  handled: number;
  ignored: number;
  unknown: number;
  unknownTypes: string[];
  /** True when unknownTypes is a bounded sample rather than an exhaustive list. */
  unknownTypesTruncated?: boolean;
  /** Stored generation, not a runtime migration target. */
  formatVersion?: number;
  /** Bounded payload-free samples of compatibility gaps or malformed records. */
  issues?: ParseIssue[];
}

export interface ParseIssue {
  code: string;
  message: string;
  type?: string;
  /** One-based nonblank JSONL record number (header is 1). */
  row?: number;
  seq?: number;
  count: number;
}

export interface SearchHit {
  session: SessionRef;
  entry: TimelineEntry;
  excerpt: string;
}

// ---------------------------------------------------------------------------
// Unified session document (DSH-inspired read-only projection, version 1).
// Reference: DSH SESSION_FORMAT_VERSION 4 envelope {type, seq, time, data} and
// its message blocks. A SessionDocument is NOT a resumable DSH session log.
// ---------------------------------------------------------------------------

/** Identity of this document within an agent's session graph. */
export type SessionRole = "main" | "subagent" | "guardian" | "unknown";

export interface SessionIdentity {
  role: SessionRole;
  /** Owning session id, when the source records one (DSH header.parentSession). */
  parentSession?: string;
  /** Session this document forked from, when known. */
  forkOf?: string;
  /** Named agent preset (DSH header.agentPreset). */
  agentPreset?: string;
  /** Delegation depth, when the source records one. */
  delegationDepth?: number;
  nickname?: string;
  agentPath?: string;
  /** Original metadata, including historical string/object thread_source layouts. */
  raw?: Record<string, unknown>;
}

/** Unified message-block vocabulary, aligned with DSH content block types. */
export type MessageBlockType = "text" | "reasoning" | "tool-call" | "tool-result" | "image" | "file" | "unknown";

/** Raw-record provenance for one block or usage record. */
export interface BlockProvenance {
  agent: AgentKind;
  /** Original raw record type (DSH event type or adapter composite). */
  rawType?: string;
  /** DSH envelope seq of the originating record. */
  seq?: number;
  /** One-based JSONL row for row-oriented sources. */
  row?: number;
  /** Envelope timestamp (epoch milliseconds) when the source used one. */
  time?: number;
  blobId?: string;
}

/**
 * One block of the unified transcript. `type` is the unified vocabulary;
 * `kind`, `tool`, `data`, `detail`, `title` preserve the adapter's original
 * vocabulary so the entries projection is lossless.
 */
export interface MessageBlock {
  id: string;
  /** Original compatibility-view position when a CLI view reduces the timeline. */
  timelineIndex?: number;
  type: MessageBlockType;
  role: TimelineRole;
  kind: string;
  text: string;
  timestamp?: string;
  title?: string;
  rawType?: string;
  tool?: ToolDetail;
  detail?: string;
  data?: Record<string, unknown>;
  provenance?: BlockProvenance;
  /** Turn/step coordinates when the source provides them (DSH). */
  turn?: number;
  step?: number;
  /** Source content blocks/attachments, retained separately from searchable text. */
  native?: unknown;
}

/**
 * Token accounting with DSH TokenUsage semantics: counts are disjoint —
 * `inputTokens` is uncached input only; cached input is reported separately
 * as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three).
 * `reasoningTokens` is a subset of `outputTokens`, never additive. Every
 * field is optional: absent means unknown, never zero.
 */
export interface UsageMetrics {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/** Context-window sample for one model route, when the source advertises it. */
export interface ContextSample {
  provider?: string;
  model?: string;
  contextWindow?: number;
  /** Source-reported prompt input count, including cache when the provider does. */
  inputTokens?: number;
  measurement?: "reported-input" | "estimated-context";
  raw?: Record<string, unknown>;
}

/** Rate-limit sample; never aggregated into token totals. */
export interface RateLimitSample {
  kind?: string;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  usedPercent?: number;
  windowMinutes?: number;
  limitId?: string;
  planType?: string;
  creditsBalance?: string | number;
  /** Account identity is usually unavailable in rollouts; do not infer one. */
  accountId?: string;
  raw?: Record<string, unknown>;
}

/**
 * One entry of the usage ledger. `cumulative: false` marks a per-call
 * increment; `cumulative: true` marks a cumulative snapshot that resets
 * running totals (odometer). A record may carry only context/rate-limit
 * samples with empty metrics.
 */
export interface UsageRecord {
  id: string;
  /** Provider response id — the dedupe key when the source provides one. */
  responseId?: string;
  timestamp?: string;
  scope?: { turn?: number; step?: number };
  cumulative: boolean;
  metrics: UsageMetrics;
  model?: string;
  kind?: "response" | "cumulative" | "context" | "rate-limit";
  ownerSessionId?: string;
  inherited?: boolean;
  /** False for observations that must not contribute to this session's totals. */
  counted?: boolean;
  raw?: Record<string, unknown>;
  conversion?: { rule: string; sourceFields: string[]; reference?: string };
  context?: ContextSample;
  rateLimit?: RateLimitSample;
  provenance?: BlockProvenance & { metering?: { source: string; note?: string } };
}

/** Normalized DSH-style envelopes; seq is local, original coordinates stay in provenance. */
export type NormalizedEvent = { seq: number; time?: number; provenance?: BlockProvenance } & (
  | { type: "message/append"; data: { block: MessageBlock } }
  | { type: "usage/record"; data: { usage: UsageRecord } }
);

/** The authoritative normalized form every parseSession() source passes through. */
export interface SessionDocument {
  format: "asmgr.session-document";
  version: 1;
  /** Post-parse session reference (identity, provenance, timestamps). */
  ref: SessionRef;
  identity: SessionIdentity;
  meta: {
    title?: string;
    startedAt?: string;
    updatedAt?: string;
    cwd?: string;
    repository?: string;
    branch?: string;
  };
  /** Fixed semantics reference, independent of the installed DSH runtime. */
  basis?: { harness: "dsh"; formatVersion: 4; commit: string };
  /** Always populated at the parseSession boundary; optional for adapter staging. */
  events?: NormalizedEvent[];
  /** Explicitly reduced CLI view; opaque carriers are omitted when filtering message roles. */
  view?: { role: TimelineRole; nativeContent: "omitted" };
  /** Convenience views of message/append and usage/record event payloads. */
  blocks: MessageBlock[];
  usage: UsageRecord[];
}

/** Aggregates derived from the usage ledger. Missing metrics stay undefined. */
export interface SessionStats {
  totals: UsageMetrics;
  /** Records that contributed at least one metric. */
  calls: number;
  /** Cumulative snapshot records seen. */
  snapshots: number;
  /** True when any record carried no recognizable metric (sampling gap). */
  incomplete: boolean;
  lastContext?: ContextSample & { observedAt?: string };
  accounting?: "responses" | "latest-snapshot" | "unavailable";
  duplicateResponses?: number;
  conflictingResponses?: number;
}

export interface ParsedSession extends SessionRef {
  entries: TimelineEntry[];
  /** Authoritative unified document; always present on parseSession() output. */
  document?: SessionDocument;
  /** Aggregate view of document.usage; always present on parseSession() output. */
  stats?: SessionStats;
  diagnostics?: ParseDiagnostics;
}
