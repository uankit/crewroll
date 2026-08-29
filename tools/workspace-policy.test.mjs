import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ESLint } from "eslint";
import { createVitest } from "vitest/node";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

const readText = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await readText(path));

const packageJson = await readJson("package.json");
const contractsPackageJson = await readJson("packages/contracts/package.json");
const controlPlanePackageJson = await readJson(
  "services/control-plane/package.json",
);

const workspaces = [
  { path: "packages/contracts", manifest: contractsPackageJson },
  { path: "services/control-plane", manifest: controlPlanePackageJson },
];

const dependencyOwners = [
  { path: "", manifest: packageJson },
  { path: "packages/contracts", manifest: contractsPackageJson },
  { path: "services/control-plane", manifest: controlPlanePackageJson },
];

const boundaryToolPins = {
  "eslint-import-resolver-typescript": "4.4.5",
  "eslint-plugin-boundaries": "7.2.0",
};

const forbiddenDependencies = [
  "@noble/ciphers",
  "@noble/curves",
  "@noble/hashes",
  "react-native-reanimated",
  "react-native-tcp-socket",
  "react-native-worklets",
];

const alwaysActiveCommands = [
  "verify:identity",
  "format:check",
  "lint",
  "typecheck",
  "test:unit",
  "doctor",
];

const futureOnlyCommands = [
  "test:integration",
  "test:native:ios",
  "test:native:android",
  "test:e2e",
  "test:load",
];

const rootLintPathClasses = [
  "app",
  "src",
  "modules",
  "__tests__",
  "tests",
  "tools",
  "eslint.config.js",
  "vitest.config.ts",
];

const prettierExclusions = [
  ".superpowers/**",
  "docs/TECHNICAL_TASKS.md",
  "docs/superpowers/plans/**",
  "docs/superpowers/specs/**",
  "package-lock.json",
  "**/dist/**",
  "**/coverage/**",
  "**/build/**",
  "**/.expo/**",
  "outputs/**",
  "ios/**",
  "android/**",
  "packages/contracts/generated/**",
  "src/infrastructure/api/generated.ts",
];

const unitProjectExclusions = [
  "test/integration/**",
  "test/staging/**",
  "test/load/**",
  "**/*.integration.test.ts",
  "**/*.staging.test.ts",
  "**/*.load.test.ts",
];

function countCommand(script, command) {
  return script
    .split(/\s*&&\s*/u)
    .filter((entry) => entry === `npm run ${command}`).length;
}

function assertRealScript(script, label) {
  assert.equal(typeof script, "string", `${label} must exist`);
  assert.notEqual(script.trim(), "", `${label} must not be empty`);
  assert.doesNotMatch(script, /(?:^|\s)--if-present(?:\s|$)/u);
  assert.doesNotMatch(script, /(?:^|\s)--passWithNoTests(?:\s|$)/u);
  assert.doesNotMatch(script, /@latest(?:\s|$)/u);
  assert.doesNotMatch(script, /continue-on-error/u);
  assert.doesNotMatch(script, /\|\|\s*true(?:\s|$)/u);
  assert.doesNotMatch(script, /(?:^|&&|;)\s*(?:echo\b|true\s*$)/u);
}

function assertWorkspaceScriptCoverage(entries) {
  assert.deepEqual(
    entries.map(({ path }) => path),
    ["packages/contracts", "services/control-plane"],
  );

  for (const { path, manifest } of entries) {
    for (const command of ["build", "lint", "typecheck", "test"]) {
      assertRealScript(manifest.scripts?.[command], `${path} ${command}`);
    }
  }
}

function assertRootLintPolicy(script) {
  assertRealScript(script, "root lint");
  assert.match(script, /^expo lint\b/u);

  const tokens = script.split(/\s+/u);
  for (const pathClass of rootLintPathClasses) {
    assert.ok(
      tokens.includes(pathClass),
      `root lint must enumerate ${pathClass}`,
    );
  }

  assert.ok(tokens.includes("--no-cache"), "root lint must disable cache");
  assert.ok(
    tokens.includes("--max-warnings=0"),
    "root lint must fail on warnings",
  );

  for (const workspaceName of [
    "@crewroll/contracts",
    "@crewroll/control-plane",
  ]) {
    const invocation = `npm run lint --workspace ${workspaceName}`;
    assert.equal(
      script.split(invocation).length - 1,
      1,
      `root lint must invoke ${workspaceName} exactly once`,
    );
  }
}

