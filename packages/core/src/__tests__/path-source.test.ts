import { describe, expect, it } from "vitest";
import { mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../fs.js";
import { detectAgent, discoverPath, findSessionAmong, refFromFile, searchRefs } from "../index.js";

const fixtures = resolve(fileURLToPath(new URL("../../../../fixtures", import.meta.url)));

describe("agent detection", () => {
  it("detects copilot from events rows", async () => {
    expect(detectAgent(await readJsonl(join(fixtures, "copilot.events.jsonl")))).toBe("copilot");
  });

  it("detects claude from message rows", async () => {
    expect(detectAgent(await readJsonl(join(fixtures, "claude.jsonl")))).toBe("claude");
  });

  it("detects codex from payload rows", async () => {
    expect(detectAgent(await readJsonl(join(fixtures, "codex.jsonl")))).toBe("codex");
  });

  it("falls back to copilot for a bare events.jsonl filename", () => {
    expect(detectAgent([], "/somewhere/session-state/abc/events.jsonl")).toBe("copilot");
    expect(detectAgent([], "/somewhere/mystery.jsonl")).toBeUndefined();
  });
});

describe("refFromFile", () => {
  it("derives the copilot id from session.start and auto-detects the agent", async () => {
    const ref = await refFromFile(join(fixtures, "copilot", "copilot-fixture", "events.jsonl"));
    expect(ref.agent).toBe("copilot");
    expect(ref.id).toBe("copilot-fixture");
  });

  it("derives the codex id from session_meta payload", async () => {
    const ref = await refFromFile(join(fixtures, "codex.jsonl"));
    expect(ref.agent).toBe("codex");
    expect(ref.id).toBe("codex-fixture");
  });

  it("honours an explicit agent override", async () => {
    const ref = await refFromFile(join(fixtures, "claude.jsonl"), "claude");
    expect(ref.agent).toBe("claude");
  });
});

describe("discoverPath", () => {
  it("returns a single ref for a file", async () => {
    const refs = await discoverPath(join(fixtures, "copilot", "copilot-fixture", "events.jsonl"));
    expect(refs).toHaveLength(1);
    expect(refs[0]?.agent).toBe("copilot");
  });

  it("walks a directory and classifies each agent", async () => {
    const refs = await discoverPath(fixtures);
    const agents = new Set(refs.map((ref) => ref.agent));
    expect(agents).toEqual(new Set(["copilot", "claude", "codex"]));
  });

  it("throws for a missing path", async () => {
    await expect(discoverPath(join(fixtures, "does-not-exist"))).rejects.toThrow(/path not found/);
  });

  it("searches a restic-cache-style directory copied elsewhere", async () => {
    const cache = await mkdtemp(join(tmpdir(), "recall-cache-"));
    await cp(fixtures, cache, { recursive: true });
    const hits = await searchRefs(await discoverPath(cache), "gamma");
    expect(hits.some((hit) => hit.session.agent === "codex")).toBe(true);
    expect(findSessionAmong(await discoverPath(cache), "copilot-fixture")?.agent).toBe("copilot");
  });
});
