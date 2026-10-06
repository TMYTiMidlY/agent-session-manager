import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { ParsedSession, SessionDocument, UsageRecord } from "../core/types.js";
import { documentFromParsed } from "../core/normalized.js";
import { deriveStatsFromDocument } from "../core/session-stats.js";
import { buildListCommand } from "./commands/list.js";
import { buildSearchCommand } from "./commands/search.js";
import { buildShowCommand } from "./commands/show.js";
import { buildTreeCommand } from "./commands/tree.js";
import { buildQuotaCommand } from "./commands/quota.js";

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

interface Captured {
  out: string;
  err: string;
}

async function capture(run: () => Promise<unknown>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(`${args.map(String).join(" ")}\n`); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(`${args.map(String).join(" ")}\n`); });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
  try {
    await run();
    return { out: out.join(""), err: err.join("") };
  } finally {
    write.mockRestore();
    error.mockRestore();
    log.mockRestore();
  }
}

afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Fixtures — REAL Codex shapes (session_meta thread_source / token_usage_record
// / token_count.info / rate_limits), not invented DSH guardian origins.
// ---------------------------------------------------------------------------

const MAIN_ID = "aaa00000-0000-4000-8000-000000000001";
const SUB_ID = "aaa00000-0000-4000-8000-000000000002";
const GUARD_ID = "aaa00000-0000-4000-8000-000000000003";
const BARE_ID = "aaa00000-0000-4000-8000-000000000004";

const RATE_LIMITS = {
  limit_id: "li-1",
  limit_name: "ChatGPT Plus",
  plan_type: "plus",
  credits: { has_credits: true, unlimited: false, balance: "$4.20" },
  primary: { used_percent: 12.5, window_minutes: 60, resets_at: 1767268800 }, // 2026-01-01T12:00:00Z
};
const RATE_LIMITS_LATER = { ...RATE_LIMITS, primary: { used_percent: 8, window_minutes: 60, resets_at: 1767268800 } };

const CODEX_MAIN = [
  JSON.stringify({ ordinal: 0, timestamp: "2026-01-01T10:00:00.000Z", type: "session_meta", payload: { id: MAIN_ID, session_id: MAIN_ID, timestamp: "2026-01-01T10:00:00.000Z", cwd: "/tmp/main", thread_source: "user" } }),
  JSON.stringify({ ordinal: 1, timestamp: "2026-01-01T10:01:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "zebra question" }] } }),
  // Per-response increments: raw input 100 (incl. 40 cached) + 60 (incl. 10 cached).
  JSON.stringify({ ordinal: 2, timestamp: "2026-01-01T10:05:00.000Z", type: "token_usage_record", payload: { thread_id: MAIN_ID, response_id: "r1", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, total_tokens: 130 } } }),
  JSON.stringify({ ordinal: 3, timestamp: "2026-01-01T10:06:00.000Z", type: "token_usage_record", payload: { thread_id: MAIN_ID, response_id: "r2", usage: { input_tokens: 60, cached_input_tokens: 10, output_tokens: 20, total_tokens: 80 } } }),
  // Context samples: input 90 WITH a window, then input 120 WITHOUT one —
  // the max sample (120) has no window, so ctx_util must stay blank.
  JSON.stringify({ ordinal: 4, timestamp: "2026-01-01T10:10:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 90, output_tokens: 5, total_tokens: 95 }, total_token_usage: { input_tokens: 160, cached_input_tokens: 50, output_tokens: 50, total_tokens: 210 }, model_context_window: 128000 }, rate_limits: RATE_LIMITS } }),
  JSON.stringify({ ordinal: 5, timestamp: "2026-01-01T10:15:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 }, total_token_usage: { input_tokens: 168, cached_input_tokens: 50, output_tokens: 58, total_tokens: 226 } }, rate_limits: RATE_LIMITS_LATER } }),
  JSON.stringify({ ordinal: 6, timestamp: "2026-01-01T10:20:00.000Z", type: "compacted", payload: { message: "compaction summary" } }),
  JSON.stringify({ ordinal: 7, timestamp: "2026-01-01T11:00:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "zebra answer" }] } }),
  "",
].join("\n");

const CODEX_SUB = [
  JSON.stringify({ ordinal: 0, timestamp: "2026-01-01T10:20:00.000Z", type: "session_meta", payload: { id: SUB_ID, session_id: SUB_ID, timestamp: "2026-01-01T10:20:00.000Z", cwd: "/tmp/sub", thread_source: "subagent", parent_thread_id: MAIN_ID } }),
  JSON.stringify({ ordinal: 1, timestamp: "2026-01-01T10:25:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "subtask" }] } }),
  // Fork-replay of the parent's rate snapshots at the SAME instants: the
  // cross-session trajectory must dedupe these, not double-count them.
  JSON.stringify({ ordinal: 2, timestamp: "2026-01-01T10:10:00.000Z", type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: RATE_LIMITS } }),
  JSON.stringify({ ordinal: 3, timestamp: "2026-01-01T11:00:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "subtask done" }] } }),
  "",
].join("\n");

const CODEX_GUARDIAN = [
  JSON.stringify({ ordinal: 0, timestamp: "2026-01-01T10:25:00.000Z", type: "session_meta", payload: { id: GUARD_ID, session_id: GUARD_ID, timestamp: "2026-01-01T10:25:00.000Z", cwd: "/tmp/guard", thread_source: "guardian_review", parent_thread_id: MAIN_ID } }),
  JSON.stringify({ ordinal: 1, timestamp: "2026-01-01T10:26:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "guardian watched the zebra" }] } }),
  JSON.stringify({ ordinal: 2, timestamp: "2026-01-01T11:30:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "guardian final note" }] } }),
  "",
].join("\n");

// No session_meta at all: the source never states a role → unknown.
const CODEX_BARE = [
  JSON.stringify({ timestamp: "2026-01-01T09:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "roleless session" }] } }),
  "",
].join("\n");

const CLAUDE_SESSION = [
  JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00.000Z", message: { role: "user", content: "hello" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-01-01T10:00:05.000Z", message: { id: "resp_c1", model: "claude-x", usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 200 } } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-01-01T10:00:09.000Z", message: { id: "resp_c2", model: "claude-x", usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 30 } } }),
  "",
].join("\n");

const CORRUPT = "!!! this is not json\n";

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "asmgr-stats-"));
  const codex = join(dir, "codex");
  const claude = join(dir, "claude");
  await mkdir(codex); await mkdir(claude);
  await writeFile(join(codex, `rollout-2026-01-01T10-00-00-${MAIN_ID}.jsonl`), CODEX_MAIN, "utf8");
  await writeFile(join(codex, `rollout-2026-01-01T10-20-00-${SUB_ID}.jsonl`), CODEX_SUB, "utf8");
  await writeFile(join(codex, `rollout-2026-01-01T10-25-00-${GUARD_ID}.jsonl`), CODEX_GUARDIAN, "utf8");
  await writeFile(join(codex, `rollout-2026-01-01T09-00-00-${BARE_ID}.jsonl`), CODEX_BARE, "utf8");
  await writeFile(join(claude, "claude-stats.jsonl"), CLAUDE_SESSION, "utf8");
  return dir;
}

async function run(cmd: Command, args: string[]): Promise<Captured> {
  return capture(() => cmd.parseAsync(args, { from: "user" }));
}

// ---------------------------------------------------------------------------
// deriveStatsFromDocument units
// ---------------------------------------------------------------------------

function documentWithUsage(usage: UsageRecord[], agent: ParsedSession["agent"] = "dsh"): SessionDocument {
  const parsed: ParsedSession = { agent, id: "t", path: "/tmp/t", entries: [] };
  return documentFromParsed(parsed, { usage });
}

describe("deriveStatsFromDocument", () => {
  it("treats responses and snapshots as alternative evidence: increments win, never additive", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", responseId: "r1", cumulative: false, metrics: { inputTokens: 50, outputTokens: 20 } },
      { id: "u1", responseId: "r2", cumulative: false, metrics: { inputTokens: 30, cacheReadTokens: 5 } },
      { id: "u2", cumulative: true, metrics: { inputTokens: 500, outputTokens: 200, totalTokens: 7000 } },
    ]));
    expect(stats.totals).toEqual({ inputTokens: 80 });
    expect(stats.incomplete).toBe(true);
    expect(stats.snapshots).toBe(1);
    // A missing bucket never folds to 0: billed input and cache% stay unknown.
    expect(stats.billedInputTokens).toBeUndefined();
    expect(stats.cacheReadRatio).toBeUndefined();
    expect(stats.cacheTokens).toBeUndefined();
  });

  it("computes billed input and cache% only from complete disjoint buckets", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", responseId: "r1", cumulative: false, metrics: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 200 } },
      { id: "u1", responseId: "r2", cumulative: false, metrics: { inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 30 } },
    ]));
    expect(stats.billedInputTokens).toBe(185);
    expect(stats.cacheReadRatio).toBeCloseTo(55 / 185);
    expect(stats.cacheTokens).toBe(65);
  });

  it("DSH falls back to total − output for the exact prompt denominator", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", responseId: "r1", cumulative: false, metrics: { totalTokens: 1000, outputTokens: 300 } },
    ], "dsh"));
    expect(stats.billedInputTokens).toBe(700);
  });

  it("Codex derives the exact prompt from Σ selected raw input_tokens (cache-write never added)", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", responseId: "r1", cumulative: false, kind: "response", ownerSessionId: "t", metrics: { inputTokens: 60, cacheReadTokens: 40 }, raw: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 7 } },
      { id: "u1", responseId: "r2", cumulative: false, kind: "response", ownerSessionId: "t", metrics: { inputTokens: 50, cacheReadTokens: 10 }, raw: { input_tokens: 60, cached_input_tokens: 10 } },
    ], "codex"));
    expect(stats.billedInputTokens).toBe(160); // 100 + 60 raw incl. cached, NOT +7 cache write
    expect(stats.cacheReadRatio).toBeCloseTo(50 / 160);
  });

  it("Codex with one raw-input-less selected response leaves the prompt unknown", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", responseId: "r1", cumulative: false, kind: "response", ownerSessionId: "t", metrics: { inputTokens: 60 }, raw: { input_tokens: 100 } },
      { id: "u1", responseId: "r2", cumulative: false, kind: "response", ownerSessionId: "t", metrics: { outputTokens: 5 } },
    ], "codex"));
    expect(stats.billedInputTokens).toBeUndefined();
  });

  it("pairs peak context with the max sample's OWN window; a windowless max leaves utilization unknown", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", cumulative: false, kind: "context", counted: false, metrics: {}, context: { inputTokens: 900, contextWindow: 128000, measurement: "reported-input" } },
      // Max input, NO window: utilization must not borrow the 128000 above
      // and must not pick the smaller sample's ratio either.
      { id: "u1", cumulative: false, kind: "context", counted: false, metrics: {}, context: { inputTokens: 1200, measurement: "reported-input" } },
      { id: "u2", cumulative: false, kind: "context", counted: false, metrics: {}, context: { inputTokens: 100, contextWindow: 64000, measurement: "reported-input" } },
    ], "codex"));
    expect(stats.peakContextTokens).toBe(1200);
    expect(stats.peakContextUtilization).toBeUndefined();
    expect(stats.peakContextWindow).toBe(128000);
  });

  it("pairs utilization exactly when the max sample carries its window", () => {
    const stats = deriveStatsFromDocument(documentWithUsage([
      { id: "u0", cumulative: false, kind: "context", counted: false, metrics: {}, context: { inputTokens: 32000, contextWindow: 128000, measurement: "reported-input" } },
      { id: "u1", cumulative: false, kind: "context", counted: false, metrics: {}, context: { inputTokens: 16000, contextWindow: 32000, measurement: "reported-input" } },
    ], "codex"));
    // Max tokens 32000 on 128000 → 0.25; the 50% smaller sample must not win.
    expect(stats.peakContextTokens).toBe(32000);
    expect(stats.peakContextUtilization).toBeCloseTo(0.25);
  });

  it("counts compaction blocks exactly, including a definitive zero", () => {
    const parsed: ParsedSession = { agent: "codex", id: "t", path: "/tmp/t", entries: [] };
    const withTwo: SessionDocument = {
      ...documentFromParsed(parsed),
      blocks: [
        { id: "b0", type: "unknown", role: "event", kind: "compaction", text: "" },
        { id: "b1", type: "unknown", role: "event", kind: "compacted", text: "" },
        { id: "b2", type: "text", role: "user", kind: "message", text: "hi" },
      ],
    };
    expect(deriveStatsFromDocument(withTwo).compactions).toBe(2);
    expect(deriveStatsFromDocument(documentFromParsed(parsed)).compactions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// list --stats / formats / sorts / role / limit
// ---------------------------------------------------------------------------

describe("list command", () => {
  it("appends unified stats: peak_ctx, ctx_util%, in, cached, out, cache%, compact", async () => {
    const dir = await fixtureDir();
    const { out, err } = await run(buildListCommand(), ["--file", join(dir, "codex", `rollout-2026-01-01T10-00-00-${MAIN_ID}.jsonl`), "--stats"]);
    const lines = out.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    const columns = lines[0]!.split("\t");
    expect(columns.slice(0, 3)).toEqual(["codex", MAIN_ID, join(dir, `codex/rollout-2026-01-01T10-00-00-${MAIN_ID}.jsonl`)]);
    // peak_ctx = max reported input (120); ctx_util blank (max sample has no
    // window); in = 100+60 raw; cached = 40+10; out = 30+20; cache% = 50/160;
    // compact = 1 compacted row.
    expect(columns.slice(6)).toEqual(["120", "", "160", "50", "50", "31.3%", "1"]);
    expect(err).toContain("metering");
    expect(err).toContain("peak_ctx");
  });

  it("computes complete Claude cache% from disjoint buckets", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildListCommand(), ["--file", join(dir, "claude"), "--stats"]);
    const columns = out.split("\n").filter((line) => line.trim() !== "")[0]!.split("\t");
    expect(columns.slice(6)).toEqual(["", "", "185", "55", "230", "29.7%", "0"]);
  });

  it("-f json exposes camelCase stats (peakContextTokens etc.), no snake aliases", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildListCommand(), ["--file", join(dir, "codex", `rollout-2026-01-01T10-00-00-${MAIN_ID}.jsonl`), "--stats", "-f", "json"]);
    const rows = JSON.parse(out) as Array<{ agent: string; stats?: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    const stats = rows[0]!.stats!;
    expect(stats.peakContextTokens).toBe(120);
    expect(stats.peakContextUtilization).toBeUndefined();
    expect(stats.billedInputTokens).toBe(160);
    expect(stats.cacheReadRatio).toBeCloseTo(50 / 160);
    expect(stats.compactions).toBe(1);
    expect(stats).not.toHaveProperty("peak_ctx");
    expect(rows[0]).not.toHaveProperty("entries");
  });

  it("stats sorts rank the full population; peak_ctx ranks on peakContextTokens (not the window)", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildListCommand(), ["--file", dir, "--sort", "peak_ctx", "--limit", "10"]);
    const rows = out.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    // Only the codex main session carries context samples (120); everyone
    // else — including the 128000-window sample's owner ranked by tokens —
    // sorts after it with blanks.
    expect(rows[0]!.startsWith(`codex\t${MAIN_ID}`)).toBe(true);
    expect(rows[0]!.split("\t")[6]).toBe("120");
    expect(rows[rows.length - 1]!.split("\t")[6]).toBe(""); // unknown stays blank
  });

  it("--sort input ranks billed input: claude 185 > codex 160, unknowns last", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildListCommand(), ["--file", dir, "--sort", "input", "--limit", "10"]);
    const rows = out.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(rows[0]!.startsWith("claude\t")).toBe(true);
    expect(rows[0]!.split("\t")[8]).toBe("185");
    expect(rows[1]!.startsWith(`codex\t${MAIN_ID}`)).toBe(true);
    expect(rows[1]!.split("\t")[8]).toBe("160");
    expect(rows[rows.length - 1]!.split("\t")[8]).toBe("");
  });

  it("--sort id orders the stats path like the metadata path", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildListCommand(), ["--file", dir, "--stats", "--sort", "id"]);
    const rows = out.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    const agents = rows.map((line) => line.split("\t")[0]);
    expect(agents).toEqual([...agents].sort());
    const codexIds = rows.filter((line) => line.startsWith("codex\t")).map((line) => line.split("\t")[1]);
    expect(codexIds).toEqual([...codexIds].sort());
  });

  it("--role filters codex roles from real session metadata, including unknown", async () => {
    const dir = await fixtureDir();
    const codex = join(dir, "codex");
    const guardian = await run(buildListCommand(), ["--file", codex, "--role", "guardian"]);
    expect(guardian.out.trim().split("\n")).toHaveLength(1);
    expect(guardian.out).toContain(GUARD_ID);
    const subagent = await run(buildListCommand(), ["--file", codex, "--role", "subagent"]);
    expect(subagent.out).toContain(SUB_ID);
    expect(subagent.out).not.toContain(GUARD_ID);
    const unknown = await run(buildListCommand(), ["--file", codex, "--role", "unknown"]);
    expect(unknown.out.trim().split("\n")).toHaveLength(1);
    expect(unknown.out).toContain(BARE_ID);
    const main = await run(buildListCommand(), ["--file", codex, "--role", "main"]);
    expect(main.out).toContain(MAIN_ID);
    expect(main.out).not.toContain(GUARD_ID);
    expect(main.out).not.toContain(BARE_ID);
  });

  it("rejects --stats combined with --by instead of silently ignoring --stats", async () => {
    const dir = await fixtureDir();
    await expect(run(buildListCommand(), ["--file", dir, "--stats", "--by", "project"]))
      .rejects.toThrow(/--by grouping cannot be combined with --stats/);
    await expect(run(buildListCommand(), ["--file", dir, "--sort", "input", "--by", "agent"]))
      .rejects.toThrow(/--by grouping cannot be combined with --stats/);
  });

  it("--limit 0 reads nothing: a corrupted session file cannot fail it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asmgr-limit0-"));
    await writeFile(join(dir, "broken.jsonl"), CORRUPT, "utf8");
    const { out, err } = await run(buildListCommand(), ["--file", dir, "--stats", "--sort", "input", "--limit", "0"]);
    expect(out).toBe("");
    expect(err).toBe("");
    const plain = await run(buildListCommand(), ["--file", dir, "--limit", "0"]);
    expect(plain.out).toBe("");
    expect(plain.err).toBe("");
  });

  it("stays metadata-only without --stats: no transcript parsing", async () => {
    const dir = await fixtureDir();
    const { out, err } = await run(buildListCommand(), ["--file", join(dir, "codex")]);
    expect(out.trim().split("\n")).toHaveLength(4);
    expect(err).toBe("");
  });
});

