export * from "./types.js";

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentKind, AgentRoots, ParsedSession, SearchHit, SessionRef, TimelineEntry } from "./types.js";
import { discoverClaude, parseClaude } from "./adapters/claude.js";
import { discoverCodex, parseCodex } from "./adapters/codex.js";
import { discoverCopilot, parseCopilot } from "./adapters/copilot.js";
import { excerpt, stringifyInline, timelineEntrySearchText } from "./text.js";
import { expandHome, fileStem, parentName, pathExists, readJsonl, walkFiles } from "./fs.js";

export { timelineEntrySearchText };

export const AGENTS: AgentKind[] = ["copilot", "claude", "codex"];

export async function discoverSessions(agents: AgentKind[] = AGENTS, roots: AgentRoots = {}): Promise<SessionRef[]> {
  const found: SessionRef[] = [];
  if (agents.includes("copilot")) found.push(...(await discoverCopilot(roots.copilot, roots.copilotDb)));
  if (agents.includes("claude")) found.push(...(await discoverClaude(roots.claude)));
  if (agents.includes("codex")) found.push(...(await discoverCodex(roots.codex)));
  return found.sort((a, b) => a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id));
}

export async function parseSession(ref: SessionRef): Promise<ParsedSession> {
  if (ref.agent === "copilot") return parseCopilot(ref);
  if (ref.agent === "claude") return parseClaude(ref);
  return parseCodex(ref);
}

export async function findSession(id: string, agents: AgentKind[] = AGENTS, roots: AgentRoots = {}): Promise<SessionRef | undefined> {
  return findSessionAmong(await discoverSessions(agents, roots), id);
}

export function findSessionAmong(refs: SessionRef[], id: string): SessionRef | undefined {
  return refs.find((session) => session.id === id) ?? refs.find((session) => session.id.startsWith(id));
}

export async function searchSessions(query: string, agents: AgentKind[] = AGENTS, roots: AgentRoots = {}, limit = 20): Promise<SearchHit[]> {
  return searchRefs(await discoverSessions(agents, roots), query, limit);
}

