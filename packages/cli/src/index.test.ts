import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(packageRoot, "../..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const cli = resolve(packageRoot, "src/index.ts");

describe("recall cli", () => {
  it("searches fixture sessions through root overrides", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "search",
      "gamma",
      "--agent",
      "codex",
      "--codex-root",
      resolve(repoRoot, "fixtures/codex"),
    ]);
    expect(stdout).toContain("codex");
    expect(stdout).toContain("gamma");
  });

  it("shows fixture sessions as JSON", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "show",
      "claude-fixture",
      "--agent",
      "claude",
      "--claude-root",
      resolve(repoRoot, "fixtures/claude-project"),
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.agent).toBe("claude");
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it("shows an explicit --file session without a session id (agent auto-detected)", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "show",
      "--file",
      resolve(repoRoot, "fixtures/copilot/copilot-fixture/events.jsonl"),
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.agent).toBe("copilot");
    expect(parsed.id).toBe("copilot-fixture");
  });

  it("searches an explicit --file directory (restic-cache style)", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "search",
      "gamma",
      "--file",
      resolve(repoRoot, "fixtures"),
    ]);
    expect(stdout).toContain("codex");
    expect(stdout).toContain("gamma");
  });

  it("errors clearly when --file matches many sessions and no id is given", async () => {
    await expect(
      execFileAsync(tsx, [cli, "show", "--file", resolve(repoRoot, "fixtures")]),
    ).rejects.toThrow(/pass a <session-id>/);
  });
});
