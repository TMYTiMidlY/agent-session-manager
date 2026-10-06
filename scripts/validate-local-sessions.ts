import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AGENTS, discoverSessions, parseSession } from "../src/core/index.js";

/** Read-only local-store acceptance run. Reports counts, never transcript contents. */
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), node: process.version, sources: {} };
const sources = report.sources as Record<string, unknown>;
let failures = 0;
for (const agent of AGENTS) {
  const refs = await discoverSessions([agent]);
  let parsed = 0, empty = 0, entries = 0, diagnostics = 0;
  const errors: { id: string; error: string }[] = [];
  for (const ref of refs) {
    try {
      const session = await parseSession(ref);
      if (!session.document) throw new Error("missing normalized document");
      if (!session.document.events) throw new Error("missing normalized envelopes");
      if (session.document.events.some((event, index) => event.seq !== index)) throw new Error("non-contiguous normalized sequence");
      if (session.entries.some((entry, index) => entry.index !== index)) throw new Error("non-contiguous timeline indices");
      parsed++;
      entries += session.entries.length;
      if (!session.entries.length) empty++;
      diagnostics += session.diagnostics?.issues?.reduce((n, issue) => n + issue.count, 0) ?? 0;
    } catch (error) {
      failures++;
      if (errors.length < 20) errors.push({ id: ref.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  sources[agent] = { discovered: refs.length, parsed, empty, entries, diagnostics, failures: refs.length - parsed, errors };
  console.log(`${agent}: discovered=${refs.length} parsed=${parsed} empty=${empty} entries=${entries} diagnostics=${diagnostics} failures=${refs.length - parsed}`);
}
const target = resolve(process.argv[2] || ".scratch/local-session-validation.json");
await mkdir(resolve(target, ".."), { recursive: true });
await writeFile(target, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`Report: ${target}`);
process.exitCode = failures ? 1 : 0;
