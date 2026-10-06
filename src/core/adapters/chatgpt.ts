import { homedir } from "node:os";
import { basename, join } from "node:path";
import { decode } from "turbo-stream";
import type { ParseDiagnostics, ParsedSession, SessionRef, TimelineEntry } from "../types.js";
import { contentToText } from "../text.js";
import { expandHome, readJson, walkFiles } from "../fs.js";
import { documentFromParsed } from "../normalized.js";

const SNAPSHOT_FORMAT = "asmgr.chatgpt-share";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_SUFFIX = ".chatgpt-share.json";
const MAX_SHARE_HTML_BYTES = 50 * 1024 * 1024;
const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);
const SHARE_LINK_EXAMPLE = "https://chatgpt.com/share/<会话ID>";

export interface ChatGptShareSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  capturedAt: string;
  requestedUrl: string;
  sourceUrl: string;
  data: Record<string, unknown>;
}

interface ChatGptToolResult {
  position: number;
  name?: string;
  text: string;
  redacted: boolean;
  nodeId?: string;
  messageId?: string;
}

interface ChatGptFidelity {
  redactedToolResults: number;
  unredactedToolResults: number;
  omittedContentParts: number;
  omittedContentKinds: string[];
}

export function chatGptRoot(root?: string): string {
  if (root) return expandHome(root);
  const env = process.env;
  const base = env.ASMGR_DATA_HOME
    ? expandHome(env.ASMGR_DATA_HOME)
    : env.XDG_DATA_HOME
      ? expandHome(env.XDG_DATA_HOME)
      : process.platform === "win32" && env.LOCALAPPDATA
        ? env.LOCALAPPDATA
        : process.platform === "darwin"
          ? join(homedir(), "Library", "Application Support")
          : join(homedir(), ".local", "share");
  return join(base, "asmgr", "imports", "chatgpt");
}

