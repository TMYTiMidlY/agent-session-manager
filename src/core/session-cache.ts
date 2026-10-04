import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { parseSession } from "./parse.js";
import { timelineEntrySearchText } from "./text.js";
import { BLOOM_BYTES, bloomMayContain, buildSearchBloom } from "./search-bloom.js";
import type { ParsedSession, ParseDiagnostics, SessionRef } from "./types.js";

// Bump when transcript/search semantics change, not just the on-disk schema.
export const SEARCH_CACHE_VERSION = "search-text-1";
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_BYTES = 128 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fingerprint(ref: SessionRef): Promise<string | undefined> {
  // A live SQLite WAL can change without touching the main DB's stat. Do not
  // persist negative indexes for db-turns unless snapshot-aware invalidation exists.
  if (/^https?:\/\//i.test(ref.path) || ref.source?.kind === "db-turns"
    || (ref.agent === "copilot" && basename(ref.path) === "session-store.db")) return undefined;
  try {
    const info = await stat(ref.path, { bigint: true });
    return [SEARCH_CACHE_VERSION, ref.agent, ref.id, resolve(ref.path), info.dev, info.ino, info.size, info.mtimeNs ?? info.mtimeMs, info.ctimeNs ?? info.ctimeMs].join("\0");
  } catch { return undefined; }
}

export interface SearchSnapshot {
  parsed: ParsedSession;
  /** Populated on a cold indexed read to avoid computing canonical text twice. */
  lowerTexts?: string[];
}
interface CacheHeader {
  version: string;
  fingerprint: string;
  bodyHash: string;
  metadata: SessionRef;
  diagnostics?: ParseDiagnostics;
  bloom?: string;
  bloomHash?: string;
  headerHash?: string;
}

function validMetadata(header: CacheHeader): boolean {
  const metadata = header.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  for (const key of ["cwd", "title", "startedAt", "updatedAt", "mtime", "repository", "branch"] as const) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "string") return false;
  }
  const source = metadata.source;
  if (source !== undefined && (!source || typeof source !== "object" || typeof source.path !== "string"
    || typeof source.lossy !== "boolean" || !["events", "db-turns", "chatgpt-share"].includes(source.kind)
    || (source.warning !== undefined && typeof source.warning !== "string")
    || (source.notices !== undefined && (!Array.isArray(source.notices) || !source.notices.every(value => typeof value === "string"))))) return false;
  const report = header.diagnostics;
  return report === undefined || (!!report && typeof report === "object"
    && [report.handled, report.ignored, report.unknown].every(value => Number.isSafeInteger(value) && value >= 0)
    && Array.isArray(report.unknownTypes) && report.unknownTypes.every(value => typeof value === "string")
    && (report.issues === undefined || (Array.isArray(report.issues) && report.issues.every(issue => issue
      && typeof issue.code === "string" && typeof issue.message === "string" && Number.isSafeInteger(issue.count) && issue.count > 0))));
}

function seal(header: CacheHeader): CacheHeader {
  const { headerHash: _previous, ...payload } = header;
  return { ...payload, headerHash: hash(JSON.stringify(payload)) };
}

function validSeal(header: CacheHeader): boolean {
  const { headerHash, ...payload } = header;
  return typeof headerHash === "string" && headerHash === hash(JSON.stringify(payload));
}

function matches(header: CacheHeader, ref: SessionRef, signature: string): boolean {
  return validMetadata(header) && header.version === SEARCH_CACHE_VERSION && header.fingerprint === signature
    && header.metadata?.id === ref.id && header.metadata.agent === ref.agent && header.metadata.path === ref.path;
}

