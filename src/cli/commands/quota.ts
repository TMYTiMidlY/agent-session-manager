import { Command, Option } from "commander";
import {
  collectCodexQuota,
  dedupeQuotaAccountSnapshots,
  dedupeQuotaSamples,
  latestAccountSnapshots,
  summarizeQuotaHourly,
  type QuotaAccountInfo,
  type QuotaGroup,
  type QuotaHourRow,
  type QuotaLedger,
  type QuotaSample,
} from "../../core/quota.js";
import { validateTimeZone } from "../../core/timezone.js";
import type { SessionRef } from "../../core/types.js";
import { mapConcurrent } from "../../core/concurrency.js";
import { withReadSource } from "../options/common.js";
import { resolveOne, resolveRefs } from "../options/resolve.js";

const PRECISION_NOTE = "# used_percent keeps the source's f64 precision; rates are sampled only when requests happen — gaps are unknown, never 0.";

const UNIDENTIFIED_NOTE = "samples without accountId may merge DIFFERENT accounts into one trajectory; only an explicit accountId identifies an account";

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function accountLabel(account: QuotaAccountInfo): string {
  const parts = [
    account.accountId !== undefined ? `account=${account.accountId}` : "account=unidentified",
    account.limitId !== undefined ? `limit_id=${account.limitId}` : "limit_id=unidentified",
    account.planType !== undefined ? `plan=${account.planType}` : undefined,
    account.creditsBalance !== undefined ? `credits.balance=${JSON.stringify(account.creditsBalance)} (source string, not coerced)` : undefined,
    account.creditsUnlimited !== undefined ? `credits.unlimited=${account.creditsUnlimited}` : undefined,
    account.hasCredits !== undefined ? `credits.has=${account.hasCredits}` : undefined,
    account.observedAt !== undefined ? `observed ${account.observedAt} (whole snapshot; missing fields unknown, never carried forward)` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" ");
}

function describeGroup(group: QuotaGroup): string {
  const account = group.accountId !== undefined
    ? `account=${group.accountId}`
    : `account=unidentified (${UNIDENTIFIED_NOTE})`;
  const limit = group.limitId !== undefined
    ? `limit_id=${group.limitId} (quota bucket, not an account identity)`
    : "limit_id=unidentified";
  const name = group.limitName !== undefined ? ` name=${JSON.stringify(group.limitName)}` : "";
  const plan = group.planType !== undefined ? ` plan=${group.planType}` : "";
  return `# ${account} ${limit}${name} window=${group.window}${plan} — hourly trajectory across ALL selected sessions`;
}

function renderRow(row: QuotaHourRow): string {
  const resets = row.resetEvents.map((event) => `${event.at} ${event.kind}`).join("; ");
  return [
    row.hour,
    formatPercent(row.min),
    formatPercent(row.max),
    formatPercent(row.last),
    String(row.samples),
    row.lastResetsAt ?? "",
    resets || "(none observed)",
  ].join("\t");
}

function emitIssues(ledgers: QuotaLedger[]): void {
  // Parse diagnostics go to stderr in both modes: stdout stays parseable.
  for (const ledger of ledgers) {
    for (const issue of ledger.issues) {
      console.error(`${ledger.ref.agent}\t${ledger.ref.id}\t${issue.code}: ${issue.message}${issue.row !== undefined ? ` (row ${issue.row})` : ""}${issue.count > 1 ? ` [${issue.count}x]` : ""}`);
    }
  }
}

const NO_WATERMARK_NOTE = "no used_percent watermark samples in the selected Codex session(s) (primary/secondary windows null/missing); only account/credits snapshots were observed — rates are only sampled when requests happen";

