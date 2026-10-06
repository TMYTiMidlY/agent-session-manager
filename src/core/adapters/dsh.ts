import { basename, dirname, join } from "node:path";
import type { ParsedSession, SessionRef, TimelineEntry, UsageRecord } from "../types.js";
import { expandHome, iterateJsonl, readJsonl, walkFiles } from "../fs.js";
import { mapConcurrent } from "../concurrency.js";
import { sessionMetadata } from "../session-metadata.js";
import { documentFromParsed } from "../normalized.js";
import { DshDiagnostics, DSH_LOG_ONLY_TYPES, dshIdentity, eventMessage, isoTime, lastStreamUsageRaw, observeDshStreamUsage, readDshEvent, readDshHeader, readDshHeaderMeta, readDshUsageMetrics, record, type DshEvent } from "./dsh-reader.js";

// A read-only transcript is not a resumable runtime state. Decode stable
// envelopes and consumed message fields, not every plugin's private schema.

export function isDshHeader(value: unknown): boolean {
  const row = record(value);
  return row.type === "session" && typeof row.version === "number" && typeof row.id === "string";
}

export function dshLogVersion(path: string): number | undefined {
  const name = basename(path);
  if (/^session\.jsonl(?:\.zstd)?$/.test(name)) return 0;
  const match = name.match(/^session\.v([1-9]\d*)\.jsonl(?:\.zstd)?$/);
  const version = match ? Number(match[1]) : undefined;
  return version !== undefined && Number.isSafeInteger(version) ? version : undefined;
}

/** Like DSH, directory discovery selects the highest generation, never a fallback predecessor. */
export function selectDshGenerations(paths: string[]): string[] {
  const selected = new Map<string, string>();
  const other: string[] = [];
  for (const path of paths) {
    const version = dshLogVersion(path);
    if (version === undefined) { other.push(path); continue; }
    const dir = dirname(path);
    const previous = selected.get(dir);
    if (!previous || version > dshLogVersion(previous)!) selected.set(dir, path);
    else if (version === dshLogVersion(previous) && path !== previous) {
      throw new Error(`DSH 同一代会话同时存在两种编码，无法选择：${previous} / ${path}`);
    }
  }
  return [...other, ...selected.values()].sort();
}

function headerRef(path: string, header: unknown): SessionRef {
  return readDshHeader(path, header, dshLogVersion(path));
}

export async function refFromDshFile(path: string): Promise<SessionRef> {
  try {
    return sessionMetadata(headerRef(path, (await readJsonl(path, 1))[0]));
  } catch (error) {
    throw new Error(`无法读取 DSH 会话 ${path}：${errorMessage(error)}`, { cause: error });
  }
}

/** Directory scans retain bad current generations so one damaged sibling cannot blind the store. */
export async function discoverDshRef(path: string): Promise<SessionRef> {
  try {
    return await refFromDshFile(path);
  } catch (error) {
    return sessionMetadata({ agent: "dsh", id: basename(dirname(path)), path,
      source: { kind: "events", path, lossy: true, warning: errorMessage(error) } });
  }
}

export async function discoverDsh(root?: string): Promise<SessionRef[]> {
  const directory = expandHome(root ?? join(process.env.DSH_HOME || "~/.dsh", "sessions"));
  const files = selectDshGenerations(await walkFiles(directory, (path) => dshLogVersion(path) !== undefined));
  return mapConcurrent(files, 8, discoverDshRef);
}

export async function parseDsh(ref: SessionRef): Promise<ParsedSession> {
  const rows = iterateJsonl(ref.path);
  try {
    const first = await rows.next();
    if (first.done) throw new Error("空会话文件");
    const source = headerRef(ref.path, first.value);
    const diagnostics = new DshDiagnostics(record(first.value).version as number);
    const headerMeta = readDshHeaderMeta(first.value);
    async function* events(): AsyncGenerator<DshEvent> {
      let row = 1;
      for await (const value of rows) {
        const event = readDshEvent(value, ++row, diagnostics);
        if (event) yield event;
      }
    }
    return await projectDsh(source, events(), diagnostics, headerMeta);
  } catch (error) {
    throw new Error(`无法解析 DSH 会话 ${ref.path}：${errorMessage(error)}`, { cause: error });
  } finally {
    await rows.return(undefined);
  }
}

