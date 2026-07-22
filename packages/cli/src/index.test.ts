import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ParsedSession } from "@agent-session-exporter/core";
import { sourceLabelForSession, summaryMismatchWarning } from "./render-options.js";

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

  it("writes show output to --out when requested", async () => {
    const outputDir = resolve(packageRoot, ".test-output-show");
    const output = resolve(outputDir, "session.json");
    await rm(outputDir, { recursive: true, force: true });
    try {
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
        "--out",
        output,
      ]);
      expect(stdout.trim()).toBe(output);
      const parsed = JSON.parse(await readFile(output, "utf8"));
      expect(parsed.agent).toBe("claude");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
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

  it("groups list output by project", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "list",
      "--by",
      "project",
      "--file",
      resolve(repoRoot, "fixtures"),
    ]);
    expect(stdout).toMatch(/^# .+\(\d+\)$/m);
    expect(stdout).toContain("codex");
  });

  it("errors clearly when --file matches many sessions and no id is given", async () => {
    await expect(
      execFileAsync(tsx, [cli, "show", "--file", resolve(repoRoot, "fixtures")]),
    ).rejects.toThrow(/pass a <session-id>/);
  });

  it("documents renderer-specific summary fragment formats", async () => {
    const [htmlHelp, markdownHelp] = await Promise.all([
      execFileAsync(tsx, [cli, "html", "--help"]),
      execFileAsync(tsx, [cli, "md", "--help"]),
    ]);
    expect(htmlHelp.stdout).toContain("inject a raw HTML fragment");
    expect(markdownHelp.stdout).toContain("inject a Markdown fragment");
    expect(htmlHelp.stdout).toContain("--summary-format <html|markdown>");
    expect(markdownHelp.stdout).toContain("--summary-format <html|markdown>");
    expect(htmlHelp.stdout).toContain('(default: "html")');
    expect(markdownHelp.stdout).toContain('(default: "markdown")');
  });

  it("warns when a summary extension does not match the renderer", async () => {
    const outputDir = resolve(packageRoot, ".test-output-summary");
    const summary = resolve(outputDir, "summary.html");
    const output = resolve(outputDir, "session.md");
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(summary, "<p>summary</p>\n", "utf8");
    try {
      const { stderr } = await execFileAsync(tsx, [
        cli,
        "md",
        "--file",
        resolve(repoRoot, "fixtures/copilot/copilot-fixture/events.jsonl"),
        "--summary",
        summary,
        "--out",
        output,
      ]);
      expect(stderr).toContain("requires a Markdown summary fragment");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("derives fallback provenance only for lossy or db-turns sessions", () => {
    const base: ParsedSession = {
      agent: "copilot",
      id: "test",
      path: "events.jsonl",
      entries: [],
    };
    expect(sourceLabelForSession({
      ...base,
      source: { kind: "events", path: "events.jsonl", lossy: false },
    })).toBeUndefined();
    expect(sourceLabelForSession({
      ...base,
      source: { kind: "events", path: "events.jsonl", lossy: true },
    })).toBe("db.turns (fallback)");
    expect(sourceLabelForSession({
      ...base,
      source: { kind: "db-turns", path: "session-store.db", lossy: false },
    })).toBe("db.turns (fallback)");
  });

  it("does not warn for matching summary formats", () => {
    expect(summaryMismatchWarning("summary.html", "html", "html")).toBeUndefined();
    expect(summaryMismatchWarning("summary.md", "markdown", "markdown")).toBeUndefined();
  });
});
