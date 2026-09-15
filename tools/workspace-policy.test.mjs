import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { ESLint } from "eslint";
import ts from "typescript";
import { createVitest } from "vitest/node";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const execFileAsync = promisify(execFile);

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

const contractsBuildCommand = "npm run build --workspace @crewroll/contracts";
const contractsProductionLifecycleHooks = [
  "prestart",
  "prestart:clean",
  "preandroid",
  "preandroid:device",
  "preios",
  "preios:device",
  "preverify:bundle",
  "eas-build-post-install",
];
const nativeAdapterBundleCommand =
  "expo export:embed --entry-file src/infrastructure/native/crewRollTransfer.ts --platform ios --dev false --minify false --bundle-output dist/native-adapter.ios.js --max-workers 1";

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
  "migrations:check",
  "test:unit",
  "doctor",
];

const migrationCheckCommand = "node tools/check-migrations.mjs";
const migrationRunCommand = "tsx src/db/migrate.ts";
const guardedMigrationCheckCommand =
  "npm run --ignore-scripts migrations:check";
const migrationLifecycleHooks = [
  "premigrations:check",
  "postmigrations:check",
  "predb:migrate",
  "postdb:migrate",
];

const futureSuiteScripts = [
  {
    publicName: "test:integration",
    publicCommand: "node tools/run-future-suite.mjs integration",
    privateName: "test:integration:run",
    privateCommand:
      "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts",
  },
  {
    publicName: "test:native:ios",
    publicCommand: "node tools/run-future-suite.mjs native-ios",
    privateName: "test:native:ios:run",
    privateCommand:
      "swift test --package-path modules/crewroll-transfer/ios --scratch-path .expo/crewroll-native-ios-tests",
  },
  {
    publicName: "test:native:android",
    publicCommand: "node tools/run-future-suite.mjs native-android",
    privateName: "test:native:android:run",
    privateCommand: "node tools/run-android-native-tests.mjs",
  },
  {
    publicName: "test:e2e",
    publicCommand: "node tools/run-future-suite.mjs e2e",
    privateName: "test:e2e:run",
    privateCommand: "maestro test tests/maestro",
  },
  {
    publicName: "test:load",
    publicCommand: "node tools/run-future-suite.mjs load",
    privateName: "test:load:run",
    privateCommand: "k6 run tests/load/photo-flow.js",
  },
];

const futureSuiteLifecycleHooks = futureSuiteScripts.flatMap(
  ({ publicName, privateName }) => [
    `pre${publicName}`,
    `post${publicName}`,
    `pre${privateName}`,
    `post${privateName}`,
  ],
);

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

function assertLintBuildPrerequisites(rootManifest, controlManifest) {
  assert.equal(
    rootManifest.scripts?.prelint,
    contractsBuildCommand,
    "root prelint must build contracts before root/mobile and workspace lint",
  );
  assert.equal(
    controlManifest.scripts?.prelint,
    contractsBuildCommand,
    "control prelint must build contracts before standalone control lint",
  );
}

function assertFutureSuiteSurface(manifest) {
  for (const {
    publicName,
    publicCommand,
    privateName,
    privateCommand,
  } of futureSuiteScripts) {
    assert.equal(
      manifest.scripts?.[publicName],
      publicCommand,
      `${publicName} must use the honest dispatcher`,
    );
    const privateValue = manifest.scripts?.[privateName];
    assert.ok(
      privateValue === undefined || privateValue === privateCommand,
      `${privateName} must be absent or use its exact owner command`,
    );
  }

  for (const hookName of futureSuiteLifecycleHooks) {
    assert.equal(
      manifest.scripts?.[hookName],
      undefined,
      `${hookName} is a forbidden lifecycle path`,
    );
  }
}