function outputText(groups: QuotaGroup[], accounts: QuotaAccountInfo[], zone: string, noWatermark = false): string {
  const lines: string[] = [PRECISION_NOTE];
  if (noWatermark) lines.push(`# ${NO_WATERMARK_NOTE}`);
  for (const group of groups) {
    lines.push(describeGroup(group));
    lines.push("# hour\tmin\tmax\tlast\tsamples\tresets-at\treset-events (observed evidence only; NOT a claim of a global reset)");
    for (const row of group.rows) lines.push(renderRow(row));
  }
  if (accounts.length) {
    lines.push(`# credits/account snapshots (latest whole observation per account${noWatermark ? "; no hourly curve — no watermark samples" : ""}):`);
    for (const account of accounts) lines.push(`# ${accountLabel(account)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildQuotaCommand(): Command {
  const cmd = withReadSource(
    new Command("quota")
      .argument("[session-id]", "Codex session id (or prefix; --file with one session may omit it)")
      .description("Summarize Codex rate-limit samples as one hourly trajectory across the selected sessions (min/max/last per account, limit_id and window)"),
    "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
  );
  cmd.option("--timezone <zone>", "IANA zone for hourly buckets (source instants stay UTC)", "UTC")
    .option("--json", "print machine-readable JSON (same as -f json)")
    .addOption(new Option("-f, --format <format>", "output format").choices(["text", "json"]).default("text"));
  cmd.action(async (id, opts) => {
    const zone = validateTimeZone(String(opts.timezone));
    const format = opts.format !== "text" ? opts.format : opts.json ? "json" : "text";
    let refs: SessionRef[];
    if (id) refs = [await resolveOne(String(id), opts)];
    else refs = await resolveRefs(opts);
    const codexRefs = refs.filter((ref) => ref.agent === "codex");
    if (codexRefs.length === 0) {
      const message = refs.length === 1
        ? `no rate-limit samples: agent '${refs[0].agent}' does not record rate_limits (only Codex token_count events carry them)`
        : "no Codex sessions in the selected scope; rate_limits are a Codex-only record";
      if (format === "json") console.log(JSON.stringify({ error: message, groups: [], accounts: [] }, null, 2));
      else console.error(message);
      return;
    }
    // Full parses (bounded concurrency); read failures propagate — an empty
    // result must never impersonate a scanned one.
    const ledgers = await mapConcurrent(codexRefs, 4, collectCodexQuota);
    emitIssues(ledgers);
    // ONE trajectory across all selected sessions: fork/subagent replays of
    // the same snapshot dedupe; every sample keeps its origin for auditing.
    // Account-level observations (credits/plan without a window watermark)
    // are merged FIRST as their own channel — they never enter the curve.
    const mergedAccounts = dedupeQuotaAccountSnapshots(ledgers.flatMap((ledger) => ledger.accountSnapshots));
    const merged: QuotaSample[] = dedupeQuotaSamples(ledgers.flatMap((ledger) => ledger.samples));
    const accounts = latestAccountSnapshots([...merged, ...mergedAccounts]);
    if (merged.length === 0 && accounts.length > 0) {
      // Accounts observed but no watermark samples: report the balances with
      // an explicit no-watermark hint — never a fake-empty result.
      if (format === "json") {
        console.log(JSON.stringify({
          timezone: zone,
          note: PRECISION_NOTE.replace(/^# /, ""),
          noWatermarkSamples: NO_WATERMARK_NOTE,
          accounts,
          groups: [],
        }, null, 2));
      } else {
        process.stdout.write(outputText([], accounts, zone, true));
      }
      return;
    }
    if (merged.length === 0) {
      const message = "no rate-limit samples found: the selected Codex session(s) contain no structured rate-limit records "
        + "(rates are only sampled when requests happen)";
      if (format === "json") console.log(JSON.stringify({ error: message, groups: [], accounts: [] }, null, 2));
      else console.error(message);
      return;
    }
    const groups = summarizeQuotaHourly(merged, zone);
    if (merged.some((sample) => sample.accountId === undefined)) console.error(`warning: ${UNIDENTIFIED_NOTE}`);
    if (format === "json") {
      console.log(JSON.stringify({
        timezone: zone,
        note: PRECISION_NOTE.replace(/^# /, ""),
        ...(merged.some((sample) => sample.accountId === undefined) ? { warning: UNIDENTIFIED_NOTE } : {}),
        accounts,
        // Each group carries its full sample list with per-sample origin refs.
        groups,
      }, null, 2));
    } else {
      process.stdout.write(outputText(groups, accounts, zone));
    }
  });
  return cmd;
}
