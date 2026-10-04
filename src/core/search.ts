import { mapConcurrent } from "./concurrency.js";
import { readSearchSession } from "./session-cache.js";
import { sortSessionRefs } from "./session-metadata.js";
import { excerpt, timelineEntrySearchText } from "./text.js";
import type { SearchHit, SessionRef, TimelineRole } from "./types.js";

export interface SearchDiagnostic {
  kind: "unreadable" | "warning" | "notice";
  session: SessionRef;
  code: string;
  message: string;
}
export interface SessionScanResult {
  found: SearchHit[];
  diagnostics: SearchDiagnostic[];
}
export interface SearchOptions {
  /** Bounded read-ahead; output remains newest-session first, then timeline order. */
  concurrency?: number;
  earlyExit?: boolean;
  role?: TimelineRole;
  /** Explicit cache root; omitted means no persistent cache for library callers. */
  cacheDir?: string;
  /** Optional execution backend (e.g. CLI worker pool); core remains independently testable. */
  scanSession?: (ref: SessionRef) => Promise<SessionScanResult>;
  /** Library callers own presentation; no console side effects in core. */
  onDiagnostic?: (diagnostic: SearchDiagnostic) => void;
}

/** Query-independent cached projections retain exactly the same timeline semantics. */
export async function scanSession(ref: SessionRef, query: string, limit: number, options: Pick<SearchOptions, "role" | "cacheDir"> = {}): Promise<SessionScanResult> {
  const diagnostics: SearchDiagnostic[] = [];
  const found: SearchHit[] = [];
  try {
    const { parsed, lowerTexts } = await readSearchSession(ref, query, options.cacheDir);
    const { entries, diagnostics: report, ...session } = parsed;
    const notices = new Set(parsed.source?.notices ?? []);
    for (const message of notices) diagnostics.push({ kind: "notice", session: ref, code: "source-notice", message });
    for (const issue of report?.issues ?? []) diagnostics.push({ kind: "warning", session: ref, code: issue.code, message: issue.message });
    if (parsed.source?.warning && !report?.issues?.length && !notices.has(parsed.source.warning)) {
      diagnostics.push({ kind: "warning", session: ref, code: "source-warning", message: parsed.source.warning });
    }
    const needle = query.toLowerCase();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (options.role && entry.role !== options.role) continue;
      if (lowerTexts && !lowerTexts[index].includes(needle)) continue;
      const text = timelineEntrySearchText(entry);
      if (!lowerTexts && !text.toLowerCase().includes(needle)) continue;
      found.push({ session, entry, excerpt: excerpt(text, query) });
      if (found.length >= limit) break;
    }
  } catch (error) {
    diagnostics.push({ kind: "unreadable", session: ref, code: "unreadable", message: error instanceof Error ? error.message : String(error) });
  }
  return { found, diagnostics };
}

/** Search canonical projection semantics, not raw JSON (private/duplicate carriers). */
export async function searchRefs(refs: SessionRef[], query: string, limit = 20, options: SearchOptions = {}): Promise<SearchHit[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");
  const concurrency = options.concurrency ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("concurrency must be an integer between 1 and 32");
  if (!query.trim()) throw new Error("search query must not be empty");
  if (limit === 0) return [];
  const hits: SearchHit[] = [];
  const ordered = sortSessionRefs(refs);
  const scan = options.scanSession ?? (ref => scanSession(ref, query, limit, options));
  // A batch limits retained timelines and speculative reads. Once the cap is
  // reached, do not schedule another batch (at most concurrency-1 read-ahead).
  for (let offset = 0; offset < ordered.length; offset += concurrency) {
    const results = await mapConcurrent(ordered.slice(offset, offset + concurrency), concurrency, scan);
    for (const result of results) {
      for (const diagnostic of result.diagnostics) options.onDiagnostic?.(diagnostic);
      hits.push(...result.found.slice(0, limit - hits.length));
    }
    if (hits.length >= limit && options.earlyExit !== false) break;
  }
  return hits;
}
