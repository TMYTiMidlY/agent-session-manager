import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  if (!(await pathExists(root))) return out;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && predicate(path)) {
        out.push(path);
      }
    }
  }

  await walk(root);
  return out.sort();
}

export async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ type: "parse_error", text: line });
    }
  }
  return rows;
}

export function fileStem(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

export function parentName(path: string): string {
  return basename(dirname(path));
}
