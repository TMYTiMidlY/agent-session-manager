export type AgentKind = "copilot" | "claude" | "codex";

export interface AgentRoots {
  copilot?: string;
  claude?: string;
  codex?: string;
}

export interface SessionRef {
  agent: AgentKind;
  id: string;
  path: string;
  startedAt?: string;
  updatedAt?: string;
  cwd?: string;
  title?: string;
}

export type TimelineRole = "user" | "assistant" | "tool" | "reasoning" | "system" | "event";

export type ToolResultKind = "success" | "failure" | "rejected" | "denied" | "pending";

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

export interface ParsedSession extends SessionRef {
  entries: TimelineEntry[];
}

export interface SearchHit {
  session: SessionRef;
  entry: TimelineEntry;
  excerpt: string;
}
