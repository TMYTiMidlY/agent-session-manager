export function stringifyCompact(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function stringifyInline(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyCompact(content);
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return stringifyCompact(item);
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (Array.isArray(record.content)) return contentToText(record.content);
      if (typeof record.name === "string") return `[${record.type ?? "item"}:${record.name}] ${stringifyCompact(record.input)}`;
      return stringifyCompact(record);
    })
    .filter(Boolean)
    .join("\n\n");
}

export function excerpt(text: string, query: string, width = 220): string {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const pos = haystack.indexOf(needle);
  if (pos < 0) return text.slice(0, width).replace(/\s+/g, " ");
  const start = Math.max(0, pos - Math.floor(width / 3));
  return text.slice(start, start + width).replace(/\s+/g, " ");
}
