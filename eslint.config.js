const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      "dist/**",
      "outputs/**",
      "services/**",
      "packages/**",
    ],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
]);
