const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  globalIgnores(
    [
      "**/.expo/**",
      "**/build/**",
      "**/coverage/**",
      "**/dist/**",
      "android/**",
      "ios/**",
      "outputs/**",
      "packages/**",
      "services/**",
      "src/shared/api/generated.ts",
    ],
    "CrewRoll generated, workspace, and CNG output",
  ),
  expoConfig,
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["tools/**/*.{js,mjs,cjs}", "*.config.{js,mjs,cjs,ts}"],
    rules: {
      "no-console": "off",
    },
  },
]);
