import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.ts"],
    exclude: ["tests/setup.ts", "tests/clarigen-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // Run test files one at a time. `singleThread: true` used to sit here and
    // did nothing: it is not a vitest 4 option (it was `poolOptions.threads.
    // singleThread` in v1, and `poolOptions` is gone from 4.1.11's types too).
    // Vitest ignores unknown keys silently, so the suite has in fact been
    // running files in parallel this whole time — visible in the run summary,
    // where summed test time is ~10x the wall clock.
    //
    // That matters here because `isolate: false` below means files sharing a
    // worker also share module state, and which files share a worker is not
    // deterministic. Serialising removes that variable.
    fileParallelism: false,
    hookTimeout: 120000,
    testTimeout: 120000,
    isolate: false,
    coverage: {
      enabled: false, // Enable with --coverage flag
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["tests/**/*.ts"],
      exclude: [
        "tests/setup.ts",
        "tests/clarigen-setup.ts",
        "node_modules/**",
        "**/*.config.*",
      ],
      reportsDirectory: "./coverage",
      all: true,
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
    },
  },
});
