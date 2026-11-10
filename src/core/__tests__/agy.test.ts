import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgent, findSessionAmong, parseSession, refFromFile, discoverSessions } from "../index.js";
import { discoverAgy, probeAgyIdentity } from "../adapters/agy.js";
import { selectTurnEntries } from "../index.js";
import { readJsonl } from "../fs.js";

const root = resolve(fileURLToPath(new URL("../../../fixtures/agy/home/antigravity-cli", import.meta.url)));
const brain = resolve(root, "brain");
const mainId = "11111111-aaaa-4bbb-8ccc-000000000001";
const subagentId = "11111111-aaaa-4bbb-8ccc-000000000002";
const mainPath = resolve(brain, mainId, ".system_generated/logs/transcript.jsonl");
const subagentPath = resolve(brain, subagentId, ".system_generated/logs/transcript.jsonl");

describe("agy discovery", () => {
  it("finds conversations under the brain root and enriches cwd from history.jsonl", async () => {
    const refs = await discoverAgy(brain);
    expect(refs.map((ref) => ref.id).sort()).toEqual([mainId, subagentId]);
    const main = findSessionAmong(refs, mainId)!;
    // First recorded workspace wins, matching session-start cwd semantics.
    expect(main.cwd).toBe("/home/demo/project");
    expect(main.agent).toBe("agy");
    expect(main.path).toBe(mainPath);
  });

  it("joins the default agent scan", async () => {
    const refs = await discoverSessions(["agy"], { agy: brain });
    expect(refs.length).toBe(2);
    expect(refs.every((ref) => ref.agent === "agy")).toBe(true);
    const enriched = findSessionAmong(refs, mainId)!;
    expect(enriched.startedAt).toBe("2026-11-08T10:00:00Z");
  });
});

