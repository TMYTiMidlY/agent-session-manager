import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectCodexQuota,
  dedupeQuotaAccountSnapshots,
  dedupeQuotaSamples,
  latestAccountSnapshots,
  summarizeQuotaHourly,
  type QuotaAccountObservation,
  type QuotaSample,
} from "../quota.js";

function codexRow(timestamp: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}

const T1 = "2026-01-01T10:05:00.000Z";
const T2 = "2026-01-01T10:40:00.000Z";
const T3 = "2026-01-01T11:20:00.000Z";

const IDENTIFIED = {
  limit_id: "li-1",
  limit_name: "ChatGPT Plus",
  plan_type: "plus",
  credits: { has_credits: true, unlimited: false, balance: "$4.20" },
  primary: { used_percent: 12.5, window_minutes: 60, resets_at: 1767268800 }, // 2026-01-01T12:00:00Z
  secondary: { used_percent: 3.25, window_minutes: 300, resets_at: 1767279600 }, // 2026-01-01T15:00:00Z
};

async function writeCodexSession(rows: string[], name = "rollout-2026-01-01T10-00-00-uuid-1.jsonl"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "asmgr-quota-"));
  const path = join(dir, name);
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");
  return path;
}

const origin = (id: string, path: string) => ({ agent: "codex" as const, id, path });

function sample(fields: Partial<QuotaSample> & { timestamp: string; usedPercent: number }): QuotaSample {
  return { window: "primary", origin: origin("s", "/tmp/s.jsonl"), ...fields };
}

