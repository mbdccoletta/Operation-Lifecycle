// Vitest config — most specs are pure-function tests that run
// happily in the lightweight `node` environment. Component specs
// (`*.dom.test.tsx`) opt into a `jsdom` environment per-file via
// the `@vitest-environment` pragma at the top of the test file.
// Mixing per-file environments is faster than running every test
// in jsdom — it keeps the math-helper suite at ~5 ms total.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["ui/app/**/*.{test,spec}.{ts,tsx}"],
    // RTL + jest-dom setup runs once per worker. Skipped silently
    // when the file uses the node env — the setup file imports
    // jest-dom lazily and is a no-op outside jsdom.
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["ui/app/**/*.{ts,tsx}"],
      exclude: [
        "ui/app/**/*.{test,spec}.{ts,tsx}",
        "ui/app/**/*.d.ts",
      ],
    },
  },
});
