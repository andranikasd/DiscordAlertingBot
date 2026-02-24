import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // server.ts is the process entry point: side effects on load (validateEnv, route registration).
      // types/config.ts is pure TypeScript interfaces with no runtime executable code.
      exclude: ["src/server.ts", "src/types/config.ts"],
      all: true,
      reporter: ["text"],
    },
  },
});
