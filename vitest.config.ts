import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    sequence: {
      shuffle: false,
    },
    reporters: process.env.GITHUB_ACTIONS ? "dot" : "default",
  },
});
