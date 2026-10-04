import type { ParseDiagnostics, ParseIssue, SessionRef } from "../types.js";

/** Read-only JSONL envelopes, not a DSH runtime restore or migration target. */
export interface DshEvent {
  type: string;
  seq?: number;
  time?: number;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
  sourceEventSeqs?: unknown;
  row: number;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isoTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Bounded, payload-free diagnostic samples; repeated defects only increment a count. */
export class DshDiagnostics {
  readonly value: ParseDiagnostics;
  private readonly issues = new Map<string, ParseIssue>();
  private readonly unknownTypes = new Set<string>();
  private expectedSeq = 0;
  private overflow = 0;

  constructor(version: number) {
    this.value = { handled: 0, ignored: 0, unknown: 0, unknownTypes: [], formatVersion: version, issues: [] };
    if (version > 4) this.add("future-version", `存档 v${version} 按已知 JSONL 消息布局读取，未验证该版本的全部语义`);
  }

  add(code: string, message: string, event?: Pick<DshEvent, "type" | "seq" | "row">): void {
    const type = event ? diagnosticName(event.type) : undefined;
    const key = `${code}:${type ?? ""}`;
    const previous = this.issues.get(key);
    if (previous) { previous.count++; return; }
    if (this.issues.size >= 50) { this.overflow++; return; }
    this.issues.set(key, { code, message: message.slice(0, 1024), type, row: event?.row, seq: event?.seq, count: 1 });
  }

  unknown(event: DshEvent): void {
    this.value.unknown++;
    const type = diagnosticName(event.type);
    if (this.unknownTypes.size < 128) this.unknownTypes.add(type);
    else if (!this.unknownTypes.has(type)) this.value.unknownTypesTruncated = true;
    this.add("unknown-event", `未解释事件 ${type}，其内容未进入转录`, event);
  }

  observeSequence(seq: number | undefined, width: number, event: DshEvent): void {
    if (seq === undefined) return;
    if (seq !== this.expectedSeq) this.add("sequence-gap", `事件序号不连续：预期 ${this.expectedSeq}，实际 ${seq}；未丢弃后续消息`, event);
    this.expectedSeq = seq + width;
  }

