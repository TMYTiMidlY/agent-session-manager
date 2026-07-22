import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveProject } from "../project.js";

describe("deriveProject", () => {
  it("buckets a missing cwd as (unscoped)", () => {
    expect(deriveProject(undefined)).toBe("(unscoped)");
  });

  it("returns the recorded cwd verbatim when it does not exist locally", () => {
    expect(deriveProject("/nope/does/not/exist/here")).toBe("/nope/does/not/exist/here");
  });

  it("walks up to the nearest .git ancestor when the path exists", () => {
    const root = mkdtempSync(join(tmpdir(), "chronicle-project-"));
    mkdirSync(join(root, ".git"));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    try {
      expect(deriveProject(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
