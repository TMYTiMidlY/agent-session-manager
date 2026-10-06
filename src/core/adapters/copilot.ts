import { basename, dirname } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry, ToolDetail, ToolResultKind, UsageRecord } from "../types.js";
import { contentToText } from "../text.js";
import { expandHome, iterateJsonl, walkFiles } from "../fs.js";
import { documentFromParsed } from "../normalized.js";
import { listCopilotDbSessions, readCopilotDbSession } from "./copilot-db.js";

const DEFAULT_ROOT = "~/.copilot/session-state";
const DEFAULT_DB = "~/.copilot/session-store.db";
const ASK_USER_ANSWER = /^User (selected|responded|answered):/u;

const HANDLED_EVENT_TYPES = new Set([
  "session.start",
  "user.message",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "system.notification",
  "session.info",
  "abort",
  "session.error",
  "error",
  "session.warning",
  "warning",
  "handoff",
  "session.compaction_start",
  "session.compaction_complete",
  "compaction",
  "session.task_complete",
  "task_complete",
  "subagent.started",
  "subagent.selected",
  "subagent.completed",
  "subagent.failed",
  "skill.invoked",
  "session.plan_changed",
]);

const INTENTIONALLY_IGNORED_EVENT_TYPES = new Set([
  "session.model_change",
  "session.resume",
  "session.shutdown",
  "session.mode_changed",
  "session.context_changed",
  "session.workspace_file_changed",
  "session.binary_asset",
  "session.permissions_changed",
  "session.schedule_created",
  "session.schedule_cancelled",
  "session.truncation",
  "session.usage_checkpoint",
  "hook.*",
  "assistant.turn_*",
  "system.message",
]);