// ---------------------------------------------------------------------------
// search guardian exclusion / show guardian merge
// ---------------------------------------------------------------------------

describe("search command", () => {
  it("excludes REAL codex guardian sessions by default; --include-guardian keeps them", async () => {
    const dir = await fixtureDir();
    const codex = join(dir, "codex");
    const quiet = ["-q", "--no-cache", "-j", "1"];
    const excluded = await run(buildSearchCommand(), ["zebra", "--file", codex, ...quiet]);
    expect(excluded.out).toContain(MAIN_ID);
    expect(excluded.out).not.toContain(GUARD_ID);
    const included = await run(buildSearchCommand(), ["zebra", "--file", codex, ...quiet, "--include-guardian"]);
    expect(included.out).toContain(MAIN_ID);
    expect(included.out).toContain(GUARD_ID);
  });

  it("--limit 0 performs no search at all", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildSearchCommand(), ["zebra", "--file", join(dir, "codex"), "-q", "--no-cache", "--limit", "0"]);
    expect(out).toBe("");
  });
});

describe("show command", () => {
  it("merges real codex guardian sub-threads by default with an explicit origin marker", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildShowCommand(), [MAIN_ID, "--file", join(dir, "codex"), "--agent", "codex"]);
    expect(out).toContain(`session: ${MAIN_ID}`);
    expect(out).toContain(`guardian sub-thread codex:${GUARD_ID}`);
    expect(out).toContain("origin: guardian");
    // Guardian content is not rewritten into human turns.
    expect(out).toContain("guardian watched the zebra");
  });

  it("--no-guardian shows only the main session", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildShowCommand(), [MAIN_ID, "--file", join(dir, "codex"), "--agent", "codex", "--no-guardian"]);
    expect(out).not.toContain(GUARD_ID);
    expect(out).toContain(`session: ${MAIN_ID}`);
  });

  it("applies --role to guardian entries too, preserving their original roles", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildShowCommand(), [MAIN_ID, "--file", join(dir, "codex"), "--agent", "codex", "-f", "json", "--role", "assistant"]);
    const parsed = JSON.parse(out) as {
      entries: Array<{ role: string }>;
      guardianThreads: Array<{ role: string; entries: Array<{ role: string }>; document?: { blocks: unknown[]; usage: unknown[] } }>;
    };
    expect(parsed.entries.every((entry) => entry.role === "assistant")).toBe(true);
    expect(parsed.guardianThreads).toHaveLength(1);
    expect(parsed.guardianThreads[0]!.role).toBe("guardian"); // role label preserved
    expect(parsed.guardianThreads[0]!.entries.length).toBeGreaterThan(0);
    expect(parsed.guardianThreads[0]!.entries.every((entry) => entry.role === "assistant")).toBe(true);
    // The guardian thread carries its full unified document, not just entries.
    expect(parsed.guardianThreads[0]!.document).toBeTruthy();
    expect(Array.isArray(parsed.guardianThreads[0]!.document!.blocks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tree / quota
// ---------------------------------------------------------------------------

describe("tree command", () => {
  it("shows real codex family relations with event-derived observed ranges and children peak concurrency", async () => {
    const dir = await fixtureDir();
    const { out } = await run(buildTreeCommand(), [MAIN_ID, "--file", join(dir, "codex"), "--agent", "codex"]);
    expect(out).toContain(`session: codex:${MAIN_ID} [main]`);
    expect(out).toContain("parent: (none recorded)");
    expect(out).toContain("children (2, by parentSession)");
    expect(out).toContain(`codex:${SUB_ID} [subagent]`);
    expect(out).toContain(`codex:${GUARD_ID} [guardian]`);
    // sub 10:25→11:00 overlaps guardian 10:26→11:30: peak 2 (event instants,
    // not file mtimes).
    expect(out).toMatch(/peak concurrency: 2/);
    expect(out).not.toContain("(times unknown)");
  });

  it("survives parent-chain cycles without infinite recursion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asmgr-cycle-"));
    const a = "ccc00000-0000-4000-8000-00000000000a";
    const b = "ccc00000-0000-4000-8000-00000000000b";
    await writeFile(join(dir, `rollout-a-${a}.jsonl`), [
      JSON.stringify({ timestamp: "2026-01-01T10:00:00.000Z", type: "session_meta", payload: { id: a, timestamp: "2026-01-01T10:00:00.000Z", cwd: "/tmp/a", thread_source: "subagent", parent_thread_id: b } }),
      "",
    ].join("\n"), "utf8");
    await writeFile(join(dir, `rollout-b-${b}.jsonl`), [
      JSON.stringify({ timestamp: "2026-01-01T10:00:00.000Z", type: "session_meta", payload: { id: b, timestamp: "2026-01-01T10:00:00.000Z", cwd: "/tmp/b", thread_source: "subagent", parent_thread_id: a } }),
      "",
    ].join("\n"), "utf8");
    const text = await run(buildTreeCommand(), [a, "--file", dir, "--agent", "codex"]);
    expect(text.out).toContain("cycle detected");
    expect(text.out).toContain(`codex:${a} [subagent]`);
    const json = await run(buildTreeCommand(), [a, "--file", dir, "--agent", "codex", "--json"]);
    const parsed = JSON.parse(json.out) as { node: { key: string; children: unknown[] }; diagnostics: { cycles: string[][] } };
    expect(parsed.diagnostics.cycles).toHaveLength(1);
    expect(parsed.node.children).toHaveLength(1); // the parent-as-child appears once, no recursion
  });

  it("flags ambiguous same-agent duplicate ids instead of silently picking one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asmgr-dup-"));
    const parent = "eee00000-0000-4000-8000-00000000000e";
    const dup = "ddd00000-0000-4000-8000-00000000000d";
    await writeFile(join(dir, `rollout-p-${parent}.jsonl`), [
      JSON.stringify({ timestamp: "2026-01-01T10:00:00.000Z", type: "session_meta", payload: { id: parent, timestamp: "2026-01-01T10:00:00.000Z", cwd: "/tmp/p", thread_source: "user" } }),
      "",
    ].join("\n"), "utf8");
    // Two distinct files carrying the SAME agent+id as children of `parent`.
    for (const sub of ["one", "two"]) {
      await mkdir(join(dir, sub), { recursive: true });
      await writeFile(join(dir, sub, `rollout-${dup}.jsonl`), [
        JSON.stringify({ timestamp: "2026-01-01T10:01:00.000Z", type: "session_meta", payload: { id: dup, timestamp: "2026-01-01T10:01:00.000Z", cwd: `/tmp/${sub}`, thread_source: "subagent", parent_thread_id: parent } }),
        "",
      ].join("\n"), "utf8");
    }
    const { out } = await run(buildTreeCommand(), [parent, "--file", dir, "--agent", "codex"]);
    expect(out).toContain("AMBIGUOUS id");
    expect(out).toContain("appears 2 times");
  });

  it("reports missing parents as scan-scoped diagnostics", async () => {
    const dir = await fixtureDir();
    const solo = await run(buildTreeCommand(), [GUARD_ID, "--file", join(dir, "codex", `rollout-2026-01-01T10-25-00-${GUARD_ID}.jsonl`), "--agent", "codex"]);
    expect(solo.out).toContain(`missing parent: codex:${GUARD_ID} references codex:${MAIN_ID}`);
  });
});