interface Question {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

interface PendingTool {
  entry: TimelineEntry;
  questions: { question: Question; entry: TimelineEntry }[];
  dispatch?: { rootCallId: unknown; parentCallId: unknown };
}

/** Only official transcript carriers are projected; opaque plugin events/meta are never stringified. */
async function projectDsh(ref: SessionRef, events: AsyncIterable<DshEvent>, report: DshDiagnostics,
  headerMeta: ReturnType<typeof readDshHeaderMeta>): Promise<ParsedSession> {
  const identity = dshIdentity(headerMeta);
  const entries: TimelineEntry[] = [];
  const usageLedger: UsageRecord[] = [];
  // Row (stable 1-based nonblank JSONL line number) of each ledger record:
  // the fork seed cut is positional, so ordering must survive records that
  // lack seq (legacy/damaged envelopes still get a row from the reader).
  const ledgerRow: number[] = [];
  let seedCutRow: number | undefined;
  const conversionNote = (): { rule: string; sourceFields: string[]; reference: string } => ({
    rule: "DSH TokenUsage 原样映射：inputTokens=未缓存输入，cacheRead/Write 独立桶，reasoning⊂output，totalTokens 仅原样保留；"
      + "缺 cache 字段保持 undefined（unknown），harness token-meter 折算时按 0 处理——两种口径差异在此声明，不改写来源",
    sourceFields: ["usage.inputTokens", "usage.cacheReadTokens", "usage.cacheWriteTokens", "usage.outputTokens", "usage.reasoningTokens", "usage.totalTokens"],
    reference: "rorepos/deepseek-harness @5badb15 packages/llm/token-meter/src/usage-projection.ts",
  });
  const pushUsage = (metrics: Record<string, number>, settlement: "committed" | "interrupted" | "attempt" | "stream-final",
    raw: DshEvent, identity: { turn?: number; step?: number; messageId?: string; provider?: string; model?: string },
    metering: string, rawUsage?: unknown): UsageRecord => {
    const usage: UsageRecord = {
      id: `u${usageLedger.length}`,
      timestamp: isoTime(raw.time),
      ...(identity.turn !== undefined || identity.step !== undefined
        ? { scope: { ...(identity.turn !== undefined ? { turn: identity.turn } : {}), ...(identity.step !== undefined ? { step: identity.step } : {}) } }
        : {}),
      cumulative: false,
      metrics,
      ...(identity.model !== undefined ? { model: identity.model } : {}),
      ...(identity.provider !== undefined || identity.model !== undefined
        ? { context: { ...(identity.provider !== undefined ? { provider: identity.provider } : {}), ...(identity.model !== undefined ? { model: identity.model } : {}) } }
        : {}),
      ...(identity.messageId !== undefined ? { responseId: identity.messageId } : {}),
      ...(rawUsage !== undefined ? { raw: { usage: rawUsage } } : {}),
      conversion: conversionNote(),
      provenance: {
        agent: "dsh",
        rawType: raw.type,
        ...(raw.seq !== undefined ? { seq: raw.seq } : {}),
        row: raw.row,
        ...(raw.time !== undefined ? { time: raw.time } : {}),
        metering: { source: metering, ...(settlement !== "committed" ? { note: settlementNote(settlement) } : {}) },
      },
    };
    usageLedger.push(usage);
    ledgerRow.push(raw.row);
    return usage;
  };
  // ---------------------------------------------------------------------------
  // Settlement meter mirroring the harness token-meter fold (usage-projection
  // @5badb15): every assistant/message and assistant/attempt settlement
  // contributes its usage sample to the same (turn,step) replacement slot — a
  // later settlement REPLACES the earlier sample's contribution (never adds),
  // and llm/retry-started closes the slot so the retried attempt accumulates.
  // Replaced observations stay in the ledger with counted=false, raw intact.
  // ---------------------------------------------------------------------------
  interface MeterSlot { turn: number; step: number; record: UsageRecord }
  let meterSlot: MeterSlot | undefined;
  const sameMetrics = (a: UsageRecord["metrics"], b: UsageRecord["metrics"]): boolean => {
    const left = a as Record<string, number | undefined>;
    const right = b as Record<string, number | undefined>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => left[key] === right[key]);
  };
  const settleUsage = (metrics: Record<string, number>, settlement: "committed" | "interrupted" | "attempt" | "stream-final",
    raw: DshEvent, identity: Parameters<typeof pushUsage>[3], metering: string, rawUsage?: unknown): UsageRecord => {
    const record = pushUsage(metrics, settlement, raw, identity, metering, rawUsage);
    if (identity.turn === undefined || identity.step === undefined) {
      // Without coordinates the upstream fold could not match a slot either;
      // the observation stands on its own and never replaces anything.
      record.provenance!.metering!.note = "事件缺 turn/step 坐标，不参与 (turn,step) 替换槽";
      return record;
    }
    const slot = meterSlot;
    if (slot && slot.turn === identity.turn && slot.step === identity.step) {
      if (sameMetrics(slot.record.metrics, record.metrics)) {
        // token-meter no-op: an identical re-observation leaves the fold unchanged.
        record.counted = false;
        record.provenance!.metering!.note = "同 (turn,step) 等值重复观测（token-meter no-op），不计入";
        return record;
      }
      slot.record.counted = false;
      slot.record.provenance!.metering!.note = "被同 (turn,step) 后续结算替换（token-meter last-wins）；保留原始观测，不计入";
      record.provenance!.metering!.note = settlementNote(settlement) + "；替换同槽先前观测（token-meter addReplacing）";
    }
    meterSlot = { turn: identity.turn, step: identity.step, record };
    return record;
  };
  const calls = new Map<string, PendingTool[]>();
  const callsBySeq = new Map<number, PendingTool[]>();
  const callsById = new Map<string, { seq: number; pending: PendingTool }[]>();
  const summaries = new Map<string, string>();
  const diagnostics = report.value;
  const warnings = new Set<string>();
  let title: string | undefined;
  let turn = 0;
  let step = 0;
  let activeCompaction: string | undefined;
  let updatedAt = ref.startedAt;
  let current: DshEvent | undefined;
  const push = (entry: Omit<TimelineEntry, "index">): TimelineEntry => {
    const value = { ...entry, index: entries.length };
    entries.push(value);
    return value;
  };
  const callKey = (id: string) => `${turn}:${step}:${id}`;

