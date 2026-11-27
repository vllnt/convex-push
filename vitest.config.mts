import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shared dev hosts: keep test parallelism low.
    maxWorkers: 2,
    environment: "edge-runtime",
    exclude: ["**/node_modules/**", "dist/**"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      include: ["src/**/*.ts", "example/convex/example.ts"],
      exclude: ["src/**/_generated/**", "src/**/*.test.ts", "src/component/convex.config.ts", "src/testing/**"],
    },
  },
});