describe("collectCodexQuota (unified ledger only)", () => {
  it("reads structured rate-limit records from parseSession: both windows, f64 precision, string balances, no account id", async () => {
    const path = await writeCodexSession([
      codexRow("2026-01-01T10:00:00.000Z", { type: "session_meta", cwd: "/tmp/x" }),
      codexRow(T1, { type: "token_count", info: { last_token_usage: { input_tokens: 50 }, total_token_usage: { input_tokens: 500 } }, rate_limits: IDENTIFIED }),
    ]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    expect(ledger.samples).toEqual([
      {
        timestamp: T1,
        window: "primary",
        usedPercent: 12.5,
        windowMinutes: 60,
        resetsAt: "2026-01-01T12:00:00.000Z",
        limitId: "li-1",
        limitName: "ChatGPT Plus",
        planType: "plus",
        raw: IDENTIFIED,
        origin: origin("s", path),
      },
      {
        timestamp: T1,
        window: "secondary",
        usedPercent: 3.25,
        windowMinutes: 300,
        resetsAt: "2026-01-01T15:00:00.000Z",
        limitId: "li-1",
        limitName: "ChatGPT Plus",
        planType: "plus",
        raw: IDENTIFIED,
        origin: origin("s", path),
      },
    ]);
  });

  it("skips window samples without used_percent instead of fabricating one", async () => {
    const path = await writeCodexSession([
      codexRow(T1, { type: "token_count", rate_limits: { limit_id: "li-1", primary: {} } }),
    ]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    expect(ledger.samples).toEqual([]);
  });

  it("propagates read failures instead of returning a fake-empty ledger", async () => {
    await expect(collectCodexQuota({ agent: "codex", id: "s", path: "/nonexistent.jsonl" })).rejects.toThrow();
  });

  it("surfaces bounded parse diagnostics instead of swallowing them", async () => {
    const path = await writeCodexSession([
      "!!! not json",
      codexRow(T1, { type: "token_count", rate_limits: IDENTIFIED }),
    ]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    expect(ledger.samples.length).toBe(2);
    expect(ledger.issues.some((issue) => issue.code === "codex/bad-row")).toBe(true);
  });

  it("collects a credits-only snapshot (windows null/missing) as an account observation, not a watermark sample", async () => {
    const snapshot = {
      limit_id: "li-1",
      limit_name: "ChatGPT Pro",
      plan_type: "pro",
      credits: { has_credits: true, unlimited: false, balance: "$5.00" },
      primary: null,
      secondary: null,
    };
    const path = await writeCodexSession([codexRow(T1, { type: "token_count", rate_limits: snapshot })]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    // no fabricated watermark: the hourly-curve channel stays empty
    expect(ledger.samples).toEqual([]);
    expect(ledger.accountSnapshots).toEqual([{
      timestamp: T1,
      limitId: "li-1",
      limitName: "ChatGPT Pro",
      planType: "pro",
      creditsBalance: "$5.00",
      creditsUnlimited: false,
      hasCredits: true,
      raw: snapshot,
      origin: origin("s", path),
    }]);
    // account id never guessed
    expect("accountId" in ledger.accountSnapshots[0]!).toBe(false);
    expect(ledger.issues.some((issue) => issue.code === "quota/unplaceable-time")).toBe(false);
  });

  it("collects a plan-only snapshot; balance stays unknown", async () => {
    const path = await writeCodexSession([codexRow(T1, { type: "token_count", rate_limits: { plan_type: "plus" } })]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    expect(ledger.samples).toEqual([]);
    expect(ledger.accountSnapshots).toHaveLength(1);
    expect(ledger.accountSnapshots[0]!.planType).toBe("plus");
    expect(ledger.accountSnapshots[0]!.creditsBalance).toBeUndefined();
  });

  it("keeps a null balance unknown while the raw snapshot preserves it verbatim", async () => {
    const snapshot = { credits: { has_credits: false, unlimited: false, balance: null } };
    const path = await writeCodexSession([codexRow(T1, { type: "token_count", rate_limits: snapshot })]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    expect(ledger.accountSnapshots[0]!.creditsBalance).toBeUndefined();
    expect((ledger.accountSnapshots[0]!.raw!.credits as Record<string, unknown>).balance).toBeNull();
  });

  it("counts rate-limit records with missing/invalid timestamps as quota/unplaceable-time, payload-free", async () => {
    const noTimestamp = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: IDENTIFIED } });
    const badTimestamp = JSON.stringify({ timestamp: "not-a-date", type: "event_msg", payload: { type: "token_count", rate_limits: { plan_type: "plus" } } });
    const path = await writeCodexSession([noTimestamp, badTimestamp]);
    const ledger = await collectCodexQuota({ agent: "codex", id: "s", path });
    // excluded from both channels — never placed on the hourly curve
    expect(ledger.samples).toEqual([]);
    expect(ledger.accountSnapshots).toEqual([]);
    const issue = ledger.issues.find((i) => i.code === "quota/unplaceable-time");
    expect(issue?.count).toBe(3); // primary + secondary from the timestamp-less row, plus the bad-timestamp row
    expect(issue?.message).toContain("hourly curve");
    // bounded, payload-free: no snapshot content echoed
    expect(issue?.message).not.toContain("li-1");
    expect(issue?.message).not.toContain("$");
  });
});

describe("cross-session dedupe", () => {
  it("collapses byte-identical snapshots replayed across sessions, keeping one origin", () => {
    const a = sample({ timestamp: T1, usedPercent: 12.5, limitId: "li-1", windowMinutes: 60, resetsAt: "2026-01-01T12:00:00.000Z" });
    const replay = { ...a, origin: origin("child", "/tmp/child.jsonl") };
    const deduped = dedupeQuotaSamples([a, replay]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.origin.id).toBe("s"); // first seen wins; the origin stays auditable
  });

  it("never dedupes across differing limit ids, accounts, windows, window lengths or reset windows", () => {
    const base = { timestamp: T1, usedPercent: 10 };
    const variants = [
      sample({ ...base, limitId: "li-1" }),
      sample({ ...base, limitId: "li-2" }),
      sample({ ...base, limitId: "li-1", accountId: "acc-1" }),
      sample({ ...base, limitId: "li-1", accountId: "acc-2" }),
      sample({ ...base, window: "secondary" as const }),
      sample({ ...base, windowMinutes: 60 }),
      sample({ ...base, resetsAt: "2026-01-01T12:00:00.000Z" }),
      sample({ ...base, resetsAt: "2026-01-01T13:00:00.000Z" }),
    ];
    expect(dedupeQuotaSamples(variants)).toHaveLength(variants.length);
  });
});

describe("account observations across sessions", () => {
  const observation = (fields: Partial<QuotaAccountObservation> & { timestamp: string }): QuotaAccountObservation =>
    ({ origin: origin("s", "/tmp/s.jsonl"), ...fields });

  it("dedupes byte-identical account observations replayed across sessions, keeping one origin", () => {
    const a = observation({ timestamp: T1, planType: "pro", creditsBalance: "$5.00", raw: { plan_type: "pro", credits: { balance: "$5.00" } } });
    const replay = { ...a, origin: origin("child", "/tmp/child.jsonl") };
    expect(dedupeQuotaAccountSnapshots([a, replay])).toHaveLength(1);
    expect(dedupeQuotaAccountSnapshots([a, replay])[0]!.origin.id).toBe("s");
  });

  it("merges observations with window samples under whole-snapshot latest semantics; no carry-forward", () => {
    const accounts = latestAccountSnapshots([
      // older observation that carried credits
      observation({ timestamp: T1, creditsBalance: "$5.00", raw: { credits: { balance: "$5.00" } } }),
      // later window sample WITHOUT credits fields: must not retire the
      // credits-bearing observation, nor lend it a stale balance
      sample({ timestamp: T2, usedPercent: 8, limitId: "li-1", raw: { limit_id: "li-1" } }),
    ]);
    expect(accounts).toEqual([{
      observedAt: T1,
      creditsBalance: "$5.00",
      raw: { credits: { balance: "$5.00" } },
    }]);
  });

  it("keeps a later credits-bearing observation as the latest whole snapshot", () => {
    const accounts = latestAccountSnapshots([
      observation({ timestamp: T1, creditsBalance: "$5.00", planType: "pro", raw: { plan_type: "pro", credits: { balance: "$5.00" } } }),
      observation({ timestamp: T3, planType: "pro", raw: { plan_type: "pro", credits: { has_credits: true } } }),
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.observedAt).toBe(T3);
    expect(accounts[0]!.creditsBalance).toBeUndefined(); // latest has no balance → unknown
    expect(accounts[0]!.hasCredits).toBe(true);
  });
});

describe("summarizeQuotaHourly", () => {
  const identified = (timestamp: string, usedPercent: number, resetsAt = "2026-01-01T12:00:00.000Z"): QuotaSample =>
    sample({ timestamp, usedPercent, resetsAt, limitId: "li-1" });

  it("buckets hourly with min/max/last by real event instant", () => {
    const rows = summarizeQuotaHourly([
      identified(T2, 8),   // later instant, lower value — written first on purpose
      identified(T1, 12.5),
      identified(T3, 9, "2026-01-01T13:00:00.000Z"),
    ]);
    expect(rows).toHaveLength(1);
    const group = rows[0]!;
    expect(group.limitId).toBe("li-1");
    expect(group.window).toBe("primary");
    expect(group.rows.map((row) => row.hour)).toEqual(["2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"]);
    const ten = group.rows[0]!;
    // "last" follows the event instant (T2), not file order.
    expect(ten).toMatchObject({ min: 8, max: 12.5, last: 8, lastAt: T2, samples: 2 });
    expect(ten.resetEvents).toEqual([{ at: T2, kind: "observed-watermark-drop" }]);
    const eleven = group.rows[1]!;
    // T2(8) → T3(9) is a rise with a later reset window: window change, not a drop.
    expect(eleven.resetEvents).toEqual([{ at: T3, kind: "reset-window-changed" }]);
    expect(eleven.lastResetsAt).toBe("2026-01-01T13:00:00.000Z");
  });

  it("orders by parsed instant, not offset text: mixed UTC offsets sort correctly", () => {
    // 11:00+08:00 is 03:00Z — BEFORE 06:00Z even though the string is larger.
    const rows = summarizeQuotaHourly([
      identified("2026-01-01T06:00:00.000Z", 20),
      identified("2026-01-01T11:00:00.000+08:00", 10),
    ]);
    const group = rows[0]!;
    expect(group.rows.map((row) => row.hour)).toEqual(["2026-01-01T03:00:00Z", "2026-01-01T06:00:00Z"]);
    expect(group.rows[0]!.last).toBe(10);
    expect(group.rows[0]!.resetEvents).toEqual([]); // 10 → 20 is a rise, no reset claim
  });

  it("labels observed evidence only and never claims a global reset", () => {
    const rows = summarizeQuotaHourly([identified(T1, 5), identified(T2, 50)]);
    expect(rows[0]!.rows[0]!.resetEvents).toEqual([]); // a rise is not reset evidence
  });

  it("keeps samples without accountId in maySpanAccounts groups even when a limit_id exists", () => {
    const rows = summarizeQuotaHourly([
      identified(T1, 10),
      sample({ timestamp: T1, usedPercent: 99, limitId: "li-1", accountId: "acc-1" }),
    ]);
    expect(rows).toHaveLength(2);
    const spanned = rows.find((group) => group.maySpanAccounts)!;
    // limit_id is a quota bucket, NOT an account identity.
    expect(spanned.limitId).toBe("li-1");
    expect(spanned.accountId).toBeUndefined();
    const account = rows.find((group) => !group.maySpanAccounts)!;
    expect(account.accountId).toBe("acc-1");
  });

  it("splits different accounts even under the same limit_id", () => {
    const rows = summarizeQuotaHourly([
      sample({ timestamp: T1, usedPercent: 10, limitId: "li-1", accountId: "acc-1" }),
      sample({ timestamp: T1, usedPercent: 20, limitId: "li-1", accountId: "acc-2" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((group) => group.accountId))).toEqual(new Set(["acc-1", "acc-2"]));
  });

  it("takes planType from the group's own latest sample, never from another group's account", () => {
    const rows = summarizeQuotaHourly([
      sample({ timestamp: T1, usedPercent: 10, limitId: "li-1", planType: "plus" }),
      sample({ timestamp: T2, usedPercent: 11, limitId: "li-1" }),
      sample({ timestamp: T1, usedPercent: 50, limitId: "li-2", planType: "pro" }),
    ]);
    const li1 = rows.find((group) => group.limitId === "li-1")!;
    expect(li1.planType).toBe("plus");
  });

  it("uses offset-aware hour buckets; DST-repeated hours stay distinct", () => {
    // America/New_York fell back at 2026-11-01T06:00Z: 01:00 local happens twice.
    const rows = summarizeQuotaHourly([
      identified("2026-11-01T05:30:00.000Z", 10), // 01:30 EDT (-04:00)
      identified("2026-11-01T06:30:00.000Z", 30), // 01:30 EST (-05:00)
    ], "America/New_York");
    const group = rows[0]!;
    expect(group.rows.map((row) => row.hour)).toEqual([
      "2026-11-01T01:00:00-04:00",
      "2026-11-01T01:00:00-05:00",
    ]);
    expect(group.rows.map((row) => row.max)).toEqual([10, 30]);
  });

  it("computes min/max without spreading (large buckets do not overflow the argument stack)", () => {
    const many = Array.from({ length: 200_000 }, (_, index) =>
      identified(new Date(1_767_226_000_000 + index * 1000).toISOString(), index % 100));
    const rows = summarizeQuotaHourly(many);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.rows.some((row) => row.samples > 1000)).toBe(true);
  });

  it("keeps per-sample origins on the group for auditing", () => {
    const rows = summarizeQuotaHourly([identified(T1, 10)]);
    expect(rows[0]!.samples[0]!.origin).toEqual({ agent: "codex", id: "s", path: "/tmp/s.jsonl" });
  });
});

describe("latestAccountSnapshots (whole-snapshot semantics)", () => {
  const withRaw = (fields: Partial<QuotaSample> & { timestamp: string; usedPercent: number }, raw: Record<string, unknown>): QuotaSample =>
    sample({ ...fields, raw });

  it("keeps the latest credits-bearing snapshot whole; older fields are not merged into it", () => {
    const accounts = latestAccountSnapshots([
      withRaw({ timestamp: T1, usedPercent: 10 }, { credits: { balance: "$4.20", unlimited: false, has_credits: true }, plan_type: "plus" }),
      // Later snapshot WITHOUT credits: must NOT borrow the stale $4.20.
      withRaw({ timestamp: T2, usedPercent: 8 }, { limit_id: "li-1" }),
    ]);
    expect(accounts).toEqual([{
      observedAt: T1,
      creditsBalance: "$4.20",
      creditsUnlimited: false,
      hasCredits: true,
      planType: "plus",
      raw: { credits: { balance: "$4.20", unlimited: false, has_credits: true }, plan_type: "plus" },
    }]);
  });

  it("reports unknown (absent) balances instead of carrying them forward", () => {
    const accounts = latestAccountSnapshots([
      withRaw({ timestamp: T1, usedPercent: 10 }, { credits: { balance: "$1.00" } }),
      withRaw({ timestamp: T2, usedPercent: 5 }, { credits: { has_credits: true } }),
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.creditsBalance).toBeUndefined(); // latest snapshot has no balance
    expect(accounts[0]!.hasCredits).toBe(true);
    expect(accounts[0]!.observedAt).toBe(T2);
  });

  it("keeps unidentified snapshots separate and never stamps them an account id", () => {
    const accounts = latestAccountSnapshots([
      withRaw({ timestamp: T1, usedPercent: 10 }, { credits: { balance: "$2.00" } }),
      withRaw({ timestamp: T2, usedPercent: 10, accountId: "acc-9" }, { credits: { balance: "$9.00" } }),
    ]);
    expect(accounts).toHaveLength(2);
    expect(accounts.find((account) => account.accountId === undefined)?.creditsBalance).toBe("$2.00");
    expect(accounts.find((account) => account.accountId === "acc-9")?.creditsBalance).toBe("$9.00");
  });
});
