import { extname } from "node:path";
import type { ParsedSession } from "../core/index.js";

export type SummaryFormat = "html" | "markdown";

export function parseSummaryFormat(value: string): SummaryFormat {
  if (value === "html" || value === "markdown") return value;
  throw new Error(`invalid summary format: ${value} (expected html or markdown)`);
}

export function sourceLabelForSession(session: ParsedSession): string | undefined {
  const source = session.source;
  if (!source || (!source.lossy && source.kind !== "db-turns")) return undefined;
  return "db.turns (fallback)";
}

export function summaryMismatchWarning(
  summaryPath: unknown,
  declaredFormat: SummaryFormat,
  requiredFormat: SummaryFormat,
): string | undefined {
  if (typeof summaryPath !== "string" || !summaryPath) return undefined;
  const extension = extname(summaryPath).toLowerCase();
  const extensionFormat = extension === ".html" || extension === ".htm"
    ? "html"
    : extension === ".md" || extension === ".markdown"
      ? "markdown"
      : undefined;
  if (declaredFormat === requiredFormat && (!extensionFormat || extensionFormat === requiredFormat)) {
    return undefined;
  }
  const label = requiredFormat === "html" ? "raw HTML" : "Markdown";
  return `warning: this command requires a ${label} summary fragment; ${summaryPath} will be embedded without conversion`;
}
