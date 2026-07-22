#!/usr/bin/env node
import { buildProgram } from "./program.js";

buildProgram().parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
