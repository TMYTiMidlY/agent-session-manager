#!/usr/bin/env node
import { buildProgram } from "./program.js";
import { isSearchWorker } from "../core/search-worker.js";

if (!isSearchWorker) buildProgram().parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
