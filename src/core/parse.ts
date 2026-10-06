import type { ParsedSession, SessionRef } from "./types.js";
import { parseClaude } from "./adapters/claude.js";
import { parseCodex } from "./adapters/codex.js";
import { parseCopilot } from "./adapters/copilot.js";
import { parseDsh } from "./adapters/dsh.js";
import { parseChatGpt } from "./adapters/chatgpt.js";
import { computeStats, documentFromParsed, finalizeDocument, projectEntries } from "./normalized.js";
import { parseCursor } from "./adapters/cursor.js";

/**
 * Every source passes through the unified SessionDocument: adapters either
 * return a native document (entries are then its projection) or an entries
 * view, which is normalized losslessly. Source-specific counters and lineage
 * are collected by the source adapter, not by a second raw-file scan.
 */
export async function parseSession(ref: SessionRef): Promise<ParsedSession> {
  let parsed: ParsedSession;
  if (ref.agent === "copilot") parsed = await parseCopilot(ref);
  else if (ref.agent === "claude") parsed = await parseClaude(ref);
  else if (ref.agent === "codex") parsed = await parseCodex(ref);
  else if (ref.agent === "dsh") parsed = await parseDsh(ref);
  else if (ref.agent === "cursor") parsed = await parseCursor(ref);
  else parsed = await parseChatGpt(ref);

  parsed = { ...parsed, mtime: parsed.mtime ?? ref.mtime, size: parsed.size ?? ref.size };
  const document = parsed.document ?? documentFromParsed(parsed);
  document.ref = { ...document.ref, mtime: parsed.mtime, size: parsed.size };
  finalizeDocument(document);
  return { ...parsed, identity: document.identity, document,
    entries: projectEntries(document), stats: computeStats(document) };
}
