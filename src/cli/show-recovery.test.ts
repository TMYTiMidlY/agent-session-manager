import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildShowCommand } from "./commands/show.js";
import { buildRecoverySummary, RECOVERY_FIELD_LIMIT, renderRecoverySummary } from "./util/show-recovery.js";
import type { ParsedSession, TimelineEntry } from "../core/types.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    if (resolve(path) !== path || !path.startsWith(join(tmpdir(), "asmgr-show-recovery-"))) throw new Error("unexpected cleanup path");
    await rm(path, { recursive: true, force: true });
  }
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "asmgr-show-recovery-"));
  directories.push(path); return path;
}
async function jsonl(dir: string, name: string, rows: unknown[]) {
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return path;
}
async function run(args: string[]) {
  let output = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += chunk.toString(); return true; });
  try { await buildShowCommand().exitOverride().configureOutput({ writeErr: () => {} }).parseAsync(args, { from: "user" }); }
  finally { write.mockRestore(); }
  return output;
}
const codexMessage = (role: string, text: string) => ({ type: "response_item", payload: {
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text },
    { type: "image", payload: "NATIVE_OPAQUE_BODY" }],
} });
async function codex(dir: string, id = "main", guardian = false) {
  return jsonl(dir, id, [
    { type: "session_meta", payload: { id, cwd: "/synthetic", thread_source: guardian ? "guardian_review" : "user", ...(guardian ? { parent_thread_id: "main" } : {}) } },
    codexMessage("user", `${id}-user-early`),
    codexMessage("assistant", `${id}-assistant-early`),
    codexMessage("user", `${id}-user-last`),
    codexMessage("assistant", `${id}-assistant-last`),
    { type: "response_item", payload: { type: "function_call", call_id: "call", name: "read", arguments: '{"path":"secret"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "error-looking-output-without-status" } },
  ]);
}
function fixture(entries: TimelineEntry[], other: Partial<ParsedSession> = {}): ParsedSession {
  return { agent: "dsh", id: "synthetic", path: "/synthetic/session.jsonl", entries,
    source: { kind: "events", path: "/synthetic/session.jsonl", lossy: false }, ...other };
}
function entry(index: number, role: TimelineEntry["role"], text: string, other: Partial<TimelineEntry> = {}): TimelineEntry {
  return { index, role, kind: "message", text, ...other };
}

describe("show --tail", () => {
  it.each(["-1", "-0", "1.5", "1e2", "+2", "0x10", "2junk", " 2", "NaN", "Infinity", "9007199254740992"])("rejects invalid safe nonnegative count %s before reading a source", async value => {
    await expect(run(["--tail", value, "--file", "/nonexistent-show-source"])).rejects.toThrow();
  });
  it("accepts the maximum safe integer and digit-only leading zeros", async () => {
    const file = await codex(await root());
    for (const count of ["9007199254740991", "0006"]) {
      const result = JSON.parse(await run(["--file", file, "--tail", count, "-f", "json"]));
      expect(result.entries).toHaveLength(6);
      expect(result.document.view.tail).toBe(Number(count));
      expect(JSON.stringify(result)).not.toContain("NATIVE_OPAQUE_BODY");
    }
  });
  it("filters role before tail and synchronizes entries, blocks and events without opaque native fields", async () => {
    const file = await codex(await root());
    const result = JSON.parse(await run(["--file", file, "--role", "assistant", "--tail", "1", "-f", "json"]));
    expect(result.entries.map((value: TimelineEntry) => [value.index, value.text])).toEqual([[3, "main-assistant-last"]]);
    expect(result.document.blocks.map((value: { timelineIndex: number; text: string }) => [value.timelineIndex, value.text])).toEqual([[3, "main-assistant-last"]]);
    expect(result.document.events.filter((value: { type: string }) => value.type === "message/append").map((value: { data: { block: { text: string } } }) => value.data.block.text)).toEqual(["main-assistant-last"]);
    expect(result.document.view).toEqual({ role: "assistant", tail: 1, nativeContent: "omitted" });
    expect(result.identity.raw).toBeUndefined();
    expect(result.document.identity.raw).toBeUndefined();
    expect(result.document.ref.identity?.raw).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("main-user");
    expect(JSON.stringify(result)).not.toContain('"native":');
    expect(JSON.stringify(result)).not.toContain("NATIVE_OPAQUE_BODY");
  });
  it("also removes opaque raw context copied into top-level stats", async () => {
    const file = await jsonl(await root(), "context", [
      { type: "session_meta", payload: { id: "context", thread_source: "user" } },
      codexMessage("assistant", "answer"),
      { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 1000,
        last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1, secret: "OPAQUE_CONTEXT_BODY" } } } },
    ]);
    const original = JSON.parse(await run(["--file", file, "-f", "json"]));
    expect(original.stats.lastContext.raw.secret).toBe("OPAQUE_CONTEXT_BODY");
    for (const options of [["--tail", "1"], ["--role", "assistant"], ["--summary"]]) {
      const value = JSON.parse(await run(["--file", file, ...options, "-f", "json"]));
      expect(value.stats.lastContext.contextWindow).toBe(1000);
      expect(value.stats.lastContext.raw).toBeUndefined();
      expect(JSON.stringify(value)).not.toContain("OPAQUE_CONTEXT_BODY");
    }
  });
  it("uses the same normalized-entry window in text, dialogue and JSON (does not backfill dialogue)", async () => {
    const file = await codex(await root());
    const result = JSON.parse(await run(["--file", file, "--tail", "2", "-f", "json"]));
    expect(result.entries.map((value: TimelineEntry) => value.index)).toEqual([4, 5]);
    const text = await run(["--file", file, "--tail", "2", "-f", "text"]);
    expect(text).toContain("## 5. tool/");
    expect(text).toContain("## 6. tool/");
    const dialogue = await run(["--file", file, "--tail", "2", "-f", "dialogue"]);
    expect(dialogue).not.toContain("## ");
    for (const output of [text, dialogue]) expect(output).not.toContain("main-assistant-last");
    for (const format of ["text", "dialogue"]) {
      const filtered = await run(["--file", file, "--role", "assistant", "--tail", "1", "-f", format]);
      expect(filtered).toContain("main-assistant-last");
      expect(filtered).not.toContain("main-assistant-early");
    }
  });
  it("keeps an empty transcript at zero and does not treat it as slice(-0)", async () => {
    const file = await codex(await root());
    const value = JSON.parse(await run(["--file", file, "--tail", "0", "-f", "json"]));
    expect(value.entries).toEqual([]);
    expect(value.document.blocks).toEqual([]);
    expect(value.document.events.filter((event: { type: string }) => event.type === "message/append")).toEqual([]);
    for (const format of ["text", "dialogue"]) expect(await run(["--file", file, "--tail", "0", "-f", format])).not.toContain("main-assistant");
  });
  it("applies role and tail independently to guardian threads and labels their summaries", async () => {
    const dir = await root();
    await codex(dir); await codex(dir, "guardian", true);
    const args = ["main", "--file", dir, "--role", "assistant", "--tail", "1"];
    const value = JSON.parse(await run([...args, "--summary", "-f", "json"]));
    expect(value.entries.map((value: TimelineEntry) => value.text)).toEqual(["main-assistant-last"]);
    expect(value.guardianThreads).toHaveLength(1);
    const child = value.guardianThreads[0];
    expect(child.entries.map((value: TimelineEntry) => value.text)).toEqual(["guardian-assistant-last"]);
    expect(child.document.blocks).toHaveLength(1);
    expect(child.recoverySummary.origin).toBe("guardian");
    expect(child.recoverySummary.session.id).toBe("guardian");
    expect(child.recoverySummary.latestDirectUserRequest).toBeNull();
    expect(child.recoverySummary.recentAssistantMessages).toHaveLength(2);
    for (const format of ["text", "dialogue"]) {
      const output = await run([...args, "-f", format]);
      expect(output).toContain("origin: guardian");
      expect(output).toContain("guardian-assistant-last");
      expect(output).not.toContain("guardian-assistant-early");
    }
    const summary = await run([...args, "--summary"]);
    expect(summary).toContain("origin: guardian");
    expect(summary).toContain("not attributed to the main session's human user");
    const noGuardian = JSON.parse(await run([...args, "--no-guardian", "-f", "json"]));
    expect(noGuardian.guardianThreads).toBeUndefined();
  });
});