export async function discoverCopilot(root = DEFAULT_ROOT, dbPath = DEFAULT_DB): Promise<SessionRef[]> {
  const resolvedDbPath = expandHome(dbPath);
  const [files, dbSessions] = await Promise.all([
    walkFiles(expandHome(root), (path) => basename(path) === "events.jsonl"),
    listCopilotDbSessions(resolvedDbPath),
  ]);
  const refs = new Map<string, SessionRef>();

  for (const session of dbSessions) {
    refs.set(session.id, {
      agent: "copilot",
      id: session.id,
      path: resolvedDbPath,
      cwd: session.cwd,
      title: session.summary,
      repository: session.repository,
      branch: session.branch,
      source: { kind: "db-turns", path: resolvedDbPath, lossy: true },
    });
  }

  for (const path of files) {
    const id = basename(dirname(path));
    const dbRef = refs.get(id);
    refs.set(id, {
      ...dbRef,
      agent: "copilot",
      id,
      path,
      source: { kind: "events", path, lossy: false },
    });
  }

  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function parseCopilot(ref: SessionRef): Promise<ParsedSession> {
  if (ref.source?.kind === "db-turns" || (basename(ref.path) === "session-store.db" && ref.source?.kind !== "events")) {
    return parseCopilotDb(ref);
  }

  const entries: TimelineEntry[] = [];
  // Native usage ledger: only fields whose meaning was verified against real
  // events.jsonl records. `session.usage_checkpoint` semantics are NOT
  // verified, so it stays intentionally ignored — unknown, never zero.
  const usageLedger: UsageRecord[] = [];
  let cwd = ref.cwd;
  let startedAt = ref.startedAt;
  let updatedAt = ref.updatedAt;
  let title = ref.title;
  let repository = ref.repository;
  const branch = ref.branch;
  const diagnosticCounts = { handled: 0, ignored: 0, unknown: 0 };
  const unknownTypes = new Set<string>();
  let badJsonRows = 0;

  /** tool entries waiting for their matching complete event, keyed by callId */
  const pendingTools = new Map<string, TimelineEntry>();
  /** subagent.started entries waiting for their subagent.completed stats, keyed by toolCallId */
  const pendingSubagents = new Map<string, TimelineEntry>();
  /** timestamp of the last session.compaction_start, to derive compaction duration */
  let pendingCompactionStart: string | undefined;

  function push(entry: Omit<TimelineEntry, "index">): TimelineEntry {
    const full: TimelineEntry = { index: entries.length, ...entry };
    entries.push(full);
    return full;
  }

  for await (const row of iterateJsonl(ref.path)) {
    if (!row || typeof row !== "object") continue;
    const event = row as Record<string, unknown>;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const type = String(event.type ?? "event");
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    updatedAt = timestamp ?? updatedAt;

    if (type === "parse_error") {
      // fs.ts marks unparseable JSONL lines; count them for diagnostics
      // instead of letting them surface as an unknown event type.
      badJsonRows++;
      continue;
    }

    if (isIntentionallyIgnoredEvent(type)) {
      diagnosticCounts.ignored += 1;
      continue;
    }
    if (!HANDLED_EVENT_TYPES.has(type)) {
      diagnosticCounts.unknown += 1;
      unknownTypes.add(type);
      continue;
    }
    diagnosticCounts.handled += 1;

    if (type === "session.start") {
      const context = (data.context ?? {}) as Record<string, unknown>;
      cwd = typeof context.cwd === "string" ? context.cwd : cwd;
      startedAt = typeof data.startTime === "string" ? data.startTime : timestamp ?? startedAt;
      repository = typeof context.repository === "string" ? context.repository : repository;
      title ??= repository;
      continue;
    }

    if (type === "user.message") {
      const text = stringOrEmpty(data.content);
      if (!text.trim()) continue;
      push({ role: "user", kind: "message", text, timestamp, rawType: type });
      continue;
    }

    if (type === "assistant.message") {
      const reasoning = stringOrEmpty(data.reasoningText);
      const content = stringOrEmpty(data.content);
      if (reasoning.trim()) {
        push({ role: "reasoning", kind: "reasoning", text: reasoning, timestamp, rawType: type });
      }
      if (content.trim()) {
        const model = typeof data.model === "string" ? data.model : undefined;
        push({
          role: "assistant",
          kind: "message",
          text: content,
          timestamp,
          rawType: type,
          data: model ? { model } : undefined,
        });
      }
      continue;
    }

    if (type === "tool.execution_start") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const entry = push(toolEntryFromStart(data, timestamp, type));
      if (callId) pendingTools.set(callId, entry);
      continue;
    }

    if (type === "tool.execution_complete") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const entry = (callId ? pendingTools.get(callId) : undefined)
        ?? push(toolEntryFromStart(data, timestamp, type));
      if (callId) pendingTools.delete(callId);

      const tool = entry.tool ?? { result: { type: "pending" } };
      tool.callId ??= callId;
      tool.name ??= typeof data.toolName === "string" ? data.toolName : undefined;
      tool.arguments ??= data.arguments;
      tool.intentionSummary ??= typeof data.intentionSummary === "string" ? data.intentionSummary : undefined;
      tool.partialOutput = partialOutput(data.partialOutput) ?? tool.partialOutput;
      tool.result = normaliseToolResult(data);
      entry.tool = tool;
      entry.title = tool.name;
      entry.text = tool.result?.log ?? "";
      entry.rawType = type;
      const answer = tool.result?.log;
      const succeeded = tool.result?.type === "success";
      // Anchor the decision to the tool identity: `ask_user` is authoritative.
      // The "User selected/responded:" prefix is only a fallback for completions
      // that dropped the tool name — otherwise any tool whose output happens to
      // start that way would mint a phantom decision.
      const isAskUser = tool.name === "ask_user"
        || (tool.name === undefined && answer !== undefined && ASK_USER_ANSWER.test(answer));
      if (succeeded && isAskUser && answer?.trim()) {
        const question = askUserQuestion(tool.arguments);
        push({
          role: "user",
          kind: "decision",
          title: question,
          text: question ? `Q: ${question}${askUserChoices(tool.arguments)}\nA: ${answer}` : answer,
          timestamp,
          rawType: "ask_user.decision",
        });
      }
      continue;
    }

    if (type === "system.notification") {
      const kind = (data.kind ?? {}) as Record<string, unknown>;
      const kindType = typeof kind.type === "string" ? kind.type : undefined;
      push({
        role: "event",
        kind: "notification",
        text: stringOrEmpty(data.content) || kindType || "",
        timestamp,
        rawType: type,
        detail: kindType,
        data: { kind },
      });
      continue;
    }

    if (type === "session.info") {
      // Bundle adds a timeline entry per persisted session.info; infoType=model
      // surfaces "Model changed from X to Y" which we want.
      const message = stringOrEmpty(data.message);
      if (message) {
        push({ role: "event", kind: "info", text: message, timestamp, rawType: type });
      }
      continue;
    }

    if (type === "abort") {
      const reason = typeof data.reason === "string" ? data.reason : "user_initiated";
      const text = reason === "user_initiated" || reason === "user initiated"
        ? "Operation cancelled by user"
        : `Operation aborted (${reason})`;
      push({ role: "event", kind: "info", text, timestamp, rawType: type });
      continue;
    }

    if (type === "session.error" || type === "error") {
      const errorType = typeof data.errorType === "string" ? data.errorType : undefined;
      const message = stringOrEmpty(data.message ?? data.content ?? data.error);
      push({
        role: "event",
        kind: "error",
        text: typedEventText(errorType, message),
        timestamp,
        rawType: type,
        detail: errorType,
        data: {
          errorType,
          stack: typeof data.stack === "string" ? data.stack : undefined,
        },
      });
      continue;
    }

    if (type === "session.warning" || type === "warning") {
      const warningType = typeof data.warningType === "string" ? data.warningType : undefined;
      const message = stringOrEmpty(data.message ?? data.content);
      push({
        role: "event",
        kind: "warning",
        text: typedEventText(warningType, message),
        timestamp,
        rawType: type,
        detail: warningType,
        data: { warningType },
      });
      continue;
    }

    if (type === "handoff") {
      push({
        role: "event",
        kind: "handoff",
        text: stringOrEmpty(data.summary),
        timestamp,
        rawType: type,
        data: data,
      });
      continue;
    }

    if (type === "session.compaction_start") {
      // The start event carries only pre-compaction token counts; the summary
      // lands on the matching complete event. Stash the ts for duration.
      pendingCompactionStart = timestamp;
      continue;
    }

    if (type === "session.compaction_complete" || type === "compaction") {
      // A compaction trims the in-context window; events.jsonl is append-only
      // so every pre-compaction turn still survives above this marker. The
      // entry carries `summaryContent` — the recap seeded into the fresh window.
      // Real field names (grounded against live events.jsonl): the complete
      // event has preCompactionTokens + preCompactionMessagesLength (there is
      // NO postCompactionTokens / messagesRemoved / tokensRemoved), and the
      // authoritative duration is compactionTokensUsed.duration (ms). We fall
      // back to the start→complete timestamp delta only if that's absent.
      const usage = (data.compactionTokensUsed ?? {}) as Record<string, unknown>;
      let durationMs = typeof usage.duration === "number" ? usage.duration : undefined;
      if (durationMs === undefined && timestamp && pendingCompactionStart) {
        durationMs = Date.parse(timestamp) - Date.parse(pendingCompactionStart);
      }
      // compactionTokensUsed is the summarizer LLM call's own metering
      // (verified field names: inputTokens/outputTokens/model/duration).
      // LOCAL EVIDENCE (本机 ~/.copilot/session-state/*/events.jsonl, 326 条
      // compaction 记录): the top-level inputTokens is the FULL prompt count —
      // in every record carrying a COMPLETE four-bucket
      // copilotUsage.tokenDetails (296 条),
      // tokenDetails.input + tokenDetails.cache_read + tokenDetails.cache_write
      // === inputTokens exactly (本机完整明细记录恒等式无失配) — so it must
      // NEVER be mapped to the uncached inputTokens bucket. The disjoint
      // decomposition comes from tokenDetails itself when present and
      // arithmetically consistent (the gate verifies each record
      // individually); otherwise input stays unknown (never guessed, never
      // zero).
      const compactInput = usage.inputTokens;
      const compactOutput = usage.outputTokens;
      const compactModel = typeof usage.model === "string" ? usage.model : undefined;
      const outputValid = typeof compactOutput === "number" && Number.isSafeInteger(compactOutput) && compactOutput >= 0;
      const inputValid = typeof compactInput === "number" && Number.isSafeInteger(compactInput) && compactInput >= 0;
      const serviceRequestId = typeof data.serviceRequestId === "string" && data.serviceRequestId ? data.serviceRequestId : undefined;
      if (inputValid && outputValid) {
        const details = tokenDetails(usage.copilotUsage);
        const metrics: Record<string, number> = {};
        let conversion: UsageRecord["conversion"];
        if (details && details.input + details.cacheRead + details.cacheWrite === compactInput && details.output === compactOutput) {
          metrics.inputTokens = details.input;
          metrics.cacheReadTokens = details.cacheRead;
          metrics.cacheWriteTokens = details.cacheWrite;
          metrics.outputTokens = compactOutput;
          conversion = {
            rule: "compactionTokensUsed.inputTokens 实测为含缓存的提示总量（input+cache_read+cache_write===inputTokens，本机完整明细记录恒等式无失配）；"
              + "未缓存输入与缓存桶取自同 payload 的 copilotUsage.tokenDetails（恒等式校验通过后映射），outputTokens 直映射",
            sourceFields: ["compactionTokensUsed.inputTokens", "compactionTokensUsed.outputTokens",
              "compactionTokensUsed.copilotUsage.tokenDetails[input,cache_read,cache_write,output]"],
            reference: "本机 ~/.copilot/session-state events.jsonl 实测（326 条 compaction 记录，296 条含完整四桶 tokenDetails，恒等式 0 失配）",
          };
        } else {
          metrics.outputTokens = compactOutput;
          conversion = {
            rule: "compactionTokensUsed.inputTokens 实测为含缓存的提示总量，不能映射为未缓存输入；该记录缺可校验的 tokenDetails 分解，input 保持 unknown（不猜 0）",
            sourceFields: ["compactionTokensUsed.inputTokens", "compactionTokensUsed.outputTokens"],
            reference: "本机 ~/.copilot/session-state events.jsonl 实测（input+cache_read+cache_write===inputTokens 恒等式）",
          };
        }
        usageLedger.push({
          id: `u${usageLedger.length}`,
          ...(timestamp !== undefined ? { timestamp } : {}),
          ...(serviceRequestId !== undefined ? { responseId: serviceRequestId } : {}),
          cumulative: false,
          metrics,
          ...(compactModel !== undefined ? { model: compactModel } : {}),
          raw: { compactionTokensUsed: { inputTokens: compactInput, outputTokens: compactOutput,
            ...(typeof usage.cacheReadTokens === "number" ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(typeof usage.cacheWriteTokens === "number" ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
            ...(compactModel !== undefined ? { model: compactModel } : {}) } },
          conversion,
          provenance: { agent: "copilot", rawType: type, metering: { source: "Copilot compactionTokensUsed（压缩摘要调用增量；input 含缓存口径已在本机数据核实）" } },
        });
      }
      push({
        role: "event",
        kind: "compaction",
        text: stringOrEmpty(data.summaryContent) || "Conversation compacted",
        timestamp,
        rawType: type,
        data: {
          success: data.success !== false,
          preTokens: data.preCompactionTokens,
          preMessages: data.preCompactionMessagesLength,
          checkpointNumber: data.checkpointNumber,
          model: typeof usage.model === "string" ? usage.model : undefined,
          durationMs,
        },
      });
      pendingCompactionStart = undefined;
      continue;
    }

    if (type === "session.task_complete" || type === "task_complete") {
      push({
        role: "event",
        kind: "task_complete",
        text: stringOrEmpty(data.content ?? data.summary),
        timestamp,
        rawType: type,
        data: { isError: data.success === false },
      });
      continue;
    }

    if (type === "subagent.started" || type === "subagent.selected") {
      const displayName = typeof data.agentDisplayName === "string" ? data.agentDisplayName : undefined;
      const name = typeof data.agentName === "string" ? data.agentName : undefined;
      const entry = push({
        role: "event",
        kind: "subagent",
        title: displayName ?? name,
        text: stringOrEmpty(data.agentDescription),
        timestamp,
        rawType: type,
        data: {
          agentName: name,
          agentDisplayName: displayName,
          description: typeof data.agentDescription === "string" ? data.agentDescription : undefined,
          model: data.model,
        },
      });
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      if (callId) pendingSubagents.set(callId, entry);
      continue;
    }

    if (type === "subagent.completed" || type === "subagent.failed") {
      // Real subagent.completed carries only toolCallId/agentName/agentDisplayName/model
      // — NO totalTokens/totalToolCalls/durationMs. subagent.failed adds `error`.
      // We only record what actually exists: the failed flag + any error text.
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const target = callId ? pendingSubagents.get(callId) : undefined;
      if (callId) pendingSubagents.delete(callId);
      if (target) {
        const failed = type === "subagent.failed" || data.success === false;
        target.data = {
          ...target.data,
          failed,
          error: failed && typeof data.error === "string" ? data.error : undefined,
        };
      }
      continue;
    }

    if (type === "skill.invoked") {
      const name = typeof data.name === "string" ? data.name : undefined;
      push({
        role: "event",
        kind: "skill",
        title: name,
        text: stringOrEmpty(data.description),
        timestamp,
        rawType: type,
        data: {
          name,
          description: typeof data.description === "string" ? data.description : undefined,
          source: data.source,
          trigger: data.trigger,
        },
      });
      continue;
    }

    if (type === "session.plan_changed") {
      const operation = data.operation;
      const opLabel = typeof operation === "string" ? operation : undefined;
      push({
        role: "event",
        kind: "plan",
        text: opLabel ? `Plan ${opLabel}` : "Plan updated",
        timestamp,
        rawType: type,
        data: { operation },
      });
      continue;
    }

  }

  const result: ParsedSession = {
    ...ref,
    startedAt,
    updatedAt,
    cwd,
    title,
    repository,
    branch,
    source: badJsonRows > 0
      ? { kind: "events", path: ref.path, lossy: true, warning: `来源含 ${badJsonRows} 行损坏的 JSON 记录，已省略` }
      : { kind: "events", path: ref.path, lossy: false },
    diagnostics: {
      ...diagnosticCounts,
      unknownTypes: [...unknownTypes].sort(),
      ...(badJsonRows > 0
        ? { issues: [{ code: "invalid-json-row", message: `损坏的 JSON 记录已省略（${badJsonRows} 行）`, count: badJsonRows }] }
        : {}),
    },
    entries,
  };
  return { ...result, document: documentFromParsed(result, { identity: { role: "main" }, usage: usageLedger }) };
}

async function parseCopilotDb(ref: SessionRef): Promise<ParsedSession> {
  const stored = await readCopilotDbSession(ref.path, ref.id);
  const entries: TimelineEntry[] = [];

  function push(role: "user" | "assistant", text: string, turnIndex: number): void {
    if (!text.trim()) return;
    entries.push({
      index: entries.length,
      role,
      kind: "message",
      text,
      rawType: role === "user" ? "turns.user_message" : "turns.assistant_response",
      data: { turnIndex },
    });
  }

  for (const turn of stored?.turns ?? []) {
    if (turn.userMessage) push("user", turn.userMessage, turn.turnIndex);
    if (turn.assistantResponse) push("assistant", turn.assistantResponse, turn.turnIndex);
  }

  // DB fallback: the turns table carries no token metering — usage stays
  // unknown (empty ledger), never fabricated zeros.
  const result: ParsedSession = {
    ...ref,
    cwd: stored?.session.cwd ?? ref.cwd,
    title: stored?.session.summary ?? ref.title,
    repository: stored?.session.repository ?? ref.repository,
    branch: stored?.session.branch ?? ref.branch,
    source: { kind: "db-turns", path: ref.path, lossy: true },
    entries,
  };
  return { ...result, document: documentFromParsed(result, { identity: { role: "main" }, usage: [] }) };
}

function stringOrEmpty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return contentToText(value);
}