test("root remains the CrewRoll Expo application and owns the workspaces", () => {
  assert.equal(packageJson.name, "crewroll");
  assert.equal(packageJson.main, "expo-router/entry");
  assert.deepEqual(packageJson.workspaces, ["packages/*", "services/*"]);
  assert.equal(packageJson.engines.node, ">=22.13.0 <23");
  assert.equal(packageJson.packageManager, "npm@10.9.2");
});

test("greenfield mobile shell does not carry legacy transfer or JS crypto", () => {
  for (const dependency of forbiddenDependencies) {
    assert.equal(
      packageJson.dependencies?.[dependency],
      undefined,
      `${dependency} must not be in the greenfield mobile runtime`,
    );
  }
});

test("Expo 57 transitive peers stay on the official template versions", () => {
  assert.deepEqual(packageJson.overrides, {
    "react-dom": "19.2.3",
    "react-native-reanimated": "4.5.1",
    "react-native-worklets": "0.10.1",
  });
});

test("test-only packages are development dependencies", () => {
  for (const dependency of [
    "@testing-library/react-native",
    "@types/jest",
    "jest",
    "jest-expo",
  ]) {
    assert.equal(packageJson.dependencies?.[dependency], undefined);
    assert.ok(packageJson.devDependencies?.[dependency]);
  }
});

test("the root exposes exactly the always-active FND-002A commands", () => {
  for (const command of [...alwaysActiveCommands, "check"]) {
    assertRealScript(packageJson.scripts?.[command], `root ${command}`);
  }

  for (const command of futureOnlyCommands) {
    assert.equal(
      packageJson.scripts?.[command],
      undefined,
      `${command} stays absent until its complete harness lands`,
    );
  }

  assert.equal(packageJson.scripts?.["typecheck:workspaces"], undefined);
  assert.equal(packageJson.scripts?.["test:workspaces"], undefined);
});

test("aggregate check invokes each always-active gate exactly once", () => {
  const check = packageJson.scripts.check;
  assert.equal(typeof check, "string");

  for (const command of alwaysActiveCommands) {
    assert.equal(
      countCommand(check, command),
      1,
      `check must invoke ${command} exactly once`,
    );
  }

  assert.deepEqual(
    check.split(/\s*&&\s*/u),
    alwaysActiveCommands.map((command) => `npm run ${command}`),
  );
});

test("all root scripts reject silent skips, network-selected latest tools, and placeholders", () => {
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    assertRealScript(script, `root ${name}`);
  }
});

test("both known workspaces expose real build, lint, typecheck, and test commands", () => {
  assertWorkspaceScriptCoverage(workspaces);
});

test("workspace policy rejects a missing lint command", () => {
  const mutated = structuredClone(workspaces);
  delete mutated[0].manifest.scripts.lint;

  assert.throws(
    () => assertWorkspaceScriptCoverage(mutated),
    /packages\/contracts lint must exist/u,
  );
});

test("root lint is exhaustive, uncached, warning-clean, and invokes both workspaces", () => {
  assertRootLintPolicy(packageJson.scripts.lint);
});

test("root lint policy rejects every omitted path class and deterministic flag", () => {
  const lint = packageJson.scripts.lint;
  assert.equal(typeof lint, "string");

  for (const requiredToken of [
    ...rootLintPathClasses,
    "--no-cache",
    "--max-warnings=0",
  ]) {
    const mutated = lint
      .split(/\s+/u)
      .filter((token) => token !== requiredToken)
      .join(" ");

    assert.throws(() => assertRootLintPolicy(mutated));
  }
});