  function settlementNote(settlement: "committed" | "interrupted" | "attempt" | "stream-final"): string {
    if (settlement === "attempt") return "未成功尝试的流内 usage（非成功正文计量）";
    if (settlement === "interrupted") return "中断后提交的前缀";
    if (settlement === "stream-final") return "assistant/message 缺 data.usage，取流内最后 usage 采样";
    return "";
  }

  /** Effective (turn,step) coordinates for a settlement event, matching the message-scope rules. */
  function eventScope(data: Record<string, unknown>, raw: DshEvent): { turn?: number; step?: number } {
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
    return {
      turn: valid(data.turn) ? data.turn : turn === -raw.row ? undefined : turn,
      step: valid(data.step) ? data.step : step === -raw.row ? undefined : step,
    };
  }

  function startTool(id: string, name: string, args: unknown, timestamp: string | undefined, rawType: string): PendingTool {
    const entry = push({ role: "tool", kind: "tool", title: name, text: "", timestamp, rawType,
      tool: { callId: id, name, arguments: args, result: { type: "pending" } } });
    const questions = name === "ask_user_question" ? readQuestions(args) : [];
    if (name === "ask_user_question" && !questions.length) report.add("invalid-question", "提问参数不是已知问答布局，未推断题目", current);
    const pending: PendingTool = { entry, questions: questions.map((question) => ({ question,
      entry: push({ role: "assistant", kind: "question", text: questionText(question), timestamp,
        rawType: "ask_user_question.question", data: { questionId: question.id } }),
    })) };
    const key = callKey(id);
    const scoped = calls.get(key) ?? [];
    scoped.push(pending);
    calls.set(key, scoped);
    return pending;
  }

  function finishTool(pending: PendingTool, content: unknown, failed: boolean, code: unknown, timestamp: string | undefined): void {
    const log = visibleText(content);
    const cancelled = code === "ASK_CANCELLED" || code === "ASK_ABORTED" || code === "TOOL_ABORTED";
    pending.entry.tool!.result = { type: cancelled ? "rejected" : failed ? "failure" : "success", log };
    pending.entry.text = log;
    if (pending.questions.length === 0) return;
    if (failed || cancelled) {
      for (const { entry } of pending.questions) entry.text += cancelled ? "\n\n（提问已取消）" : "\n\n（未取得回答）";
      pending.questions = [];
      return;
    }
    const answers = readAnswers(content, pending.questions.map(({ question }) => question));
    if (!answers) {
      report.add("invalid-answer", "部分提问结果不符合官方问答格式，未推断回答", current);
      return;
    }
    for (const { question } of pending.questions) {
      const answer = answers.get(question.id)!;
      push({ role: "user", kind: "decision", text: `回答「${question.question}」：\n${answer}`, timestamp,
        rawType: "ask_user_question.answer", data: { questionId: question.id } });
    }
    pending.questions = [];
  }

  function independentResult(id: string, content: unknown, failed: boolean, timestamp: string | undefined, rawType: string): void {
    const log = visibleText(content);
    push({ role: "tool", kind: "tool", text: log, timestamp, rawType,
      tool: { callId: id, result: { type: failed ? "failure" : "success", log } } });
  }

  function indexCall(seq: number | undefined, id: string, pending: PendingTool): void {
    if (seq === undefined) return;
    const bucket = callsBySeq.get(seq) ?? [];
    if (!bucket.includes(pending)) bucket.push(pending);
    if (bucket.length > 1) report.add("duplicate-call-seq", "多个工具调用使用同一 seq，来源关联视为歧义", current);
    callsBySeq.set(seq, bucket);
    const byId = callsById.get(id) ?? [];
    byId.push({ seq, pending });
    callsById.set(id, byId);
  }