/**
 * Disjoint token decomposition from copilotUsage.tokenDetails. Returns the
 * four buckets only when every entry is a valid non-negative integer count;
 * callers must additionally verify the arithmetic identity against the
 * record's own inputTokens/outputTokens before trusting the decomposition.
 */
function tokenDetails(value: unknown): { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined {
  const usage = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const details = Array.isArray(usage.tokenDetails) ? usage.tokenDetails : undefined;
  if (!details) return undefined;
  const buckets: Partial<Record<"input" | "cache_read" | "cache_write" | "output", number>> = {};
  for (const entry of details) {
    const detail = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const tokenType = detail.tokenType;
    const tokenCount = detail.tokenCount;
    if ((tokenType !== "input" && tokenType !== "cache_read" && tokenType !== "cache_write" && tokenType !== "output")
      || typeof tokenCount !== "number" || !Number.isSafeInteger(tokenCount) || tokenCount < 0
      || tokenType in buckets) return undefined;
    buckets[tokenType] = tokenCount;
  }
  if (buckets.input === undefined || buckets.cache_read === undefined || buckets.cache_write === undefined || buckets.output === undefined) {
    return undefined;
  }
  return { input: buckets.input, cacheRead: buckets.cache_read, cacheWrite: buckets.cache_write, output: buckets.output };
}

function askUserQuestion(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const question = (value as Record<string, unknown>).question;
  return typeof question === "string" && question.trim() ? question.trim() : undefined;
}

function askUserChoices(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length || !choices.every((choice) => typeof choice === "string")) return "";
  return `\n选项：${choices.map((choice, index) => `\n${index + 1}. ${choice}`).join("")}`;
}