async function atomicWrite(namespace: string, name: string, data: string | Buffer): Promise<void> {
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const path = join(namespace, name);
  const temporary = join(namespace, `${name}.${randomUUID()}.tmp`);
  if (dirname(path) !== namespace || dirname(temporary) !== namespace) throw new Error("invalid cache target");
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function withBloom(header: CacheHeader, lowerTexts: string[]): CacheHeader {
  const bloom = buildSearchBloom(lowerTexts);
  return { ...header, bloom: bloom.toString("base64"), bloomHash: hash(bloom) };
}

/**
 * Cache case-folded canonical search texts, not full timelines. Negative queries
 * scan verified bytes without JSON-parsing megabytes of tool payloads. Positive
 * candidates re-read the canonical source, so hit details/indices never change.
 */
export async function readSearchSession(ref: SessionRef, query: string, cacheRoot: string | undefined): Promise<SearchSnapshot> {
  if (!cacheRoot) return { parsed: await parseSession(ref) };
  const before = await fingerprint(ref);
  if (!before) return { parsed: await parseSession(ref) };
  const namespace = join(resolve(cacheRoot), "search", SEARCH_CACHE_VERSION);
  const key = hash([ref.agent, ref.id, resolve(ref.path)].join("\0"));
  const path = join(namespace, `${key}.json.gz`);
  const manifest = join(namespace, `${key}.meta.json`);
  let manifestValid = false;
  try {
    if ((await stat(manifest)).size <= 1024 * 1024) {
      const header = JSON.parse(await readFile(manifest, "utf8")) as CacheHeader;
      if (matches(header, ref, before) && validSeal(header) && typeof header.bloom === "string") {
        const bloom = Buffer.from(header.bloom, "base64");
        if (bloom.length === BLOOM_BYTES && hash(bloom) === header.bloomHash) {
          manifestValid = true;
          if (!bloomMayContain(bloom, query.toLowerCase()) && await fingerprint(ref) === before) {
            return { parsed: { ...header.metadata, diagnostics: header.diagnostics, entries: [] } };
          }
        }
      }
    }
  } catch { /* Missing/corrupt Bloom manifest falls through to the verified text index. */ }
  try {
    const info = await stat(path);
    if (info.size <= MAX_BYTES) {
      const bytes = await decompress(await readFile(path), { maxOutputLength: MAX_BYTES });
      const boundary = bytes.indexOf(10);
      if (boundary < 0 || boundary > 1024 * 1024) throw new Error("invalid cache header");
      const header = JSON.parse(bytes.subarray(0, boundary).toString("utf8")) as CacheHeader;
      const body = bytes.subarray(boundary + 1);
      if (matches(header, ref, before) && header.bodyHash === hash(body) && await fingerprint(ref) === before) {
        // Upgrade a valid pre-Bloom index once, without re-decoding the original
        // thousands of frames. Invalid index arrays always fall back to source.
        if (!manifestValid) {
          let promoted = header;
          const bloom = typeof header.bloom === "string" ? Buffer.from(header.bloom, "base64") : undefined;
          if (!bloom || bloom.length !== BLOOM_BYTES || hash(bloom) !== header.bloomHash) {
            const lowerTexts: unknown = JSON.parse(body.toString("utf8"));
            if (!Array.isArray(lowerTexts) || !lowerTexts.every(text => typeof text === "string")) throw new Error("invalid text index");
            promoted = withBloom(header, lowerTexts);
          }
          await atomicWrite(namespace, `${key}.meta.json`, JSON.stringify(seal(promoted))).catch(() => {});
        }
        // JSON escaping is substring-preserving inside a stored case-folded
        // string. Metadata/array boundaries can give false positives, never
        // false negatives; canonical re-parsing verifies positive candidates.
        // A query containing an individual UTF16 surrogate can match inside an
        // emoji in JS but not its UTF8/JSON bytes; bypass the byte prefilter.
        if (/[\uD800-\uDFFF]/.test(query)) return { parsed: await parseSession(ref) };
        const encodedNeedle = JSON.stringify(query.toLowerCase()).slice(1, -1);
        if (!body.includes(Buffer.from(encodedNeedle))) {
          return { parsed: { ...header.metadata, diagnostics: header.diagnostics, entries: [] } };
        }
        return { parsed: await parseSession(ref) };
      }
    }
  } catch {
    // Missing, stale, corrupt or unavailable cache is never a search refusal.
  }
  const parsed = await parseSession(ref);
  const lowerTexts = parsed.entries.map(entry => timelineEntrySearchText(entry).toLowerCase());
  if (await fingerprint(ref) !== before) return { parsed, lowerTexts };
  try {
    const body = JSON.stringify(lowerTexts);
    const { entries: _entries, diagnostics, ...metadata } = parsed;
    const header = withBloom({ version: SEARCH_CACHE_VERSION, fingerprint: before, metadata, diagnostics, bodyHash: hash(body) }, lowerTexts);
    const text = JSON.stringify(header) + "\n" + body;
    if (Buffer.byteLength(text) > MAX_BYTES) return { parsed, lowerTexts };
    await atomicWrite(namespace, `${key}.json.gz`, await compress(text));
    await atomicWrite(namespace, `${key}.meta.json`, JSON.stringify(seal(header)));
  } catch {
    // Cache writes are optional (read-only homes/disk full included).
  }
  return { parsed, lowerTexts };
}
