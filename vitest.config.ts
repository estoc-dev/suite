import { defineConfig } from "vitest/config";

// One vitest run over every package, sharing one pool of workers.
// A package's own vitest.config.ts still applies to its project.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
