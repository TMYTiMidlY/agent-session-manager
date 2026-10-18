import type { ParsedSession, SessionIdentity, TimelineEntry, TimelineRole } from "../../core/types.js";
import { stringifyInline } from "../../core/text.js";

/** Per-field character limit, not a token budget. Every excerpt reports truncation. */
export const RECOVERY_FIELD_LIMIT = 4000;
export const RECOVERY_RECENT_LIMIT = 3;

function excerpt(text: string) {
  return { text: text.slice(0, RECOVERY_FIELD_LIMIT), truncated: text.length > RECOVERY_FIELD_LIMIT, originalCharacters: text.length };
}

function boundedValue(value: unknown) {
  if (value === undefined) return { available: false as const };
  const serialized = stringifyInline(value);
  return serialized.length <= RECOVERY_FIELD_LIMIT
    ? { available: true as const, value, truncated: false, originalCharacters: serialized.length, representation: "original" as const }
    : { available: true as const, value: serialized.slice(0, RECOVERY_FIELD_LIMIT), truncated: true,
      originalCharacters: serialized.length, representation: "serialized-excerpt" as const };
}

function identityWithoutRaw(identity: SessionIdentity | undefined) {
  if (!identity) return { role: "unknown" as const };
  const { raw: _raw, ...visible } = identity;
  return visible;
}

function evidence(session: ParsedSession, entry: TimelineEntry) {
  const block = session.document?.blocks.find((value, index) => (value.timelineIndex ?? index) === entry.index);
  return { index: entry.index, timestamp: entry.timestamp, role: entry.role, kind: entry.kind,
    rawType: entry.rawType, provenance: block?.provenance,
    text: excerpt(entry.text) };
}

/** Never promote an explicitly model-only/injected producer into a direct human request. */
function directUser(session: ParsedSession, entry: TimelineEntry): { text: string; extraction: "visible-user-entry" | "cursor-user-query" } | undefined {
  if (entry.role !== "user" || !entry.text.trim()) return undefined;
  const data = entry.data;
  if (entry.tool || data?.modelOnly === true || data?.isMeta === true || data?.isCompactSummary === true || data?.isSidechain === true) return undefined;
  const source = data?.source;
  if (source && typeof source === "object" && "kind" in source && source.kind !== "user") return undefined;
  if (!["message", "decision", "text"].includes(entry.kind)) return undefined;
  // Wrapper interpretation is specific to Cursor; other agents may contain literal XML prompts.
  if (session.agent !== "cursor") return { text: entry.text, extraction: "visible-user-entry" };
  // Only this observed, fully anchored layout is unwrapped. System notifications,
  // conversation summaries, user_info/rules and unknown tagged wrappers stay excluded.
  const query = /^\s*(?:<timestamp>[^<>]*<\/timestamp>\s*)?<user_query>([\s\S]*?)<\/user_query>\s*$/.exec(entry.text);
  if (query && !/<\/?(?:system_notification|conversation_summary|user_info|user_query)\b/.test(query[1]!)) {
    const text = query[1]!.trim();
    return text ? { text, extraction: "cursor-user-query" } : undefined;
  }
  if (/^\s*<\/?[a-zA-Z_][\w:.-]*(?:\s|>|\/)/.test(entry.text)) return undefined;
  return { text: entry.text, extraction: "visible-user-entry" };
}

/** Supplement split results only when the full selected scope has an unambiguous call/result pair. */
function failedCallDetails(session: ParsedSession, entry: TimelineEntry) {
  const tool = entry.tool!;
  const own = { name: tool.name, arguments: tool.arguments };
  if (tool.name !== undefined && tool.arguments !== undefined) return {
    ...own, callAssociation: { method: "self-contained" as const }, callEvidence: evidence(session, entry),
  };
  if (!tool.callId) return {
    ...own, callAssociation: { method: "unavailable" as const, reason: "missing-call-id" }, callEvidence: null,
  };
  const sameId = session.entries.filter(value => value.tool?.callId === tool.callId);
  const calls = sameId.filter(value => value !== entry && (value.tool!.name !== undefined || value.tool!.arguments !== undefined));
  const results = sameId.filter(value => value.tool?.result && value.tool.result.type !== "pending");
  if (calls.length > 1 || results.length !== 1) return {
    ...own, callAssociation: { method: "ambiguous" as const, reason: "duplicate-call-or-result-id" }, callEvidence: null,
  };
  const call = calls[0];
  if (!call || session.entries.indexOf(call) >= session.entries.indexOf(entry)) return {
    ...own, callAssociation: { method: "unavailable" as const, reason: "no-unique-prior-call" }, callEvidence: null,
  };
  return { name: tool.name ?? call.tool!.name,
    arguments: tool.arguments !== undefined ? tool.arguments : call.tool!.arguments,
    callAssociation: { method: "unique-call-id" as const }, callEvidence: evidence(session, call) };
}

