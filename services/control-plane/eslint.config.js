import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import path from "node:path";
import tseslint from "typescript-eslint";

import boundaryPolicy from "../../tools/dependency-boundary-policy.cjs";

const { createControlPlaneBoundaryPolicy } = boundaryPolicy;
const controlPlaneBoundaryPolicy = createControlPlaneBoundaryPolicy({
  tsconfigPath: path.join(import.meta.dirname, "tsconfig.json"),
});

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { boundaries },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    ...controlPlaneBoundaryPolicy,
    rules: {
      ...controlPlaneBoundaryPolicy.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["src/api/**/*.ts", "src/modules/**/{route,routes}/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Routes must call application services through owned ports.",
        },
      ],
    },
  },
);