  function visibleText(content: unknown): string {
    if (!Array.isArray(content)) {
      report.add("invalid-content", "消息 content 不是内容块数组，未推断正文", current);
      return "";
    }
    return content.map((value) => {
      const block = record(value);
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image" || block.type === "file") {
        warnings.add("图片和文件附件仅显示占位符，未嵌入附件内容");
        const name = record(block.attachment).name;
        return block.type === "image" ? "[图片]" : `[附件：${typeof name === "string" ? name : "文件"}]`;
      }
      if (block.type !== "reasoning" && block.type !== "tool-call" && block.type !== "tool-result") {
        report.add("unknown-content", `未解释内容块 ${typeof block.type === "string" ? block.type : "<invalid>"}，未推断正文`, current);
      } else if (block.type === "reasoning" && typeof block.text !== "string") {
        report.add("invalid-content", "reasoning 内容缺少 text", current);
      }
      return "";
    }).join("");
  }

  for await (const raw of events) {
    current = raw;
    const data = raw.data;
    const timestamp = isoTime(raw.time);
    if (timestamp) updatedAt = timestamp;
    if (raw.type === "turn/start" || raw.type === "step/start") {
      const coordinate = raw.type === "turn/start" ? data.turn : data.step;
      if (typeof coordinate !== "number" || !Number.isSafeInteger(coordinate) || coordinate < 1) {
        report.add("invalid-boundary", "轮/步骤边界缺少有效坐标，已清除工具匹配范围", raw);
        turn = -raw.row; step = 0;
      } else if (raw.type === "turn/start") { turn = coordinate; step = 0; }
      else step = coordinate;
    } else if (raw.type === "session/title") {
      if (typeof data.title === "string") title = data.title;
      else report.add("invalid-title", "会话标题缺少 title", raw);
    } else if (raw.type === "tool/call" || raw.type === "tool/ptc-dispatch-start" || raw.type === "tool/ptc-dispatch") {
      const id = raw.type === "tool/call" ? data.callId : data.subCallId;
      if (typeof id !== "string" || !id || typeof data.name !== "string" || !data.name) {
        report.add("invalid-tool", "工具调用缺少调用标识或名称，已省略", raw);
        diagnostics.ignored++; continue;
      }
      if (raw.type === "tool/call") {
        indexCall(raw.seq, id, startTool(id, data.name, parseJson(data.arguments), timestamp, raw.type));
      } else {
        if ((data.rootCallId !== undefined && typeof data.rootCallId !== "string")
          || (data.parentCallId !== undefined && typeof data.parentCallId !== "string")
          || (raw.type === "tool/ptc-dispatch" && typeof data.isError !== "boolean")) {
          report.add("invalid-dispatch", "PTC 调用身份或结果状态不是已知布局，未推断问答", raw);
          diagnostics.ignored++; continue;
        }
        const scoped = calls.get(callKey(id)) ?? [];
        let pending: PendingTool;
        if (raw.type === "tool/ptc-dispatch-start" || !scoped.length) {
          pending = startTool(id, data.name, data.arguments, timestamp, raw.type);
          pending.dispatch = { rootCallId: data.rootCallId, parentCallId: data.parentCallId };
        } else {
          const candidate = scoped.length === 1 ? scoped[0] : undefined;
          if (!candidate?.dispatch || candidate.entry.tool?.name !== data.name
            || !sameJson(candidate.entry.tool.arguments, data.arguments)
            || candidate.dispatch.rootCallId !== data.rootCallId || candidate.dispatch.parentCallId !== data.parentCallId
            || candidate.entry.tool.result?.type !== "pending") {
            report.add("ambiguous-dispatch", "PTC 完成记录与开始调用的身份/参数不一致或存在歧义，保留独立结果", raw);
            independentResult(id, data.content, data.isError === true, timestamp, raw.type);
            diagnostics.handled++; continue;
          }
          pending = candidate;
        }
        indexCall(raw.seq, id, pending);
        if (raw.type === "tool/ptc-dispatch") finishTool(pending, data.content, data.isError === true, undefined, timestamp);
      }
    } else if (raw.type === "compaction/start") {
      activeCompaction = typeof data.compactionId === "string" ? data.compactionId : `legacy-compaction:${ref.id}:${raw.seq ?? raw.row}`;
    } else if (raw.type === "compaction/summary") {
      const id = typeof data.compactionId === "string" ? data.compactionId : activeCompaction;
      if (id) summaries.set(id, visibleText(data.summary));
      else report.add("invalid-compaction", "压缩摘要缺少可匹配的 compactionId", raw);
    } else if (raw.type === "compaction/end" || raw.type === "session/end-seed") {
      // A tagged marker is the fork-inherited seed cut; the last one wins.
      // The cut anchors on the marker's ROW (a stable nonblank JSONL line
      // number assigned by the reader), so a marker that itself lacks seq
      // still defines the cut, and seq-less usage records remain orderable
      // against it — a missing seq stays a diagnostic (invalid-envelope),
      // never a reason to leak parent-lineage usage into the child's totals.
      if (raw.type === "session/end-seed" && data.inherited === true) {
        seedCutRow = seedCutRow === undefined ? raw.row : Math.max(seedCutRow, raw.row);
      }
      activeCompaction = undefined;
    } else if (raw.type === "llm/retry-started") {
      // token-meter: a retry whose (turn,step) matches the open replacement
      // slot closes it, so the retried attempt's settlement ACCUMULATES
      // instead of replacing the failed attempt's contribution.
      const scope = eventScope(data, raw);
      if (meterSlot && scope.turn === meterSlot.turn && scope.step === meterSlot.step) {
        meterSlot = undefined;
      }
      diagnostics.ignored++;
      continue;
    } else if (raw.type === "assistant/attempt") {
      // An unsettled attempt never becomes successful body text. Its last
      // observed usage chunk settles through the same (turn,step) slot as the
      // committed message — distinguishable from, never double-summed with,
      // the final settlement (token-meter addReplacing semantics).
      const metrics = observeDshStreamUsage(data.stream);
      if (Object.keys(metrics).length) {
        const scope = eventScope(data, raw);
        settleUsage(metrics, "attempt", raw, scope,
          "DSH assistant/attempt 流内最后观测到的 usage（未成功尝试，非成功正文计量）", lastStreamUsageRaw(data.stream));
      }
      diagnostics.ignored++;
      continue;
    } else if (raw.type === "request/context") {
      // Route metadata sample: context-window facts only, never token metrics.
      const provider = typeof data.provider === "string" ? data.provider : undefined;
      const model = typeof data.model === "string" ? data.model : undefined;
      const contextWindow = typeof data.contextWindow === "number" && Number.isSafeInteger(data.contextWindow) && data.contextWindow >= 0
        ? data.contextWindow : undefined;
      if (provider !== undefined || model !== undefined || contextWindow !== undefined) {
        usageLedger.push({
          id: `u${usageLedger.length}`,
          timestamp: isoTime(raw.time),
          cumulative: false,
          metrics: {},
          context: { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}) },
          provenance: { agent: "dsh", rawType: raw.type, ...(raw.seq !== undefined ? { seq: raw.seq } : {}),
            row: raw.row, ...(raw.time !== undefined ? { time: raw.time } : {}),
            metering: { source: "DSH request/context 路由元数据（无 token 计量）" } },
        });
        ledgerRow.push(raw.row);
      }
      diagnostics.ignored++;
      continue;
    } else if (raw.type === "user/message" || raw.type === "assistant/message" || raw.type === "tool/result") {
      const message = eventMessage(raw);
      const source = record(message.source);
      if (raw.surfaceOp !== "append") {
        const operation = record(raw.surfaceOp);
        const start = operation.startSeq ?? operation.start;
        const end = operation.endSeq ?? operation.end;
        const replacement = operation.op === "replace" && typeof start === "number" && typeof end === "number"
          && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= 0;
        // Replacement endpoints follow model-surface order, not numeric seq order.
        if (!replacement) report.add("unknown-surface", "消息缺少已知的 append/replace 标记，未推断对话", raw);
        else if (raw.type === "user/message" && (source.kind === "compact-checkpoint" || (source.kind === "plugin" && source.plugin === "compact"))) {
          const id = typeof source.compactionId === "string" ? source.compactionId : activeCompaction;
          push({ role: "event", kind: "compaction", text: (id ? summaries.get(id) : undefined) || "对话已压缩", timestamp, rawType: raw.type });
        }
        diagnostics.ignored++; continue;
      }
      const expectedRole = raw.type === "user/message" ? "user" : raw.type === "assistant/message" ? "assistant" : undefined;
      if (expectedRole && message.role !== undefined && message.role !== expectedRole) {
        report.add("invalid-message", "消息 role 与事件类型不符，未推断正文", raw);
        diagnostics.ignored++; continue;
      }
      if (raw.type === "user/message") {
        if (source.kind !== "user") {
          // Every named non-user producer is intentionally model-only; its
          // private vocabulary need not be upgraded to preserve human dialogue.
          if (typeof source.kind !== "string" || !source.kind) report.add("unknown-source", "用户消息缺少 source.kind，未推断人类作者", raw);
          diagnostics.ignored++; continue;
        }
        const text = visibleText(message.content);
        const native = nativeContentBlocks(message.content, raw);
        if (text.trim()) push({ role: "user", kind: "message", text, timestamp, rawType: raw.type,
          data: { seq: raw.seq, row: raw.row, ...(raw.time !== undefined ? { time: raw.time } : {}),
            ...(native !== undefined ? { native } : {}) } });
      } else if (raw.type === "assistant/message") {
        const content = Array.isArray(message.content) ? message.content : [];
        const reasoning = content.map(record).filter(block => block.type === "reasoning" && typeof block.text === "string").map(block => block.text).join("");
        if (reasoning.trim()) push({ role: "reasoning", kind: "reasoning", text: reasoning, timestamp, rawType: raw.type });
        const text = visibleText(message.content);
        // Usage follows upstream usageOf(): the committed message's data.usage
        // when present, otherwise the LAST usage sample embedded in its stream
        // (missing usage on earlier rows never blocks a later valid sample).
        // Every settlement flows through the (turn,step) replacement slot.
        const metrics = data.usage !== undefined ? readDshUsageMetrics(data.usage) : observeDshStreamUsage(data.stream);
        const rawUsage = data.usage !== undefined ? data.usage : lastStreamUsageRaw(data.stream);
        const assistantSource = record(message.source);
        const modelSource = assistantSource.kind === "model"
          ? { provider: typeof assistantSource.provider === "string" ? assistantSource.provider : undefined,
              model: typeof assistantSource.model === "string" ? assistantSource.model : undefined }
          : {};
        const scope = eventScope(data, raw);
        const messageId = typeof message.id === "string" && message.id ? message.id : undefined;
        const usage = Object.keys(metrics).length
          ? settleUsage(metrics, data.interrupted === true ? "interrupted" : (data.usage !== undefined ? "committed" : "stream-final"), raw,
              { ...scope, messageId, ...modelSource },
              data.interrupted === true
                ? "DSH assistant/message usage（中断后提交的前缀，TokenUsage 单步增量）"
                : data.usage !== undefined
                  ? "DSH assistant/message usage（TokenUsage 单步增量）"
                  : "DSH assistant/message 缺 data.usage，采用流内最后 usage 采样（upstream usageOf 回退）",
              rawUsage)
          : undefined;
        const native = nativeContentBlocks(message.content, raw);
        if (text.trim()) push({ role: "assistant", kind: "message", text, timestamp, rawType: raw.type,
          data: { seq: raw.seq, row: raw.row, ...(raw.time !== undefined ? { time: raw.time } : {}),
            ...(scope.turn !== undefined || scope.step !== undefined
              ? { ...(scope.turn !== undefined ? { turn: scope.turn } : {}), ...(scope.step !== undefined ? { step: scope.step } : {}) } : {}),
            ...(Object.keys(modelSource).length ? { source: { kind: "model", ...modelSource } } : {}),
            ...(usage ? { usage } : {}), ...(native !== undefined ? { native } : {}) } });
      } else {
        const result = toolResult(message);
        if (!result) {
          report.add("invalid-tool-result", "工具结果不是已知布局，未推断调用关系", raw);
          diagnostics.ignored++; continue;
        }
        if (data.error !== undefined && !result.isError) {
          report.add("invalid-tool-status", "工具结果的错误字段与成功标记矛盾，未推断问答", raw);
          independentResult(result.callId, result.content, result.isError, timestamp, raw.type);
          diagnostics.handled++; continue;
        }
        // Stored provenance may cite individual seqs or inclusive legacy ranges.
        // Match existing calls without expanding arbitrarily large ranges.
        const explicit = raw.sourceEventSeqs !== undefined;
        const sources = provenance(raw.sourceEventSeqs);
        if (explicit && !sources) report.add("invalid-provenance", "工具结果的明确来源不是有效 seq/范围数组，未推断调用关系", raw);
        const linked = new Set<PendingTool>();
        let collision = false;
        for (const source of sources ?? []) {
          const range = Array.isArray(source) ? source : [source, source];
          for (const { seq, pending } of callsById.get(result.callId) ?? []) {
            if (range[0] <= seq && seq <= range[1]) {
              if ((callsBySeq.get(seq)?.length ?? 0) > 1) collision = true;
              linked.add(pending);
            }
          }
        }
        const candidates = explicit ? [...linked] : calls.get(callKey(result.callId)) ?? [];
        const candidate = !collision && candidates.length === 1 ? candidates[0] : undefined;
        const pending = candidate?.entry.tool?.result?.type === "pending" ? candidate : undefined;
        if (collision || candidates.length > 1) report.add("ambiguous-tool-result", "工具结果关联到多个调用，保留独立结果", raw);
        else if (candidate && !pending) report.add("duplicate-tool-result", "已结束的工具调用又收到结果，保留独立结果", raw);
        else if (explicit && sources && !pending) report.add("unmatched-tool-result", "工具结果的明确来源未匹配到调用，保留独立结果", raw);
        if (pending) finishTool(pending, result.content, result.isError, record(data.error).code, timestamp);
        else independentResult(result.callId, result.content, result.isError, timestamp, raw.type);
      }
    } else {
      if (DSH_LOG_ONLY_TYPES.has(raw.type)) diagnostics.ignored++;
      else report.unknown(raw);
      continue;
    }
    diagnostics.handled++;
  }
  for (const scoped of calls.values()) {
    for (const pending of scoped) {
      for (const { entry } of pending.questions) entry.text += "\n\n（未记录可匹配的回答）";
    }
  }
  // Fork-inherited seed history: usage recorded before the LAST tagged
  // session/end-seed marker belongs to the parent lineage, not this thread's
  // own consumption. Only header.isSeeded and the tagged markers are trusted
  // signals; the records stay in the ledger flagged inherited/counted=false.
  // The comparison is positional (record row < marker row) so envelopes
  // missing seq are still classified, never silently counted as the child's.
  if (seedCutRow !== undefined) {
    usageLedger.forEach((usage, index) => {
      const row = ledgerRow[index];
      if (row !== undefined && row < seedCutRow) {
        usage.inherited = true;
        usage.counted = false;
        if (usage.provenance?.metering) {
          usage.provenance.metering.note = "fork 继承 seed 历史（最后一个 session/end-seed 标记之前），非本线程消耗，勿重复累计";
        }
      }
    });
  } else if (headerMeta.isSeeded) {
    // A seeded header without any end-seed marker gives no cut: parent-lineage
    // usage cannot be separated from this thread's, so NOTHING may be summed —
    // every record stays unattributed (counted=false) rather than guessing.
    report.add("seeded-fork-no-marker",
      "header.isSeeded 为 true 但全文缺少 session/end-seed 标记，无法界定继承切点；为避免把父线程用量累计为本线程消耗，全部 usage 记录不计入");
    usageLedger.forEach((usage) => {
      usage.counted = false;
      if (usage.provenance?.metering) {
        usage.provenance.metering.note = "seed 会话缺少 end-seed 标记，无法区分父线程与本线程消耗，不计入任何统计";
      }
    });
  }
  const notices = [...warnings];
  const diagnosticWarning = report.finish();
  if (diagnosticWarning) warnings.add(diagnosticWarning);
  const result: ParsedSession = { ...ref, title, updatedAt,
    source: { kind: "events", path: ref.path, lossy: warnings.size > 0, warning: warnings.size ? [...warnings].join("；") : undefined, ...(notices.length ? { notices } : {}) },
    entries, diagnostics, identity };
  // Native document: single-pass usage ledger + session-graph identity from
  // the v4 header (origin/parentSession+isSeeded→forkOf/delegationDepth/agentPreset).
  // Committed messages carry data.native — normalized.ts lifts it onto
  // block.native and strips it from the searchable entries projection, and
  // blockType classifies result-only tool carriers as tool-result blocks.
  return { ...result, document: documentFromParsed(result, { identity, usage: usageLedger }) };
}

