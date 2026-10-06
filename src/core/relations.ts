import type { AgentKind, ParsedSession, SessionIdentity, SessionRef, SessionRole } from "./types.js";
import { iterateJsonl, readJsonl } from "./fs.js";
import { mapConcurrent } from "./concurrency.js";
import { sessionMetadata } from "./session-metadata.js";
import { readDshHeaderMeta } from "./adapters/dsh-reader.js";

/**
 * Session-graph relations. Edges are always keyed by `agent:id` — the same
 * bare id under two agents is two different sessions and must never be
 * joined across agents.
 */
export interface SessionNode {
  key: string;
  agent: AgentKind;
  id: string;
  role: SessionRole;
  /** `${agent}:${parentSession}` when the source records a parent. */
  parentKey?: string;
  /** `${agent}:${forkOf}` when the source records a fork. */
  forkKey?: string;
  agentPreset?: string;
  delegationDepth?: number;
  startedAt?: string;
  /** Last observed activity — NOT proof the session is still running. */
  lastObservedAt?: string;
  title?: string;
  /** True when the same agent+id appeared more than once: resolution is ambiguous. */
  ambiguous?: boolean;
}

export interface GraphDiagnostics {
  /** Parent-chain cycles, each as the list of keys on the cycle. */
  cycles: string[][];
  /** parentSession recorded but no such session among the scanned refs. */
  missingParents: { key: string; agent: AgentKind; parentSession: string }[];
  /** forkOf recorded but no such session among the scanned refs. */
  missingForks: { key: string; agent: AgentKind; forkOf: string }[];
  /** Same agent+id appearing more than once (ambiguous id resolution). */
  duplicates: { key: string; count: number }[];
}

export interface SessionGraph {
  nodes: Map<string, SessionNode>;
  /** Sessions whose parentSession is this node, in discovery order. */
  childrenOf(key: string): SessionNode[];
  /** Sessions forked from this node, in discovery order. */
  forksOf(key: string): SessionNode[];
  diagnostics: GraphDiagnostics;
}

export function sessionKey(agent: AgentKind, id: string): string {
  return `${agent}:${id}`;
}

export interface GraphNodeInput {
  agent: AgentKind;
  id: string;
  identity?: SessionIdentity;
  startedAt?: string;
  lastObservedAt?: string;
  title?: string;
}

/**
 * Build the relation graph from probed identities. Pure; no I/O. When the
 * same agent+id occurs more than once the first occurrence supplies the node
 * fields but the node is marked `ambiguous` (and reported in diagnostics) —
 * callers must not treat the picked fields as the silent truth.
 */
