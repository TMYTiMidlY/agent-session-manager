import { defineConfig } from "vitest/config";

// Reference repositories are complete clones, not part of asmgr's test suite.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