// ---------------------------------------------------------------------------
// Native content preservation. Only VISIBLE COMMITTED messages project their
// source content blocks, onto document.block.native — deliberately outside
// entry.data so nothing here can leak into search text. Binary payloads are
// never copied; attachments keep filename/source-pointer metadata with an
// explicit omission note (lossy, not "full fidelity"). Unknown blocks keep
// bounded scalar metadata only. Non-user injections, failed-attempt bodies
// and unknown plugin events never get native blocks at all.
// ---------------------------------------------------------------------------

const NATIVE_ATTACHMENT_OMITTED = "附件内容（base64/二进制）未随转录复制；仅保留文件名/来源指针等元数据，明确为有损保留";
const NATIVE_UNKNOWN_NOTE = "未知内容块：仅保留字段名列表，不保留字段值（可能是未知插件的私有 payload），明确为有损保留";
const NATIVE_BINARY_KEYS = new Set(["data", "base64", "bytes", "body", "buffer", "content", "blob", "stream", "text"]);
const NATIVE_TEXT_LIMIT = 512;

function nativeScalar(key: string, value: unknown): unknown | undefined {
  if (NATIVE_BINARY_KEYS.has(key)) return undefined;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return value.length > NATIVE_TEXT_LIMIT ? `${value.slice(0, NATIVE_TEXT_LIMIT)}…` : value;
  return undefined;
}