describe("agy parsing", () => {
  it("prefers transcript_full.jsonl and keeps the compact ref lossless", async () => {
    const session = await parseSession({ agent: "agy", id: mainId, path: mainPath });
    expect(session.source?.kind).toBe("agy-transcript");
    expect(session.source?.path?.endsWith("transcript_full.jsonl")).toBe(true);
    expect(session.source?.lossy).toBeFalsy();
    // The compact-only truncation markers must NOT trigger a lossy warning here.
    expect(session.source?.warning).toBeUndefined();
    expect(session.identity!.role).toBe("main");
    expect(session.startedAt).toBe("2026-11-08T10:00:00Z");
    expect(session.updatedAt).toBe("2026-11-08T10:05:02Z");
  });

  it("maps every AGY row type onto the unified timeline", async () => {
    const session = await parseSession({ agent: "agy", id: mainId, path: mainPath });
    const byRoleKind = session.entries.map((entry) => `${entry.role}/${entry.kind}`);
    expect(byRoleKind).toContain("user/message");
    expect(byRoleKind).toContain("reasoning/thinking");
    expect(byRoleKind).toContain("tool/tool_use");
    expect(byRoleKind).toContain("tool/tool_result");
    expect(byRoleKind).toContain("assistant/text");
    expect(byRoleKind).toContain("system/system");
    expect(byRoleKind).toContain("system/compaction");
    expect(byRoleKind).toContain("event/error");
    // Verbatim user text: the full USER_REQUEST wrapper survives untouched.
    const user = session.entries.find((entry) => entry.role === "user")!;
    expect(user.text).toContain("<USER_REQUEST>");
    expect(user.text).toContain("帮我看一下这个目录里有什么");
    const compaction = session.entries.find((entry) => entry.kind === "compaction")!;
    expect(compaction.text).toContain("# Resuming from a compaction");
    const error = session.entries.find((entry) => entry.kind === "error")!;
    expect(error.text).toContain("API error (attempt 1)");
  });

  it("decodes one level of JSON-encoded tool arguments", async () => {
    const session = await parseSession({ agent: "agy", id: mainId, path: mainPath });
    const call = session.entries.find((entry) => entry.tool?.name === "run_command")!;
    expect(call.tool?.arguments).toMatchObject({
      CommandLine: "ls -la /home/demo/project",
      WaitMsBeforeAsync: 5000,
      toolSummary: "List project directory",
    });
  });

  it("pairs a single pending tool call with its GENERIC result and reads the exit code", async () => {
    const session = await parseSession({ agent: "agy", id: mainId, path: mainPath });
    const results = session.entries.filter((entry) => entry.kind === "tool_result");
    expect(results.length).toBe(3);
    const ok = results.find((entry) => entry.tool?.callId === "step1:0")!;
    expect(ok.tool?.name).toBe("run_command");
    expect(ok.tool?.result?.type).toBe("success");
    expect(ok.tool?.result?.log).toContain("Command exited with code 0");
    const failed = results.find((entry) => entry.tool?.callId === "step7:0")!;
    expect(failed.tool?.result?.type).toBe("failure");
    expect(failed.tool?.result?.log).toContain("Command exited with code 2");
  });

  it("accounts PLANNER_RESPONSE tokens as per-response increments and keeps CHECKPOINT out of totals", async () => {
    const session = await parseSession({ agent: "agy", id: mainId, path: mainPath });
    expect(session.stats?.accounting).toBe("responses");
    expect(session.stats?.calls).toBe(6);
    expect(session.stats?.totals).toEqual({
      inputTokens: 1200 + 1500 + 2100 + 2300 + 1000 + 800,
      cacheReadTokens: 3400 + 3600 + 3800 + 4000 + 50100 + 50200,
      outputTokens: 210 + 80 + 320 + 60 + 120 + 50,
    });
    expect(session.stats?.incomplete).toBe(false);
    const context = session.document!.usage.filter((usage) => usage.kind === "context");
    expect(context.length).toBe(1);
    expect(context[0]?.counted).toBe(false);
    expect(context[0]?.context?.inputTokens).toBe(900);
  });

  it("numbers turns over USER_INPUT rows only", async () => {
    const session = await parseSession({ agent: "agy", id: mainId, path: mainPath });
    const { entries, window } = selectTurnEntries("agy", session.entries, 2);
    expect(window.totalTurns).toBe(2);
    expect(entries[0]?.text).toContain("第二轮");
    expect(entries.length).toBe(2);
  });

  it("classifies a dispatched conversation as a subagent of the sender", async () => {
    const session = await parseSession({ agent: "agy", id: subagentId, path: subagentPath });
    expect(session.identity!.role).toBe("subagent");
    expect(session.identity!.parentSession).toBe(mainId);
    // Compact-only transcript with truncated_fields is explicitly lossy.
    expect(session.source?.lossy).toBe(true);
    expect(session.source?.warning).toContain("truncated_fields");
    const media = session.entries.find((entry) => entry.data?.media)?.data?.media as { mimeType?: string; uri?: string }[];
    expect(media?.[0]?.mimeType).toBe("image/png");
    expect(media?.[0]?.uri).toContain("step_3_media_0.png");
  });

  it("keeps a conversation without any user input or dispatch message honest", async () => {
    const identity = await probeAgyIdentity({ agent: "agy", id: mainId, path: mainPath });
    expect(identity.role).toBe("main");
    const subagent = await probeAgyIdentity({ agent: "agy", id: subagentId, path: subagentPath });
    expect(subagent).toEqual({ role: "subagent", parentSession: mainId });
  });
});

describe("agy source detection", () => {
  it("recognizes AGY rows in detectAgent", async () => {
    const rows = await readJsonl(mainPath, 10);
    expect(detectAgent(rows.slice(0, 10), mainPath)).toBe("agy");
  });

  it("derives the conversation id from a transcript path in refFromFile", async () => {
    const ref = await refFromFile(mainPath);
    expect(ref.agent).toBe("agy");
    expect(ref.id).toBe(mainId);
    const subagentRef = await refFromFile(subagentPath, "agy");
    expect(subagentRef.id).toBe(subagentId);
    // A transcript copied to an arbitrary filename still parses by content,
    // falling back to the file stem for the id.
    const copied = await refFromFile(resolve(root, "agy-standalone.jsonl"));
    expect(copied.agent).toBe("agy");
    expect(copied.id).toBe("agy-standalone");
  });
});
