import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";
import { withReadSource } from "./common.js";
import { agentOverrideFromOptions, parseAgents, rootsFromOptions } from "./resolve.js";

describe("read command options", () => {
  it.each(["list", "search", "show", "html", "md"])("exposes DSH selection and a root override on %s", (name) => {
    const command = buildProgram().commands.find((candidate) => candidate.name() === name);
    expect(command?.options.find(option => option.long === "--agent")?.description).toContain("copilot|claude|codex|chatgpt|dsh|cursor (cursor-agent)|all");
    expect(command?.helpInformation()).toContain("--cursor-root <path>");
    expect(command?.helpInformation()).toContain("--dsh-root <path>");
  });

  it("accepts Cursor Agent aliases and its independent root", () => {
    expect(parseAgents("cursor-agent")).toEqual(["cursor"]);
    expect(parseAgents("all")).toContain("cursor");
    expect(rootsFromOptions({ cursorRoot: "/cursor" }).cursor).toBe("/cursor");
  });

  it("parses DSH options without opening a session", () => {
    const command = withReadSource(new Command(), "explicit session file");
    command.parse(["--agent", "dsh", "--dsh-root", "/fixtures/dsh sessions"], { from: "user" });
    const options = command.opts();
    expect(parseAgents(options.agent)).toEqual(["dsh"]);
    expect(agentOverrideFromOptions(options)).toBe("dsh");
    expect(rootsFromOptions(options).dsh).toBe("/fixtures/dsh sessions");
  });

  it("includes DSH in all agents while retaining the existing selectors", () => {
    expect(parseAgents("all")).toContain("dsh");
    for (const agent of ["copilot", "claude", "codex", "chatgpt"]) {
      expect(parseAgents(agent)).toEqual([agent]);
    }
    expect(() => parseAgents("unknown")).toThrow("unknown agent: unknown");
    expect(agentOverrideFromOptions({ agent: "all" })).toBeUndefined();
  });

  it("keeps root overrides independent and ignores a non-string DSH root", () => {
    expect(rootsFromOptions({
      copilotRoot: "/copilot", copilotDb: "/copilot.db", claudeRoot: "/claude",
      codexRoot: "/codex", chatgptRoot: "/chatgpt", dshRoot: "/dsh",
    })).toEqual({
      copilot: "/copilot", copilotDb: "/copilot.db", claude: "/claude",
      codex: "/codex", chatgpt: "/chatgpt", dsh: "/dsh",
    });
    expect(rootsFromOptions({}).dsh).toBeUndefined();
    expect(rootsFromOptions({ dshRoot: 42 }).dsh).toBeUndefined();
  });
});
