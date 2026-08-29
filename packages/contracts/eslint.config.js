import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import path from "node:path";
import tseslint from "typescript-eslint";

import boundaryPolicy from "../../tools/dependency-boundary-policy.cjs";

const { createContractsBoundaryPolicy } = boundaryPolicy;
const contractsBoundaryPolicy = createContractsBoundaryPolicy({
  tsconfigPath: path.join(import.meta.dirname, "tsconfig.json"),
});

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "generated/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    plugins: { boundaries },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    ...contractsBoundaryPolicy,
    rules: {
      ...contractsBoundaryPolicy.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["test/**/*.typecheck.ts"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
