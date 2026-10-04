import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSessions } from "../index.js";
import { filterSessionCwd, sortSessionRefs } from "../session-metadata.js";
import type { SessionRef } from "../types.js";

let empty: string | undefined;
afterEach(async () => { if (empty) await rm(empty, { recursive: true, force: true }); empty = undefined; });

describe("metadata-only discovery", () => {
  it("samples cwd and filesystem activity across Claude/Codex/Copilot without full timelines", async () => {
    empty = await mkdtemp(join(tmpdir(), "asmgr-discovery-empty-"));
    const refs = await discoverSessions(["claude", "codex", "copilot"], {
      claude: resolve("fixtures/claude-project"), codex: resolve("fixtures/codex"),
      copilot: resolve("fixtures/copilot"), copilotDb: join(empty, "missing.db"),
    });
    expect(refs).toHaveLength(3);
    expect(refs.every(ref => typeof ref.mtime === "string" && (ref.size ?? 0) > 0)).toBe(true);
    expect(refs.filter(ref => ref.agent !== "claude").every(ref => typeof ref.cwd === "string")).toBe(true);
    expect(refs.find(ref => ref.agent === "claude")?.cwd).toBeUndefined();
    expect(refs.every(ref => !("entries" in ref))).toBe(true);
  });

  it("samples Claude cwd while ignoring malformed metadata values", async () => {
    empty = await mkdtemp(join(tmpdir(), "asmgr-claude-metadata-"));
    await writeFile(join(empty, "claude.jsonl"), [null, { type: "user", cwd: { invalid: true } },
      { type: "user", cwd: "/synthetic/claude", timestamp: "2026-01-01T00:00:00.000Z" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const refs = await discoverSessions(["claude"], { claude: empty });
    expect(refs[0].cwd).toBe("/synthetic/claude");
  });

  it("normalizes exact cwd but does not recursively include children or unscoped sessions", () => {
    const refs: SessionRef[] = [
      { agent: "dsh", id: "a", path: "/a", cwd: resolve(".") },
      { agent: "dsh", id: "b", path: "/b", cwd: resolve("./child") },
      { agent: "dsh", id: "c", path: "/c" },
    ];
    expect(filterSessionCwd(refs, "./").map(ref => ref.id)).toEqual(["a"]);
  });

  it("has deterministic ordering for equal/missing mtimes and does not mutate the input", () => {
    const refs: SessionRef[] = [
      { agent: "dsh", id: "z", path: "/z" },
      { agent: "dsh", id: "b", path: "/b", mtime: "2026-01-01" },
      { agent: "dsh", id: "a", path: "/a", mtime: "2026-01-01" },
    ];
    expect(sortSessionRefs(refs).map(ref => ref.id)).toEqual(["a", "b", "z"]);
    expect(refs.map(ref => ref.id)).toEqual(["z", "b", "a"]);
  });
});
