import { defineProject } from "vitest/config";

export default defineProject({
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
    name: "control-plane-unit",
  },
});
