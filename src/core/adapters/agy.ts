import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ParsedSession, ParseDiagnostics, SessionIdentity, SessionRef, SessionSource,
  TimelineEntry, UsageRecord,
} from "../types.js";
import { expandHome, iterateJsonl, pathExists, readJsonl } from "../fs.js";
import { documentFromParsed } from "../normalized.js";

/**
 * Antigravity CLI (AGY) read-only adapter.
 *
 * Layout (verified against a 502-conversation brain on disk):
 *   $AGY_HOME/.gemini/antigravity-cli/brain/<conversation-id>/
 *     .system_generated/logs/transcript.jsonl        — compact transcript
 *     .system_generated/logs/transcript_full.jsonl   — untruncated rows
 *     .system_generated/logs/media/step_N_media_M.*  — pasted/screenshot media
 *     .system_generated/messages/*.json              — inbox messages (agent-to-agent)
 *   $AGY_HOME/.gemini/antigravity-cli/history.jsonl  — {conversationId, workspace, display}
 *
 * transcript.jsonl and transcript_full.jsonl are row-aligned; compact rows may
 * carry `truncated_fields: ["content"|"tool_calls"]`, and the corresponding
 * transcript_full row holds the full field (AGY's own CHECKPOINT summary
 * documents this pairing). Both files share one row schema:
 *   {step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type, status, created_at,
 *    content?, thinking?, tool_calls?: [{name, args}], media?, error?,
 *    input_tokens?, cache_read_tokens?, output_tokens?, truncated_fields?}
 * with type ∈ USER_INPUT | PLANNER_RESPONSE | GENERIC | SYSTEM_MESSAGE |
 * CHECKPOINT | ERROR_MESSAGE.
 */

const DEFAULT_AGY_TRANSCRIPT_DIR = "~/.gemini/antigravity-cli/brain";

const AGY_ROW_TYPES = new Set([
  "USER_INPUT", "PLANNER_RESPONSE", "GENERIC", "SYSTEM_MESSAGE", "CHECKPOINT", "ERROR_MESSAGE",
]);

const SENDER_ID_PATTERN = /sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const EXIT_CODE_PATTERN = /Command exited with code (-?\d+)/;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function defaultAgyRoot(): string {
  const home = process.env.AGY_HOME;
  return home ? join(expandHome(home), ".gemini/antigravity-cli/brain") : DEFAULT_AGY_TRANSCRIPT_DIR;
}

/** True when a JSONL row sample carries the AGY transcript signature. */
export function isAgyRow(value: unknown): boolean {
  const row = record(value);
  return typeof row.step_index === "number"
    && typeof row.source === "string"
    && AGY_ROW_TYPES.has(String(row.type));
}

/**
 * AGY stores tool arguments as JSON-encoded primitives
 * ({"CommandLine":"\"ls -la\""}.CommandLine is the two-character-string
 * `"ls -la"` plus quotes). Decode exactly one level, and only when the value
 * round-trips as a JSON scalar; everything else passes through untouched.
 */
function decodeAgyArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^(".*"|null|true|false|-?\d+(\.\d+)?)$/s.test(trimmed)) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed === null || typeof parsed !== "object" ? parsed : value;
  } catch {
    return value;
  }
}

function decodeAgyArgs(args: unknown): Record<string, unknown> | undefined {
  if (args === null || args === undefined) return undefined;
  if (typeof args !== "object" || Array.isArray(args)) return { args };
  const source = args as Record<string, unknown>;
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) decoded[key] = decodeAgyArg(value);
  return decoded;
}

/** Conversation id for a transcript path inside a brain directory; file stem otherwise. */
export function agyConversationId(path: string): string {
  if (/^transcript(_full)?\.jsonl$/i.test(basename(path))) return basename(dirname(dirname(dirname(path))));
  return basename(path).replace(/\.jsonl$/i, "");
}

/** The untruncated sibling of a compact transcript path, when present. */
export function agyFullTranscriptPath(path: string): string {
  const name = basename(path);
  if (/^transcript(_full)?\.jsonl$/i.test(name)) return join(dirname(path), "transcript_full.jsonl");
  return path;
}