export async function searchRefs(refs: SessionRef[], query: string, limit = 20): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const needle = query.toLowerCase();
  for (const ref of refs) {
    const parsed = await parseSession(ref);
    for (const entry of parsed.entries) {
      const searchText = timelineEntrySearchText(entry);
      if (!searchText.toLowerCase().includes(needle)) continue;
      hits.push({
        session: {
          agent: parsed.agent,
          id: parsed.id,
          path: parsed.path,
          startedAt: parsed.startedAt,
          updatedAt: parsed.updatedAt,
          cwd: parsed.cwd,
          title: parsed.title,
          repository: parsed.repository,
          branch: parsed.branch,
          source: parsed.source,
        },
        entry,
        excerpt: excerpt(searchText, query),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

const COPILOT_TYPES = new Set([
  "session.start", "user.message", "assistant.message", "tool.execution_start",
  "tool.execution_complete", "system.notification", "session.info", "task_complete", "compaction",
]);
const CODEX_TYPES = new Set(["session_meta", "response_item", "turn_context", "event_msg", "compacted"]);
const CLAUDE_TYPES = new Set(["user", "assistant", "system", "ai-title", "summary"]);

/**
 * Guess which agent produced a JSONL session from a sample of its rows.
 * Copilot rows carry a `data` payload and dotted/eventful types; Codex rows
 * carry a `payload`; Claude rows carry a `message` under bare user/assistant
 * types. Returns undefined when nothing matches.
 */
export function detectAgent(rows: unknown[], path?: string): AgentKind | undefined {
  let copilot = 0;
  let codex = 0;
  let claude = 0;
  for (const row of rows.slice(0, 50)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if ("payload" in record && CODEX_TYPES.has(type)) {
      codex += 1;
    } else if ("data" in record && (type.includes(".") || COPILOT_TYPES.has(type))) {
      copilot += 1;
    } else if (CLAUDE_TYPES.has(type) && ("message" in record || type === "ai-title" || type === "summary")) {
      claude += 1;
    }
  }
  if (copilot === 0 && codex === 0 && claude === 0) {
    return path && basename(path) === "events.jsonl" ? "copilot" : undefined;
  }
  if (copilot >= codex && copilot >= claude) return "copilot";
  if (codex >= claude) return "codex";
  return "claude";
}

function deriveId(path: string, agent: AgentKind, rows: unknown[]): string {
  if (agent === "copilot") {
    for (const row of rows.slice(0, 10)) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (record.type !== "session.start") continue;
      const data = (record.data ?? {}) as Record<string, unknown>;
      if (typeof data.sessionId === "string" && data.sessionId) return data.sessionId;
    }
    return basename(path) === "events.jsonl" ? parentName(path) : fileStem(path);
  }
  if (agent === "codex") {
    for (const row of rows.slice(0, 10)) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (record.type !== "session_meta") continue;
      const payload = (record.payload ?? {}) as Record<string, unknown>;
      const id = payload.session_id ?? payload.id;
      if (typeof id === "string" && id) return id;
    }
    const name = fileStem(path);
    return name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? name;
  }
  return fileStem(path);
}

/** Build a SessionRef from an explicit JSONL file, auto-detecting the agent. */
export async function refFromFile(path: string, agentOverride?: AgentKind): Promise<SessionRef> {
  const abs = expandHome(path);
  const rows = await readJsonl(abs);
  const agent = agentOverride ?? detectAgent(rows, abs) ?? "copilot";
  return { agent, id: deriveId(abs, agent, rows), path: abs };
}

/**
 * Discover sessions from an explicit filesystem path outside the live agent
 * homes: a single `*.jsonl` file, or a directory walked for `*.jsonl` files
 * (e.g. a restic-restored backup cache, or session files copied off another
 * machine). Each file's agent is auto-detected unless `agentOverride` is set.
 */
export async function discoverPath(path: string, agentOverride?: AgentKind): Promise<SessionRef[]> {
  const abs = expandHome(path);
  if (!(await pathExists(abs))) throw new Error(`path not found: ${path}`);
  const info = await stat(abs);
  if (info.isFile()) return [await refFromFile(abs, agentOverride)];
  const files = await walkFiles(abs, (candidate) => candidate.endsWith(".jsonl"));
  const refs: SessionRef[] = [];
  for (const file of files) refs.push(await refFromFile(file, agentOverride));
  return refs.sort((a, b) => a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id));
}

export function sessionToText(session: ParsedSession): string {
  const header = [
    `session: ${session.id}`,
    `agent: ${session.agent}`,
    session.cwd ? `cwd: ${session.cwd}` : undefined,
    session.startedAt ? `started: ${session.startedAt}` : undefined,
    "",
  ].filter((line) => line !== undefined).join("\n");
  const body = session.entries.map((entry) => {
    const time = entry.timestamp ? ` ${entry.timestamp}` : "";
    const title = entry.title ? ` ${entry.title}` : "";
    return `## ${entry.index + 1}. ${entry.role}/${entry.kind}${title}${time}\n\n${timelineEntryToText(entry)}`;
  }).join("\n\n");
  return `${header}${body}\n`;
}

function timelineEntryToText(entry: TimelineEntry): string {
  if (entry.tool) {
    const lines = [`tool: ${entry.tool.name ?? "(unnamed)"}`];
    if (entry.tool.arguments !== undefined) lines.push(`args: ${stringifyInline(entry.tool.arguments)}`);
    if (entry.tool.intentionSummary) lines.push(`intention: ${entry.tool.intentionSummary}`);
    if (entry.tool.partialOutput) lines.push(`partial-output:\n${entry.tool.partialOutput}`);
    lines.push(`result: ${entry.tool.result?.type ?? "pending"}`);
    if (entry.tool.result?.log) lines.push(`log:\n${entry.tool.result.log}`);
    return lines.join("\n");
  }

  const data = entry.data ?? {};
  const stats: string[] = [];
  let text = entry.text;

  if (entry.kind === "subagent") {
    stats.push(`name: ${stringifyInline(entry.title ?? data.agentDisplayName ?? data.agentName ?? "(unnamed)")}`);
    if (data.model !== undefined) stats.push(`model: ${stringifyInline(data.model)}`);
    if (data.failed !== undefined) stats.push(`failed: ${stringifyInline(data.failed)}`);
  } else if (entry.kind === "skill") {
    stats.push(`name: ${stringifyInline(entry.title ?? data.name ?? "(unnamed)")}`);
    if (data.source !== undefined) stats.push(`source: ${stringifyInline(data.source)}`);
    if (data.trigger !== undefined) stats.push(`trigger: ${stringifyInline(data.trigger)}`);
  } else if (entry.kind === "plan") {
    if (data.operation !== undefined) stats.push(`operation: ${stringifyInline(data.operation)}`);
  } else if (entry.kind === "compaction") {
    if (data.preTokens !== undefined) stats.push(`tokens: ${stringifyInline(data.preTokens)}`);
    if (data.preMessages !== undefined) stats.push(`messages: ${stringifyInline(data.preMessages)}`);
    if (data.durationMs !== undefined) stats.push(`duration-ms: ${stringifyInline(data.durationMs)}`);
    if (text) stats.push(`summary:\n${text}`);
    text = "";
  }

  if (text) stats.push(text);
  return stats.join("\n");
}
