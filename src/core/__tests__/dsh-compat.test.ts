import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDsh, refFromDshFile } from "../adapters/dsh.js";
import { searchRefs, sessionToDialogue, sessionToText } from "../index.js";
import { renderSessionMarkdown } from "../../markdown/index.js";
import { renderSessionHtml } from "../../html/index.js";

type Row = Record<string, any>;
const directories: string[] = [];
const text = (value: string) => ({ type: "text", text: value });
const header = (version: number): Row => ({ type: "session", version, id: "compat", createdAt: 1, cwd: "/synthetic" });
const event = (type: string, seq: number, data: unknown, extra: Row = {}): Row => ({ type, seq, time: seq + 2, data, ...extra });
const user = (seq: number, value: string): Row => event("user/message", seq, { source: { kind: "user" }, content: [text(value)] }, { surfaceOp: "append" });
const assistant = (seq: number, value: string): Row => event("assistant/message", seq, { message: { role: "assistant", content: [text(value)] } }, { surfaceOp: "append" });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function log(rows: unknown[], version = 4) {
  const directory = await mkdtemp(join(tmpdir(), "asmgr-dsh-compat-"));
  directories.push(directory);
  const path = join(directory, version ? `session.v${version}.jsonl` : "session.jsonl");
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { path, ref: await refFromDshFile(path) };
}
async function parse(rows: unknown[], version = 4) {
  return parseDsh((await log(rows, version)).ref);
}

