import { describe, expect, it } from "vitest";
import { hourBucket, validateTimeZone, zonedTime } from "../timezone.js";

describe("timestamp zones", () => {
  it("uses the event instant, not a local rollout filename", () => {
    expect(zonedTime("2026-10-02T00:15:00Z", "Asia/Shanghai")).toBe("2026-10-02T08:15:00+08:00");
    expect(hourBucket("2026-10-02T00:15:00Z", "Asia/Shanghai")).toBe("2026-10-02T08:00:00+08:00");
    expect(hourBucket("2026-10-02T00:15:00Z")).toBe("2026-10-02T00:00:00Z");
  });
  it("distinguishes DST repeated local hours", () => {
    expect(hourBucket("2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-01T01:00:00-04:00");
    expect(hourBucket("2026-11-01T06:30:00Z", "America/New_York")).toBe("2026-11-01T01:00:00-05:00");
  });
  it("refuses invalid zones and omits invalid instants", () => {
    expect(() => validateTimeZone("Bad/Zone")).toThrow("invalid time zone");
    expect(zonedTime("bad")).toBeUndefined();
    expect(zonedTime(undefined)).toBeUndefined();
  });
});
