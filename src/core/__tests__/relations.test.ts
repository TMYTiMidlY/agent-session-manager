import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentKind, ParsedSession } from "../types.js";
import { documentFromParsed, finalizeDocument } from "../normalized.js";
import {
  buildSessionGraph,
  documentObservedRange,
  peakConcurrency,
  probeIdentity,
  sessionKey,
  type GraphNodeInput,
} from "../relations.js";

function node(agent: AgentKind, id: string, extra: Partial<GraphNodeInput> = {}): GraphNodeInput {
  return { agent, id, ...extra };
}

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "asmgr-rel-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("buildSessionGraph", () => {
  it("links children by agent-scoped parentSession", () => {
    const graph = buildSessionGraph([
      node("dsh", "p1"),
      node("dsh", "c1", { identity: { role: "subagent", parentSession: "p1" } }),
    ]);
    const parentKey = sessionKey("dsh", "p1");
    expect(graph.childrenOf(parentKey).map((child) => child.key)).toEqual(["dsh:c1"]);
    expect(graph.nodes.get("dsh:c1")?.parentKey).toBe(parentKey);
    expect(graph.diagnostics).toEqual({ cycles: [], missingParents: [], missingForks: [], duplicates: [] });
  });

  it("never joins relations across agents with the same bare id", () => {
    const graph = buildSessionGraph([
      node("codex", "shared"),
      node("dsh", "child", { identity: { role: "subagent", parentSession: "shared" } }),
    ]);
    // The dsh child's parent is dsh:shared, which does not exist — the codex
    // session named "shared" must not be adopted as its parent.
    expect(graph.childrenOf(sessionKey("codex", "shared"))).toEqual([]);
    expect(graph.diagnostics.missingParents).toEqual([
      { key: "dsh:child", agent: "dsh", parentSession: "shared" },
    ]);
  });

  it("keeps forks separate from children", () => {
    const graph = buildSessionGraph([
      node("dsh", "base"),
      node("dsh", "kid", { identity: { role: "subagent", parentSession: "base" } }),
      node("dsh", "fork", { identity: { role: "main", forkOf: "base" } }),
    ]);
    const base = sessionKey("dsh", "base");
    expect(graph.childrenOf(base).map((child) => child.id)).toEqual(["kid"]);
    expect(graph.forksOf(base).map((fork) => fork.id)).toEqual(["fork"]);
  });

  it("detects parent-chain cycles", () => {
    const graph = buildSessionGraph([
      node("dsh", "a", { identity: { role: "subagent", parentSession: "b" } }),
      node("dsh", "b", { identity: { role: "subagent", parentSession: "a" } }),
    ]);
    expect(graph.diagnostics.cycles).toHaveLength(1);
    const cycle = graph.diagnostics.cycles[0]!.sort();
    expect(cycle).toEqual(["dsh:a", "dsh:b"]);
  });

  it("marks duplicate agent+id nodes as ambiguous instead of silently picking one", () => {
    const graph = buildSessionGraph([
      node("dsh", "f1", { identity: { role: "main", forkOf: "gone" } }),
      node("claude", "s", { startedAt: "2026-01-01T00:00:00.000Z" }),
      node("claude", "s", { startedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(graph.diagnostics.missingForks).toEqual([{ key: "dsh:f1", agent: "dsh", forkOf: "gone" }]);
    expect(graph.diagnostics.duplicates).toEqual([{ key: "claude:s", count: 2 }]);
    // First occurrence supplies the fields, but the pick is flagged, not silent.
    expect(graph.nodes.get("claude:s")?.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(graph.nodes.get("claude:s")?.ambiguous).toBe(true);
    expect(graph.nodes.get("dsh:f1")?.ambiguous).toBeUndefined();
  });
});

describe("peakConcurrency", () => {
  it("treats intervals as half-open: touching intervals are not concurrent", () => {
    const result = peakConcurrency([
      { startedAt: "2026-01-01T10:00:00Z", lastObservedAt: "2026-01-01T10:30:00Z" },
      { startedAt: "2026-01-01T10:30:00Z", lastObservedAt: "2026-01-01T11:00:00Z" },
    ]);
    expect(result.peak).toBe(1);
  });

  it("counts real overlaps", () => {
    const result = peakConcurrency([
      { startedAt: "2026-01-01T10:00:00Z", lastObservedAt: "2026-01-01T11:00:00Z" },
      { startedAt: "2026-01-01T10:15:00Z", lastObservedAt: "2026-01-01T10:45:00Z" },
      { startedAt: "2026-01-01T10:20:00Z", lastObservedAt: "2026-01-01T10:25:00Z" },
    ]);
    expect(result.peak).toBe(3);
    expect(result.at).toBe("2026-01-01T10:20:00Z");
    expect(result.unplaced).toBe(0);
  });

  it("compares parsed instants, not offset text: +02:00 overlaps a Z-scaled window", () => {
    // 10:00+02:00 IS 08:00Z — inside [08:15Z, 09:00Z)? No: it is before, but
    // the FIRST interval [08:00Z, 08:45Z) overlaps the second starting 08:15Z.
    const result = peakConcurrency([
      { startedAt: "2026-01-01T10:00:00+02:00", lastObservedAt: "2026-01-01T08:45:00Z" }, // 08:00→08:45Z
      { startedAt: "2026-01-01T08:15:00Z", lastObservedAt: "2026-01-01T09:00:00Z" },
    ]);
    expect(result.peak).toBe(2);
    expect(result.at).toBe("2026-01-01T08:15:00Z");
  });

  it("treats an invalid end instant as unknown, never as ongoing", () => {
    const result = peakConcurrency([
      { startedAt: "2026-01-01T10:00:00Z", lastObservedAt: "not-an-instant" },
      { startedAt: "2026-01-01T12:00:00Z", lastObservedAt: "2026-01-01T12:05:00Z" },
    ]);
    expect(result.peak).toBe(1); // the broken-end interval counts only at its own start
    expect(result.unplaced).toBe(0);
  });

  it("reports intervals without a valid start as unplaced", () => {
    const result = peakConcurrency([
      { startedAt: "2026-01-01T10:00:00Z", lastObservedAt: "2026-01-01T10:10:00Z" },
      { startedAt: undefined, lastObservedAt: "2026-01-01T10:05:00Z" },
      { startedAt: "garbage", lastObservedAt: "2026-01-01T10:06:00Z" },
    ]);
    expect(result.peak).toBe(1);
    expect(result.unplaced).toBe(2);
  });

  it("uses last-observed ends, never an ongoing forever-assumption", () => {
    const result = peakConcurrency([
      { startedAt: "2026-01-01T10:00:00Z", lastObservedAt: "2026-01-01T10:10:00Z" },
      { startedAt: "2026-01-01T12:00:00Z", lastObservedAt: undefined },
    ]);
    expect(result.peak).toBe(1);
    expect(result.unplaced).toBe(0);
  });
});

describe("documentObservedRange", () => {
  it("derives start/end from event instants (epoch), ignoring file mtime", () => {
    const parsed = {
      agent: "dsh", id: "t", path: "/tmp/t", entries: [],
      document: {
        format: "asmgr.session-document", version: 1,
        ref: { agent: "dsh", id: "t", path: "/tmp/t" },
        identity: { role: "main" }, meta: {},
        blocks: [], usage: [],
        events: [
          { type: "message/append", seq: 0, time: Date.parse("2026-03-01T09:00:00+08:00"), data: { block: {} } },
          { type: "usage/record", seq: 1, time: Date.parse("2026-03-01T02:30:00.000Z"), data: { usage: {} } },
          { type: "message/append", seq: 2, time: undefined, data: { block: {} } },
        ],
      },
    } as unknown as ParsedSession;
    const range = documentObservedRange(parsed);
    expect(range.startedAt).toBe("2026-03-01T01:00:00.000Z"); // the +08:00 event, by instant
    expect(range.lastObservedAt).toBe("2026-03-01T02:30:00.000Z");
  });

  it("does not attribute inherited parent time to a fork's own interval", () => {
    const parsed: ParsedSession = { agent: "dsh", id: "child", path: "/synthetic", startedAt: "2026-01-02T10:00:00Z", updatedAt: "2026-01-02T13:00:00Z", entries: [
      { index: 0, role: "assistant", kind: "message", text: "inherited", timestamp: "2026-01-01T01:00:00Z" },
      { index: 1, role: "assistant", kind: "message", text: "own", timestamp: "2026-01-02T12:00:00Z" },
    ] };
    parsed.document = finalizeDocument(documentFromParsed(parsed, { identity: { forkOf: "parent" }, usage: [] }));
    expect(documentObservedRange(parsed)).toEqual({ startedAt: "2026-01-02T10:00:00.000Z", lastObservedAt: "2026-01-02T13:00:00.000Z" });
  });

  it("falls back to recorded metadata when no event carries an instant", () => {
    const parsed = {
      agent: "codex", id: "t", path: "/tmp/t", entries: [],
      startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z",
      document: {
        format: "asmgr.session-document", version: 1,
        ref: { agent: "codex", id: "t", path: "/tmp/t" },
        identity: { role: "main" }, meta: {}, blocks: [], usage: [], events: [],
      },
    } as unknown as ParsedSession;
    expect(documentObservedRange(parsed)).toEqual({
      startedAt: "2026-01-01T00:00:00.000Z",
      lastObservedAt: "2026-01-01T01:00:00.000Z",
    });
  });
});

describe("probeIdentity", () => {
  it("prefers ref.identity outright", async () => {
    const identity = { role: "guardian" as const, parentSession: "p" };
    await expect(probeIdentity({ agent: "codex", id: "x", path: "/nonexistent", identity })).resolves.toBe(identity);
  });

  it("reads the DSH header: official origin values only (subagent); a valid unmarked header is main", async () => {
    const sub = await tempFile("sub.jsonl", `${JSON.stringify({ type: "session", version: 4, id: "s1", createdAt: 1767225600000, isSeeded: false, origin: "subagent", parentSession: "p1", delegationDepth: 2, agentPreset: "scout" })}\n`);
    await expect(probeIdentity({ agent: "dsh", id: "s1", path: sub })).resolves.toEqual({ role: "subagent", parentSession: "p1", delegationDepth: 2, agentPreset: "scout" });
    const plain = await tempFile("a.jsonl", `${JSON.stringify({ type: "session", version: 4, id: "a", createdAt: 1767225600000, isSeeded: false })}\n`);
    await expect(probeIdentity({ agent: "dsh", id: "a", path: plain })).resolves.toEqual({ role: "main" });
    const broken = await tempFile("b.jsonl", "not json\n");
    await expect(probeIdentity({ agent: "dsh", id: "b", path: broken })).resolves.toEqual({ role: "unknown" });
  });

  it("detects REAL Codex guardians via session_meta (thread_source/source.subagent), not a fabricated DSH origin", async () => {
    const guardian = await tempFile("g.jsonl", [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "g1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/g", thread_source: "guardian_review", parent_thread_id: "main-9" } }),
      "",
    ].join("\n"));
    await expect(probeIdentity({ agent: "codex", id: "g1", path: guardian })).resolves.toMatchObject({ role: "guardian", parentSession: "main-9" });

    const spawnGuardian = await tempFile("g2.jsonl", [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "g2", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/g", source: { subagent: { other: "guardian" } } } }),
      "",
    ].join("\n"));
    await expect(probeIdentity({ agent: "codex", id: "g2", path: spawnGuardian })).resolves.toMatchObject({ role: "guardian" });
  });

  it("maps Codex subagent metadata and keeps unrecognized/unreadable sources unknown, never a guessed main", async () => {
    const sub = await tempFile("s.jsonl", [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/s", thread_source: "subagent", parent_thread_id: "p" } }),
      "",
    ].join("\n"));
    await expect(probeIdentity({ agent: "codex", id: "s1", path: sub })).resolves.toMatchObject({ role: "subagent", parentSession: "p" });

    const bare = await tempFile("m.jsonl", [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [] } }),
      "",
    ].join("\n"));
    await expect(probeIdentity({ agent: "codex", id: "m", path: bare })).resolves.toEqual({ role: "unknown" });
    await expect(probeIdentity({ agent: "codex", id: "x", path: "/nonexistent" })).resolves.toEqual({ role: "unknown" });
  });

  it("Claude sidechain rows are subagents; readable mainline sessions are main; unreadable is unknown", async () => {
    const sidechain = await tempFile("c1.jsonl", [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", isSidechain: true, message: { role: "user", content: "hi" } }),
      "",
    ].join("\n"));
    await expect(probeIdentity({ agent: "claude", id: "c1", path: sidechain })).resolves.toEqual({ role: "subagent" });
    const mainline = await tempFile("c2.jsonl", [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }),
      "",
    ].join("\n"));
    await expect(probeIdentity({ agent: "claude", id: "c2", path: mainline })).resolves.toEqual({ role: "main" });
    await expect(probeIdentity({ agent: "claude", id: "x", path: "/nonexistent" })).resolves.toEqual({ role: "unknown" });
  });

  it("keeps the no-delegation convention only for sources with no subagent semantics", async () => {
    expect(await probeIdentity({ agent: "copilot", id: "x", path: "/nonexistent" })).toEqual({ role: "main" });
    expect(await probeIdentity({ agent: "chatgpt", id: "x", path: "/nonexistent" })).toEqual({ role: "main" });
    expect(await probeIdentity({ agent: "cursor", id: "x", path: "/nonexistent" })).toEqual({ role: "main" });
  });
});
