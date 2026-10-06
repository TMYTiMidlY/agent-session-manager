#!/usr/bin/env node
import { buildProgram } from "./program.js";
import { isSearchWorker } from "../core/search-worker.js";

if (!isSearchWorker) {
  // Pipeline consumers such as head may intentionally close stdout early.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  buildProgram().parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