function assertMigrationCheckSurface(
  rootManifest,
  controlManifest,
  contractsManifest,
) {
  assert.equal(
    rootManifest.scripts?.["migrations:check"],
    migrationCheckCommand,
    "migrations:check must use the canonical dispatcher",
  );
  assert.equal(
    rootManifest.scripts?.["db:migrate"],
    undefined,
    "root db:migrate is not an authorized migration runner owner",
  );
  assert.equal(
    controlManifest.scripts?.["migrations:check"],
    undefined,
    "control migrations:check is not an authorized dispatcher owner",
  );
  assert.equal(
    contractsManifest.scripts?.["db:migrate"],
    undefined,
    "contracts db:migrate is not an authorized migration runner owner",
  );
  for (const hookName of ["predb:migrate", "postdb:migrate"]) {
    assert.equal(
      contractsManifest.scripts?.[hookName],
      undefined,
      `contracts ${hookName} is a forbidden lifecycle path`,
    );
  }
  const migrationRunValue = controlManifest.scripts?.["db:migrate"];
  assert.ok(
    migrationRunValue === undefined ||
      migrationRunValue === migrationRunCommand,
    "control db:migrate must be absent or use the exact DB-001 runner command",
  );

  for (const hookName of migrationLifecycleHooks) {
    assert.equal(
      rootManifest.scripts?.[hookName],
      undefined,
      `${hookName} is a forbidden lifecycle path`,
    );
    assert.equal(
      controlManifest.scripts?.[hookName],
      undefined,
      `${hookName} is a forbidden lifecycle path`,
    );
  }
}

