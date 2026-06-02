import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@warlock.js/logger": resolve(__dirname, "../logger/src/index.ts"),
      "@warlock.js/fs": resolve(__dirname, "../fs/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.spec.ts"],
    silent: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/index.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
