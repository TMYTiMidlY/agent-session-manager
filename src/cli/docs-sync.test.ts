import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "./program.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/**
 * README, the in-repo agent skill, and the CLI code describe the same
 * behavior. This guard keeps the option surface aligned: every long option
 * the docs mention must be registered on some command, and every registered
 * long option must appear in the docs corpus. Semantic drift still needs the
 * discipline documented in README's "Agent skill" section; this catches the
 * common failure modes (options added, renamed, or removed without updating
 * docs).
 *
 * Long options only: short flags (-f, -a, …) are too easy to confuse with
 * prose hyphens for a regex corpus scan.
 */

/** Options quoted from OTHER tools' command lines in docs examples. */
const EXTERNAL_OPTIONS = new Set([
  "--resume", // native agent resume (codex/dsh), referenced as a boundary
  "--user", // systemctl --user (backup timer setup)
  "--now", // systemctl enable --now
  "--ref", // gh workflow run --ref
]);

const DOC_FILES = [
  "README.md",
  ".agents/skills/asmgr/SKILL.md",
  ".agents/skills/asmgr/references/commands.md",
  ".agents/skills/asmgr/references/turns-and-fidelity.md",
];

interface MinimalCommand {
  name(): string;
  commands: MinimalCommand[];
  options: { long: string | undefined }[];
}

function registeredLongOptions(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (command: MinimalCommand, path: string): void => {
    const label = path ? `${path} ${command.name()}` : command.name();
    for (const option of command.options) {
      if (!option.long || option.long === "--help" || option.long === "--version") continue;
      found.set(option.long, [...(found.get(option.long) ?? []), label]);
    }
    for (const child of command.commands) walk(child, label);
  };
  for (const command of (buildProgram() as unknown as Command).commands as unknown as MinimalCommand[]) {
    walk(command, "");
  }
  return found;
}

async function documentedLongOptions(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const file of DOC_FILES) {
    const text = await readFile(join(repoRoot, file), "utf8");
    for (const match of text.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
      found.set(match[0], [...(found.get(match[0]) ?? []), file]);
    }
  }
  return found;
}

describe("docs stay aligned with the CLI option surface", () => {
  it("documents only options that the CLI actually registers", async () => {
    const registered = registeredLongOptions();
    const documented = await documentedLongOptions();
    const stale = [...documented.keys()]
      .filter(flag => !registered.has(flag) && !EXTERNAL_OPTIONS.has(flag))
      .sort();
    expect(
      stale.map(flag => `${flag} (documented in: ${documented.get(flag)?.join(", ")})`),
      "docs mention long options that no command registers — update the docs, or the option was renamed/removed",
    ).toEqual([]);
  });

  it("mentions every registered long option somewhere in the docs corpus", async () => {
    const registered = registeredLongOptions();
    const documented = await documentedLongOptions();
    const missing = [...registered.keys()].filter(flag => !documented.has(flag)).sort();
    expect(
      missing.map(flag => `${flag} (registered on: ${registered.get(flag)?.join(", ")})`),
      "CLI long options missing from README/skill docs — document them or the entry docs drift from the code",
    ).toEqual([]);
  });
});