function assertContractsProductionLifecycle(rootManifest) {
  for (const hook of contractsProductionLifecycleHooks) {
    assert.equal(
      rootManifest.scripts?.[hook],
      contractsBuildCommand,
      `${hook} must build dist-only contracts before production mobile resolution`,
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

test("the root exposes always-active gates and exact honest future dispatchers", () => {
  for (const command of [...alwaysActiveCommands, "check"]) {
    assertRealScript(packageJson.scripts?.[command], `root ${command}`);
  }

  assertFutureSuiteSurface(packageJson);
  assertMigrationCheckSurface(
    packageJson,
    controlPlanePackageJson,
    contractsPackageJson,
  );

  assert.equal(packageJson.scripts?.["typecheck:workspaces"], undefined);
  assert.equal(packageJson.scripts?.["test:workspaces"], undefined);
});

test("workspace policy permits only the exact control-plane migration runner activation", () => {
  const activatedControl = structuredClone(controlPlanePackageJson);
  activatedControl.scripts["db:migrate"] = migrationRunCommand;

  assert.doesNotThrow(() =>
    assertMigrationCheckSurface(
      packageJson,
      activatedControl,
      contractsPackageJson,
    ),
  );

  for (const replacement of [
    `${migrationRunCommand} --mutated`,
    "tsx src/db/other.ts",
    "",
  ]) {
    const mutatedControl = structuredClone(controlPlanePackageJson);
    mutatedControl.scripts["db:migrate"] = replacement;

    assert.throws(
      () =>
        assertMigrationCheckSurface(
          packageJson,
          mutatedControl,
          contractsPackageJson,
        ),
      /control db:migrate/u,
    );
  }

  const wrongRootOwner = structuredClone(packageJson);
  wrongRootOwner.scripts["db:migrate"] = migrationRunCommand;
  assert.throws(
    () =>
      assertMigrationCheckSurface(
        wrongRootOwner,
        controlPlanePackageJson,
        contractsPackageJson,
      ),
    /root db:migrate/u,
  );

  const wrongControlOwner = structuredClone(controlPlanePackageJson);
  wrongControlOwner.scripts["migrations:check"] = migrationCheckCommand;
  assert.throws(
    () =>
      assertMigrationCheckSurface(
        packageJson,
        wrongControlOwner,
        contractsPackageJson,
      ),
    /control migrations:check/u,
  );
});

for (const scriptName of ["db:migrate", "predb:migrate", "postdb:migrate"]) {
  test(`workspace policy rejects contracts ${scriptName}`, () => {
    const mutatedContracts = structuredClone(contractsPackageJson);
    mutatedContracts.scripts[scriptName] =
      scriptName === "db:migrate"
        ? migrationRunCommand
        : "node -e process.exit(0)";

    assert.throws(
      () =>
        assertMigrationCheckSurface(
          packageJson,
          controlPlanePackageJson,
          mutatedContracts,
        ),
      new RegExp(
        `^AssertionError \\[ERR_ASSERTION\\]: contracts ${scriptName}`,
        "u",
      ),
    );
  });
}

test("workspace policy rejects every migration lifecycle hook", () => {
  for (const hookName of migrationLifecycleHooks) {
    for (const owner of ["root", "control"]) {
      const mutatedRoot = structuredClone(packageJson);
      const mutatedControl = structuredClone(controlPlanePackageJson);
      mutatedControl.scripts["db:migrate"] = migrationRunCommand;
      (owner === "root" ? mutatedRoot : mutatedControl).scripts[hookName] =
        "node -e process.exit(0)";

      assert.throws(
        () =>
          assertMigrationCheckSurface(
            mutatedRoot,
            mutatedControl,
            contractsPackageJson,
          ),
        new RegExp(`^AssertionError \\[ERR_ASSERTION\\]: ${hookName}`, "u"),
      );
    }
  }
});

test("workspace policy rejects every public and private future-suite lifecycle hook", () => {
  assert.equal(futureSuiteLifecycleHooks.length, 20);
  assert.equal(new Set(futureSuiteLifecycleHooks).size, 20);

  for (const hookName of futureSuiteLifecycleHooks) {
    const mutated = structuredClone(packageJson);
    mutated.scripts[hookName] = "node -e process.exit(0)";

    assert.throws(
      () => assertFutureSuiteSurface(mutated),
      new RegExp(`^AssertionError \\[ERR_ASSERTION\\]: ${hookName}`, "u"),
    );
  }
});

test("workspace policy permits absent or exact private owner scripts and rejects mutations", () => {
  for (const { privateName, privateCommand } of futureSuiteScripts) {
    const activated = structuredClone(packageJson);
    activated.scripts[privateName] = privateCommand;
    assert.doesNotThrow(
      () => assertFutureSuiteSurface(activated),
      `${privateName} exact owner command`,
    );

    const mutated = structuredClone(packageJson);
    mutated.scripts[privateName] = `${privateCommand} --mutated`;
    assert.throws(
      () => assertFutureSuiteSurface(mutated),
      new RegExp(`^AssertionError \\[ERR_ASSERTION\\]: ${privateName}`, "u"),
    );
  }
});

test("aggregate check invokes each always-active gate exactly once", () => {
  const check = packageJson.scripts.check;
  assert.equal(typeof check, "string");

  for (const command of alwaysActiveCommands.filter(
    (command) => command !== "migrations:check",
  )) {
    assert.equal(
      countCommand(check, command),
      1,
      `check must invoke ${command} exactly once`,
    );
  }
  assert.equal(
    check.split(guardedMigrationCheckCommand).length - 1,
    1,
    "check must invoke migrations:check exactly once with lifecycle scripts disabled",
  );

  assert.deepEqual(check.split(/\s*&&\s*/u), [
    "npm run verify:identity",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    guardedMigrationCheckCommand,
    "npm run test:unit",
    "npm run doctor",
  ]);

  for (const { publicName, privateName } of futureSuiteScripts) {
    assert.equal(countCommand(check, publicName), 0);
    assert.equal(countCommand(check, privateName), 0);
  }
});

test("aggregate migration check is guarded and rejects an unguarded mutation", () => {
  const unguarded = structuredClone(packageJson);
  unguarded.scripts.check = alwaysActiveCommands
    .map((command) => `npm run ${command}`)
    .join(" && ");

  assert.throws(() => {
    const check = unguarded.scripts.check;
    assert.ok(check.includes(guardedMigrationCheckCommand));
  }, /guarded/u);
});

test("npm 10 guarded migration invocation runs no lifecycle hook", async (t) => {
  const fixturePath = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-npm-hook-"),
  );
  t.after(async () => rm(fixturePath, { force: true, recursive: true }));
  await mkdir(fixturePath, { recursive: true });
  await writeFile(
    path.join(fixturePath, "package.json"),
    JSON.stringify({
      name: "crewroll-npm-hook-fixture",
      private: true,
      scripts: {
        "migrations:check": "node main.mjs",
        "premigrations:check": "node pre.mjs",
        "postmigrations:check": "node post.mjs",
      },
    }),
  );
  await writeFile(
    path.join(fixturePath, "pre.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile("pre.marker", "bad");\n',
  );
  await writeFile(
    path.join(fixturePath, "post.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile("post.sentinel", "bad");\n',
  );
  await writeFile(
    path.join(fixturePath, "main.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile("main.marker", "ok");\n',
  );

  await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "--ignore-scripts", "migrations:check"],
    { cwd: fixturePath },
  );

  await readFile(path.join(fixturePath, "main.marker"), "utf8");
  await assert.rejects(readFile(path.join(fixturePath, "pre.marker")));
  await assert.rejects(readFile(path.join(fixturePath, "post.sentinel")));
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

test("root and control lint lifecycle build contracts first", () => {
  assertLintBuildPrerequisites(packageJson, controlPlanePackageJson);
});

test("every production mobile lifecycle builds dist-only contracts first", () => {
  assertContractsProductionLifecycle(packageJson);
});

test("production lifecycle policy rejects every missing or substituted contracts build", () => {
  const compliant = structuredClone(packageJson);
  for (const hook of contractsProductionLifecycleHooks) {
    compliant.scripts[hook] = contractsBuildCommand;
  }

  for (const hook of contractsProductionLifecycleHooks) {
    for (const replacement of [
      undefined,
      "npm run typecheck --workspace @crewroll/contracts",
      "npm run build --workspace @crewroll/control-plane",
      `${contractsBuildCommand} && true`,
    ]) {
      const mutated = structuredClone(compliant);
      if (replacement === undefined) delete mutated.scripts[hook];
      else mutated.scripts[hook] = replacement;

      assert.throws(
        () => assertContractsProductionLifecycle(mutated),
        new RegExp(
          `${hook.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} must build`,
        ),
      );
    }
  }
});

test("lint prerequisite policy rejects removal or a different dependency build", () => {
  for (const owner of ["root", "control"]) {
    for (const replacement of [
      undefined,
      "npm run typecheck --workspace @crewroll/contracts",
      "npm run build --workspace @crewroll/control-plane",
    ]) {
      const mutatedRoot = structuredClone(packageJson);
      const mutatedControl = structuredClone(controlPlanePackageJson);
      const mutatedOwner = owner === "root" ? mutatedRoot : mutatedControl;

      if (replacement === undefined) delete mutatedOwner.scripts.prelint;
      else mutatedOwner.scripts.prelint = replacement;

      assert.throws(
        () => assertLintBuildPrerequisites(mutatedRoot, mutatedControl),
        owner === "root"
          ? /root prelint must build contracts/u
          : /control prelint must build contracts/u,
      );
    }
  }
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
    "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && npm run test:production-resolution && npm run test:tools && npm run test:ui && vitest run --config vitest.config.ts",
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

test("bundle verification executes the native adapter production graph", () => {
  assert.deepEqual(packageJson.scripts["verify:bundle"].split(/\s*&&\s*/u), [
    nativeAdapterBundleCommand,
    "expo export --platform ios --output-dir dist/ios",
    "expo export --platform android --output-dir dist/android",
  ]);
  assert.equal(
    packageJson.scripts["test:production-resolution"],
    "node tools/verify-native-production-resolution.mjs",
  );
});

test("builds one shell-free npm CLI invocation for POSIX and Windows paths and fails closed without npm_execpath", async () => {
  const { buildNpmCliInvocation } =
    await import("./verify-native-production-resolution.mjs?workspace-policy");
  const cases = [
    {
      label: "POSIX",
      input: {
        execPath: "/opt/node/bin/node",
        npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
      },
      expected: {
        command: "/opt/node/bin/node",
        args: [
          "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
          "run",
          "verify:bundle",
        ],
      },
    },
    {
      label: "Windows",
      input: {
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath:
          "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      },
      expected: {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [
          "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
          "run",
          "verify:bundle",
        ],
      },
    },
  ];

  for (const { label, input, expected } of cases) {
    assert.deepEqual(buildNpmCliInvocation(input), expected, label);
  }

  for (const npmExecPath of [undefined, "", "   "]) {
    assert.throws(
      () =>
        buildNpmCliInvocation({
          execPath: "/opt/node/bin/node",
          npmExecPath,
        }),
      /npm_execpath must be a non-empty path to the npm CLI/u,
    );
  }
});

test("imports the npm invocation builder without executing the destructive production probe", () => {
  const moduleUrl = new URL(
    "./verify-native-production-resolution.mjs",
    import.meta.url,
  ).href;
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const loaded = await import(${JSON.stringify(moduleUrl)}); if (typeof loaded.buildNpmCliInvocation !== "function") throw new Error("missing builder");`,
    ],
    {
      cwd: rootPath,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: "" },
    },
  );

  assert.equal(
    imported.status,
    0,
    [imported.stdout, imported.stderr].filter(Boolean).join("\n"),
  );
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
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

  await assert.rejects(readText("app/trips/create.tsx"), {
    code: "ENOENT",
  });
  await assert.rejects(readText("app/trips/join.tsx"), {
    code: "ENOENT",
  });

  const publicImports = [
    ["app/index.tsx", /^import \{ Redirect \} from "expo-router";$/mu],
    [
      "app/index.tsx",
      /^import \{[^}]*\buseAppSession\b[^}]*\} from "@\/bootstrap";$/mu,
    ],
    [
      "app/index.tsx",
      /^import \{[^}]*\bSessionLoadingScreen\b[^}]*\} from "@\/bootstrap";$/mu,
    ],
    [
      "app/(app)/index.tsx",
      /import\s*\{[^}]*\bHomeScreen\b[^}]*\}\s*from "@\/features\/home";/u,
    ],
    [
      "app/(app)/trips/create.tsx",
      /import\s*\{[^}]*\bCreateTripScreen\b[^}]*\}\s*from "@\/features\/trips";/u,
    ],
    [
      "app/(app)/trips/join.tsx",
      /import\s*\{[^}]*\bJoinTripScreen\b[^}]*\}\s*from "@\/features\/invitations";/u,
    ],
    [
      "app/(app)/trips/[tripId].tsx",
      /import\s*\{[^}]*\bLobbyScreen\b[^}]*\}\s*from "@\/features\/trips";/u,
    ],
    [
      "__tests__/home-screen-test.tsx",
      /import\s*\{[^}]*\bHomeScreen\b[^}]*\}\s*from "@\/features\/home";/u,
    ],
    [
      "src/features/home/index.ts",
      /export\s*\{[^}]*\bHomeScreen\b[^}]*\}\s*from "\.\/HomeScreen";/u,
    ],
  ];

  for (const [path, expectedImport] of publicImports) {
    assert.match(await readText(path), expectedImport, path);
  }
});

test("development acceptance stays out of static production and feature graphs", async () => {
  const appProviders = await readText("src/bootstrap/AppProviders.tsx");
  const acceptanceRoute = await readText("app/dev/staging-acceptance.tsx");
  const acceptanceControl = await readText(
    "src/bootstrap/DevelopmentAcceptance.tsx",
  );
  assert.doesNotMatch(appProviders, /(?:import|export)[^;]*["']\.\.\/dev\//u);
  assert.doesNotMatch(
    acceptanceRoute,
    /^import[^;]*(?:DevelopmentAcceptance|src\/dev)/mu,
  );
  assert.match(
    acceptanceRoute,
    /import\("@\/bootstrap\/DevelopmentAcceptanceSurface"\)/u,
  );
  assert.match(
    acceptanceControl,
    /import\("\.\.\/dev\/TripMutationResponseCut"\)/u,
  );
  assert.match(
    acceptanceControl,
    /import\("\.\.\/dev\/SafeClerkClaimInspector"\)/u,
  );

  async function sourceFiles(relativeDirectory) {
    const directory = new URL(`${relativeDirectory}/`, root);
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
      else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(relative);
    }
    return files;
  }

  function staticModuleSpecifiers(source, fileName = "source.ts") {
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
      fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    return sourceFile.statements.flatMap((statement) => {
      if (
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        return [statement.moduleSpecifier.text];
      }
      return [];
    });
  }
  assert.deepEqual(staticModuleSpecifiers('import "../dev/side-effect";'), [
    "../dev/side-effect",
  ]);
  assert.deepEqual(
    staticModuleSpecifiers(
      'import DefaultThing, { named } from "../dev/combined";',
    ),
    ["../dev/combined"],
  );
  assert.deepEqual(
    staticModuleSpecifiers('void import("../dev/dynamic");'),
    [],
  );

  for (const file of [
    ...(await sourceFiles("src/features")),
    ...(await sourceFiles("src/domain")),
  ]) {
    assert.doesNotMatch(
      await readText(file),
      /(?:DevelopmentAcceptance|src\/dev|\.\.\/dev\/)/u,
      file,
    );
  }
  for (const file of await sourceFiles("src/bootstrap")) {
    assert.equal(
      staticModuleSpecifiers(await readText(file), file).some((specifier) =>
        /(?:^|\/)dev\//u.test(specifier),
      ),
      false,
      file,
    );
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

test("EAS release profiles and submission destinations stay explicit", async () => {
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
      "preview-simulator": {
        extends: "preview",
        ios: { simulator: true },
      },
      testflight: {
        extends: "production",
        distribution: "store",
        channel: "testflight",
        environment: "preview",
      },
      production: {
        autoIncrement: true,
        channel: "production",
        environment: "production",
      },
    },
    submit: {
      testflight: { ios: { ascAppId: "6797897853" } },
      production: {},
    },
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
