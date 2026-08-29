const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const boundaries = require("eslint-plugin-boundaries");
const path = require("node:path");

const {
  createMobileBoundaryPolicy,
} = require("./tools/dependency-boundary-policy.cjs");

const rootPath = path.dirname(require.resolve("./package.json"));
const mobileBoundaryPolicy = createMobileBoundaryPolicy({
  tsconfigPath: path.join(rootPath, "tsconfig.json"),
});

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
      "src/infrastructure/api/generated.ts",
    ],
    "CrewRoll generated, workspace, and CNG output",
  ),
  expoConfig,
  {
    plugins: { boundaries },
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: rootPath,
      },
    },
    ...mobileBoundaryPolicy,
  },
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Routes and features must use the infrastructure API boundary.",
        },
      ],
    },
  },
  {
    files: ["tools/**/*.{js,mjs,cjs}", "*.config.{js,mjs,cjs,ts}"],
    rules: {
      "no-console": "off",
    },
  },
]);