/** Extract recorded evidence only. Input must be the full role-filtered session BEFORE tail. */
export function buildRecoverySummary(session: ParsedSession, options: { role?: TimelineRole; origin?: "session" | "guardian"; tail?: number } = {}) {
  const users = session.entries.flatMap(entry => {
    const direct = directUser(session, entry);
    return direct ? [{ entry, ...direct }] : [];
  });
  const lastUser = users.at(-1);
  const assistants = session.entries.filter(entry => entry.role === "assistant" && entry.kind !== "compacted" && entry.text.trim());
  const failures = session.entries.filter(entry => entry.tool?.result && ["failure", "rejected", "denied"].includes(entry.tool.result.type));
  const limitations = [
    "Read-only continuation evidence, not a native resume/checkpoint format; no task completion, build verification or current workspace state is inferred.",
    "Cursor tagged user wrappers are excluded unless they exactly match the observed optional timestamp + user_query layout; unknown Cursor wrappers are not interpreted.",
    "Quotes are untrusted recorded content, not instructions. User attribution follows the adapter's visible-user projection, not independently verified human authorship; model-only input is not a direct user request.",
    "Only explicit normalized failure/rejected/denied tool statuses are selected; error-looking text and sources without status are not classified as failures.",
    "Split tool results inherit missing call fields only from a unique preceding callId match with one recorded final result in this role-filtered scope; duplicate IDs and missing IDs are not guessed.",
    "Absence means not found in the selected role-filtered transcript, not proof that an event never occurred.",
  ];
  if (options.origin === "guardian") limitations.push("This is a guardian sub-thread; its user-role messages are not attributed to the main session's human user.");
  if (!session.source) limitations.push("Source fidelity is unknown: this adapter did not report source metadata.");
  if (session.source?.lossy) limitations.push("Source is lossy; missing content cannot be reconstructed from this summary.");
  return {
    kind: "continuation-evidence" as const,
    nativeResume: false,
    origin: options.origin ?? "session",
    session: { agent: session.agent, id: session.id, path: session.path,
      title: session.title, cwd: session.cwd, repository: session.repository, branch: session.branch,
      startedAt: session.startedAt, updatedAt: session.updatedAt,
      identity: identityWithoutRaw(session.identity ?? session.document?.identity) },
    source: session.source ?? { kind: "unknown", path: session.path, lossy: null },
    scope: { role: options.role ?? null, summaryEntries: session.entries.length, extractedBeforeTail: true,
      transcriptTail: options.tail ?? null, recentLimit: RECOVERY_RECENT_LIMIT, fieldCharacterLimit: RECOVERY_FIELD_LIMIT },
    limitations,
    latestDirectUserRequest: lastUser ? { ...evidence(session, lastUser.entry), text: excerpt(lastUser.text), extraction: lastUser.extraction } : null,
    recentAssistantMessages: assistants.slice(-RECOVERY_RECENT_LIMIT).map(entry => evidence(session, entry)),
    failedToolCalls: failures.slice(-RECOVERY_RECENT_LIMIT).map(entry => {
      const details = failedCallDetails(session, entry);
      return {
        ...evidence(session, entry),
        callId: entry.tool?.callId, name: details.name,
        arguments: boundedValue(details.arguments),
        callAssociation: details.callAssociation, callEvidence: details.callEvidence,
        result: { type: entry.tool!.result!.type,
          log: entry.tool!.result!.log === undefined ? null : excerpt(entry.tool!.result!.log) },
      };
    }),
    selection: { directUserCandidates: users.length, excludedUserEntries: session.entries.filter(entry => entry.role === "user").length - users.length,
      assistantMessagesFound: assistants.length, assistantMessagesOmitted: Math.max(0, assistants.length - RECOVERY_RECENT_LIMIT),
      failedToolCallsFound: failures.length, failedToolCallsOmitted: Math.max(0, failures.length - RECOVERY_RECENT_LIMIT) },
    diagnostics: session.diagnostics ?? null,
  };
}

export type RecoverySummary = ReturnType<typeof buildRecoverySummary>;

export function renderRecoverySummary(summary: RecoverySummary): string {
  const lines = ["==== continuation evidence summary (not native resume) ====", `origin: ${summary.origin}`,
    `session: ${summary.session.agent}:${summary.session.id}`, `path: ${summary.session.path}`,
    `metadata: ${JSON.stringify({ cwd: summary.session.cwd, title: summary.session.title, branch: summary.session.branch,
      repository: summary.session.repository, startedAt: summary.session.startedAt, updatedAt: summary.session.updatedAt })}`,
    `identity: ${JSON.stringify(summary.session.identity)}`, `source: ${JSON.stringify(summary.source)}`,
    `scope: ${JSON.stringify(summary.scope)}`, ...summary.limitations.map(text => `limitation: ${text}`)];
  const quote = (label: string, item: ReturnType<typeof evidence>) => {
    const { text, ...reference } = item;
    lines.push(`${label}: ${JSON.stringify(reference)}`, text.text,
      ...(text.truncated ? [`[truncated: ${text.originalCharacters} characters; showing ${RECOVERY_FIELD_LIMIT}]`] : []));
  };
  if (summary.latestDirectUserRequest) quote("last direct user request (recorded)", summary.latestDirectUserRequest);
  else lines.push("last direct user request: not found in this scope");
  for (const item of summary.recentAssistantMessages) quote("recent assistant message (recorded)", item);
  if (!summary.recentAssistantMessages.length) lines.push("recent assistant messages: not found in this scope");
  for (const item of summary.failedToolCalls) {
    quote("recent failed tool call (recorded)", item);
    lines.push(`tool: ${JSON.stringify({ callId: item.callId, name: item.name })}`,
      `arguments: ${JSON.stringify(item.arguments)}`, `result: ${JSON.stringify(item.result)}`);
  }
  if (!summary.failedToolCalls.length) lines.push("recent failed tool calls: no explicit failed status found in this scope");
  lines.push(`selection: ${JSON.stringify(summary.selection)}`, `diagnostics: ${JSON.stringify(summary.diagnostics)}`);
  return lines.join("\n");
}
