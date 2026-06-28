export * from "./types.js";

import type { AgentKind, AgentRoots, ParsedSession, SearchHit, SessionRef } from "./types.js";
import { discoverClaude, parseClaude } from "./adapters/claude.js";
import { discoverCodex, parseCodex } from "./adapters/codex.js";
import { discoverCopilot, parseCopilot } from "./adapters/copilot.js";
import { excerpt } from "./text.js";

export const AGENTS: AgentKind[] = ["copilot", "claude", "codex"];

export async function discoverSessions(agents: AgentKind[] = AGENTS, roots: AgentRoots = {}): Promise<SessionRef[]> {
  const found: SessionRef[] = [];
  if (agents.includes("copilot")) found.push(...(await discoverCopilot(roots.copilot)));
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
  const sessions = await discoverSessions(agents, roots);
  return sessions.find((session) => session.id === id || session.id.startsWith(id));
}

export async function searchSessions(query: string, agents: AgentKind[] = AGENTS, roots: AgentRoots = {}, limit = 20): Promise<SearchHit[]> {
  const sessions = await discoverSessions(agents, roots);
  const hits: SearchHit[] = [];
  const needle = query.toLowerCase();
  for (const ref of sessions) {
    const parsed = await parseSession(ref);
    for (const entry of parsed.entries) {
      if (!entry.text || !entry.text.toLowerCase().includes(needle)) continue;
      hits.push({
        session: {
          agent: parsed.agent,
          id: parsed.id,
          path: parsed.path,
          startedAt: parsed.startedAt,
          updatedAt: parsed.updatedAt,
          cwd: parsed.cwd,
          title: parsed.title,
        },
        entry,
        excerpt: excerpt(entry.text, query),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
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
    return `## ${entry.index + 1}. ${entry.role}/${entry.kind}${title}${time}\n\n${entry.text}`;
  }).join("\n\n");
  return `${header}${body}\n`;
}
