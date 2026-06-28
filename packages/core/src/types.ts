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

export interface TimelineEntry {
  index: number;
  role: TimelineRole;
  kind: string;
  text: string;
  timestamp?: string;
  title?: string;
  rawType?: string;
}

export interface ParsedSession extends SessionRef {
  entries: TimelineEntry[];
}

export interface SearchHit {
  session: SessionRef;
  entry: TimelineEntry;
  excerpt: string;
}