function nativeScalars(source: Record<string, unknown>, limit = 16): Record<string, unknown> | undefined {
  const scalars: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const value = nativeScalar(key, source[key]);
    if (value !== undefined) scalars[key] = value;
    if (Object.keys(scalars).length >= limit) break;
  }
  return Object.keys(scalars).length ? scalars : undefined;
}

function attachmentFacts(attachment: Record<string, unknown>): Record<string, unknown> {
  const facts = nativeScalars(attachment);
  return { ...(facts ?? {}), omitted: NATIVE_ATTACHMENT_OMITTED };
}

/** Sanitized native projection of one committed message's content blocks, with per-block seq/row provenance. */
function nativeContentBlocks(content: unknown, raw: DshEvent): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks = content.map((value) => {
    const block = record(value);
    const base = { seq: raw.seq, row: raw.row, ...(raw.time !== undefined ? { time: raw.time } : {}) };
    const type = typeof block.type === "string" ? block.type : "<invalid>";
    if ((type === "text" || type === "reasoning") && typeof block.text === "string") {
      return { type, ...base, text: block.text };
    }
    if (type === "image" || type === "file") {
      return { type, ...base, attachment: attachmentFacts(record(block.attachment)) };
    }
    if (type === "tool-call" || type === "tool-result") {
      const identifiers = nativeScalars({
        callId: block.callId, toolCallId: block.toolCallId, name: block.name, id: block.id, isError: block.isError,
      });
      return { type, ...base, ...(identifiers ?? {}) };
    }
    // Unknown block types keep key names only: values could be a private
    // plugin payload, so nothing beyond the field inventory is preserved.
    return { type, ...base, note: NATIVE_UNKNOWN_NOTE, keys: Object.keys(block).sort() };
  });
  return blocks;
}

