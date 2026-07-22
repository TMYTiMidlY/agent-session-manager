import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeCacheTarget, defaultCacheDir } from "./cache-target.js";

describe("assertSafeCacheTarget", () => {
  it("accepts a dedicated cache directory", () => {
    const target = join(homedir(), ".cache", "chronicle", "restic-cache");
    expect(assertSafeCacheTarget(target)).toBe(target);
  });

  it("rejects the live agent homes and anything inside them", () => {
    for (const name of [".copilot", ".claude", ".codex"]) {
      expect(() => assertSafeCacheTarget(join(homedir(), name))).toThrow(/live agent home/);
      expect(() => assertSafeCacheTarget(join(homedir(), name, "session-state"))).toThrow(/live agent home/);
    }
  });

  it("rejects the home directory itself", () => {
    expect(() => assertSafeCacheTarget(homedir())).toThrow(/home directory/);
  });

  it("defaults the cache dir under ~/.cache", () => {
    expect(defaultCacheDir()).toContain(join(".cache"));
  });
});
