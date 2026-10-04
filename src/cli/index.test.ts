import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ParsedSession } from "../core/index.js";
import { sourceLabelForSession, summaryMismatchWarning } from "./render-options.js";

const execFileAsync = promisify(execFile);
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(here, "../..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const cli = resolve(here, "index.ts");

describe("asmgr cli", () => {
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

  it("restricts search hits to a session id prefix", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "search",
      "message",
      "--file",
      resolve(repoRoot, "fixtures"),
      "--session",
      "codex-fixt",
      "--limit",
      "1",
    ]);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\tcodex\tcodex-fixture\t");
    expect(stdout).not.toContain("copilot-fixture");
    expect(stdout).not.toContain("claude-fixture");
  });

  it("errors when --session matches no known session", async () => {
    await expect(
      execFileAsync(tsx, [
        cli,
        "search",
        "message",
        "--file",
        resolve(repoRoot, "fixtures"),
        "--session",
        "does-not-exist-xyz",
      ]),
    ).rejects.toThrow(/session not found/);
  });

  /** Descriptor evolution must not hide this session or its readable sibling. */
  async function dshRootWithDescriptorSession(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "asmgr-search-resilience-"));
    const descriptor = join(root, "a-descriptor", "session.jsonl");
    await mkdir(dirname(descriptor), { recursive: true });
    await writeFile(descriptor, [
      JSON.stringify({ type: "session", version: 0, id: "00a-descriptor", createdAt: 1, cwd: "/synthetic", delegationDepth: 0 }),
      JSON.stringify({ type: "subagent/descriptor", seq: 0, time: 2, data: { version: 2, mode: "continuable", provider: "mock", label: "synthetic old child" } }),
      JSON.stringify({ type: "user/message", seq: 1, time: 3, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "needleword descriptor question" }] } }),
    ].join("\n") + "\n");
    const good = join(root, "z-good", "session.v3.jsonl");
    await mkdir(dirname(good), { recursive: true });
    await writeFile(good, [
      JSON.stringify({ type: "session", version: 3, id: "session-zgood", createdAt: 1, cwd: "/synthetic", isSeeded: false, delegationDepth: 0 }),
      JSON.stringify({ type: "user/message", seq: 0, time: 2, surfaceOp: "append", data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "needleword question" }] } }),
    ].join("\n") + "\n");
    return root;
  }

  it("searches descriptor-v2 sessions alongside ordinary sessions", async () => {
    const root = await dshRootWithDescriptorSession();
    try {
      const { stdout, stderr } = await execFileAsync(tsx, [cli, "search", "needleword", "--agent", "dsh", "--dsh-root", root]);
      expect(stdout).toContain("session-zgood");
      expect(stdout).toContain("needleword");
      expect(stdout).toContain("00a-descriptor");
      expect(stdout).toContain("descriptor question");
      expect(stderr).not.toContain("跳过");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows a DSH session by its bare uuid when the id carries the session- prefix", async () => {
    const root = await dshRootWithDescriptorSession();
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "show", "zgood", "--agent", "dsh", "--dsh-root", root, "--format", "dialogue"]);
      expect(stdout).toContain("session-zgood");
      expect(stdout).toContain("needleword");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads future DSH headers and descriptor payloads across search/show/html/md", async () => {
    const root = await dshRootWithDescriptorSession();
    try {
      const path = join(root, "future", "session.v99.jsonl");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, [
        { type: "session", version: 99, id: "session-future", createdAt: 1, cwd: "/synthetic" },
        { type: "subagent/descriptor", seq: 0, time: 2, data: { version: 999, newPayload: true } },
        { type: "user/message", seq: 1, time: 3, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "future needleword question" }] } },
        { type: "future/required", seq: 2, time: 4, data: { text: "PRIVATE UNKNOWN PAYLOAD" } },
        { type: "assistant/message", seq: 3, time: 5, surfaceOp: "append", data: { message: { role: "assistant", content: [{ type: "text", text: "future answer" }] } } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      const options = ["--agent", "dsh", "--dsh-root", root];
      const search = await execFileAsync(tsx, [cli, "search", "absent-query", ...options]);
      expect(search.stdout).toBe("");
      expect(search.stderr).toContain("future/required");
      expect(search.stderr).not.toContain("跳过");
      const show = await execFileAsync(tsx, [cli, "show", "future", ...options, "--format", "json"]);
      const parsed = JSON.parse(show.stdout);
      expect(parsed.entries.map((entry: { text: string }) => entry.text)).toEqual(["future needleword question", "future answer"]);
      expect(parsed.diagnostics.formatVersion).toBe(99);
      for (const command of ["html", "md"]) {
        const out = join(root, `report.${command}`);
        await execFileAsync(tsx, [cli, command, "future", ...options, "--out", out]);
        const rendered = await readFile(out, "utf8");
        expect(rendered).toContain("future needleword question");
        expect(rendered).toContain("future answer");
        expect(rendered).toContain("future/required");
        expect(rendered).not.toContain("PRIVATE UNKNOWN PAYLOAD");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const outputDir = resolve(here, ".test-output-show");
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

  it("shows an imported ChatGPT share snapshot through --file", async () => {
    const { stdout } = await execFileAsync(tsx, [
      cli,
      "show",
      "--file",
      resolve(repoRoot, "fixtures/chatgpt-fixture.chatgpt-share.json"),
      "--format",
      "dialogue",
    ]);
    expect(stdout).toContain("agent: chatgpt");
    expect(stdout).toContain("Find the answer");
    expect(stdout).toContain("The final answer.");
    expect(stdout).not.toContain("fixture query");
  });

  it("rejects non-share URLs before attempting discovery or network access", async () => {
    await expect(
      execFileAsync(tsx, [
        cli,
        "show",
        "https://chatgpt.com/g/project/c/private",
      ]),
    ).rejects.toThrow(/地址栏复制的私有会话链接.*点击右上角“分享”/);
    await expect(
      execFileAsync(tsx, [
        cli,
        "import",
        "https://example.com/share/not-chatgpt",
      ]),
    ).rejects.toThrow(/目前只支持 ChatGPT 的公开分享链接/);
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
    const outputDir = resolve(here, ".test-output-summary");
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
    })).toBe("events (lossy)");
    expect(sourceLabelForSession({
      ...base,
      source: { kind: "db-turns", path: "session-store.db", lossy: false },
    })).toBe("db.turns (fallback)");
    expect(sourceLabelForSession({
      ...base,
      agent: "chatgpt",
      source: { kind: "chatgpt-share", path: "share.json", lossy: true },
    })).toBe("ChatGPT 分享");
  });

  it("does not warn for matching summary formats", () => {
    expect(summaryMismatchWarning("summary.html", "html", "html")).toBeUndefined();
    expect(summaryMismatchWarning("summary.md", "markdown", "markdown")).toBeUndefined();
  });
});
