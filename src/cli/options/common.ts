import type { Command } from "commander";

/**
 * Reusable option groups shared by the read commands (list/search/show/html/md).
 * Each helper mutates and returns the command so they compose left-to-right and
 * preserve the historical `--help` option order.
 */

/** `-a, --agent` selector. */
export function withAgent(cmd: Command): Command {
  return cmd.option("-a, --agent <agent>", "copilot|claude|codex|all", "all");
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
    .option("--codex-root <path>", "override Codex sessions root");
}

/** agent + source + roots, in the historical order — for commands with no interleaved options. */
export function withReadSource(cmd: Command, fileDescription: string): Command {
  return withRoots(withSource(withAgent(cmd), fileDescription));
}
