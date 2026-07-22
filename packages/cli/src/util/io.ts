import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Read an optional file path into a string, or undefined when no path is given. */
export async function readOptionalFile(path: unknown): Promise<string | undefined> {
  if (typeof path !== "string" || !path) return undefined;
  return readFile(resolve(path), "utf8");
}