/** Scan `$AGY_HOME/.gemini/antigravity-cli/history.jsonl` for conversationId → workspace. */
async function agyWorkspaceIndex(brainRoot: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const history = join(dirname(brainRoot), "history.jsonl");
  if (!(await pathExists(history))) return index;
  try {
    for await (const value of iterateJsonl(history)) {
      const row = record(value);
      const id = typeof row.conversationId === "string" ? row.conversationId : undefined;
      const workspace = typeof row.workspace === "string" && row.workspace ? row.workspace : undefined;
      // First recorded workspace wins: it is where the conversation started,
      // matching the session-start cwd semantics of the other adapters.
      if (id && workspace && !index.has(id)) index.set(id, workspace);
    }
  } catch {
    // Discovery is not a history integrity check; cwd stays unset.
  }
  return index;
}

export async function discoverAgy(root?: string): Promise<SessionRef[]> {
  const brainRoot = expandHome(root ?? defaultAgyRoot());
  const refs: SessionRef[] = [];
  if (!(await pathExists(brainRoot))) return refs;
  const workspaces = await agyWorkspaceIndex(brainRoot);
  // Shallow two-level scan of the fixed brain layout. Never descend into
  // .system_generated subtrees: a long conversation's steps/ directory holds
  // tens of thousands of per-step output directories, and only
  // logs/transcript.jsonl is a session source.
  for (const entry of await readdir(brainRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(brainRoot, entry.name, ".system_generated", "logs", "transcript.jsonl");
    if (!(await pathExists(path))) continue;
    const id = entry.name;
    refs.push({
      agent: "agy",
      id,
      path,
      ...(workspaces.get(id) !== undefined ? { cwd: workspaces.get(id) } : {}),
    });
  }
  return refs;
}

interface PendingAgyCall {
  callId: string;
  name: string;
  paired: boolean;
}

/**
 * Parse one AGY conversation. Reads transcript_full.jsonl when its compact
 * sibling is the ref (rows are aligned; full rows never carry truncated
 * fields), and falls back to the compact file with an explicit lossy warning
 * per truncated field marker.
 */
export async function parseAgy(ref: SessionRef): Promise<ParsedSession> {
  const full = agyFullTranscriptPath(ref.path);
  const useFull = full !== ref.path && await pathExists(full);
  const sourcePath = useFull ? full : ref.path;
  const rows = await readJsonl(sourcePath);

  const entries: TimelineEntry[] = [];
  const usageLedger: UsageRecord[] = [];
  const diagnosticCounts = { handled: 0, ignored: 0, unknown: 0 };
  const unknownTypes = new Set<string>();
  let badJsonRows = 0;
  let truncatedMarkers = 0;
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let sawUserInput = false;
  let parentSession: string | undefined;
  // Pending calls from the most recent PLANNER_RESPONSE, for safe 1:1 pairing.
  let pendingCalls: PendingAgyCall[] = [];

  const push = (entry: Omit<TimelineEntry, "index">): void => {
    entries.push({ index: entries.length, ...entry });
  };

  for (const value of rows) {
    const row = record(value);
    if (row.type === "parse_error") {
      badJsonRows++;
      continue;
    }
    const type = typeof row.type === "string" ? row.type : "";
    const timestamp = typeof row.created_at === "string" ? row.created_at : undefined;
    startedAt ??= timestamp;
    if (timestamp) updatedAt = timestamp;
    if (Array.isArray(row.truncated_fields) && !useFull) truncatedMarkers += row.truncated_fields.length;

    if (!AGY_ROW_TYPES.has(type)) {
      diagnosticCounts.unknown++;
      if (unknownTypes.size < 20) unknownTypes.add(type || "(empty)");
      continue;
    }

    if (type === "USER_INPUT") {
      sawUserInput = true;
      push({
        role: "user", kind: "message",
        text: typeof row.content === "string" ? row.content : "",
        timestamp, rawType: "USER_INPUT",
      });
      diagnosticCounts.handled++;
    } else if (type === "PLANNER_RESPONSE") {
      if (typeof row.thinking === "string" && row.thinking) {
        push({ role: "reasoning", kind: "thinking", text: row.thinking, timestamp, rawType: "PLANNER_RESPONSE/thinking" });
      }
      if (Array.isArray(row.tool_calls)) {
        pendingCalls = [];
        for (let i = 0; i < row.tool_calls.length; i++) {
          const call = record(row.tool_calls[i]);
          const name = typeof call.name === "string" ? call.name : "(unnamed)";
          const callId = `step${typeof row.step_index === "number" ? row.step_index : "?"}:${i}`;
          const arguments_ = "args" in call ? decodeAgyArgs(call.args) : undefined;
          push({
            role: "tool", kind: "tool_use", title: name, text: "",
            timestamp, rawType: "PLANNER_RESPONSE/tool_call",
            tool: { callId, name, ...(arguments_ !== undefined ? { arguments: arguments_ } : {}), result: { type: "pending" } },
          });
          pendingCalls.push({ callId, name, paired: false });
        }
      } else {
        pendingCalls = [];
      }
      if (typeof row.content === "string" && row.content) {
        push({ role: "assistant", kind: "text", text: row.content, timestamp, rawType: "PLANNER_RESPONSE/content" });
      }
      // One planner step is one model response; its token counts are per-call
      // increments (Gemini semantics: cache read is a separate bucket).
      const usage = readAgyUsage(row, typeof row.step_index === "number" ? `step-${row.step_index}` : undefined, timestamp);
      if (usage) usageLedger.push({ ...usage, id: `u${usageLedger.length}` });
      diagnosticCounts.handled++;
    } else if (type === "GENERIC") {
      const content = typeof row.content === "string" ? row.content : "";
      const exit = EXIT_CODE_PATTERN.exec(content);
      // Pair with a pending call only when exactly one is unpaired — with
      // concurrent calls the positional mapping is not verifiable.
      const unpaired = pendingCalls.filter((call) => !call.paired);
      const pair = unpaired.length === 1 ? unpaired[0] : undefined;
      if (pair) pair.paired = true;
      const media = Array.isArray(row.media)
        ? row.media.map((item) => {
          const entry = record(item);
          return {
            ...(typeof entry.mime_type === "string" ? { mimeType: entry.mime_type } : {}),
            ...(typeof entry.uri === "string" ? { uri: entry.uri } : {}),
          };
        })
        : undefined;
      push({
        role: "tool", kind: "tool_result", text: content,
        timestamp, rawType: "MODEL/tool_result",
        ...(pair ? { title: pair.name } : {}),
        tool: {
          ...(pair ? { callId: pair.callId, name: pair.name } : {}),
          result: {
            type: exit && Number(exit[1]) !== 0 ? "failure" : "success",
            ...(content ? { log: content } : {}),
          },
        },
        ...(media !== undefined ? { data: { media } } : {}),
      });
      diagnosticCounts.handled++;
    } else if (type === "SYSTEM_MESSAGE") {
      const content = typeof row.content === "string" ? row.content : "";
      if (parentSession === undefined) {
        const sender = SENDER_ID_PATTERN.exec(content)?.[1];
        if (sender) parentSession = sender;
      }
      push({ role: "system", kind: "system", text: content, timestamp, rawType: "SYSTEM_MESSAGE" });
      diagnosticCounts.handled++;
    } else if (type === "CHECKPOINT") {
      const content = typeof row.content === "string" ? row.content : "";
      push({ role: "system", kind: "compaction", text: content, timestamp, rawType: "CHECKPOINT" });
      // Context size at compaction, not metering: preserve as an uncounted
      // context sample so it never contributes to session token totals.
      usageLedger.push({
        id: `u${usageLedger.length}`,
        ...(timestamp !== undefined ? { timestamp } : {}),
        cumulative: false, counted: false, kind: "context", metrics: {},
        context: {
          ...(safeCount(row.input_tokens) !== undefined ? { inputTokens: safeCount(row.input_tokens) } : {}),
          ...(safeCount(row.cache_read_tokens) !== undefined ? { cacheReadTokens: safeCount(row.cache_read_tokens) } : {}),
          raw: {
            ...(safeCount(row.input_tokens) !== undefined ? { input_tokens: row.input_tokens } : {}),
            ...(safeCount(row.cache_read_tokens) !== undefined ? { cache_read_tokens: row.cache_read_tokens } : {}),
            ...(safeCount(row.output_tokens) !== undefined ? { output_tokens: row.output_tokens } : {}),
          },
        },
        provenance: { agent: "agy", rawType: "CHECKPOINT", metering: { source: "AGY CHECKPOINT token 计数为压缩点上下文规模快照，不计量、不计入总计" } },
      });
      diagnosticCounts.handled++;
    } else if (type === "ERROR_MESSAGE") {
      push({
        role: "event", kind: "error",
        text: typeof row.error === "string" ? row.error : "",
        timestamp, rawType: "ERROR_MESSAGE",
      });
      diagnosticCounts.handled++;
    }
  }

  // A conversation with no human input is an agent-dispatched subagent; the
  // first SYSTEM_MESSAGE sender is the parent conversation id (verified in
  // real orchestrator→worker dispatches).
  const identity: SessionIdentity = rows.length === 0
    ? { role: "unknown" }
    : sawUserInput
      ? { role: "main" }
      : { role: "subagent", ...(parentSession !== undefined ? { parentSession } : {}) };

  const warnings = [
    ...(badJsonRows > 0 ? [`来源含 ${badJsonRows} 行损坏的 JSON 记录，已省略`] : []),
    ...(!useFull && truncatedMarkers > 0
      ? [`紧凑 transcript 含 ${truncatedMarkers} 个 truncated_fields 标记且缺少 transcript_full.jsonl，受影响步骤内容不完整`]
      : []),
  ];
  const source: SessionSource = {
    kind: "agy-transcript",
    path: sourcePath,
    lossy: warnings.length > 0,
    ...(warnings.length ? { warning: warnings.join("；") } : {}),
    notices: [
      "AGY transcript 不记录模型名与 cwd（cwd 来自 history.jsonl 的 workspace 字段）",
    ],
  };

  const diagnostics: ParseDiagnostics = {
    ...diagnosticCounts,
    unknownTypes: [...unknownTypes].sort(),
    ...(unknownTypes.size >= 20 ? { unknownTypesTruncated: true } : {}),
  };
  const result: ParsedSession = {
    ...ref, startedAt, updatedAt, entries, diagnostics, identity, source,
  };
  return { ...result, document: documentFromParsed(result, { identity, usage: usageLedger }) };
}

/** Verified fields only; anything malformed stays unknown, never zero. */
function readAgyUsage(row: Record<string, unknown>, responseId: string | undefined, timestamp: string | undefined): Omit<UsageRecord, "id"> | undefined {
  const metrics: Partial<Pick<UsageRecord["metrics"], "inputTokens" | "cacheReadTokens" | "outputTokens">> = {};
  const inputTokens = safeCount(row.input_tokens);
  const cacheReadTokens = safeCount(row.cache_read_tokens);
  const outputTokens = safeCount(row.output_tokens);
  if (inputTokens !== undefined) metrics.inputTokens = inputTokens;
  if (cacheReadTokens !== undefined) metrics.cacheReadTokens = cacheReadTokens;
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens;
  if (!Object.keys(metrics).length) return undefined;
  return {
    ...(responseId !== undefined ? { responseId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    cumulative: false,
    metrics,
    kind: "response",
    provenance: {
      agent: "agy", rawType: "PLANNER_RESPONSE",
      metering: { source: "AGY PLANNER_RESPONSE token 计数（单次响应增量，cache_read 独立桶）" },
    },
  };
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Lightweight identity probe for the relation graph: streams rows until the
 * first USER_INPUT (main) or SYSTEM_MESSAGE sender (subagent + parent).
 */
export async function probeAgyIdentity(ref: SessionRef): Promise<SessionIdentity> {
  try {
    let sawUserInput = false;
    let parentSession: string | undefined;
    let sawAny = false;
    for await (const value of iterateJsonl(ref.path)) {
      const row = record(value);
      if (!isAgyRow(row)) continue;
      sawAny = true;
      if (row.type === "USER_INPUT") {
        sawUserInput = true;
        break;
      }
      if (row.type === "SYSTEM_MESSAGE" && parentSession === undefined) {
        parentSession = SENDER_ID_PATTERN.exec(typeof row.content === "string" ? row.content : "")?.[1];
        break;
      }
      if (row.type === "PLANNER_RESPONSE" || row.type === "GENERIC") break;
    }
    if (!sawAny) return { role: "unknown" };
    return sawUserInput ? { role: "main" } : { role: "subagent", ...(parentSession !== undefined ? { parentSession } : {}) };
  } catch {
    return { role: "unknown" };
  }
}