describe("show --summary", () => {
  it("extracts summary before tail=0, retains diagnostics and does not infer status from output text", async () => {
    const file = await codex(await root());
    const value = JSON.parse(await run(["--file", file, "--tail", "0", "--summary", "-f", "json"]));
    expect(value.entries).toEqual([]);
    expect(value.document.blocks).toEqual([]);
    expect(value.recoverySummary.latestDirectUserRequest.text.text).toBe("main-user-last");
    expect(value.recoverySummary.recentAssistantMessages.map((item: { text: { text: string } }) => item.text.text)).toEqual(["main-assistant-early", "main-assistant-last"]);
    expect(value.recoverySummary.failedToolCalls).toEqual([]);
    expect(value.recoverySummary.diagnostics).toEqual(value.diagnostics);
    expect(value.recoverySummary.scope).toMatchObject({ extractedBeforeTail: true, transcriptTail: 0, summaryEntries: 6 });
    expect(value.recoverySummary).toMatchObject({ nativeResume: false, origin: "session", session: { agent: "codex", id: "main", path: file } });
    expect(JSON.stringify(value)).not.toContain('"native":');
    const untailed = JSON.parse(await run(["--file", file, "--summary", "-f", "json"]));
    expect(untailed.entries).toHaveLength(6);
    expect(JSON.stringify(untailed)).not.toContain("NATIVE_OPAQUE_BODY");
    const restricted = JSON.parse(await run(["--file", file, "--role", "tool", "--summary", "-f", "json"]));
    expect(restricted.recoverySummary.latestDirectUserRequest).toBeNull();
    expect(restricted.recoverySummary.recentAssistantMessages).toEqual([]);
    for (const format of ["text", "dialogue"]) {
      const output = await run(["--file", file, "--summary", "--tail", "0", "-f", format]);
      expect(output).toContain("last direct user request (recorded)");
      expect(output).toContain("main-user-last");
      expect(output).toContain("not native resume");
      expect(output).toContain("build verification");
      expect(output).toContain("diagnostics:");
      expect(output).not.toContain("## ");
    }
  });
  it("preserves explicit failed-call parameters and results in JSON and text", async () => {
    const file = await jsonl(await root(), "copilot", [
      { type: "session.start", data: { sessionId: "copilot", context: { cwd: "/synthetic" } } },
      { type: "user.message", data: { content: "please inspect" } },
      { type: "tool.execution_start", data: { toolCallId: "failed", toolName: "shell", arguments: { command: "inspect" } } },
      { type: "tool.execution_complete", data: { toolCallId: "failed", success: false, error: "recorded failure" } },
      { type: "assistant.message", data: { content: "recorded response" } },
    ]);
    const value = JSON.parse(await run(["--file", file, "--summary", "--tail", "0", "-f", "json"]));
    expect(value.recoverySummary.failedToolCalls).toHaveLength(1);
    expect(value.recoverySummary.failedToolCalls[0]).toMatchObject({ callId: "failed", name: "shell",
      arguments: { available: true, value: { command: "inspect" }, truncated: false },
      result: { type: "failure", log: { text: "recorded failure", truncated: false } } });
    const text = await run(["--file", file, "--summary"]);
    expect(text).toContain('"command":"inspect"');
    expect(text).toContain("recorded failure");
    expect(text).toContain('"callId":"failed"');
  });
  it("links Claude split failed tool results to a unique preceding call without changing transcript entries", async () => {
    const file = await jsonl(await root(), "claude-failure", [
      { type: "user", message: { content: "inspect build" } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "claude-call", name: "Bash", input: { command: "inspect --check" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "claude-call", is_error: true, content: "recorded build failure" }] } },
    ]);
    const value = JSON.parse(await run(["--file", file, "--role", "tool", "--summary", "--tail", "0", "-f", "json"]));
    expect(value.entries).toEqual([]);
    expect(value.recoverySummary.failedToolCalls).toHaveLength(1);
    expect(value.recoverySummary.failedToolCalls[0]).toMatchObject({ index: 2, callId: "claude-call", name: "Bash",
      arguments: { available: true, value: { command: "inspect --check" } },
      result: { type: "failure", log: { text: "recorded build failure" } },
      callAssociation: { method: "unique-call-id" }, callEvidence: { index: 1, kind: "tool_use" } });
    const original = JSON.parse(await run(["--file", file, "--summary", "-f", "json"]));
    expect(original.entries[2].tool.arguments).toBeUndefined();
    expect(original.entries[2].tool.name).toBeUndefined();
    expect(original.entries[1].tool.result.type).toBe("pending");
    const text = await run(["--file", file, "--summary"]);
    expect(text).toContain("inspect --check");
    expect(text).toContain('"method":"unique-call-id"');
  });
  it.each(["calls", "results"])("does not associate split tool failures when duplicate %s share a callId", duplicate => {
    const call = entry(0, "tool", "call", { tool: { callId: "duplicate", name: "shell", arguments: { command: "original" }, result: { type: "pending" } } });
    const failure = entry(2, "tool", "failure", { tool: { callId: "duplicate", result: { type: "failure", log: "failed" } } });
    const extra = duplicate === "calls"
      ? entry(1, "tool", "other call", { tool: { callId: "duplicate", name: "other", arguments: { command: "other" } } })
      : entry(1, "tool", "other result", { tool: { callId: "duplicate", result: { type: "success", log: "prior outcome" } } });
    const session = fixture([call, extra, failure]);
    const before = JSON.stringify(session);
    const summary = buildRecoverySummary(session);
    expect(summary.failedToolCalls[0]).toMatchObject({ arguments: { available: false }, callAssociation: { method: "ambiguous" }, callEvidence: null });
    expect(summary.failedToolCalls[0]?.name).toBeUndefined();
    expect(JSON.stringify(session)).toBe(before);
  });
  it("does not invent associations without IDs, preceding calls, or calls in the selected scope", () => {
    for (const entries of [
      [entry(0, "tool", "failure", { tool: { result: { type: "failure" } } })],
      [entry(0, "tool", "failure", { tool: { callId: "later", result: { type: "failure" } } }),
        entry(1, "tool", "late call", { tool: { callId: "later", name: "shell", arguments: "late" } })],
      [entry(0, "tool", "failure", { tool: { callId: "filtered-out", result: { type: "failure" } } })],
    ]) {
      const item = buildRecoverySummary(fixture(entries)).failedToolCalls[0];
      expect(item).toMatchObject({ arguments: { available: false }, callAssociation: { method: "unavailable" }, callEvidence: null });
      expect(item?.name).toBeUndefined();
    }
  });
  it("leaves self-contained failed calls authoritative despite duplicate IDs elsewhere", () => {
    const session = fixture([
      entry(0, "tool", "unrelated", { tool: { callId: "same", name: "other", arguments: "other" } }),
      entry(1, "tool", "failure", { tool: { callId: "same", name: "own", arguments: { command: "own" }, result: { type: "failure", log: "own error" } } }),
    ]);
    const before = JSON.stringify(session);
    const item = buildRecoverySummary(session).failedToolCalls[0];
    expect(item).toMatchObject({ name: "own", arguments: { value: { command: "own" } },
      callAssociation: { method: "self-contained" }, callEvidence: { index: 1 } });
    expect(JSON.stringify(session)).toBe(before);
  });
  it("does not turn DSH plugin/model-only user messages into a direct human request", async () => {
    const file = await jsonl(await root(), "session.v4", [
      { type: "session", version: 4, id: "dsh-direct", createdAt: 1, isSeeded: false },
      { type: "user/message", seq: 0, time: 2, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "real request" }] } },
      { type: "user/message", seq: 1, time: 3, surfaceOp: "append", data: { source: { kind: "plugin", plugin: "goal" }, content: [{ type: "text", text: "MODEL ONLY SECRET" }] } },
    ]);
    const value = JSON.parse(await run(["--file", file, "--summary", "-f", "json"]));
    expect(value.recoverySummary.latestDirectUserRequest.text.text).toBe("real request");
    expect(JSON.stringify(value.recoverySummary)).not.toContain("MODEL ONLY SECRET");
  });
  it("conservatively excludes tagged system/model inputs and unwraps only exact observed user_query envelopes", () => {
    const session = fixture([
      entry(0, "user", "old direct request"),
      entry(1, "user", '<timestamp>Sunday, Oct 18, 2026, 5:09 PM (UTC+8)</timestamp>\n<user_query>\n做啊\n</user_query>'),
      entry(2, "user", '<timestamp>later</timestamp>\n<system_notification source="goal">continue</system_notification>'),
      entry(3, "user", "<conversation_summary>model summary</conversation_summary>"),
      entry(4, "user", "<user_info>private rules</user_info>"),
      entry(5, "user", "<unknown_wrapper>do something</unknown_wrapper>"),
      entry(6, "user", "not human", { data: { source: { kind: "plugin" } } }),
      entry(7, "user", "model only", { data: { modelOnly: true } }),
    ], { agent: "cursor" });
    const summary = buildRecoverySummary(session);
    expect(summary.latestDirectUserRequest).toMatchObject({ index: 1, extraction: "cursor-user-query", text: { text: "做啊", truncated: false } });
    expect(summary.selection.excludedUserEntries).toBe(6);
    expect(JSON.stringify(summary.latestDirectUserRequest)).not.toContain("private rules");
  });
  it.each([false, true])("includes Claude text requests but never promotes explicit meta, summary or sidechain input (array=%s)", async array => {
    const content = (text: string) => array ? [{ type: "text", text }] : text;
    const file = await jsonl(await root(), "claude", [
      { type: "user", message: { content: content("<request>real user XML</request>") } },
      { type: "assistant", message: { content: content("acknowledged") } },
      { type: "user", isMeta: true, message: { content: content("injected metadata") } },
      { type: "user", isCompactSummary: true, message: { content: content("model generated summary") } },
      { type: "user", isSidechain: true, message: { content: content("sidechain request") } },
    ]);
    const value = JSON.parse(await run(["--file", file, "--summary", "-f", "json"]));
    expect(value.recoverySummary.latestDirectUserRequest.text.text).toBe("<request>real user XML</request>");
    expect(value.recoverySummary.latestDirectUserRequest.extraction).toBe("visible-user-entry");
    expect(value.recoverySummary.selection.excludedUserEntries).toBe(3);
    expect(value.entries).toHaveLength(5); // Transcript remains faithful; only attribution changes.
  });
  it("does not unwrap literal user_query tags from non-Cursor prompts", () => {
    const summary = buildRecoverySummary(fixture([entry(0, "user", "<user_query>literal</user_query>")]));
    expect(summary.latestDirectUserRequest?.text.text).toBe("<user_query>literal</user_query>");
    expect(summary.latestDirectUserRequest?.extraction).toBe("visible-user-entry");
  });
  it("bounds recent messages, failed calls, arguments and results with explicit truncation", () => {
    const long = "x".repeat(RECOVERY_FIELD_LIMIT + 23);
    const session = fixture([
      entry(0, "user", long),
      ...Array.from({ length: 5 }, (_, index) => entry(index + 1, "assistant", index === 4 ? long : `answer ${index}`)),
      ...Array.from({ length: 5 }, (_, index) => entry(index + 6, "tool", long, { tool: {
        callId: `call-${index}`, name: "shell", arguments: { command: long }, result: { type: index === 4 ? "denied" : "failure", log: long },
      } })),
      entry(11, "tool", "error-looking success", { tool: { result: { type: "success", log: "error" } } }),
    ], { source: { kind: "db-turns", path: "/synthetic/store.db", lossy: true, warning: "tools may be missing" },
      diagnostics: { handled: 12, ignored: 2, unknown: 1, unknownTypes: ["unknown/type"],
        unparsedEnvelopeFields: 9, unparsedEnvelopeTypes: ["proto-field:5"], unparsedEnvelopeTypesTruncated: true,
        issues: [{ code: "unknown", message: "unverified fields", count: 1 }] } });
    const summary = buildRecoverySummary(session);
    expect(summary.latestDirectUserRequest?.text).toMatchObject({ truncated: true, originalCharacters: long.length });
    expect(summary.latestDirectUserRequest?.text.text).toHaveLength(RECOVERY_FIELD_LIMIT);
    expect(summary.recentAssistantMessages).toHaveLength(3);
    expect(summary.failedToolCalls.map(value => value.callId)).toEqual(["call-2", "call-3", "call-4"]);
    expect(summary.failedToolCalls[2]?.arguments).toMatchObject({ truncated: true, representation: "serialized-excerpt" });
    expect(summary.failedToolCalls[2]?.result.log).toMatchObject({ truncated: true, originalCharacters: long.length });
    expect(summary.selection).toMatchObject({ assistantMessagesOmitted: 2, failedToolCallsOmitted: 2 });
    expect(summary.diagnostics).toEqual(session.diagnostics);
    expect(summary.source).toEqual(session.source);
    expect(renderRecoverySummary(summary)).toContain("[truncated:");
  });
  it("renders recorded session metadata in text summaries", () => {
    const summary = buildRecoverySummary(fixture([], { cwd: "/synthetic/project", title: "recorded title", branch: "topic",
      repository: "owner/repo", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }));
    const text = renderRecoverySummary(summary);
    for (const value of ["/synthetic/project", "recorded title", "topic", "owner/repo", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]) expect(text).toContain(value);
  });
  it("marks absent evidence/source/diagnostics as unavailable rather than inventing recovery facts", () => {
    const summary = buildRecoverySummary(fixture([], { source: undefined }));
    expect(summary.latestDirectUserRequest).toBeNull();
    expect(summary.recentAssistantMessages).toEqual([]);
    expect(summary.failedToolCalls).toEqual([]);
    expect(summary.diagnostics).toBeNull();
    expect(summary.source).toMatchObject({ kind: "unknown", lossy: null });
    expect(summary.limitations.join(" ")).toContain("Source fidelity is unknown");
  });
});