function toolEntryFromStart(data: Record<string, unknown>, timestamp: string | undefined, rawType: string): Omit<TimelineEntry, "index"> {
  const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
  const name = typeof data.toolName === "string" ? data.toolName : undefined;
  return {
    role: "tool",
    kind: "tool",
    title: name,
    text: "",
    timestamp,
    rawType,
    tool: {
      callId,
      name,
      arguments: data.arguments,
      intentionSummary: typeof data.intentionSummary === "string" ? data.intentionSummary : undefined,
      partialOutput: partialOutput(data.partialOutput),
      result: { type: "pending" },
    },
  };
}

function normaliseToolResult(data: Record<string, unknown>): ToolDetail["result"] {
  const success = data.success !== false;
  const raw = data.result;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
  const explicitType = toolResultKind(obj?.type);
  const type = explicitType ?? (success ? "success" : "failure");
  const error = !success ? data.error ?? obj?.error : undefined;
  const logSource = error ?? obj?.content ?? obj?.detailedContent ?? (typeof raw === "string" ? raw : undefined);
  let log = logSource === undefined ? undefined : stringOrEmpty(logSource);

  if (log === undefined && obj && Object.keys(obj).some((key) => key !== "type" && key !== "markdown")) {
    log = contentToText(obj);
  }

  if (obj) {
    return {
      type,
      log,
      markdown: obj.markdown === true,
    };
  }
  return { type, log };
}

function partialOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  return stringOrEmpty(value);
}

function typedEventText(type: string | undefined, message: string): string {
  if (!type) return message;
  return message ? `[${type}] ${message}` : `[${type}]`;
}

function toolResultKind(value: unknown): ToolResultKind | undefined {
  // No distinct rejected/denied event encoding has been observed. Preserve
  // those states only when a completion explicitly supplies result.type.
  if (value === "success" || value === "failure" || value === "rejected" || value === "denied" || value === "pending") {
    return value;
  }
  return undefined;
}

function isIntentionallyIgnoredEvent(type: string): boolean {
  return INTENTIONALLY_IGNORED_EVENT_TYPES.has(type)
    || type.startsWith("hook.")
    || type.startsWith("assistant.turn_");
}

export function copilotRoots(root?: string): string {
  return root ?? DEFAULT_ROOT;
}

export function copilotDbRoot(root?: string): string {
  return root ?? DEFAULT_DB;
}