test("formatting is check-only and literal protected/generated exclusions are active", async () => {
  assert.equal(
    packageJson.scripts["format:check"],
    "prettier . --check --ignore-unknown",
  );
  assert.doesNotMatch(packageJson.scripts["format:check"], /--write/u);

  const prettierConfig = await readJson(".prettierrc.json");
  assert.equal(Array.isArray(prettierConfig), false);

  const ignoreLines = (await readText(".prettierignore"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  for (const exclusion of prettierExclusions) {
    assert.ok(
      ignoreLines.includes(exclusion),
      `.prettierignore must literally include ${exclusion}`,
    );
  }
  assert.equal(
    ignoreLines.includes("src/shared/api/generated.ts"),
    false,
    "obsolete mobile generated ownership must be removed",
  );
});

test("typecheck builds contracts before checking root and control-plane projects", () => {
  assert.equal(
    packageJson.scripts.typecheck,
    "npm run typecheck --workspace @crewroll/contracts && npm run build --workspace @crewroll/contracts && tsc --noEmit && npm run typecheck --workspace @crewroll/control-plane",
  );
});

test("root TypeScript checks tests and the root Vitest project config", async () => {
  const tsconfig = await readJson("tsconfig.json");
  for (const include of [
    "__tests__/**/*.ts",
    "__tests__/**/*.tsx",
    "tests/**/*.ts",
    "tests/**/*.tsx",
    "vitest.config.ts",
  ]) {
    assert.ok(
      tsconfig.include.includes(include),
      `tsconfig must include ${include}`,
    );
  }
});

test("unit orchestration builds dependencies and runs every suite exactly once", () => {
  assert.equal(
    packageJson.scripts["test:unit"],
    "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && npm run test:tools && npm run test:ui && vitest run --config vitest.config.ts",
  );
  assert.equal(packageJson.scripts.test, "npm run test:unit");
  assert.equal(
    packageJson.scripts["test:unit"].split("vitest run").length - 1,
    1,
  );
  assert.doesNotMatch(
    packageJson.scripts["test:unit"],
    /npm run test --workspace/u,
  );
});

test("Node policy-test discovery does not depend on shell glob expansion", () => {
  assert.equal(
    packageJson.scripts["test:tools"],
    'node --test "tools/*.test.mjs"',
  );
});

test("root Vitest is only the two exact named unit projects", async () => {
  const projectExpectations = [
    { path: "packages/contracts/vitest.config.ts", name: "contracts-unit" },
    {
      path: "services/control-plane/vitest.config.ts",
      name: "control-plane-unit",
    },
  ];

  const vitest = await createVitest("test", {
    config: "vitest.config.ts",
    run: true,
  });

  try {
    assert.deepEqual(
      vitest.projects.map((project) => project.vite.config.configFile),
      projectExpectations.map(({ path }) => fileURLToPath(new URL(path, root))),
    );
    assert.deepEqual(
      vitest.config.reporters.map(([name]) => name),
      ["verbose"],
    );

    for (const { path, name } of projectExpectations) {
      const project = vitest.projects.find(
        (candidate) => candidate.name === name,
      );
      assert.ok(project, `${path} must load as ${name}`);
      assert.deepEqual(project.config.include, ["test/**/*.test.ts"]);
      for (const exclusion of unitProjectExclusions) {
        assert.ok(
          project.config.exclude.includes(exclusion),
          `${path} must exclude ${exclusion}`,
        );
      }
    }
  } finally {
    await vitest.close();
  }
});

test("the approved local quality tools are exact dependency pins", () => {
  assert.equal(packageJson.devDependencies.prettier, "3.9.6");
  assert.equal(packageJson.devDependencies.vitest, "4.1.11");
  assert.equal(packageJson.devDependencies["expo-doctor"], "1.20.4");
  assert.equal(contractsPackageJson.devDependencies.eslint, "10.9.1");
  assert.equal(contractsPackageJson.devDependencies["@eslint/js"], "10.0.1");
  assert.equal(
    contractsPackageJson.devDependencies["typescript-eslint"],
    "8.68.0",
  );
});

test("every ESLint owner directly pins the approved boundary plugin and TypeScript resolver", async () => {
  const packageLock = await readJson("package-lock.json");

  for (const { path, manifest } of dependencyOwners) {
    const lockOwner = packageLock.packages[path];
    assert.ok(lockOwner, `package-lock.json must contain ${path || "root"}`);

    for (const [dependency, version] of Object.entries(boundaryToolPins)) {
      assert.equal(
        manifest.devDependencies?.[dependency],
        version,
        `${path || "root"} must directly pin ${dependency}`,
      );
      assert.equal(manifest.dependencies?.[dependency], undefined);
      assert.equal(
        lockOwner.devDependencies?.[dependency],
        version,
        `package-lock.json must record ${path || "root"} ownership of ${dependency}`,
      );
    }
  }

  for (const [dependency, version] of Object.entries(boundaryToolPins)) {
    const resolution = packageLock.packages[`node_modules/${dependency}`];
    assert.equal(resolution?.version, version, `${dependency} lock resolution`);
    assert.match(
      resolution?.resolved ?? "",
      new RegExp(
        `/${dependency}/-/${dependency}-${version.replaceAll(".", "\\.")}\\.tgz$`,
        "u",
      ),
    );
    assert.match(resolution?.integrity ?? "", /^sha512-/u);
  }
});

test("mobile source uses only the locked topology and public route imports", async () => {
  await assert.rejects(readdir(new URL("src/shared/", root)), {
    code: "ENOENT",
  });
  await assert.rejects(readText("src/shared/config/env.ts"), {
    code: "ENOENT",
  });
  await assert.rejects(readText("src/shared/config/env.test.ts"), {
    code: "ENOENT",
  });
  await assert.rejects(readText("src/shared/test/render.tsx"), {
    code: "ENOENT",
  });
  await assert.rejects(readText("src/shared/test/render.test.tsx"), {
    code: "ENOENT",
  });

  await readText("src/bootstrap/config/env.ts");
  await readText("src/bootstrap/config/env.test.ts");
  await readText("tests/support/render.tsx");
  await readText("tests/support/render.test.tsx");

  const publicImports = [
    ["app/index.tsx", /^import \{ HomeScreen \} from "@\/features\/home";$/mu],
    [
      "app/trips/create.tsx",
      /^import \{ AppText, Screen \} from "@\/design-system";$/mu,
    ],
    [
      "app/trips/join.tsx",
      /^import \{ AppText, Screen \} from "@\/design-system";$/mu,
    ],
    [
      "__tests__/home-screen-test.tsx",
      /^import \{ HomeScreen \} from "@\/features\/home";$/mu,
    ],
    [
      "src/features/home/index.ts",
      /^export \{ HomeScreen \} from "\.\/HomeScreen";$/mu,
    ],
  ];

  for (const [path, expectedImport] of publicImports) {
    assert.match(await readText(path), expectedImport, path);
  }
});

test("Doctor uses only the exact locally installed binary", () => {
  assert.equal(packageJson.scripts.doctor, "expo-doctor");
});

test("mobile identity runbook uses the pinned Doctor script", async () => {
  const runbook = await readText("docs/runbooks/mobile-identity.md");

  assert.match(runbook, /^npm run doctor$/mu);
  assert.doesNotMatch(runbook, /expo-doctor@latest/u);
  assert.doesNotMatch(runbook, /@latest/u);
});

test("EAS CLI is remote-pinned in all four build commands and never installed locally", () => {
  const expectedBuildScripts = {
    "build:dev:android":
      "npx --yes eas-cli@22.4.0 build --profile development --platform android",
    "build:dev:ios":
      "npx --yes eas-cli@22.4.0 build --profile development --platform ios",
    "build:preview:android":
      "npx --yes eas-cli@22.4.0 build --profile preview --platform android",
    "build:preview:ios":
      "npx --yes eas-cli@22.4.0 build --profile preview --platform ios",
  };

  for (const [name, expected] of Object.entries(expectedBuildScripts)) {
    assert.equal(packageJson.scripts[name], expected);
  }

  for (const { path, manifest } of [
    { path: "root", manifest: packageJson },
    ...workspaces,
  ]) {
    assert.equal(manifest.dependencies?.["eas-cli"], undefined, path);
    assert.equal(manifest.devDependencies?.["eas-cli"], undefined, path);
  }
});

test("EAS CLI pin changes no release profile or submission behavior", async () => {
  const easJson = await readJson("eas.json");
  assert.deepEqual(easJson, {
    cli: { version: "22.4.0", appVersionSource: "remote" },
    build: {
      development: {
        developmentClient: true,
        distribution: "internal",
        channel: "development",
        environment: "development",
      },
      "development-simulator": {
        extends: "development",
        ios: { simulator: true },
      },
      preview: {
        distribution: "internal",
        channel: "preview",
        environment: "preview",
        android: { buildType: "apk" },
      },
      production: {
        autoIncrement: true,
        channel: "production",
        environment: "production",
      },
    },
    submit: { production: {} },
  });
});

test("root ESLint ignores duplicate/generated trees and keeps app console strict", async () => {
  const eslint = new ESLint({ cwd: rootPath });

  for (const ignoredPath of [
    "packages/contracts/openapi/index.ts",
    "services/control-plane/src/index.ts",
    "dist/ios/_expo/static/js/app.js",
    "coverage/index.js",
    "modules/crewroll-transfer/dist/index.js",
    "modules/crewroll-transfer/coverage/index.js",
    "modules/crewroll-transfer/build/index.js",
    "ios/CrewRoll/AppDelegate.mm",
    "android/app/src/main/java/App.kt",
    "src/infrastructure/api/generated.ts",
  ]) {
    assert.equal(
      await eslint.isPathIgnored(ignoredPath),
      true,
      `${ignoredPath} must be globally ignored by root lint`,
    );
  }

  assert.equal(
    await eslint.isPathIgnored("src/shared/api/generated.ts"),
    false,
    "obsolete mobile generated ownership must not stay ignored",
  );

  const appConfig = await eslint.calculateConfigForFile("app/index.tsx");
  const toolsConfig = await eslint.calculateConfigForFile(
    "tools/verify-app-identity.mjs",
  );
  assert.equal(appConfig.rules["no-console"][0], 2);
  assert.equal(toolsConfig.rules["no-console"][0], 0);
});