  finish(): string | undefined {
    this.value.unknownTypes = [...this.unknownTypes].sort();
    this.value.issues = [...this.issues.values()];
    if (this.overflow) this.value.issues.push({ code: "diagnostic-limit", message: "更多诊断已省略", count: this.overflow });
    return this.value.issues.map(issue => `${issue.message}${issue.row ? `（记录 ${issue.row}${issue.seq === undefined ? "" : `，seq ${issue.seq}`}）` : ""}${issue.count > 1 ? ` [${issue.count} 次]` : ""}`).join("；") || undefined;
  }
}

function diagnosticName(value: string): string {
  const escaped = value.slice(0, 160).replace(/[\x00-\x1f\x7f]/g, char => JSON.stringify(char).slice(1, -1));
  return value.length > 160 || escaped.length > 160 ? `${escaped.slice(0, 159)}…` : escaped;
}

export function readDshHeader(path: string, value: unknown, namedVersion?: number): SessionRef {
  const header = record(value);
  if (header.type !== "session" || !Number.isSafeInteger(header.version) || (header.version as number) < 0
    || typeof header.id !== "string" || !header.id) throw new Error("无效的 DSH session 文件头（需要 version 与 id）");
  const startedAt = isoTime(header.createdAt);
  if (!startedAt) throw new Error("无效的 DSH session.createdAt");
  if (namedVersion !== undefined && namedVersion !== header.version) {
    throw new Error(`DSH 文件名版本 v${namedVersion} 与文件头 v${header.version} 不符`);
  }
  return { agent: "dsh", id: header.id, path, cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    startedAt, source: { kind: "events", path, lossy: false } };
}

/**
 * v0/v1 packed runs contain assistant stream chunks, not committed messages.
 * Preserve final message rows once; never reconstruct text from attempts/chunks.
 * v2+ retains the same ordinary {type,seq,time,data} envelope. Extra fields and
 * unrelated payload subformats (e.g. descriptors) do not gate transcript reads.
 */
export function readDshEvent(value: unknown, row: number, diagnostics: DshDiagnostics): DshEvent | undefined {
  const raw = record(value);
  const type = typeof raw.type === "string" ? raw.type : "<invalid-row>";
  const event: DshEvent = { type, row, data: record(raw.data),
    seq: typeof raw.seq === "number" && Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : undefined,
    time: typeof raw.time === "number" ? raw.time : undefined,
    surfaceOp: raw.surfaceOp, sourceEventSeqs: raw.sourceEventSeqs };
  if (type === "parse_error" || type === "<invalid-row>" || !type) {
    diagnostics.value.ignored++;
    diagnostics.add("invalid-row", "非 JSON 对象事件或损坏的 JSON 记录已省略", event);
    return undefined;
  }
  // These packed carriers never carry committed transcript text.
  if (type === "text-chunks" || type === "reasoning-chunks" || type === "tool-call-chunks") {
    const fragments = type === "tool-call-chunks" ? event.data.args : event.data.texts;
    const dt = event.data.dt;
    const seq = typeof raw.seq0 === "number" && Number.isSafeInteger(raw.seq0) && raw.seq0 >= 0 ? raw.seq0 : undefined;
    if (seq === undefined || !isoTime(raw.time0) || !Array.isArray(fragments) || !fragments.length
      || !fragments.every(value => typeof value === "string") || !Array.isArray(dt) || dt.length !== fragments.length - 1
      || !dt.every(value => typeof value === "number" && Number.isSafeInteger(value))) {
      diagnostics.add("invalid-packed-row", "旧版流片段布局不完整，未推断正文", event);
    }
    if (Array.isArray(fragments) && fragments.length) diagnostics.observeSequence(seq, fragments.length, event);
    diagnostics.value.ignored++;
    return undefined;
  }
  if (event.seq === undefined || !isoTime(event.time)) diagnostics.add("invalid-envelope", `事件 ${diagnosticName(type)} 的 seq/time 不完整，保留可识别的消息内容`, event);
  diagnostics.observeSequence(event.seq, 1, event);
  if (type === "assistant/chunk") { diagnostics.value.ignored++; return undefined; }
  if (type === "steering/message") {
    event.type = "user/message";
    if (Object.hasOwn(event.data, "message")) event.data = record(event.data.message);
  } else if (type.startsWith("compact/") && ["start", "summary", "end", "prune"].includes(type.slice(8))) {
    event.type = `compaction/${type.slice(8)}`;
  } else if (type === "tool/code-dispatch" || type === "tool/code-dispatch-start") {
    event.type = type.replace("code-dispatch", "ptc-dispatch");
  }
  return event;
}

/** Legacy committed carriers, kept local to the transcript reader, without coordinate migration. */
export function eventMessage(event: DshEvent): Record<string, unknown> {
  const data = event.data;
  if (event.type === "user/message") return data;
  if (Object.hasOwn(data, "message")) return record(data.message);
  // v0/v1 stored assistant content and tool results directly in data.
  return data;
}

/** Names whose payloads have no direct transcript carrier. Payload versions are deliberately opaque. */
export const DSH_LOG_ONLY_TYPES = new Set([
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided", "approval/policy",
  "assistant/attempt", "command/done", "command/run", "compaction/end", "compaction/prune", "compaction/start",
  "deliverables/presented", "feedback/message-delete", "feedback/message-put", "feedback/record", "goal/change",
  "hook/invoked", "hook/result", "llm/retry", "llm/retry-started", "model/selection", "permission/preset",
  "plan/mode", "request/context", "request/header", "sandbox/mode", "schedule/change",
  "session-log-deepseek/delivery-accepted", "session/end-seed", "session/title-llm-request",
  "subagent/catalog", "subagent/descriptor", "subagent/model-selection-policy", "system/message", "developer/message",
  "team/member", "team/message/delivered", "team/message/queued", "team/task", "todo/write",
  "tool-workflow/agent-end", "tool-workflow/agent-start", "tool-workflow/run-end", "tool-workflow/run-start",
  "turn/end", "step/end", "web/deepseek-search-llm-request", "workspace/changes",
]);
