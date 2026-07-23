import {
  AGENTS,
  discoverPath,
  discoverSessions,
  findSession,
  findSessionAmong,
  type AgentKind,
  type AgentRoots,
  type SessionRef,
} from "../../core/index.js";
import { BIN_NAME } from "../brand.js";

export function parseAgents(value: string): AgentKind[] {
  if (value === "all") return AGENTS;
  if (value === "copilot" || value === "claude" || value === "codex") return [value];
  throw new Error(`unknown agent: ${value}`);
}

export function filePathFromOptions(opts: Record<string, unknown>): string | undefined {
  if (typeof opts.file === "string" && opts.file) return opts.file;
  if (typeof opts.events === "string" && opts.events) return opts.events;
  return undefined;
}

export function agentOverrideFromOptions(opts: Record<string, unknown>): AgentKind | undefined {
  return typeof opts.agent === "string" && opts.agent !== "all" ? parseAgents(opts.agent)[0] : undefined;
}

export function rootsFromOptions(opts: Record<string, unknown>): AgentRoots {
  return {
    copilot: typeof opts.copilotRoot === "string" ? opts.copilotRoot : undefined,
    copilotDb: typeof opts.copilotDb === "string" ? opts.copilotDb : undefined,
    claude: typeof opts.claudeRoot === "string" ? opts.claudeRoot : undefined,
    codex: typeof opts.codexRoot === "string" ? opts.codexRoot : undefined,
  };
}

/** Resolve the working set of sessions from --file/--events or the live agent homes. */
export async function resolveRefs(opts: Record<string, unknown>): Promise<SessionRef[]> {
  const file = filePathFromOptions(opts);
  if (file) return discoverPath(file, agentOverrideFromOptions(opts));
  return discoverSessions(parseAgents(String(opts.agent ?? "all")), rootsFromOptions(opts));
}

/** Resolve exactly one session for show/html/md. */
export async function resolveOne(id: string | undefined, opts: Record<string, unknown>): Promise<SessionRef> {
  const file = filePathFromOptions(opts);
  if (file) {
    const refs = await discoverPath(file, agentOverrideFromOptions(opts));
    if (refs.length === 0) throw new Error(`no sessions found in --file path: ${file}`);
    if (!id) {
      if (refs.length === 1) return refs[0];
      throw new Error(`--file matched ${refs.length} sessions; pass a <session-id> to pick one ('${BIN_NAME} list --file ${file}')`);
    }
    const ref = findSessionAmong(refs, id);
    if (!ref) throw new Error(`session not found in --file path: ${id}`);
    return ref;
  }
  if (!id) throw new Error("session id required (or pass --file <path>)");
  const ref = await findSession(id, parseAgents(String(opts.agent ?? "all")), rootsFromOptions(opts));
  if (!ref) throw new Error(`session not found: ${id}`);
  return ref;
}
