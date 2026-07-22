import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";

describe("buildProgram", () => {
  it("registers the expected top-level commands", () => {
    const names = buildProgram().commands.map((command) => command.name()).sort();
    expect(names).toEqual(["backup", "html", "list", "md", "search", "show"]);
  });

  it("names the binary from the shared brand constant", () => {
    expect(buildProgram().name()).toBe("recall");
  });

  it("keeps the markdown alias on the md command", () => {
    const md = buildProgram().commands.find((command) => command.name() === "md");
    expect(md?.aliases()).toContain("markdown");
  });

  it("exposes backup as a group with run and cache subcommands", () => {
    const backup = buildProgram().commands.find((command) => command.name() === "backup");
    const subs = backup?.commands.map((command) => command.name()).sort();
    expect(subs).toEqual(["cache", "run"]);
  });
});