export function chatGptSnapshotPath(id: string, root?: string): string {
  return join(chatGptRoot(root), `${id}${SNAPSHOT_SUFFIX}`);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseChatGptShareUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`无效的 URL：${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("ChatGPT 分享链接必须使用 https");
  }
  if (!CHATGPT_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(
      `目前只支持 ChatGPT 的公开分享链接，格式应为 ${SHARE_LINK_EXAMPLE}`,
    );
  }
  if (isAddressBarConversationPath(url.pathname)) {
    throw new Error(
      "检测到这是从 ChatGPT 地址栏复制的私有会话链接，asmgr 无法直接读取。"
      + "请在 ChatGPT 中打开该会话，点击右上角“分享”，创建分享链接后，"
      + `再复制形如 ${SHARE_LINK_EXAMPLE} 的链接`,
    );
  }
  if (
    url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || !/^\/share\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)
  ) {
    throw new Error(
      `这不是 ChatGPT 分享链接。请打开目标会话，点击“分享”，再复制形如 ${SHARE_LINK_EXAMPLE} 的链接`,
    );
  }
  url.hash = "";
  return url;
}

export function chatGptConversationId(value: string): string {
  const url = parseChatGptShareUrl(value);
  return url.pathname.split("/").filter(Boolean)[1] ?? "";
}

export async function captureChatGptShare(
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatGptShareSnapshot> {
  const requested = parseChatGptShareUrl(value);
  const { response, finalUrl } = await fetchSharePage(requested, fetchImpl);
  if (!response.ok) {
    throw new Error(`获取 ChatGPT 分享页失败：HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error(`ChatGPT 分享页返回了异常的内容类型：${contentType || "未提供"}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_SHARE_HTML_BYTES) {
    throw new Error(`ChatGPT 分享页过大：${contentLength} 字节`);
  }

  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > MAX_SHARE_HTML_BYTES) {
    throw new Error(`ChatGPT 分享页超过大小限制：${MAX_SHARE_HTML_BYTES} 字节`);
  }
  const data = await decodeShareData(html);
  if (data.is_public === false) {
    throw new Error("该 ChatGPT 会话未公开，无法读取");
  }

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    requestedUrl: requested.toString(),
    sourceUrl: finalUrl.toString(),
    data,
  };
}

export async function readChatGptSnapshot(path: string): Promise<ChatGptShareSnapshot> {
  return validateSnapshot(await readJson(path), path);
}

export function isChatGptShareSnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  return snapshot?.format === SNAPSHOT_FORMAT;
}

export async function discoverChatGpt(root = chatGptRoot()): Promise<SessionRef[]> {
  const files = await walkFiles(expandHome(root), (path) => path.endsWith(SNAPSHOT_SUFFIX));
  const refs: SessionRef[] = [];
  for (const path of files) {
    refs.push(refFromSnapshot(path, await readChatGptSnapshot(path)));
  }
  return refs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function refFromChatGptFile(path: string): Promise<SessionRef> {
  return refFromSnapshot(path, await readChatGptSnapshot(path));
}

export function refFromChatGptUrl(value: string): SessionRef {
  const url = parseChatGptShareUrl(value);
  return {
    agent: "chatgpt",
    id: chatGptConversationId(url.toString()),
    path: url.toString(),
    source: {
      kind: "chatgpt-share",
      path: url.toString(),
      lossy: false,
      origin: url.toString(),
    },
  };
}

export async function parseChatGpt(ref: SessionRef): Promise<ParsedSession> {
  const snapshot = isHttpUrl(ref.path)
    ? await captureChatGptShare(ref.path)
    : await readChatGptSnapshot(ref.path);
  return parseChatGptSnapshot(ref, snapshot);
}

export function parseChatGptSnapshot(
  ref: SessionRef,
  snapshot: ChatGptShareSnapshot,
): ParsedSession {
  const data = snapshot.data;
  const rows = Array.isArray(data.linear_conversation) ? data.linear_conversation : [];
  if (rows.length === 0) {
    throw new Error("ChatGPT 分享数据中没有可读取的 linear_conversation 消息");
  }

  const entries: TimelineEntry[] = [];
  const diagnosticCounts = { handled: 0, ignored: 0, unknown: 0 };
  const unknownTypes = new Set<string>();
  const fidelity = inspectChatGptFidelity(data);
  const {
    redactedToolResults,
    unredactedToolResults,
    omittedContentParts,
    omittedContentKinds,
  } = fidelity;
  const {
    resultByCallPosition,
    callByResultPosition,
  } = matchChatGptToolResults(rows);
  const firstUserPosition = rows.findIndex((row) => {
    const message = asRecord(asRecord(row)?.message);
    return stringValue(asRecord(message?.author)?.role) === "user";
  });

  function push(entry: Omit<TimelineEntry, "index">): void {
    entries.push({ index: entries.length, ...entry });
  }

  for (let position = 0; position < rows.length; position += 1) {
    const node = asRecord(rows[position]);
    const message = asRecord(node?.message);
    if (!message) {
      diagnosticCounts.ignored += 1;
      continue;
    }

    const author = asRecord(message.author);
    const metadata = asRecord(message.metadata);
    const role = stringValue(author?.role) ?? "unknown";
    const authorName = stringValue(author?.name);
    const recipient = stringValue(message.recipient);
    const content = asRecord(message.content);
    const contentType = stringValue(content?.content_type) ?? "unknown";
    const text = messageText(message);
    const timestamp = isoTimestamp(message.create_time);
    const visuallyHidden = metadata?.is_visually_hidden_from_conversation === true;
    const rawType = `chatgpt/${role}/${contentType}${recipient ? `/${recipient}` : ""}`;
    const commonData = compactRecord({
      position,
      nodeId: stringValue(node?.id),
      parent: stringValue(node?.parent),
      children: Array.isArray(node?.children) ? node.children : undefined,
      messageId: stringValue(message.id),
      authorName,
      recipient,
      channel: stringValue(message.channel),
      contentType,
      model: stringValue(metadata?.model_slug ?? metadata?.resolved_model_slug),
      turnExchangeId: stringValue(metadata?.turn_exchange_id),
      citations: metadata?.citations,
      contentReferences: metadata?.content_references,
      searchResultGroups: metadata?.search_result_groups,
      visuallyHidden,
      // Native block facts: structured multimodal parts keep their type and
      // asset pointer; share payloads carry NO token usage — absent means
      // unknown, never zero, and no usage record is fabricated.
      ...(nativeParts(message) ?? {}),
    });

    if (role === "user") {
      if (!text.trim()) {
        diagnosticCounts.ignored += 1;
        continue;
      }
      diagnosticCounts.handled += 1;
      push({ role: "user", kind: "message", text, timestamp, rawType, data: commonData });
      continue;
    }

    if (role === "assistant") {
      if (contentType === "thoughts" || contentType === "reasoning_recap") {
        if (!text.trim()) {
          diagnosticCounts.ignored += 1;
          continue;
        }
        diagnosticCounts.handled += 1;
        push({ role: "reasoning", kind: contentType, text, timestamp, rawType, data: commonData });
        continue;
      }

      if (recipient && recipient !== "all") {
        const matchedResult = resultByCallPosition.get(position);
        const entryData = matchedResult
          ? compactRecord({
              ...commonData,
              toolResultPosition: matchedResult.position,
              toolResultNodeId: matchedResult.nodeId,
              toolResultMessageId: matchedResult.messageId,
            })
          : commonData;
        diagnosticCounts.handled += 1;
        push({
          role: "tool",
          kind: "tool",
          title: recipient,
          text: "",
          timestamp,
          rawType,
          data: entryData,
          tool: {
            callId: stringValue(message.id),
            name: recipient,
            arguments: parseToolArguments(text),
            intentionSummary: stringValue(metadata?.search_display_string),
            result: matchedResult ? normalizedToolResult(matchedResult) : { type: "pending" },
          },
        });
        continue;
      }

      if (contentType !== "text") {
        if (!text.trim()) {
          diagnosticCounts.ignored += 1;
          continue;
        }
        diagnosticCounts.handled += 1;
        push({ role: "system", kind: contentType, text, timestamp, rawType, data: commonData });
        continue;
      }

      if (visuallyHidden || !text.trim()) {
        diagnosticCounts.ignored += 1;
        continue;
      }
      diagnosticCounts.handled += 1;
      if (firstUserPosition >= 0 && position < firstUserPosition) {
        push({ role: "system", kind: "preamble", text, timestamp, rawType, data: commonData });
      } else {
        push({ role: "assistant", kind: "message", text, timestamp, rawType, data: commonData });
      }
      continue;
    }

    if (role === "tool") {
      const redacted = isRedactedToolResult(message);
      if (callByResultPosition.has(position)) {
        diagnosticCounts.handled += 1;
        continue;
      }
      if (!redacted && !text.trim()) {
        diagnosticCounts.ignored += 1;
        continue;
      }
      diagnosticCounts.handled += 1;
      push({
        role: "tool",
        kind: "tool_result",
        title: authorName ?? "tool result",
        text: redacted ? "" : text,
        timestamp,
        rawType,
        data: commonData,
        tool: {
          name: authorName ?? "tool result",
          result: redacted
            ? {
                type: "redacted",
                log: "ChatGPT 已在公开分享中隐藏该工具的原始输出。",
              }
            : { type: "success", log: text },
        },
      });
      continue;
    }

    if (role === "system") {
      if (!text.trim()) {
        diagnosticCounts.ignored += 1;
        continue;
      }
      diagnosticCounts.handled += 1;
      push({ role: "system", kind: contentType, text, timestamp, rawType, data: commonData });
      continue;
    }

    diagnosticCounts.unknown += 1;
    unknownTypes.add(rawType);
  }

  const sourceInfoEntries: Omit<TimelineEntry, "index">[] = [];
  if (redactedToolResults > 0) {
    sourceInfoEntries.push({
      role: "event",
      kind: "info",
      text: `${redactedToolResults} 条工具结果已被 ChatGPT 隐藏；仍可查看工具参数和派生引用。`,
      rawType: "chatgpt/redaction-summary",
      data: { redactedToolResults, unredactedToolResults },
    });
  }
  if (omittedContentParts > 0) {
    sourceInfoEntries.push({
      role: "event",
      kind: "info",
      text: `${omittedContentParts} 个图片或附件内容未随公开分享归档；报告仅保留占位符。`,
      rawType: "chatgpt/omitted-content-summary",
      data: { omittedContentParts, omittedContentKinds },
    });
  }
  if (sourceInfoEntries.length > 0) {
    entries.unshift(...sourceInfoEntries.map((entry, index) => ({ index, ...entry })));
    entries.forEach((entry, index) => {
      entry.index = index;
    });
  }

  const id = stringValue(data.conversation_id) || ref.id;
  const warning = chatGptFidelityWarning(fidelity);
  const diagnostics: ParseDiagnostics = {
    ...diagnosticCounts,
    unknownTypes: [...unknownTypes].sort(),
  };

  const result: ParsedSession = {
    ...ref,
    agent: "chatgpt",
    id,
    title: stringValue(data.title) ?? ref.title,
    startedAt: isoTimestamp(data.create_time) ?? ref.startedAt,
    updatedAt: isoTimestamp(data.update_time) ?? ref.updatedAt,
    source: {
      kind: "chatgpt-share",
      path: ref.path,
      lossy: Boolean(warning),
      warning,
      origin: snapshot.sourceUrl,
    },
    diagnostics,
    entries,
  };
  // Public share payloads expose no token metering: usage is unknown (empty
  // ledger), not zero; native blocks were preserved above without invention.
  return { ...result, document: documentFromParsed(result, { identity: { role: "main" }, usage: [] }) };
}

function refFromSnapshot(path: string, snapshot: ChatGptShareSnapshot): SessionRef {
  const data = snapshot.data;
  const fallbackId = basename(path).replace(new RegExp(`${escapeRegExp(SNAPSHOT_SUFFIX)}$`, "u"), "");
  const fidelity = inspectChatGptFidelity(data);
  const warning = chatGptFidelityWarning(fidelity);
  return {
    agent: "chatgpt",
    id: stringValue(data.conversation_id) || fallbackId,
    path,
    title: stringValue(data.title),
    startedAt: isoTimestamp(data.create_time),
    updatedAt: isoTimestamp(data.update_time),
    source: {
      kind: "chatgpt-share",
      path,
      lossy: Boolean(warning),
      warning,
      origin: snapshot.sourceUrl,
    },
  };
}

function validateSnapshot(value: unknown, path: string): ChatGptShareSnapshot {
  const snapshot = asRecord(value);
  if (snapshot?.format !== SNAPSHOT_FORMAT) {
    throw new Error(`不支持的 JSON 会话格式：${path}`);
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`不支持的 ChatGPT 快照版本：${String(snapshot.version)}`);
  }
  const data = asRecord(snapshot.data);
  if (!data || !Array.isArray(data.linear_conversation)) {
    throw new Error(`无效的 ChatGPT 分享快照：${path}`);
  }
  const capturedAt = stringValue(snapshot.capturedAt);
  const requestedUrl = stringValue(snapshot.requestedUrl);
  const sourceUrl = stringValue(snapshot.sourceUrl);
  if (!capturedAt || !requestedUrl || !sourceUrl) {
    throw new Error(`ChatGPT 分享快照元数据不完整：${path}`);
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    capturedAt,
    requestedUrl,
    sourceUrl,
    data,
  };
}

async function decodeShareData(html: string): Promise<Record<string, unknown>> {
  const chunks = extractEnqueuedChunks(html);
  if (chunks.length === 0) {
    throw new Error(
      "未找到 ChatGPT 分享数据；链接可能是私有会话、已失效，或页面格式已经变化",
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const decoded = await decode(stream);
  await decoded.done;
  const root = asRecord(decoded.value);
  const loaderData = asRecord(root?.loaderData);
  for (const route of Object.values(loaderData ?? {})) {
    const routeData = asRecord(asRecord(route)?.serverResponse)?.data;
    const candidate = asRecord(routeData);
    if (candidate && Array.isArray(candidate.linear_conversation)) return candidate;
  }
  throw new Error(
    "未找到 ChatGPT 分享数据；页面格式可能已经变化",
  );
}

function extractEnqueuedChunks(html: string): string[] {
  const chunks: string[] = [];
  const marker = "streamController.enqueue(";
  let offset = 0;
  while (offset < html.length) {
    const markerIndex = html.indexOf(marker, offset);
    if (markerIndex < 0) break;
    let start = markerIndex + marker.length;
    while (/\s/u.test(html[start] ?? "")) start += 1;
    if (html[start] !== "\"") {
      offset = start + 1;
      continue;
    }

    let end = start + 1;
    while (end < html.length) {
      if (html[end] === "\\") {
        end += 2;
        continue;
      }
      if (html[end] === "\"") break;
      end += 1;
    }
    if (end >= html.length) {
      throw new Error("ChatGPT 分享页的水合数据包含未结束的字符串");
    }
    try {
      chunks.push(JSON.parse(html.slice(start, end + 1)));
    } catch {
      throw new Error("ChatGPT 分享页的水合数据包含无效的 JavaScript 字符串");
    }
    offset = end + 1;
  }
  return chunks;
}

function messageText(message: Record<string, unknown>): string {
  const content = asRecord(message.content);
  if (!content) return "";
  if (Array.isArray(content.parts)) {
    return content.parts.map(partToText).filter(Boolean).join("\n");
  }
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content.thoughts)) {
    return content.thoughts
      .map((value) => {
        const thought = asRecord(value);
        return [stringValue(thought?.summary), stringValue(thought?.content)]
          .filter(Boolean)
          .join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof content.content === "string") return content.content;
  return contentToText(content);
}

function partToText(value: unknown): string {
  if (typeof value === "string") return value;
  const part = asRecord(value);
  if (!part) return String(value ?? "");
  if (part.content_type === "text" && typeof part.text === "string") return part.text;
  if (part.content_type === "image_asset_pointer") {
    return `[image:${stringValue(part.asset_pointer) ?? "unknown"}]`;
  }
  return contentToText(part);
}

/** Structured multimodal part facts (no asset bytes; no fabricated usage). */
function nativeParts(message: Record<string, unknown>): { nativeBlocks: unknown[] } | undefined {
  const content = asRecord(message.content);
  const parts = content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const blocks = parts.flatMap((value) => {
    const part = asRecord(value);
    if (!part) return [];
    const contentType = stringValue(part.content_type);
    if (contentType === undefined) return [];
    return [{
      contentType,
      ...(stringValue(part.asset_pointer) !== undefined ? { assetPointer: stringValue(part.asset_pointer) } : {}),
      ...(stringValue(part.content_type) === "image_asset_pointer" && typeof part.width === "number" ? { width: part.width } : {}),
      ...(stringValue(part.content_type) === "image_asset_pointer" && typeof part.height === "number" ? { height: part.height } : {}),
    }];
  });
  return blocks.length ? { nativeBlocks: blocks } : undefined;
}

function parseToolArguments(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function matchChatGptToolResults(rows: unknown[]): {
  resultByCallPosition: Map<number, ChatGptToolResult>;
  callByResultPosition: Map<number, number>;
} {
  const segments: number[][] = [];
  let segment: number[] = [];
  for (let position = 0; position < rows.length; position += 1) {
    const message = asRecord(asRecord(rows[position])?.message);
    const role = stringValue(asRecord(message?.author)?.role);
    if (role === "user" && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
    segment.push(position);
  }
  if (segment.length > 0) segments.push(segment);

  const resultByCallPosition = new Map<number, ChatGptToolResult>();
  const callByResultPosition = new Map<number, number>();

  for (const positions of segments) {
    const calls = positions.flatMap((position) => {
      const message = asRecord(asRecord(rows[position])?.message);
      const role = stringValue(asRecord(message?.author)?.role);
      const name = stringValue(message?.recipient);
      return role === "assistant" && name && name !== "all"
        ? [{ position, name }]
        : [];
    });
    const unmatchedCalls = new Set(calls.map((call) => call.position));

    for (const position of positions) {
      const node = asRecord(rows[position]);
      const message = asRecord(node?.message);
      const role = stringValue(asRecord(message?.author)?.role);
      if (role !== "tool" || !message) continue;
      const text = messageText(message);
      const redacted = isRedactedToolResult(message);
      if (!redacted && !text.trim()) continue;
      const name = stringValue(asRecord(message.author)?.name);
      const candidates = calls.filter((call) =>
        unmatchedCalls.has(call.position)
        && (name ? call.name === name : true));
      if (candidates.length !== 1) continue;

      const call = candidates[0];
      const result: ChatGptToolResult = {
        position,
        name,
        text,
        redacted,
        nodeId: stringValue(node?.id),
        messageId: stringValue(message.id),
      };
      resultByCallPosition.set(call.position, result);
      callByResultPosition.set(position, call.position);
      unmatchedCalls.delete(call.position);
    }
  }

  return { resultByCallPosition, callByResultPosition };
}

function normalizedToolResult(result: ChatGptToolResult): {
  type: "success" | "redacted";
  log: string;
} {
  return result.redacted
    ? {
        type: "redacted",
        log: "ChatGPT 已在公开分享中隐藏该工具的原始输出。",
      }
    : { type: "success", log: result.text };
}

function isRedactedToolResult(message: Record<string, unknown>): boolean {
  const metadata = asRecord(message.metadata);
  return metadata?.is_redacted === true
    || messageText(message) === "The output of this plugin was redacted.";
}

function inspectChatGptFidelity(data: Record<string, unknown>): ChatGptFidelity {
  const rows = Array.isArray(data.linear_conversation) ? data.linear_conversation : [];
  let redactedToolResults = 0;
  let unredactedToolResults = 0;
  let omittedContentParts = 0;
  const omittedContentKinds = new Set<string>();

  for (const row of rows) {
    const message = asRecord(asRecord(row)?.message);
    if (!message) continue;
    if (stringValue(asRecord(message.author)?.role) === "tool") {
      if (isRedactedToolResult(message)) redactedToolResults += 1;
      else unredactedToolResults += 1;
    }
    omittedContentParts += collectOmittedContentKinds(message.content, omittedContentKinds);
  }

  return {
    redactedToolResults,
    unredactedToolResults,
    omittedContentParts,
    omittedContentKinds: [...omittedContentKinds].sort(),
  };
}

function collectOmittedContentKinds(value: unknown, kinds: Set<string>): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + collectOmittedContentKinds(item, kinds), 0);
  }
  const record = asRecord(value);
  if (!record) return 0;

  const contentType = stringValue(record.content_type);
  const hasExternalAsset = typeof record.asset_pointer === "string"
    || "image_url" in record
    || "audio_url" in record
    || "video_url" in record
    || "file_id" in record;
  if (hasExternalAsset) {
    kinds.add(contentType ?? "external_asset");
    return 1;
  }

  return Object.values(record)
    .reduce<number>((count, item) => count + collectOmittedContentKinds(item, kinds), 0);
}

function chatGptFidelityWarning(fidelity: ChatGptFidelity): string | undefined {
  const warnings: string[] = [];
  if (fidelity.redactedToolResults > 0) {
    warnings.push(
      `来源已隐藏 ${fidelity.redactedToolResults} 条 ChatGPT 工具结果，原始输出无法恢复`,
    );
  }
  if (fidelity.omittedContentParts > 0) {
    const kinds = fidelity.omittedContentKinds.length > 0
      ? `（${fidelity.omittedContentKinds.join("、")}）`
      : "";
    warnings.push(
      `公开分享中的 ${fidelity.omittedContentParts} 个图片或附件内容未归档${kinds}，仅保留占位符`,
    );
  }
  return warnings.length > 0 ? warnings.join("；") : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value) {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? undefined : new Date(milliseconds).toISOString();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function fetchSharePage(
  requested: URL,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = requested;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "asmgr ChatGPT share importer",
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("ChatGPT 分享页重定向时没有提供目标地址");
    try {
      current = parseChatGptShareUrl(new URL(location, current).toString());
    } catch {
      throw new Error("该链接重定向到了 ChatGPT 公开分享页之外，已停止访问");
    }
  }
  throw new Error("ChatGPT 分享页重定向次数过多");
}

function isAddressBarConversationPath(pathname: string): boolean {
  return /^\/c\/[^/]+\/?$/u.test(pathname)
    || /^\/g\/[^/]+\/c\/[^/]+\/?$/u.test(pathname);
}