describe("DSH read-only compatibility contract", () => {
  it.each([0, 1, 2, 3, 4, 5, 99])("reads stable human/assistant carriers under generation %s", async version => {
    const parsed = await parse([header(version), user(0, "Question"), event("subagent/descriptor", 1, { version: 999 }), assistant(2, "Answer")], version);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Question", "Answer"]);
    expect(parsed.source?.lossy).toBe(version > 4);
  });

  it.each([0, 1, 2])("reads legacy flat tools, code dispatch, steering, packed runs and compact aliases (v%s)", async version => {
    const ask = { questions: [{ id: "q", question: "Choose?", options: [{ label: "A" }, { label: "B" }] }] };
    const rows: Row[] = [header(version), event("turn/start", 0, { turn: 1 }), event("step/start", 1, { step: 1 }), user(2, "Original question"),
      { type: "text-chunks", seq0: 3, time0: 5, data: { turn: 1, step: 1, index: 0, dt: [-1], texts: ["CHUNK", " PRIVATE"] } },
      event("assistant/message", 5, { content: [text("Settled answer")], provenance: { provider: "mock" } }, { surfaceOp: "append" }),
      event("tool/call", 6, { callId: "read", name: "read", arguments: "{}" }),
      event("tool/result", 7, { callId: "read", content: [text("Tool output")], isError: false }, { surfaceOp: "append", sourceEventSeqs: [[6, 6]] }),
      event("tool/code-dispatch-start", 8, { subCallId: "ask", name: "ask_user_question", arguments: ask }),
      event("tool/code-dispatch", 9, { subCallId: "ask", name: "ask_user_question", arguments: ask, content: [text(JSON.stringify({ answers: [{ id: "q", selected: ["B"] }] }))], isError: false }),
      event("steering/message", 10, { turn: 1, message: { source: { kind: "user" }, content: [text("Steering question")] } }, { surfaceOp: "append" }),
      event("compact/start", 11, { turn: 1 }),
      event("compact/summary", 12, { summary: [text("Compaction summary")] }),
      event("user/message", 13, { source: { kind: "plugin", plugin: "compact" }, content: [text("PRIVATE CHECKPOINT")] }, { surfaceOp: { op: "replace", start: 2, end: 5 } }),
      event("compact/end", 14, {}),
    ];
    const parsed = await parse(rows, version);
    expect(parsed.entries.filter(entry => entry.kind === "decision")[0]?.text).toContain("B");
    expect(parsed.entries.find(entry => entry.tool?.callId === "read")?.tool?.result?.log).toBe("Tool output");
    const dialogue = sessionToDialogue(parsed);
    for (const visible of ["Original question", "Settled answer", "Steering question", "Compaction summary", "Choose?"]) expect(dialogue).toContain(visible);
    expect(dialogue).not.toContain("PRIVATE");
    expect(parsed.source?.lossy).toBe(false);
  });

  it("continues across seed markers, displaying inherited history only once", async () => {
    const parsed = await parse([header(0), user(0, "Inherited"), event("session/end-seed", 1, { inherited: true }), user(2, "New"),
      event("session/end-seed", 3, { inherited: true }), assistant(4, "Latest")], 0);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Inherited", "New", "Latest"]);
  });

  it("accepts additive fields without recursively reading private metadata or embedded streams", async () => {
    const a = assistant(2, "Visible answer");
    a.data.message.future = "PRIVATE";
    a.data.stream = [{ type: "text-chunks", texts: ["PRIVATE STREAM"] }];
    a.meta = { text: "PRIVATE META" };
    const parsed = await parse([header(4), user(0, "Visible question"), event("subagent/descriptor", 1, "opaque future payload"), a]);
    expect(parsed.source?.lossy).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });

  it("continues after malformed rows and malformed known carriers without guessing authors or text", async () => {
    const { path, ref } = await log([header(4), user(0, "Before"),
      event("assistant/message", 1, { message: null }, { surfaceOp: "append" }),
      event("tool/result", 2, { message: { content: [{ type: "text", text: "PRIVATE FAKE TOOL WRAPPER" }] } }, { surfaceOp: "append" }),
      event("user/message", 3, { content: [text("PRIVATE UNKNOWN AUTHOR")] }, { surfaceOp: "append" }),
      assistant(4, "After")]);
    const original = await readFile(path, "utf8");
    await writeFile(path, original + "{broken JSON\nnull\n");
    const parsed = await parseDsh(ref);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Before", "After"]);
    expect(parsed.source?.lossy).toBe(true);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toEqual(expect.arrayContaining(["invalid-content", "invalid-tool-result", "unknown-source", "invalid-row"]));
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });

  it("keeps valid text alongside unknown content blocks and invalid timestamps", async () => {
    const message = assistant(1, "Visible");
    message.time = "new clock";
    message.data.message.content.push({ type: "future-block", text: "PRIVATE BLOCK" });
    const parsed = await parse([header(4), user(0, "Question"), message]);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Question", "Visible"]);
    expect(parsed.entries[1]?.timestamp).toBeUndefined();
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toEqual(expect.arrayContaining(["invalid-envelope", "unknown-content"]));
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE BLOCK");
  });

  it("diagnoses changed surface operations instead of treating a replacement as fresh dialogue", async () => {
    const changed = user(1, "PRIVATE UNKNOWN SURFACE");
    changed.surfaceOp = { op: "new-operation" };
    const parsed = await parse([header(4), user(0, "Before"), changed, assistant(2, "After")]);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Before", "After"]);
    expect(parsed.diagnostics?.issues?.[0]?.code).toBe("unknown-surface");
  });

  it("accepts replacement endpoints whose surface order differs from numeric seq order", async () => {
    const checkpoint = user(3, "PRIVATE CHECKPOINT");
    checkpoint.data.source = { kind: "compact-checkpoint", compactionId: "c" };
    checkpoint.surfaceOp = { op: "replace", startSeq: 2, endSeq: 0 };
    const parsed = await parse([header(4), user(0, "Original"), event("compaction/summary", 1, { compactionId: "c", summary: [text("Summary")] }),
      assistant(2, "Answer"), checkpoint]);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Original", "Answer", "Summary"]);
    expect(parsed.source?.lossy).toBe(false);
  });

  it("does not infer decisions from ambiguous duplicate tool ids or mismatched explicit provenance", async () => {
    const args = JSON.stringify({ questions: [{ id: "q", question: "Choose?", options: [{ label: "A" }] }] });
    const result = { role: "tool", toolCallId: "ask", isError: false, content: [text(JSON.stringify({ answers: [{ id: "q", selected: ["A"] }] }))] };
    const parsed = await parse([header(4), event("tool/call", 0, { callId: "ask", name: "ask_user_question", arguments: args }),
      event("tool/call", 1, { callId: "ask", name: "ask_user_question", arguments: args }),
      event("tool/result", 2, { message: result }, { surfaceOp: "append" }),
      event("tool/result", 3, { message: result }, { surfaceOp: "append", sourceEventSeqs: [999] })]);
    expect(parsed.entries.filter(entry => entry.kind === "question")).toHaveLength(2);
    expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toEqual(["ambiguous-tool-result", "unmatched-tool-result"]);
  });

  it("shows compatibility warnings in text, dialogue, Markdown and HTML and search with no hits", async () => {
    const { ref } = await log([header(5), user(0, "Question"), event("future/required", 1, { text: "PRIVATE FUTURE PAYLOAD" }), assistant(2, "Answer")], 5);
    const parsed = await parseDsh(ref);
    const warning = parsed.source?.warning;
    expect(warning).toContain("future/required");
    for (const rendered of [sessionToText(parsed), sessionToDialogue(parsed), renderSessionMarkdown(parsed), await renderSessionHtml(parsed)]) {
      expect(rendered).toContain("future/required");
      expect(rendered).toContain("Question");
      expect(rendered).toContain("Answer");
      expect(rendered).not.toContain("PRIVATE FUTURE PAYLOAD");
    }
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await searchRefs([ref], "not present")).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("future/required"));
  });

  it("retains per-session search resilience for genuine file I/O errors", async () => {
    const { ref } = await log([header(4), user(0, "needle")]);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const hits = await searchRefs([{ ...ref, path: join(directories[0], "missing.jsonl") }, ref], "needle");
    expect(hits).toHaveLength(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("跳过无法解析"));
  });

  it.each(["invalid", [], ["bad"], [[2, 1]], [[-1, 0]], [0, "bad"]].map(sourceEventSeqs => ({ sourceEventSeqs })))("does not infer decisions with unusable explicit provenance $sourceEventSeqs", async ({ sourceEventSeqs }) => {
    const args = { questions: [{ id: "q", question: "Choose?" }] };
    const parsed = await parse([header(4), event("tool/call", 0, { callId: "ask", name: "ask_user_question", arguments: JSON.stringify(args) }),
      event("tool/result", 1, { message: { role: "tool", toolCallId: "ask", isError: false,
        content: [text(JSON.stringify({ answers: [{ id: "q", selected: [] }] }))] } }, { surfaceOp: "append", sourceEventSeqs })]);
    expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toContain("invalid-provenance");
  });

  it("preserves ambiguity when calls collide at a stored seq", async () => {
    const args = { questions: [{ id: "q", question: "Choose?" }] };
    const parsed = await parse([header(4), ...[0, 1].map(() => event("tool/call", 0, { callId: "ask", name: "ask_user_question", arguments: JSON.stringify(args) })),
      event("tool/result", 1, { message: { role: "tool", toolCallId: "ask", isError: false,
        content: [text(JSON.stringify({ answers: [{ id: "q", selected: [] }] }))] } }, { surfaceOp: "append", sourceEventSeqs: [0] })]);
    expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toEqual(expect.arrayContaining(["duplicate-call-seq", "ambiguous-tool-result"]));
  });

  it.each(["tool/ptc-dispatch", "tool/code-dispatch"])("rejects mismatched and duplicate starts for %s", async type => {
    const args = { questions: [{ id: "q", question: "Original?" }] };
    const start = { subCallId: "ask", name: "ask_user_question", rootCallId: "root", parentCallId: "parent", arguments: args };
    const answer = [text(JSON.stringify({ answers: [{ id: "q", selected: [], custom: "untrusted answer" }] }))];
    for (const change of [{ rootCallId: "other" }, { parentCallId: "other" }, { name: "other" }, { arguments: { questions: [{ id: "q", question: "Other?" }] } }]) {
      const parsed = await parse([header(4), event(`${type}-start`, 0, start), event(type, 1, { ...start, ...change, isError: false, content: answer })]);
      expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
      expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toContain("ambiguous-dispatch");
    }
    const parsed = await parse([header(4), event(`${type}-start`, 0, start), event(`${type}-start`, 1, start), event(type, 2, { ...start, isError: false, content: answer })]);
    expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toContain("ambiguous-dispatch");
  });

  it("does not treat malformed error flags or foreign-role carriers as successful tool responses", async () => {
    const answer = [text(JSON.stringify({ answers: [{ id: "q", selected: [] }] }))];
    const parsed = await parse([header(4), event("tool/call", 0, { callId: "ask", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q", question: "Choose?" }] }) }),
      event("tool/result", 1, { message: { role: "user", content: [{ type: "tool-result", toolCallId: "ask", content: answer, isError: "true" }] } }, { surfaceOp: "append" }),
      event("tool/result", 2, { message: { role: "system", callId: "ask", isError: false, content: [text("PRIVATE SYSTEM CONTENT")] } }, { surfaceOp: "append" }),
      event("tool/ptc-dispatch", 3, { subCallId: "ptc", name: "ask_user_question", arguments: { questions: [{ id: "q", question: "Other?" }] }, isError: "false", content: answer })]);
    expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toEqual(expect.arrayContaining(["invalid-tool-result", "invalid-dispatch"]));
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE SYSTEM CONTENT");
  });

  it("does not infer answers when error metadata contradicts a successful tool result", async () => {
    const parsed = await parse([header(4), event("tool/call", 0, { callId: "ask", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q", question: "Choose?" }] }) }),
      event("tool/result", 1, { error: { code: "ASK_CANCELLED" }, message: { role: "tool", toolCallId: "ask", isError: false,
        content: [text(JSON.stringify({ answers: [{ id: "q", selected: [] }] }))] } }, { surfaceOp: "append" })]);
    expect(parsed.entries.filter(entry => entry.kind === "decision")).toHaveLength(0);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toContain("invalid-tool-status");
  });

  it("diagnoses malformed question parameters and preserves later messages", async () => {
    const parsed = await parse([header(4), event("tool/call", 0, { callId: "ask", name: "ask_user_question", arguments: { questions: "unknown layout" } }), assistant(1, "Visible answer")]);
    expect(parsed.diagnostics?.issues?.map(issue => issue.code)).toContain("invalid-question");
    expect(sessionToDialogue(parsed)).toContain("Visible answer");
  });

  it("keeps named non-user producers model-only without interpreting their private vocabularies", async () => {
    const injection = user(0, "PRIVATE PRODUCER BODY");
    injection.data.source.kind = "new-plugin-producer";
    const parsed = await parse([header(4), injection, assistant(1, "Visible")]);
    expect(parsed.entries.map(entry => entry.text)).toEqual(["Visible"]);
    expect(parsed.diagnostics?.ignored).toBe(1);
    expect(parsed.source?.lossy).toBe(false);
  });

  it("bounds unknown-type names and samples with total counts intact", async () => {
    const parsed = await parse([header(4), ...Array.from({ length: 1000 }, (_, i) => event(`future/${i}-${"x".repeat(200)}`, i, {}))]);
    expect(parsed.diagnostics?.unknown).toBe(1000);
    expect(parsed.diagnostics?.unknownTypes).toHaveLength(128);
    expect(parsed.diagnostics?.unknownTypesTruncated).toBe(true);
    expect(parsed.diagnostics?.unknownTypes.every(type => type.length <= 160 && type.endsWith("…"))).toBe(true);
  });

  it("bounds payload-free issue samples while counting repeated unknown rows", async () => {
    const rows = [header(4), user(0, "Question"), ...Array.from({ length: 80 }, (_, i) => event(`future/${i}`, i + 1, { secret: "PRIVATE" }))];
    const parsed = await parse(rows);
    expect(parsed.diagnostics?.unknown).toBe(80);
    expect(parsed.diagnostics?.issues).toHaveLength(51);
    expect(parsed.diagnostics?.issues?.at(-1)).toMatchObject({ code: "diagnostic-limit", count: 30 });
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });
});
