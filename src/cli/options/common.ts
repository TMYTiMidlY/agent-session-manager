import { InvalidArgumentError, Option, type Command } from "commander";

/**
 * Reusable option groups shared by the read commands (list/search/show/html/md).
 * Each helper mutates and returns the command so they compose left-to-right and
 * preserve the historical `--help` option order.
 */

export function nonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError("must be a non-negative integer");
  return Number(value);
}

export function searchConcurrency(value: string): number {
  const count = nonNegativeInteger(value);
  if (count < 1 || count > 32) throw new InvalidArgumentError("must be between 1 and 32");
  return count;
}

export function withRole(cmd: Command): Command {
  return cmd.addOption(new Option("--role <role>", "filter normalized timeline role")
    .choices(["user", "assistant", "tool", "reasoning", "system", "event"]));
}

/** `-a, --agent` selector. */
export function withAgent(cmd: Command): Command {
  return cmd.option("-a, --agent <agent>", "copilot|claude|codex|chatgpt|dsh|cursor (cursor-agent)|all", "all");
}

/**
 * Explicit-source options (`--file` / `--events`). The `--file` description
 * varies per command (list vs search phrasing), so it is passed in.
 */
export function withSource(cmd: Command, fileDescription: string): Command {
  return cmd
    .option("--file <path>", fileDescription)
    .option("--events <path>", "alias of --file (an explicit events.jsonl path)");
}

/** Per-agent root/db overrides. */
export function withRoots(cmd: Command): Command {
  return cmd
    .option("--copilot-root <path>", "override Copilot session-state root")
    .option("--copilot-db <path>", "override Copilot session-store.db (for pruned/DB-only sessions)")
    .option("--claude-root <path>", "override Claude projects root")
    .option("--codex-root <path>", "override Codex sessions root")
    .option("--chatgpt-root <path>", "覆盖托管的 ChatGPT 导入目录")
    .option("--dsh-root <path>", "override DeepSeek Harness sessions root")
    .option("--cursor-root <path>", "override Cursor Agent chats root");
}

/** agent + source + roots, in the historical order — for commands with no interleaved options. */
export function withReadSource(cmd: Command, fileDescription: string): Command {
  return withRoots(withSource(withAgent(cmd), fileDescription));
}