export function buildSessionGraph(inputs: readonly GraphNodeInput[]): SessionGraph {
  const nodes = new Map<string, SessionNode>();
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const key = sessionKey(input.agent, input.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (nodes.has(key)) continue; // first occurrence wins; ambiguity reported.
    const identity = input.identity ?? { role: "unknown" };
    nodes.set(key, {
      key,
      agent: input.agent,
      id: input.id,
      role: identity.role,
      ...(identity.parentSession !== undefined ? { parentKey: sessionKey(input.agent, identity.parentSession) } : {}),
      ...(identity.forkOf !== undefined ? { forkKey: sessionKey(input.agent, identity.forkOf) } : {}),
      ...(identity.agentPreset !== undefined ? { agentPreset: identity.agentPreset } : {}),
      ...(identity.delegationDepth !== undefined ? { delegationDepth: identity.delegationDepth } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.lastObservedAt !== undefined ? { lastObservedAt: input.lastObservedAt } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
  const ambiguous = new Set(duplicates.map((entry) => entry.key));
  for (const node of nodes.values()) {
    if (ambiguous.has(node.key)) node.ambiguous = true;
  }

  const children = new Map<string, SessionNode[]>();
  const forks = new Map<string, SessionNode[]>();
  const missingParents: GraphDiagnostics["missingParents"] = [];
  const missingForks: GraphDiagnostics["missingForks"] = [];
  for (const node of nodes.values()) {
    if (node.parentKey !== undefined) {
      if (nodes.has(node.parentKey)) {
        const bucket = children.get(node.parentKey) ?? [];
        bucket.push(node);
        children.set(node.parentKey, bucket);
      } else {
        missingParents.push({ key: node.key, agent: node.agent, parentSession: node.parentKey.slice(node.agent.length + 1) });
      }
    }
    if (node.forkKey !== undefined) {
      if (nodes.has(node.forkKey)) {
        const bucket = forks.get(node.forkKey) ?? [];
        bucket.push(node);
        forks.set(node.forkKey, bucket);
      } else {
        missingForks.push({ key: node.key, agent: node.agent, forkOf: node.forkKey.slice(node.agent.length + 1) });
      }
    }
  }

  return {
    nodes,
    childrenOf: (key) => [...(children.get(key) ?? [])],
    forksOf: (key) => [...(forks.get(key) ?? [])],
    diagnostics: { cycles: detectCycles(nodes), missingParents, missingForks, duplicates },
  };
}

/** Cycles along parentSession chains (each node has at most one parent edge). */
function detectCycles(nodes: Map<string, SessionNode>): string[][] {
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  for (const start of nodes.keys()) {
    if (state.get(start) === "done") continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && state.get(current) !== "done") {
      if (position.has(current)) {
        cycles.push(path.slice(position.get(current)));
        break;
      }
      position.set(current, path.length);
      path.push(current);
      state.set(current, "visiting");
      const parentKey: string | undefined = nodes.get(current)?.parentKey;
      current = parentKey !== undefined && nodes.has(parentKey) ? parentKey : undefined;
    }
    for (const key of path) state.set(key, "done");
  }
  return cycles;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Lightweight identity probe: reads only the header row(s) a source needs to
 * state role/parent — never a full transcript parse.
 *
 * Order of evidence:
 * 1. `ref.identity` — the native discovery/parse identity wins outright.
 * 2. Per-agent light probes:
 *    - DSH: the v4 session header. Official `origin` values only include
 *      `subagent`; anything else on a valid header is a top-level session
 *      (`main`). No guardian origin is invented here — Codex guardians are
 *      detected through their own metadata (below), and unrecognized origins
 *      stay `unknown`.
 *    - Codex: `sessionMetadata()` reads `session_meta` (thread_source /
 *      source.subagent / parent_thread_id); no header → `unknown`, never a
 *      guessed `main` (that would disable guardian detection entirely).
 *    - Claude: sidechain rows (`isSidechain: true`) → `subagent`; a readable
 *      non-sidechain session is `main`; unreadable → `unknown`.
 * 3. copilot/chatgpt/cursor have no delegation semantics at all — every
 *    session is top-level by construction (`main`).
 * An unreadable or absent source is `unknown`, never a guess.
 */
export async function probeIdentity(ref: SessionRef): Promise<SessionIdentity> {
  if (ref.identity) return ref.identity;
  if (ref.agent === "dsh") {
    try {
      const header = record((await readJsonl(ref.path, 1))[0]);
      if (header.type !== "session") return { role: "unknown" };
      const meta = readDshHeaderMeta(header);
      const identity: SessionIdentity = { role: meta.origin === "subagent" ? "subagent" : "main" };
      if (meta.parentSession !== undefined) identity.parentSession = meta.parentSession;
      if (meta.agentPreset !== undefined) identity.agentPreset = meta.agentPreset;
      if (meta.delegationDepth !== undefined) identity.delegationDepth = meta.delegationDepth;
      return identity;
    } catch {
      return { role: "unknown" };
    }
  }
  if (ref.agent === "codex") {
    try {
      const enriched = await sessionMetadata(ref);
      if (enriched.identity && enriched.identity.role !== undefined) return enriched.identity;
    } catch {
      // fall through to unknown
    }
    return { role: "unknown" };
  }
  if (ref.agent === "claude") {
    try {
      for await (const value of iterateJsonl(ref.path)) {
        const row = record(value);
        if (row.isSidechain === true) return { role: "subagent" };
        if (row.type === "user" || row.type === "assistant") break; // transcript rows decide, and none was a sidechain marker
      }
      return { role: "main" };
    } catch {
      return { role: "unknown" };
    }
  }
  return { role: "main" };
}

/** Graph nodes for a set of refs using only header-level probes. */
export async function probeGraphNodes(refs: readonly SessionRef[]): Promise<GraphNodeInput[]> {
  return mapConcurrent(refs, 8, async (ref) => ({
    agent: ref.agent,
    id: ref.id,
    identity: await probeIdentity(ref),
    startedAt: ref.startedAt,
    // Event-derived only. File mtime is NOT transcript activity and must not
    // impersonate a last-observed instant; tree parses the family to fill it.
    lastObservedAt: ref.updatedAt,
    title: ref.title,
  }));
}

/** Observed range of a parsed session, from its event instants (epoch ms). */
export function documentObservedRange(parsed: ParsedSession): { startedAt?: string; lastObservedAt?: string } {
  let first: number | undefined;
  let last: number | undefined;
  const events = parsed.document?.events;
  if (events) {
    for (const event of events) {
      const time = event.time;
      if (time === undefined || !Number.isFinite(time)) continue;
      if (first === undefined || time < first) first = time;
      if (last === undefined || time > last) last = time;
    }
  }
  const iso = (value: number | undefined) => value === undefined ? undefined : new Date(value).toISOString();
  const recordedStart = epoch(parsed.document?.meta.startedAt ?? parsed.startedAt);
  const recordedEnd = epoch(parsed.document?.meta.updatedAt ?? parsed.updatedAt);
  // A fork's inherited messages predate its creation and cannot extend its own activity interval.
  const start = parsed.document?.identity.forkOf && recordedStart !== undefined ? recordedStart : first ?? recordedStart;
  const end = last === undefined ? recordedEnd : recordedEnd === undefined ? last : Math.max(last, recordedEnd);
  return { startedAt: iso(start), lastObservedAt: end !== undefined && (start === undefined || end >= start) ? iso(end) : undefined };
}

export interface ConcurrencyInterval {
  startedAt?: string;
  /** Last observed end; an absent end is NOT treated as ongoing forever. */
  lastObservedAt?: string;
}

export interface PeakConcurrency {
  peak: number;
  /** Start instant of the interval that reached the peak. */
  at?: string;
  /** Intervals without a valid start instant cannot be placed on the timeline. */
  unplaced: number;
}

const epoch = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
};

/**
 * Peak overlap of half-open [start, end) intervals. Touching intervals
 * (one ends exactly when the next starts) are NOT concurrent. Ends are the
 * last observed instants, never "now". Instants compare as EPOCH values, not
 * offset text: "10:00+08:00" and "02:00Z" are the same instant. Intervals
 * with a missing or invalid start are unplaced; a missing or invalid end
 * never implies ongoing — the interval only counts at its own start.
 */
export function peakConcurrency(intervals: readonly ConcurrencyInterval[]): PeakConcurrency {
  const placed: { start: number; end?: number; label: string }[] = [];
  for (const interval of intervals) {
    const start = epoch(interval.startedAt);
    if (start === undefined) continue;
    placed.push({ start, end: epoch(interval.lastObservedAt), label: interval.startedAt! });
  }
  const unplaced = intervals.length - placed.length;
  let peak = 0;
  let at: string | undefined;
  for (const probe of placed) {
    let active = 0;
    for (const interval of placed) {
      if (interval.start > probe.start) continue;
      // No valid end: only counted at its own start (last-observed unknown).
      if (interval.end === undefined ? interval.start === probe.start : interval.end > probe.start) active++;
    }
    if (active > peak) {
      peak = active;
      at = probe.label;
    }
  }
  return { peak, ...(at !== undefined && peak > 0 ? { at } : {}), unplaced };
}
