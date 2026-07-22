import { Command } from "commander";
import { BIN_NAME } from "./brand.js";
import { buildListCommand } from "./commands/list.js";
import { buildSearchCommand } from "./commands/search.js";
import { buildShowCommand } from "./commands/show.js";
import { buildHtmlCommand } from "./commands/html.js";
import { buildMdCommand } from "./commands/md.js";
import { buildBackupCommand } from "./commands/backup/index.js";

/** Assemble the root `recall` program with every command attached. Exported so tests can drive it. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name(BIN_NAME)
    .description("Search and render local coding-agent session histories")
    .version("0.1.0");
  program.addCommand(buildListCommand());
  program.addCommand(buildSearchCommand());
  program.addCommand(buildShowCommand());
  program.addCommand(buildHtmlCommand());
  program.addCommand(buildMdCommand());
  program.addCommand(buildBackupCommand());
  return program;
}
