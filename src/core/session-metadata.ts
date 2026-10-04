import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionRef } from "./types.js";
import { expandHome, iterateJsonl } from "./fs.js";
import { mapConcurrent } from "./concurrency.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Discovery samples metadata, never builds a timeline merely to list/filter it. */
export async function sessionMetadata(ref: SessionRef): Promise<SessionRef> {
  const result = { ...ref };
  try {
    const info = await stat(ref.path);
    result.mtime = info.mtime.toISOString();
    result.size = info.size;
  } catch {
    // Keep disappearing/unreadable refs visible; parsing reports the actual refusal.
  }
  if (ref.agent === "dsh" || ref.agent === "chatgpt" || ref.source?.kind === "db-turns") return result;
  try {
    let sampled = 0;
    for await (const value of iterateJsonl(ref.path)) {
      const row = record(value);
      if (ref.agent === "copilot" && row.type === "session.start") {
        const data = record(row.data);
        result.cwd ??= text(record(data.context).cwd);
        result.startedAt ??= text(data.startTime) ?? text(row.timestamp);
      } else if (ref.agent === "codex" && row.type === "session_meta") {
        const payload = record(row.payload);
        result.cwd ??= text(payload.cwd);
        result.startedAt ??= text(payload.timestamp) ?? text(row.timestamp);
      } else if (ref.agent === "claude" && typeof row.cwd === "string") {
        result.cwd ??= row.cwd;
        result.startedAt ??= text(row.timestamp);
      }
      if (++sampled >= 50 || (result.cwd && result.startedAt)) break;
    }
  } catch {
    // Discovery is not a transcript integrity check.
  }
  return result;
}

export async function enrichSessionRefs(refs: SessionRef[]): Promise<SessionRef[]> {
  return mapConcurrent(refs, 8, sessionMetadata);
}

/** Stable newest-first ordering, with deterministic ties and undated refs last. */
export function sortSessionRefs(refs: readonly SessionRef[], sort: "mtime" | "id" = "mtime"): SessionRef[] {
  return [...refs].sort((a, b) => (sort === "mtime" ? (b.mtime ?? "").localeCompare(a.mtime ?? "") : 0)
    || a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
}

/** Exact recorded cwd, normalized for relative paths, ~ and trailing separators. */
export function filterSessionCwd(refs: SessionRef[], cwd: string | undefined): SessionRef[] {
  if (cwd === undefined) return refs;
  const target = resolve(expandHome(cwd));
  return refs.filter(ref => ref.cwd && resolve(expandHome(ref.cwd)) === target);
}
