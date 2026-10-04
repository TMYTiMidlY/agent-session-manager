import type { ParsedSession, SessionRef } from "./types.js";
import { parseClaude } from "./adapters/claude.js";
import { parseCodex } from "./adapters/codex.js";
import { parseCopilot } from "./adapters/copilot.js";
import { parseDsh } from "./adapters/dsh.js";
import { parseChatGpt } from "./adapters/chatgpt.js";

export async function parseSession(ref: SessionRef): Promise<ParsedSession> {
  if (ref.agent === "copilot") return parseCopilot(ref);
  if (ref.agent === "claude") return parseClaude(ref);
  if (ref.agent === "codex") return parseCodex(ref);
  if (ref.agent === "dsh") return parseDsh(ref);
  return parseChatGpt(ref);
}
