import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "web/src/**/*.test.ts", "worker/test/**/*.test.ts"],
    environment: "node",
  },
});
