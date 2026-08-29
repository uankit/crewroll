import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@sinclair/typebox": fileURLToPath(
        new URL("../../node_modules/@sinclair/typebox", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/integration/**",
      "test/staging/**",
      "test/load/**",
      "**/*.integration.test.ts",
      "**/*.staging.test.ts",
      "**/*.load.test.ts",
    ],
    name: "contracts-unit",
  },
});
