import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDsh, parseDsh, refFromDshFile } from "../adapters/dsh.js";
import { sessionToDialogue } from "../index.js";

type Row = Record<string, unknown>;
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asmgr-dsh-test-"));
  directories.push(directory);
  return directory;
}

function text(value: string): Row {
  return { type: "text", text: value };
}

function header(version = 3, id = "dsh-synthetic"): Row {
  return { type: "session", version, id, createdAt: EPOCH, cwd: "/synthetic/project", delegationDepth: 0,
    ...(version >= 2 ? { isSeeded: false } : {}),
  };
}

function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function writeLog(rows: readonly unknown[], path?: string): Promise<string> {
  path ??= join(await temporaryDirectory(), "session.v3.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl(rows));
  return path;
}

async function parseRows(rows: readonly unknown[], name = "session.v3.jsonl") {
  const path = await writeLog(rows, join(await temporaryDirectory(), name));
  return parseDsh(await refFromDshFile(path));
}

/** Small canonical logs; every test owns its rows, messages, and temporary files. */
function fixture(id = "dsh-synthetic", version: 3 | 4 = 3) {
  const rows: Row[] = [header(version, id)];
  let step = 1;
  const event = (type: string, data: unknown, metadata: Row = {}): number => {
    const seq = rows.length - 1;
    rows.push({ type, seq, time: EPOCH + (seq + 1) * 1000, data, ...metadata });
    return seq;
  };
  const user = (value: string | Row[], source: Row = { kind: "user" }, metadata: Row = { surfaceOp: "append" }) => event("user/message", {
    id: `user-${rows.length}`, role: "user", source, content: typeof value === "string" ? [text(value)] : value,
  }, metadata);
  const assistant = (content: Row[], interrupted = false) => event("assistant/message", {
    turn: 1, step, stream: [],
    message: { id: `assistant-${rows.length}`, role: "assistant", source: { kind: "model", provider: "mock", model: "mock" }, content },
    ...(interrupted ? { interrupted: true } : {}),
  }, { surfaceOp: "append" });
  const call = (callId: string, name: string, args: unknown) => {
    assistant([{ type: "tool-call", id: callId, name, arguments: JSON.stringify(args) }]);
    return event("tool/call", { turn: 1, step, callId, name, arguments: JSON.stringify(args) });
  };
  // v4 carries results as first-class tool-role messages; released v3 wrapped one block in a user-role message.
  const result = (callId: string, content: Row[], options: { error?: string; meta?: unknown } = {}) => event("tool/result", {
    turn: 1, step,
    message: version === 4
      ? { id: `result-${rows.length}`, role: "tool", source: { kind: "tool", callId }, toolCallId: callId, content,
        isError: options.error !== undefined }
      : { id: `result-${rows.length}`, role: "user", source: { kind: "tool", callId }, content: [{
        type: "tool-result", toolCallId: callId, content, isError: options.error !== undefined,
      }] },
    ...(options.error ? { error: { name: "UserQuestionError", code: options.error } } : {}),
    ...(options.meta === undefined ? {} : { meta: options.meta }),
  }, { surfaceOp: "append" });
  const nextStep = () => {
    event("step/end", { turn: 1, step });
    step++;
    event("step/start", { turn: 1, step });
  };
  const close = () => {
    event("step/end", { turn: 1, step });
    event("turn/end", { turn: 1, reason: { kind: "completed" } });
    return rows;
  };
  event("turn/start", { turn: 1 });
  event("step/start", { turn: 1, step });
  event("system/message", { turn: 1, step, message: {
    id: "system", role: "system", source: version === 4 ? { kind: "system-prompt" } : { kind: "plugin", plugin: "system-prompt" },
    content: [text("SYSTEM PRIVATE CONTEXT")],
  } }, { surfaceOp: "append" });
  return { rows, event, user, assistant, call, result, nextStep, close };
}

const questions = [
  { id: "database", header: "Storage", question: "Which database?", options: [
    { label: "PostgreSQL", description: "Shared relational storage" },
    { label: "SQLite", description: "A single local file" },
  ] },
  { id: "features", question: "Which features?", multi_select: true, options: [
    { label: "Search" }, { label: "Export" }, { label: "Sync", description: "Not selected" },
  ] },
  { id: "notes", question: "Anything else?" },
];

describe("DSH v3 transcript", () => {
  it("reads identified user and assistant text without exposing the system prompt", async () => {
    const log = fixture();
    log.user([text("Human "), text("question")]);
    log.assistant([text("Assistant "), text("answer")]);
    const parsed = await parseRows(log.close());
    expect(parsed).toMatchObject({ agent: "dsh", id: "dsh-synthetic", cwd: "/synthetic/project", startedAt: new Date(EPOCH).toISOString() });
    expect(parsed.entries.map((entry) => [entry.role, entry.text])).toEqual([["user", "Human question"], ["assistant", "Assistant answer"]]);
    expect(parsed.source?.lossy).toBe(false);
    expect(sessionToDialogue(parsed)).not.toContain("SYSTEM PRIVATE CONTEXT");
  });

  it("retains mixed assistant text once while dialogue hides ordinary tools and reasoning", async () => {
    const log = fixture();
    log.user("Inspect this synthetic example");
    log.assistant([
      text("Before the tool. "),
      { type: "reasoning", text: "REASONING NOISE" },
      { type: "tool-call", id: "read", name: "read", arguments: '{"path":"TOOL ARGUMENT NOISE"}' },
      text("After the tool."),
    ]);
    log.event("tool/call", { turn: 1, step: 1, callId: "read", name: "read", arguments: '{"path":"TOOL ARGUMENT NOISE"}' });
    log.result("read", [text("TOOL RESULT NOISE")], { meta: { secret: "PRIVATE TOOL METADATA" } });
    log.nextStep();
    log.assistant([text("Final response")]);
    const parsed = await parseRows(log.close());
    expect(parsed.entries.filter((entry) => entry.role === "assistant").map((entry) => entry.text)).toEqual(["Before the tool. After the tool.", "Final response"]);
    const dialogue = sessionToDialogue(parsed);
    expect(dialogue).toContain("Before the tool. After the tool.");
    expect(dialogue).toContain("Final response");
    for (const hidden of ["TOOL ARGUMENT NOISE", "TOOL RESULT NOISE", "REASONING NOISE", "PRIVATE TOOL METADATA"]) expect(dialogue).not.toContain(hidden);
    expect(JSON.stringify(parsed.entries)).not.toContain("PRIVATE TOOL METADATA");
  });

  it("retains every question and option while pairing reordered multi-select answers by id", async () => {
    const log = fixture();
    log.user("Please ask before selecting storage");
    log.call("ask", "ask_user_question", { questions });
    log.result("ask", [text(JSON.stringify({ answers: [
      { id: "features", selected: ["Search", "Export"], custom: "Also keep the CLI" },
      { id: "notes", selected: [], custom: "" },
      { id: "database", selected: ["PostgreSQL"] },
    ] }))]);
    const parsed = await parseRows(log.close());
    const prompts = parsed.entries.filter((entry) => entry.kind === "question");
    expect(prompts.map((entry) => entry.data?.questionId)).toEqual(["database", "features", "notes"]);
    expect(prompts[0]?.text).toContain("Storage\nWhich database?");
    expect(prompts[0]?.text).toContain("PostgreSQL — Shared relational storage");
    expect(prompts[0]?.text).toContain("SQLite — A single local file");
    expect(prompts[1]?.text).toContain("（多选）");
    expect(prompts[1]?.text).toContain("Sync — Not selected");
    const decisions = parsed.entries.filter((entry) => entry.kind === "decision");
    expect(decisions.map((entry) => entry.data?.questionId)).toEqual(["database", "features", "notes"]);
    expect(decisions[0]?.text).toContain("回答「Which database?」：\nPostgreSQL");
    expect(decisions[1]?.text).toContain("Search\nExport\nAlso keep the CLI");
    expect(decisions[2]?.text).toContain("（未选择）");
    const dialogue = sessionToDialogue(parsed);
    expect(dialogue).toContain("SQLite — A single local file");
    expect(dialogue).toContain("Sync — Not selected");
    expect(dialogue).toContain("Also keep the CLI");
    expect(dialogue).not.toContain('"answers":');
    expect(dialogue).not.toContain('"questions":');
  });

  it.each(["ASK_CANCELLED", "ASK_ABORTED"])("keeps questions and unselected options for %s without inventing a decision", async (code) => {
    const log = fixture();
    log.call("ask", "ask_user_question", { questions: [questions[0]] });
    log.result("ask", [text("RAW ERROR DIAGNOSTIC")], { error: code });
    const parsed = await parseRows(log.close());
    expect(parsed.entries.filter((entry) => entry.kind === "decision")).toHaveLength(0);
    const dialogue = sessionToDialogue(parsed);
    expect(dialogue).toContain("Which database?");
    expect(dialogue).toContain("SQLite — A single local file");
    expect(dialogue).toMatch(/取消|中断/);
    expect(dialogue).not.toContain("RAW ERROR DIAGNOSTIC");
  });

  it("preserves an unanswered question when no result has been recorded", async () => {
    const log = fixture();
    log.call("pending", "ask_user_question", { questions: [questions[0]] });
    const parsed = await parseRows(log.rows);
    expect(parsed.entries.filter((entry) => entry.kind === "decision")).toHaveLength(0);
    expect(sessionToDialogue(parsed)).toContain("SQLite — A single local file");
    expect(sessionToDialogue(parsed)).toContain("未记录可匹配的回答");
  });

  it.each([
    { name: "unknown answer id", answers: [{ id: "other", selected: ["UNTRUSTED ANSWER"] }, { id: "features", selected: [] }] },
    { name: "duplicate answer ids", answers: [{ id: "database", selected: ["UNTRUSTED ANSWER"] }, { id: "database", selected: [] }] },
    { name: "missing answer", answers: [{ id: "database", selected: ["UNTRUSTED ANSWER"] }] },
    { name: "invalid selection", answers: [{ id: "database", selected: "UNTRUSTED ANSWER" }, { id: "features", selected: [] }] },
  ])("does not guess answers for $name", async ({ answers }) => {
    const log = fixture();
    log.call("ask", "ask_user_question", { questions: questions.slice(0, 2) });
    log.result("ask", [text(JSON.stringify({ answers }))]);
    const parsed = await parseRows(log.close());
    expect(parsed.entries.filter((entry) => entry.kind === "question")).toHaveLength(2);
    expect(parsed.entries.filter((entry) => entry.kind === "decision")).toHaveLength(0);
    expect(sessionToDialogue(parsed)).toContain("Which database?");
    expect(sessionToDialogue(parsed)).not.toContain("UNTRUSTED ANSWER");
    expect(parsed.source?.warning).toContain("未推断回答");
  });

  it("reads asks from official PTC dispatch events without expanding the parent program", async () => {
    const log = fixture();
    log.call("root", "run_code", { code: "PARENT PROGRAM NOISE" });
    const dispatch = { rootCallId: "root", parentCallId: "root", subCallId: "root:ptc:1", name: "ask_user_question", arguments: { questions: [questions[0]] } };
    log.event("tool/ptc-dispatch-start", dispatch);
    log.event("tool/ptc-dispatch", { ...dispatch, isError: false, content: [text(JSON.stringify({ answers: [{ id: "database", selected: ["SQLite"] }] }))] });
    log.result("root", [text("PARENT RESULT NOISE")]);
    const parsed = await parseRows(log.close());
    expect(parsed.entries.filter((entry) => entry.kind === "question")).toHaveLength(1);
    expect(parsed.entries.filter((entry) => entry.kind === "decision")).toHaveLength(1);
    const dialogue = sessionToDialogue(parsed);
    expect(dialogue).toContain("回答「Which database?」：\nSQLite");
    expect(dialogue).not.toContain("PARENT PROGRAM NOISE");
    expect(dialogue).not.toContain("PARENT RESULT NOISE");
  });

  it("does not traverse opaque ignorable payloads, injected user-role content, or failed attempt streams", async () => {
    const log = fixture();
    log.user("Human question");
    log.user("INJECTED PRIVATE TEXT", { kind: "plugin", plugin: "custom-plugin" });
    log.event("custom/record", { content: "OPAQUE PRIVATE TEXT", nested: {
      type: "user/message", source: { kind: "user" }, text: "FAKE USER TEXT",
      name: "ask_user_question", arguments: { questions: [questions[0]] },
    } }, { ignorable: true, surfaceOp: "append" });
    log.event("assistant/attempt", { turn: 1, step: 1, stream: [{ type: "text-chunks", time0: EPOCH, index: 0, dt: [], texts: ["ATTEMPT PRIVATE TEXT"] }] });
    log.assistant([text("Visible prefix")], true);
    const parsed = await parseRows(log.close());
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Human question", "Visible prefix"]);
    expect(parsed.diagnostics?.unknownTypes).toContain("custom/record");
    const serialized = JSON.stringify(parsed.entries);
    for (const secret of ["INJECTED PRIVATE TEXT", "OPAQUE PRIVATE TEXT", "FAKE USER TEXT", "ATTEMPT PRIVATE TEXT"]) expect(serialized).not.toContain(secret);
  });

  it("preserves original human questions across model-only replacement checkpoints", async () => {
    const log = fixture();
    const humanSeq = log.user("Original human question");
    log.assistant([text("Original answer")]);
    const assistantSeq = log.rows.length - 2;
    log.event("compaction/start", { compactionId: "compact", turn: 1 });
    log.event("compaction/summary", { compactionId: "compact", summary: [text("Public compaction summary")],
      shadowedRange: { start: humanSeq, end: assistantSeq }, shadowedSeqs: [humanSeq, assistantSeq], shadowedTokenCount: 12, provider: "mock", model: "mock" });
    log.user("MODEL-ONLY CHECKPOINT BODY", { kind: "plugin", plugin: "compact", compactionId: "compact" }, {
      surfaceOp: { op: "replace", startSeq: humanSeq, endSeq: assistantSeq }, sourceEventSeqs: [humanSeq, assistantSeq],
    });
    log.event("compaction/end", { compactionId: "compact", turn: 1 });
    const parsed = await parseRows(log.close());
    const dialogue = sessionToDialogue(parsed);
    expect(dialogue).toContain("Original human question");
    expect(dialogue).toContain("Original answer");
    expect(dialogue).toContain("Public compaction summary");
    expect(dialogue).not.toContain("MODEL-ONLY CHECKPOINT BODY");
    expect(parsed.entries.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
  });

  it("keeps the embedded fork prefix once without reading a parent session", async () => {
    const log = fixture("fork-synthetic");
    log.rows[0] = { ...header(3, "fork-synthetic"), isSeeded: true, parentSession: "absent-parent" };
    log.user("Inherited question");
    log.assistant([text("Inherited answer")]);
    log.close();
    log.event("session/end-seed", { inherited: true });
    const parsed = await parseRows(log.rows);
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Inherited question", "Inherited answer"]);
  });

  it("pairs repeated question ids within their call and step, including seq provenance", async () => {
    const log = fixture();
    const firstCall = log.call("first-ask", "ask_user_question", { questions: [questions[0]] });
    const firstResult = log.result("first-ask", [text(JSON.stringify({ answers: [{ id: "database", selected: ["SQLite"] }] }))]);
    log.rows[firstResult + 1].sourceEventSeqs = [firstCall];
    log.nextStep();
    const secondCall = log.call("second-ask", "ask_user_question", { questions: [questions[0]] });
    const secondResult = log.result("second-ask", [text(JSON.stringify({ answers: [{ id: "database", selected: ["PostgreSQL"] }] }))]);
    log.rows[secondResult + 1].sourceEventSeqs = [secondCall];
    const parsed = await parseRows(log.close());
    expect(parsed.entries.filter((entry) => entry.kind === "decision").map((entry) => entry.text)).toEqual([
      "回答「Which database?」：\nSQLite", "回答「Which database?」：\nPostgreSQL",
    ]);
  });

  it("refuses unknown required records instead of silently producing a partial transcript", async () => {
    const log = fixture();
    log.user("A visible question before an unknown required record");
    log.event("custom/required", { text: "must not silently skip" });
    await expect(parseRows(log.close())).rejects.toThrow(/custom\/required|unknown|required|unrecognized/i);
  });
});

describe("DSH v4 transcript", () => {
  const parseV4 = (rows: readonly unknown[]) => parseRows(rows, "session.v4.jsonl");

  it("pairs first-class tool-role results with their calls without exposing the system prompt", async () => {
    const log = fixture("dsh-v4-synthetic", 4);
    log.user("Inspect this v4 example");
    log.assistant([text("Running the reader. ")]);
    log.call("read", "read", { path: "/synthetic" });
    log.result("read", [text("V4 TOOL OUTPUT")]);
    log.nextStep();
    log.assistant([text("Final v4 response")]);
    const parsed = await parseV4(log.close());
    expect(parsed).toMatchObject({ agent: "dsh", id: "dsh-v4-synthetic", cwd: "/synthetic/project" });
    expect(parsed.entries.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual(["Inspect this v4 example"]);
    expect(parsed.entries.filter((entry) => entry.role === "assistant").map((entry) => entry.text)).toEqual(["Running the reader. ", "Final v4 response"]);
    const tools = parsed.entries.filter((entry) => entry.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].tool).toMatchObject({ callId: "read", name: "read", result: { type: "success", log: "V4 TOOL OUTPUT" } });
    expect(sessionToDialogue(parsed)).not.toContain("SYSTEM PRIVATE CONTEXT");
  });

  it("pairs v4 dialogue answers with their questions, including custom replies", async () => {
    const log = fixture("dsh-v4-synthetic", 4);
    log.user("Please ask before selecting storage");
    log.call("ask", "ask_user_question", { questions: [questions[0], questions[2]] });
    log.result("ask", [text(JSON.stringify({ answers: [
      { id: "database", selected: ["SQLite"], custom: "本地优先" },
      { id: "notes", selected: [] },
    ] }))]);
    const parsed = await parseV4(log.close());
    expect(parsed.entries.filter((entry) => entry.kind === "question").map((entry) => entry.data?.questionId)).toEqual(["database", "notes"]);
    const decisions = parsed.entries.filter((entry) => entry.kind === "decision");
    expect(decisions.map((entry) => entry.data?.questionId)).toEqual(["database", "notes"]);
    expect(decisions[0]?.text).toContain("回答「Which database?」：\nSQLite\n本地优先");
    expect(decisions[1]?.text).toContain("（未选择）");
  });

  it("preserves original human questions across v4 compact-checkpoint replacements", async () => {
    const log = fixture("dsh-v4-synthetic", 4);
    const humanSeq = log.user("Original v4 question");
    log.assistant([text("Original v4 answer")]);
    const assistantSeq = log.rows.length - 2;
    log.event("compaction/start", { compactionId: "compact", turn: 1 });
    log.event("compaction/summary", { compactionId: "compact", summary: [text("Public v4 summary")],
      shadowedRange: { start: humanSeq, end: assistantSeq }, shadowedSeqs: [humanSeq, assistantSeq], shadowedTokenCount: 12, provider: "mock", model: "mock" });
    log.user("MODEL-ONLY V4 CHECKPOINT BODY", { kind: "compact-checkpoint", compactionId: "compact" }, {
      surfaceOp: { op: "replace", startSeq: humanSeq, endSeq: assistantSeq }, sourceEventSeqs: [humanSeq, assistantSeq],
    });
    log.event("compaction/end", { compactionId: "compact", turn: 1 });
    const parsed = await parseV4(log.close());
    const dialogue = sessionToDialogue(parsed);
    expect(dialogue).toContain("Original v4 question");
    expect(dialogue).toContain("Original v4 answer");
    expect(dialogue).toContain("Public v4 summary");
    expect(dialogue).not.toContain("MODEL-ONLY V4 CHECKPOINT BODY");
  });

  it("keeps the embedded fork prefix once under a seeded v4 header", async () => {
    const log = fixture("v4-fork-synthetic", 4);
    log.rows[0] = { ...header(4, "v4-fork-synthetic"), isSeeded: true, parentSession: "absent-parent" };
    log.user("Inherited v4 question");
    log.assistant([text("Inherited v4 answer")]);
    log.close();
    log.event("session/end-seed", { inherited: true });
    const parsed = await parseV4(log.rows);
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Inherited v4 question", "Inherited v4 answer"]);
  });

  it("classifies v4-only event types as known instead of unknown diagnostics", async () => {
    const log = fixture("dsh-v4-synthetic", 4);
    log.user("Check diagnostics");
    log.event("developer/message", { turn: 1, step: 1, message: {
      id: "dev", role: "developer", source: { kind: "runtime-context" }, content: [text("DEVELOPER PRIVATE TEXT")],
    } }, { surfaceOp: "append" });
    log.event("workspace/changes", { changes: [] });
    log.assistant([text("Done")]);
    const parsed = await parseV4(log.close());
    expect(parsed.diagnostics?.unknown).toBe(0);
    expect(parsed.diagnostics?.unknownTypes).toEqual([]);
    expect(JSON.stringify(parsed.entries)).not.toContain("DEVELOPER PRIVATE TEXT");
  });

  it("refuses formats newer than v4 instead of guessing a partial transcript", async () => {
    const path = await writeLog([header(5)], join(await temporaryDirectory(), "session.v5.jsonl"));
    await expect(refFromDshFile(path)).rejects.toThrow(/v5.*最高支持 v4|更新的存档格式/);
  });
});

/** Released v0 shapes copied semantically from the official migration tests, never from a user session. */
function legacyRows(packed: boolean): Row[] {
  const rows: Row[] = [header(0, "legacy-synthetic")];
  let seq = 0;
  const event = (type: string, data: unknown, metadata: Row = {}) => {
    rows.push({ type, seq, time: EPOCH + seq + 1, data, ...metadata });
    seq++;
  };
  event("turn/start", { turn: 1 });
  event("step/start", { turn: 1, step: 1 });
  event("user/message", { content: [text("Legacy human question")], source: { kind: "user" } }, { surfaceOp: "append" });
  event("request/header", { header: { config: { provider: "mock", model: "mock" }, system: "LEGACY SYSTEM PRIVATE TEXT" }, reason: "initial" });
  let sources: number[][] | undefined;
  if (packed) {
    const firstSeq = seq;
    rows.push({ type: "text-chunks", seq0: seq, time0: EPOCH + seq + 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["Legacy ", "assistant answer"] } });
    seq += 2;
    event("assistant/chunk", { turn: 1, step: 1, chunk: { type: "finish", reason: { kind: "stop" } } });
    sources = [[firstSeq, seq - 1]];
  }
  event("assistant/message", { turn: 1, step: 1, content: [text("Legacy assistant answer")], provenance: { provider: "mock", model: "mock" } }, {
    surfaceOp: "append", ...(sources ? { sourceEventSeqs: sources } : {}),
  });
  event("step/end", { turn: 1, step: 1 });
  event("turn/end", { turn: 1, reason: { kind: "completed" } });
  return rows;
}

describe("DSH released formats and discovery", () => {
  it.each([false, true])("restores legacy v0 through official migrations without rewriting the source (packed=%s)", async (packed) => {
    const directory = await temporaryDirectory();
    const path = await writeLog(legacyRows(packed), join(directory, "session.jsonl"));
    const original = await readFile(path);
    const parsed = await parseDsh(await refFromDshFile(path));
    expect(parsed.entries.map((entry) => [entry.role, entry.text])).toEqual([["user", "Legacy human question"], ["assistant", "Legacy assistant answer"]]);
    expect(sessionToDialogue(parsed)).not.toContain("LEGACY SYSTEM PRIVATE TEXT");
    expect(await readFile(path)).toEqual(original);
    expect(await readdir(directory)).toEqual(["session.jsonl"]);
  });

  it("also restores the shared-message layout written under a v0 header", async () => {
    const rows = legacyRows(false);
    rows.find((row) => row.type === "user/message")!.data = {
      id: "shared-user", role: "user", source: { kind: "user" }, content: [text("Legacy human question")],
    };
    rows.find((row) => row.type === "assistant/message")!.data = {
      turn: 1, step: 1, message: { id: "shared-assistant", role: "assistant",
        source: { kind: "model", provider: "mock", model: "mock" }, content: [text("Legacy assistant answer")] },
    };
    const path = await writeLog(rows, join(await temporaryDirectory(), "session.jsonl"));
    const parsed = await parseDsh(await refFromDshFile(path));
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Legacy human question", "Legacy assistant answer"]);
  });

  it("preserves the official refusal of legacy descriptor v2 instead of rewriting it to v3", async () => {
    const directory = await temporaryDirectory();
    const path = await writeLog([header(0), { type: "subagent/descriptor", seq: 0, time: EPOCH,
      data: { version: 2, mode: "continuable", provider: "mock", label: "synthetic old child" },
    }], join(directory, "session.jsonl"));
    const before = await readFile(path);
    await expect(parseDsh(await refFromDshFile(path))).rejects.toThrow(/unsupported descriptor version 2/);
    expect(await readFile(path)).toEqual(before);
  });

  it("discovers the highest canonical generation while an explicit file still names the exact older generation", async () => {
    const directory = await temporaryDirectory();
    const oldPath = await writeLog(legacyRows(false), join(directory, "one-session", "session.jsonl"));
    const current = fixture("legacy-synthetic");
    current.user("New-generation question");
    current.assistant([text("New-generation answer")]);
    const currentPath = await writeLog(current.close(), join(directory, "one-session", "session.v3.jsonl"));
    await writeFile(join(directory, "one-session", "session.v99.jsonl.tmp"), "ignored temporary artifact");
    const refs = await discoverDsh(directory);
    expect(refs.map((ref) => ref.path)).toEqual([currentPath]);
    expect((await parseDsh(refs[0])).entries[0]?.text).toBe("New-generation question");
    expect((await parseDsh(await refFromDshFile(oldPath))).entries[0]?.text).toBe("Legacy human question");
  });

  it("refuses an unsupported highest generation instead of falling back to older data", async () => {
    const directory = await temporaryDirectory();
    await writeLog(legacyRows(false), join(directory, "session.jsonl"));
    await writeLog([header(99)], join(directory, "session.v99.jsonl"));
    await expect(discoverDsh(directory)).rejects.toThrow(/99|unsupported|newer|format/i);
  });

  it("rejects a generation filename/header mismatch and ambiguous same-generation encodings", async () => {
    const directory = await temporaryDirectory();
    const mismatch = await writeLog([header(3)], join(directory, "session.v2.jsonl"));
    await expect(refFromDshFile(mismatch)).rejects.toThrow(/文件名版本/);
    await writeLog([header(3)], join(directory, "session.v3.jsonl"));
    await writeFile(join(directory, "session.v3.jsonl.zstd"), "not opened when selection is ambiguous");
    await expect(discoverDsh(directory)).rejects.toThrow(/同一代/);
  });

  it.skipIf(typeof zlib.zstdCompressSync !== "function")("reads concatenated Zstandard frames with a JSON line split between frames", async () => {
    const log = fixture();
    log.user("Compressed question 压缩问题");
    log.assistant([text("Compressed answer")]);
    const bytes = Buffer.from(jsonl(log.close()));
    const split = bytes.indexOf(Buffer.from("压缩")) + 1;
    const path = join(await temporaryDirectory(), "session.v3.jsonl.zstd");
    await writeFile(path, Buffer.concat([zlib.zstdCompressSync(bytes.subarray(0, split)), zlib.zstdCompressSync(bytes.subarray(split))]));
    const parsed = await parseDsh(await refFromDshFile(path));
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["Compressed question 压缩问题", "Compressed answer"]);
  });
});