/** v4 tool results are first-class tool-role messages; released v3 wrapped one tool-result block in a user-role message. */
function toolResult(message: unknown): { callId: string; content: unknown; isError: boolean } | undefined {
  const row = record(message);
  if (row.role === "tool") {
    return typeof row.toolCallId === "string" && row.toolCallId && typeof row.isError === "boolean"
      ? { callId: row.toolCallId, content: row.content, isError: row.isError } : undefined;
  }
  if (row.role === undefined && typeof row.callId === "string" && row.callId && Object.hasOwn(row, "content") && typeof row.isError === "boolean") {
    return { callId: row.callId, content: row.content, isError: row.isError };
  }
  if (row.role !== undefined && row.role !== "user") return undefined;
  const wrapper = record(Array.isArray(row.content) && row.content.length === 1 ? row.content[0] : undefined);
  if (wrapper.type !== "tool-result" || typeof wrapper.toolCallId !== "string" || !wrapper.toolCallId || typeof wrapper.isError !== "boolean") return undefined;
  return { callId: wrapper.toolCallId, content: wrapper.content, isError: wrapper.isError === true };
}

function provenance(value: unknown): (number | [number, number])[] | undefined {
  const seq = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!Array.isArray(value) || !value.length || !value.every(source => seq(source)
    || (Array.isArray(source) && source.length === 2 && seq(source[0]) && seq(source[1]) && source[0] <= source[1]))) return undefined;
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  const work: [unknown, unknown][] = [[a, b]];
  while (work.length) {
    const [left, right] = work.pop()!;
    if (left === right) continue;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let i = 0; i < left.length; i++) work.push([left[i], right[i]]);
    } else {
      if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
      const x = record(left), y = record(right), keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(y, key)) return false;
        work.push([x[key], y[key]]);
      }
    }
  }
  return true;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function readQuestions(args: unknown): Question[] {
  const values = record(args).questions;
  if (!Array.isArray(values) || values.length === 0) return [];
  const questions: Question[] = [];
  for (const value of values) {
    const q = record(value);
    if (typeof q.id !== "string" || typeof q.question !== "string" || questions.some((other) => other.id === q.id)) return [];
    if ((q.options !== undefined && !Array.isArray(q.options))
      || (q.multi_select !== undefined && typeof q.multi_select !== "boolean")
      || (q.header !== undefined && typeof q.header !== "string")) return [];
    const options: Question["options"] = [];
    for (const value of (q.options ?? []) as unknown[]) {
      const option = record(value);
      if (typeof option.label !== "string" || (option.description !== undefined && typeof option.description !== "string")) return [];
      options.push({ label: option.label, description: option.description as string | undefined });
    }
    questions.push({ id: q.id, question: q.question, header: typeof q.header === "string" ? q.header : undefined,
      options, multiSelect: q.multi_select === true });
  }
  return questions;
}

function questionText(q: Question): string {
  const mode = q.options.length ? q.multiSelect ? "（多选）" : "（单选）" : "";
  return `${q.header ? `${q.header}\n` : ""}${q.question}${mode}`
    + q.options.map((option, index) => `\n${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("");
}

/** Match the official settled-question card: one text result, unique IDs, complete one-to-one pairing. */
function readAnswers(content: unknown, questions: Question[]): Map<string, string> | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = record(content[0]);
  if (block.type !== "text" || typeof block.text !== "string") return undefined;
  const values = record(parseJson(block.text)).answers;
  if (!Array.isArray(values) || values.length !== questions.length) return undefined;
  const answers = new Map<string, string>();
  for (const value of values) {
    const answer = record(value);
    if (typeof answer.id !== "string" || answers.has(answer.id) || !questions.some((q) => q.id === answer.id)
      || !Array.isArray(answer.selected) || !answer.selected.every((item) => typeof item === "string")
      || (answer.custom !== undefined && typeof answer.custom !== "string")) return undefined;
    const parts = [...answer.selected, ...(typeof answer.custom === "string" && answer.custom.trim() ? [answer.custom] : [])];
    answers.set(answer.id, parts.length ? parts.join("\n") : "（未选择）");
  }
  return answers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
