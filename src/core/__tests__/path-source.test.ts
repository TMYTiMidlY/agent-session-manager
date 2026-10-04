import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../fs.js";
import { detectAgent, discoverPath, findSessionAmong, refFromFile, searchRefs } from "../index.js";

const fixtures = resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

  it("detects an imported ChatGPT snapshot from its explicit file", async () => {
    const refs = await discoverPath(join(fixtures, "chatgpt-fixture.chatgpt-share.json"));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      agent: "chatgpt",
      id: "chatgpt-fixture",
      title: "ChatGPT fixture",
    });
  });

  it("detects a ChatGPT snapshot even when --out used a custom JSON filename", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-chatgpt-custom-"));
    scratchDirectories.push(scratch);
    const custom = join(scratch, "conversation.json");
    await cp(join(fixtures, "chatgpt-fixture.chatgpt-share.json"), custom);
    const refs = await discoverPath(custom);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.agent).toBe("chatgpt");
  });

  it("rejects unsupported pretty-printed JSON instead of returning an empty session", async () => {
    await expect(discoverPath(join(resolve(fixtures, ".."), "package.json"))).rejects.toThrow(
      /不支持的 JSON 会话格式/,
    );
  });

  it("walks a directory and classifies each agent", async () => {
    const refs = await discoverPath(fixtures);
    const agents = new Set(refs.map((ref) => ref.agent));
    expect(agents).toEqual(new Set(["copilot", "claude", "codex", "chatgpt"]));
  });

  it("throws for a missing path", async () => {
    await expect(discoverPath(join(fixtures, "does-not-exist"))).rejects.toThrow(/path not found/);
  });

  it("searches a restic-cache-style directory copied elsewhere", async () => {
    const cache = await mkdtemp(join(process.cwd(), ".core-asmgr-cache-"));
    scratchDirectories.push(cache);
    await cp(fixtures, cache, { recursive: true });
    const hits = await searchRefs(await discoverPath(cache), "gamma");
    expect(hits.some((hit) => hit.session.agent === "codex")).toBe(true);
    expect(findSessionAmong(await discoverPath(join(cache, "copilot")), "copilot-fixture")?.agent).toBe("copilot");
  });
});

describe("findSessionAmong", () => {
  const ref = (id: string) => ({ agent: "dsh" as const, id, path: `/synthetic/${id}`, startedAt: "", source: { kind: "events" as const, path: "", lossy: false } });

  it("matches exact ids and id prefixes", () => {
    const refs = [ref("codex-fixture"), ref("session-62d1adcb-c10c-4ae5-b08f-5de90e56102d")];
    expect(findSessionAmong(refs, "codex-fixture")?.id).toBe("codex-fixture");
    expect(findSessionAmong(refs, "codex-fix")?.id).toBe("codex-fixture");
  });

  it("matches the uuid part of a session-prefixed DSH id", () => {
    const refs = [ref("session-62d1adcb-c10c-4ae5-b08f-5de90e56102d")];
    expect(findSessionAmong(refs, "62d1adcb")?.id).toBe("session-62d1adcb-c10c-4ae5-b08f-5de90e56102d");
    expect(findSessionAmong(refs, "62d1adcb-c10c-4ae5-b08f-5de90e56102d")?.id).toBe("session-62d1adcb-c10c-4ae5-b08f-5de90e56102d");
  });

  it("still finds nothing for unrelated queries", () => {
    const refs = [ref("session-62d1adcb-c10c-4ae5-b08f-5de90e56102d")];
    expect(findSessionAmong(refs, "xyz")).toBeUndefined();
    expect(findSessionAmong(refs, "62d1adcb-c10c-4ae5-b08f-5de90e56102d-extra")).toBeUndefined();
  });
});