describe("quota command", () => {
  it("prints ONE cross-session hourly trajectory and dedupes fork-replayed snapshots", async () => {
    const dir = await fixtureDir();
    const { out, err } = await run(buildQuotaCommand(), ["--file", join(dir, "codex"), "--agent", "codex"]);
    expect(out).toContain("hourly trajectory across ALL selected sessions");
    expect(out).toContain("limit_id=li-1");
    expect(out).toContain("plan=plus");
    // 12.5 → 8 within hour 10 is a watermark drop; the sub-agent's replay of
    // the 12.5 snapshot deduped (samples=2, not 3).
    expect(out).toMatch(/8\.00%\t12\.50%\t8\.00%\t2/);
    expect(out).toContain("observed-watermark-drop");
    expect(out).toContain('credits.balance="$4.20"');
    // No accountId anywhere upstream → strong unidentified-account warning.
    expect(err).toContain("may merge DIFFERENT accounts");
    expect(out).toContain("account=unidentified");
  });

  it("keeps per-sample origin refs in JSON and preserves f64 precision", async () => {
    const dir = await fixtureDir();
    const json = await run(buildQuotaCommand(), ["--file", join(dir, "codex"), "--agent", "codex", "-f", "json"]);
    const parsed = JSON.parse(json.out) as {
      warning?: string;
      accounts: Array<{ creditsBalance?: string; observedAt: string }>;
      groups: Array<{ window: string; rows: Array<{ hour: string; min: number; max: number }>; samples: Array<{ origin: { id: string; path: string } }> }>;
    };
    expect(parsed.warning).toContain("may merge DIFFERENT accounts");
    expect(parsed.accounts[0]!.creditsBalance).toBe("$4.20");
    const primary = parsed.groups.find((group) => group.window === "primary")!;
    expect(primary.rows[0]!.max).toBe(12.5);
    const originIds = new Set(primary.samples.map((sample) => sample.origin.id));
    // Dedupe keeps first-seen origins; the survivors are real session refs.
    expect([...originIds].every((id) => [MAIN_ID, SUB_ID].includes(id))).toBe(true);
    expect(primary.samples.every((sample) => sample.origin.path.endsWith(".jsonl"))).toBe(true);
  });

  it("supports --timezone for pipeline bucketing", async () => {
    const dir = await fixtureDir();
    const shanghai = await run(buildQuotaCommand(), ["--file", join(dir, "codex"), "--agent", "codex", "--timezone", "Asia/Shanghai"]);
    expect(shanghai.out).toContain("2026-01-01T18:00:00+08:00");
  });

  it("reports clearly when no rate-limit samples exist", async () => {
    const dir = await fixtureDir();
    const claude = await run(buildQuotaCommand(), ["--file", join(dir, "claude")]);
    expect(claude.out).toBe("");
    expect(claude.err).toContain("does not record rate_limits");
  });
});
