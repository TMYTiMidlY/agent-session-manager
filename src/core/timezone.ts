const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached) return cached;
  const value = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  if (formatters.size >= 64) formatters.clear();
  formatters.set(zone, value);
  return value;
}

/** Validate an IANA zone before parsing or printing any data. */
export function validateTimeZone(zone: string): string {
  try { formatter(zone); }
  catch { throw new Error(`invalid time zone: ${zone}`); }
  return zone;
}

/** Display event timestamps in a chosen zone; source timestamps remain UTC instants. */
export function zonedTime(timestamp: string | undefined, zone = "UTC"): string | undefined {
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  if (zone === "UTC") return date.toISOString();
  const parts = formatter(zone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace(/^GMT/, "") || "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

/** Hour bucket includes its UTC offset so DST repeated hours remain distinct. */
export function hourBucket(timestamp: string, zone = "UTC"): string | undefined {
  const display = zonedTime(timestamp, zone);
  if (!display) return undefined;
  return `${display.slice(0, 13)}:00:00${zone === "UTC" ? "Z" : display.slice(19)}`;
}
