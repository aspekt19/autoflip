import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Preserve the existing mock-history semantics during the Vitest 5 upgrade.
    clearMocks: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
