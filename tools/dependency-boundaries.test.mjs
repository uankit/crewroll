import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ESLint as RootESLint } from "eslint";

const execFileAsync = promisify(execFile);

const rootPath = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const contractsPath = path.resolve(
  fileURLToPath(new URL("../packages/contracts/", import.meta.url)),
);
const controlPath = path.resolve(
  fileURLToPath(new URL("../services/control-plane/", import.meta.url)),
);
const policyPath = fileURLToPath(
  new URL("./dependency-boundary-policy.cjs", import.meta.url),
);
const windowsContractsBuildCommand =
  "npm run build --workspace @crewroll/contracts";
let contractsBuildCompleted = false;
let completedContractsBuildInvocation;

function buildContractsBuildInvocation(platform) {
  if (platform === "win32") {
    return {
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", windowsContractsBuildCommand],
      options: { cwd: rootPath },
    };
  }

  return {
    executable: "npm",
    args: ["run", "build", "--workspace", "@crewroll/contracts"],
    options: { cwd: rootPath },
  };
}

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const contractsRequire = createRequire(
  new URL("../packages/contracts/package.json", import.meta.url),
);
const controlRequire = createRequire(
  new URL("../services/control-plane/package.json", import.meta.url),
);

const ownerDefinitions = {
  mobile: {
    ESLint: RootESLint,
    cwd: rootPath,
    configProbe: "app/index.tsx",
    tsconfig: path.join(rootPath, "tsconfig.json"),
    version: "9",
  },
  contracts: {
    ESLint: contractsRequire("eslint").ESLint,
    cwd: contractsPath,
    configProbe: "openapi/common.ts",
    tsconfig: path.join(contractsPath, "tsconfig.json"),
    version: "10",
  },
  control: {
    ESLint: controlRequire("eslint").ESLint,
    cwd: controlPath,
    configProbe: "src/index.ts",
    tsconfig: path.join(controlPath, "tsconfig.json"),
    version: "10",
  },
};

const eslintByOwner = Object.fromEntries(
  Object.entries(ownerDefinitions).map(([name, { ESLint, cwd }]) => [
    name,
    new ESLint({ cwd }),
  ]),
);

const controlPolicyOracle = new ownerDefinitions.control.ESLint({
  cwd: controlPath,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["src/**/*.{ts,tsx,js,mts}"],
      plugins: { boundaries: controlRequire("eslint-plugin-boundaries") },
      languageOptions: {
        parser: controlRequire("typescript-eslint").parser,
        parserOptions: { tsconfigRootDir: controlPath },
      },
      ...rootRequire(policyPath).createControlPlaneBoundaryPolicy({
        tsconfigPath: path.join(controlPath, "tsconfig.json"),
      }),
    },
  ],
});

const controlCompositionPaths = [
  "src/index.ts",
  "src/app/buildApp.ts",
  "src/api/apiRuntime.ts",
  "src/api/main.ts",
  "src/api/productionApiFactories.ts",
  "src/worker/main.ts",
];
const controlCompositionPathSet = new Set(controlCompositionPaths);

const fixtureFiles = {
  mobile: {
    "src/__boundary-unknown/source.ts": "export {};\n",
    "src/bootstrap/__boundary_fixture__/target.ts":
      "export const target = true;\n",
    "src/design-system/__boundary_fixture__/target.ts":
      "export const target = true;\n",
    "src/features/__boundary_alpha__/index.ts":
      'export { target } from "./internal";\n',
    "src/features/__boundary_alpha__/internal.ts":
      "export const target = true;\n",
    "src/features/__boundary_beta__/index.ts":
      'export { target } from "./internal";\n',
    "src/features/__boundary_beta__/internal.ts":
      "export const target = true;\n",
    "src/application/__boundary_fixture__/target.ts":
      "export const target = true;\n",
    "src/domain/__boundary_fixture__/target.ts":
      "export const target = true;\n",
    "src/infrastructure/__boundary_alpha__/index.ts":
      'export { target } from "./internal";\n',
    "src/infrastructure/__boundary_alpha__/internal.ts":
      "export const target = true;\n",
    "src/infrastructure/__boundary_beta__/index.ts":
      'export { target } from "./internal";\n',
    "src/infrastructure/__boundary_beta__/internal.ts":
      "export const target = true;\n",
    "src/infrastructure/native/__boundary-source.ts": "export {};\n",
    "modules/crewroll-transfer/src/__boundary-target.ts":
      "export const target = true;\n",
    "tests/support/__boundary-target.ts": "export const target = true;\n",
  },
  contracts: {
    "__boundary-unknown/source.ts": "export {};\n",
    "openapi/__boundary-source.ts": "export {};\n",
    "openapi/__boundary-target.ts": "export const target = true;\n",
    "crypto/__boundary-target.ts": "export const target = true;\n",
    "native/__boundary-source.ts": "export {};\n",
    "native/__boundary-target.ts": "export const target = true;\n",
    "storage/__boundary-source.ts": "export {};\n",
    "storage/__boundary-target.ts": "export const target = true;\n",
    "fixtures/__boundary-source.ts": "export {};\n",
    "fixtures/__boundary-target.ts": "export const target = true;\n",
    "generator/__boundary-source.ts": "export {};\n",
    "generator/__boundary-target.ts": "export const target = true;\n",
    "test/__boundary-source.ts": "export {};\n",
    "test/__boundary-target.ts": "export const target = true;\n",
  },
  control: {
    "src/__boundary-unknown/source.ts": "export {};\n",
    "src/api/__boundary-route.ts": "export {};\n",
    "src/api/__boundary-source.ts": "export {};\n",
    "src/api/__boundary-target.ts": "export const target = true;\n",
    "src/worker/__boundary-source.ts": "export {};\n",
    "src/worker/__boundary-target.ts": "export const target = true;\n",
    "src/worker/__boundary-worker.ts": "export {};\n",
    "src/app/__boundary-service.ts": "export {};\n",
    "src/app/__boundary-target.ts": "export const target = true;\n",
    "src/app/index.ts": 'export { target } from "./__boundary-target";\n',
    "src/modules/__boundary_alpha__/index.ts":
      'export { target } from "./internal";\n',
    "src/modules/__boundary_alpha__/internal.ts":
      "export const target = true;\n",
    "src/modules/__boundary_alpha__/source.ts": "export {};\n",
    "src/modules/__boundary_alpha__/deviceRepository.ts": "export {};\n",
    "src/modules/__boundary_alpha__/deviceRoutes.ts": "export {};\n",
    "src/modules/__boundary_alpha__/tripRoutes.ts": "export {};\n",
    "src/modules/__boundary_alpha__/ports/port.ts":
      "export interface Port { readonly ready: boolean }\n",
    "src/modules/__boundary_alpha__/routes/route.ts":
      "export const target = true;\n",
    "src/modules/__boundary_alpha__/routes/source.ts": "export {};\n",
    "src/modules/__boundary_alpha__/repositories/repository.ts":
      "export const target = true;\n",
    "src/modules/__boundary_alpha__/repositories/source.ts": "export {};\n",
    "src/modules/__boundary_beta__/index.ts":
      'export { target } from "./internal";\n',
    "src/modules/__boundary_beta__/internal.ts":
      "export const target = true;\n",
    "src/modules/trips/__boundary-internal.ts": "export const target = true;\n",
    "src/modules/trips/ports/__boundary-port.ts":
      "export interface Port { readonly ready: boolean }\n",
    "src/modules/devices/ports/__boundary-port.ts":
      "export interface Port { readonly ready: boolean }\n",
    "src/db/__boundary-adapter.ts": "export {};\n",
    "src/db/__boundary-target.ts": "export const target = true;\n",
    "src/db/trips/__boundary-adapter.ts": "export {};\n",
    "src/db/devices/__boundary-adapter.ts": "export {};\n",
    "src/platform/__boundary_fixture__/source.ts": "export {};\n",
    "src/platform/__boundary_fixture__/target.ts":
      "export const target = true;\n",
    "src/config/__boundary-source.ts": "export {};\n",
    "src/config/__boundary-target.ts": "export const target = true;\n",
    "src/shared/__boundary-source.ts": "export {};\n",
    "src/shared/__boundary-target.ts": "export const target = true;\n",
    "test/__boundary-source.ts": "export {};\n",
    "test/__boundary-target.ts": "export const target = true;\n",
  },
};

const createdFiles = [];
const createdDirectories = new Set();

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createFixtureFiles() {
  for (const [owner, files] of Object.entries(fixtureFiles)) {
    const ownerPath = ownerDefinitions[owner].cwd;
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(ownerPath, relativePath);
      const directory = path.dirname(absolutePath);
      const missingDirectories = [];
      let cursor = directory;
      while (
        cursor !== ownerPath &&
        cursor.startsWith(`${ownerPath}${path.sep}`)
      ) {
        if (
          cursor
            .split(path.sep)
            .some((segment) => segment.startsWith("__boundary_"))
        ) {
          createdDirectories.add(cursor);
        }
        if (!(await pathExists(cursor))) missingDirectories.push(cursor);
        cursor = path.dirname(cursor);
      }
      await mkdir(directory, { recursive: true });
      for (const createdDirectory of missingDirectories) {
        createdDirectories.add(createdDirectory);
      }
      assert.equal(
        await pathExists(absolutePath),
        false,
        `fixture would overwrite ${absolutePath}`,
      );
      await writeFile(absolutePath, contents, "utf8");
      createdFiles.push(absolutePath);
    }
  }
}

async function removeFixtureFiles() {
  for (const file of createdFiles.toReversed()) await rm(file, { force: true });
  const directories = [...createdDirectories].sort(
    (left, right) => right.length - left.length,
  );
  for (const directory of directories) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
}

async function setupBoundaryOracle() {
  const invocation = buildContractsBuildInvocation(process.platform);
  await execFileAsync(
    invocation.executable,
    invocation.args,
    invocation.options,
  );
  completedContractsBuildInvocation = invocation;
  contractsBuildCompleted = true;
  await createFixtureFiles();
}

test.before(setupBoundaryOracle);
test.after(removeFixtureFiles);

test("contracts build command builder returns fixed safe POSIX and Windows invocations", () => {
  assert.deepEqual(buildContractsBuildInvocation("linux"), {
    executable: "npm",
    args: ["run", "build", "--workspace", "@crewroll/contracts"],
    options: { cwd: rootPath },
  });
  assert.deepEqual(buildContractsBuildInvocation("win32"), {
    executable: "cmd.exe",
    args: ["/d", "/s", "/c", "npm run build --workspace @crewroll/contracts"],
    options: { cwd: rootPath },
  });
});

test("boundary oracle builds contracts with the canonical portable invocation", async () => {
  assert.deepEqual(
    completedContractsBuildInvocation,
    process.platform === "win32"
      ? {
          executable: "cmd.exe",
          args: [
            "/d",
            "/s",
            "/c",
            "npm run build --workspace @crewroll/contracts",
          ],
          options: { cwd: rootPath },
        }
      : {
          executable: "npm",
          args: ["run", "build", "--workspace", "@crewroll/contracts"],
          options: { cwd: rootPath },
        },
  );
  assert.equal(
    contractsBuildCompleted,
    true,
    "contracts build must complete before effective ESLint runs",
  );
  for (const entrypoint of [
    "dist/openapi/index.js",
    "dist/openapi/index.d.ts",
  ]) {
    assert.equal(
      await pathExists(path.join(contractsPath, entrypoint)),
      true,
      `contracts build must emit ${entrypoint}`,
    );
  }
});

function formatMessages(result) {
  return result.messages
    .map(
      ({ column, line, message, ruleId }) =>
        `${line}:${column} ${ruleId ?? "fatal"}: ${message}`,
    )
    .join("\n");
}

function assertNoMasking(result) {
  const diagnostics = formatMessages(result);
  assert.equal(result.fatalErrorCount, 0, diagnostics);
  assert.equal(
    result.messages.some(
      ({ message, ruleId }) =>
        ruleId === null ||
        /configuration|parsing error|plugin|resolve error|resolver/iu.test(
          message,
        ),
    ),
    false,
    `boundary assertion was masked:\n${diagnostics}`,
  );
}

function assertForbidden(result, expectedRuleId) {
  assertNoMasking(result);
  assert.ok(
    result.messages.some(({ ruleId }) => ruleId === expectedRuleId),
    `expected ${expectedRuleId}:\n${formatMessages(result)}`,
  );
}

function assertAllowed(result) {
  assertNoMasking(result);
  assert.equal(result.errorCount, 0, formatMessages(result));
  assert.equal(result.warningCount, 0, formatMessages(result));
}

async function lint(owner, code, filePath, eslint = eslintByOwner[owner]) {
  if (
    eslint === eslintByOwner.control &&
    !(await pathExists(path.join(controlPath, filePath)))
  ) {
    return lintAbsentControlCompositionInIsolatedProcess(code, filePath);
  }
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result, `${owner}:${filePath} did not produce an ESLint result`);
  return result;
}

async function lintControlPolicy(code, filePath) {
  const [result] = await controlPolicyOracle.lintText(code, { filePath });
  assert.ok(
    result,
    `control-policy:${filePath} did not produce an ESLint result`,
  );
  return result;
}

async function lintFile(owner, filePath, eslint = eslintByOwner[owner]) {
  const [result] = await eslint.lintFiles([filePath]);
  assert.ok(result, `${owner}:${filePath} did not produce an ESLint result`);
  return result;
}

async function lintUnknownContractsFileInIsolatedProcess() {
  const eslintModule = contractsRequire.resolve("eslint");
  const script = `
    const { ESLint } = require(${JSON.stringify(eslintModule)});
    const eslint = new ESLint({
      cwd: ${JSON.stringify(contractsPath)},
      overrideConfig: {
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: ["__boundary-unknown/*.ts"],
              defaultProject: "tsconfig.json"
            }
          }
        }
      }
    });
    eslint.lintFiles(["__boundary-unknown/source.ts"]).then(([result]) => {
      process.stdout.write(JSON.stringify({
        errorCount: result.errorCount,
        fatalErrorCount: result.fatalErrorCount,
        messages: result.messages,
        warningCount: result.warningCount
      }));
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    cwd: contractsPath,
  });
  return JSON.parse(stdout);
}

async function lintAbsentControlCompositionInIsolatedProcess(code, filePath) {
  const eslintModule = controlRequire.resolve("eslint");
  const script = `
    const { ESLint } = require(${JSON.stringify(eslintModule)});
    const eslint = new ESLint({
      cwd: ${JSON.stringify(controlPath)},
      overrideConfig: {
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: [${JSON.stringify(filePath)}],
              defaultProject: "tsconfig.json"
            }
          }
        }
      }
    });
    eslint.lintText(${JSON.stringify(code)}, {
      filePath: ${JSON.stringify(filePath)}
    }).then(([result]) => {
      process.stdout.write(JSON.stringify({
        errorCount: result.errorCount,
        fatalErrorCount: result.fatalErrorCount,
        messages: result.messages,
        warningCount: result.warningCount
      }));
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    cwd: controlPath,
  });
  return JSON.parse(stdout);
}

async function lintExistingGraphInIsolatedProcess(owner, patterns) {
  const definition = ownerDefinitions[owner];
  const eslintModule = {
    contracts: contractsRequire,
    control: controlRequire,
    mobile: rootRequire,
  }[owner].resolve("eslint");
  const script = `
    const { ESLint } = require(${JSON.stringify(eslintModule)});
    const eslint = new ESLint({ cwd: ${JSON.stringify(definition.cwd)} });
    eslint.lintFiles(${JSON.stringify(patterns)}).then((results) => {
      process.stdout.write(JSON.stringify(results.map((result) => ({
        errorCount: result.errorCount,
        filePath: result.filePath,
        messages: result.messages.map(({ message, ruleId }) => ({
          message,
          ruleId
        })),
        warningCount: result.warningCount
      }))));
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    cwd: definition.cwd,
  });
  return JSON.parse(stdout);
}

const dependencyForms = {
  "dynamic import": (specifier) =>
    `void import(${JSON.stringify(specifier)});\n`,
  "static export": (specifier) =>
    `export { default } from ${JSON.stringify(specifier)};\n`,
  "static import": (specifier) => `import ${JSON.stringify(specifier)};\n`,
  require: (specifier) => `require(${JSON.stringify(specifier)});\n`,
};

function everyDependencyForm(specifiers) {
  return specifiers
    .flatMap((specifier) =>
      Object.values(dependencyForms).map((source) => source(specifier)),
    )
    .join("");
}

function assertForbiddenInEveryDependencyForm(result, expectedCount) {
  assertNoMasking(result);
  const boundaryErrors = result.messages.filter(
    ({ ruleId }) => ruleId === "boundaries/dependencies",
  );
  assert.equal(
    boundaryErrors.length,
    expectedCount,
    `expected every dependency form to be rejected:\n${formatMessages(result)}`,
  );
}

test("policy builders are pure, plugin-free, current-v7 settings/rules", () => {
  const {
    createContractsBoundaryPolicy,
    createControlPlaneBoundaryPolicy,
    createMobileBoundaryPolicy,
  } = rootRequire(policyPath);

  for (const [name, createPolicy] of Object.entries({
    contracts: createContractsBoundaryPolicy,
    control: createControlPlaneBoundaryPolicy,
    mobile: createMobileBoundaryPolicy,
  })) {
    const project = `/sentinel/${name}/tsconfig.json`;
    const policy = createPolicy({ tsconfigPath: project });
    assert.deepEqual(Object.keys(policy).sort(), ["rules", "settings"]);
    assert.equal(
      policy.plugins,
      undefined,
      `${name} builder must stay plugin-free`,
    );
    assert.deepEqual(policy.settings["import/resolver"], {
      typescript: { alwaysTryTypes: true, project },
    });
    assert.equal(
      policy.settings["boundaries/root-path"],
      path.dirname(project),
    );
    assert.equal(
      policy.settings["boundaries/flag-as-external"].outsideRootPath,
      true,
    );
    assert.equal(policy.rules["boundaries/no-unknown-files"], "error");
    assert.equal(policy.rules["boundaries/no-unknown-dependencies"], "error");
    assert.equal(policy.rules["boundaries/element-types"], undefined);
    assert.equal(policy.rules["boundaries/external"], undefined);
    const [severity, options] = policy.rules["boundaries/dependencies"];
    assert.equal(severity, "error");
    assert.equal(options.checkAllOrigins, true);
    assert.equal(options.checkInternals, true);
    assert.equal(options.checkUnknownLocals, true);
  }

  const mobilePolicy = createMobileBoundaryPolicy({
    tsconfigPath: "/sentinel/mobile/tsconfig.json",
  });
  assert.deepEqual(
    mobilePolicy.settings["boundaries/flag-as-external"].customSourcePatterns,
    [
      "@crewroll/contracts",
      "@crewroll/contracts/**",
      "@crewroll/control-plane",
      "@crewroll/control-plane/**",
    ],
  );
  const contractsPolicy = createContractsBoundaryPolicy({
    tsconfigPath: "/sentinel/contracts/tsconfig.json",
  });
  assert.deepEqual(contractsPolicy.settings["boundaries/ignore"], [
    "dist/**",
    "generated/**",
  ]);
  assert.equal(
    mobilePolicy.settings["boundaries/additional-dependency-nodes"],
    undefined,
  );
  assert.equal(
    contractsPolicy.settings["boundaries/additional-dependency-nodes"],
    undefined,
  );
  const controlPolicy = createControlPlaneBoundaryPolicy({
    tsconfigPath: "/sentinel/control/tsconfig.json",
  });
  assert.deepEqual(
    controlPolicy.settings["boundaries/additional-dependency-nodes"],
    [
      {
        selector: "TSImportType > Literal",
        kind: "type",
        name: "type-query",
      },
      {
        selector:
          "TSImportEqualsDeclaration TSExternalModuleReference > Literal",
        kind: "value",
        name: "import-equals",
      },
    ],
  );
});

test("effective configs independently wire the owning ESLint/plugin/resolver", async () => {
  for (const [name, definition] of Object.entries(ownerDefinitions)) {
    const config = await eslintByOwner[name].calculateConfigForFile(
      definition.configProbe,
    );
    assert.equal(definition.ESLint.version.split(".")[0], definition.version);
    assert.equal(config.plugins.boundaries.meta.version, "7.2.0");
    assert.deepEqual(config.settings["import/resolver"].typescript, {
      alwaysTryTypes: true,
      project: definition.tsconfig,
    });
    assert.ok(config.rules["boundaries/dependencies"]);
    assert.ok(config.rules["boundaries/no-unknown-files"]);
    assert.ok(config.rules["boundaries/no-unknown-dependencies"]);
    assert.equal(
      config.settings["boundaries/root-path"],
      path.resolve(definition.cwd),
    );
  }
});

test("every high-risk external/core package is rejected in every dependency-node form", async (t) => {
  const cases = [
    {
      owner: "mobile",
      filePath: "app/__boundary-source.tsx",
      specifiers: [
        "@crewroll/control-plane",
        "@clerk/expo",
        "@tanstack/react-query",
        "expo-constants",
        "expo-device",
        "expo-media-library",
        "expo-notifications",
        "expo-secure-store",
        "expo-task-manager",
        "expo-updates",
        "node:fs",
        "openapi-fetch",
        "zustand",
      ],
    },
    {
      owner: "mobile",
      filePath: "src/bootstrap/__boundary-source.ts",
      specifiers: ["@crewroll/control-plane"],
    },
    {
      owner: "contracts",
      filePath: "openapi/__boundary-source.ts",
      specifiers: [
        "@aws-sdk/client-s3",
        "@crewroll/control-plane",
        "expo",
        "expo-constants",
        "fastify",
        "kysely",
        "node:fs",
        "pg",
        "react",
        "react-native",
        "react-native-screens",
      ],
    },
    {
      owner: "contracts",
      filePath: "fixtures/__boundary-source.ts",
      specifiers: ["@crewroll/control-plane", "react"],
    },
    {
      owner: "contracts",
      filePath: "generator/__boundary-source.ts",
      specifiers: ["@crewroll/control-plane", "react-native"],
    },
    {
      owner: "control",
      filePath: "src/modules/__boundary_alpha__/routes/source.ts",
      specifiers: [
        "@aws-sdk/client-s3",
        "@clerk/backend",
        "firebase-admin",
        "kysely",
        "node:fs",
        "pg",
      ],
    },
    {
      owner: "control",
      filePath: "src/modules/__boundary_alpha__/repositories/source.ts",
      specifiers: [
        "@fastify/cors",
        "expo",
        "expo-constants",
        "fastify",
        "node:http",
        "react",
        "react-native",
        "react-native-screens",
      ],
    },
  ];

  for (const { filePath, owner, specifiers } of cases) {
    for (const specifier of specifiers) {
      for (const [form, source] of Object.entries(dependencyForms)) {
        await t.test(`${owner}:${specifier}:${form}`, async () => {
          assertForbidden(
            await lint(owner, source(specifier), filePath),
            "boundaries/dependencies",
          );
        });
      }
    }
  }
});

test("only the canonical migration runner may use its three Node adapters", async (t) => {
  const allowed = ["node:fs", "node:path", "node:url"];
  const canonicalPath = "src/db/migrate.ts";

  for (const specifier of allowed) {
    await t.test(
      `allows every import form of ${specifier} from the canonical runner`,
      async () => {
        assertAllowed(
          await lintControlPolicy(
            everyDependencyForm([specifier]),
            canonicalPath,
          ),
        );
      },
    );
  }

  for (const [name, filePath, specifiers] of [
    [
      "Node-core subpaths",
      canonicalPath,
      ["node:fs/promises", "node:path/posix", "node:path/win32", "node:url/x"],
    ],
    [
      "Node-core case variants",
      canonicalPath,
      ["node:FS", "node:Path", "node:URL"],
    ],
    [
      "case-mutated importer",
      "src/db/Migrate.ts",
      [...allowed, "node:child_process"],
    ],
    [
      "path-mutated importer",
      "src/db/runner/migrate.ts",
      [...allowed, "node:child_process"],
    ],
    [
      "TSX alternate importer",
      "src/db/migrate.tsx",
      [...allowed, "node:child_process"],
    ],
    [
      "JavaScript alternate importer",
      "src/db/migrate.js",
      [...allowed, "node:child_process"],
    ],
    [
      "MTS alternate importer",
      "src/db/migrate.mts",
      [...allowed, "node:child_process"],
    ],
    [
      "package and relative lookalikes",
      canonicalPath,
      ["node:child_process", "node:filesystem", "./node:fs"],
    ],
    ["database source", "src/db/database.ts", allowed],
    ["schema source", "src/db/schema/tables.ts", allowed],
    ["migration source", "src/db/migrations/001_initial.ts", allowed],
    [
      "repository source",
      "src/modules/__boundary_alpha__/repositories/databaseRepository.ts",
      allowed,
    ],
    ["non-database source", "src/app/__boundary-service.ts", allowed],
  ]) {
    await t.test(`rejects every import form from ${name}`, async () => {
      assertForbiddenInEveryDependencyForm(
        await lintControlPolicy(everyDependencyForm(specifiers), filePath),
        specifiers.length * Object.keys(dependencyForms).length,
      );
    });
  }
});

test("every production layer class has an effective forbidden-edge mutation", async (t) => {
  const cases = [
    [
      "mobile route to infrastructure alias",
      "mobile",
      'import "@/infrastructure/__boundary_alpha__";\n',
      "app/__boundary-source.tsx",
    ],
    [
      "mobile bootstrap to test support",
      "mobile",
      'import "../../tests/support/__boundary-target";\n',
      "src/bootstrap/__boundary-source.ts",
    ],
    [
      "mobile design to feature",
      "mobile",
      'import "../features/__boundary_alpha__";\n',
      "src/design-system/__boundary-source.tsx",
    ],
    [
      "mobile cross-feature internal",
      "mobile",
      'import "../__boundary_beta__/internal";\n',
      "src/features/__boundary_alpha__/source.ts",
    ],
    [
      "mobile application to infrastructure",
      "mobile",
      'import "../infrastructure/__boundary_alpha__";\n',
      "src/application/__boundary-source.ts",
    ],
    [
      "mobile domain to application",
      "mobile",
      'import "../application/__boundary_fixture__/target";\n',
      "src/domain/__boundary-source.ts",
    ],
    [
      "mobile infrastructure adapter cross-internal",
      "mobile",
      'import "../__boundary_beta__/internal";\n',
      "src/infrastructure/__boundary_alpha__/source.ts",
    ],
    [
      "mobile non-native infrastructure adapter to TypeBox",
      "mobile",
      'import "@sinclair/typebox/value";\n',
      "src/infrastructure/__boundary_alpha__/source.ts",
    ],
    [
      "mobile native bridge to feature",
      "mobile",
      'import "../../../src/features/__boundary_alpha__";\n',
      "modules/crewroll-transfer/src/__boundary-source.ts",
    ],
    [
      "mobile native bridge to contracts openapi",
      "mobile",
      'import "@crewroll/contracts/openapi";\n',
      "modules/crewroll-transfer/src/__boundary-source.ts",
    ],
    [
      "contracts openapi to fixture",
      "contracts",
      'import "../fixtures/__boundary-target.js";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "contracts native to storage",
      "contracts",
      'import "../storage/__boundary-target.js";\n',
      "native/__boundary-source.ts",
    ],
    [
      "contracts native to an unapproved openapi internal",
      "contracts",
      'import "../openapi/__boundary-target.js";\n',
      "native/__boundary-source.ts",
    ],
    [
      "contracts storage to native",
      "contracts",
      'import "../native/__boundary-target.js";\n',
      "storage/__boundary-source.ts",
    ],
    [
      "contracts storage to non-public openapi internal",
      "contracts",
      'import "../openapi/__boundary-target.js";\n',
      "storage/__boundary-source.ts",
    ],
    [
      "control api to db",
      "control",
      'import "../db/__boundary-target.js";\n',
      "src/api/__boundary-route.ts",
    ],
    [
      "control worker to platform",
      "control",
      'import "../platform/__boundary_fixture__/target.js";\n',
      "src/worker/__boundary-worker.ts",
    ],
    [
      "control app service to db",
      "control",
      'import "../db/__boundary-target.js";\n',
      "src/app/__boundary-service.ts",
    ],
    [
      "control module to other-module internal",
      "control",
      'import "../__boundary_beta__/internal.js";\n',
      "src/modules/__boundary_alpha__/source.ts",
    ],
    [
      "control db adapter to platform concrete",
      "control",
      'import "../platform/__boundary_fixture__/target.js";\n',
      "src/db/__boundary-adapter.ts",
    ],
    [
      "control platform adapter to db concrete",
      "control",
      'import "../../db/__boundary-target.js";\n',
      "src/platform/__boundary_fixture__/source.ts",
    ],
    [
      "control config to module",
      "control",
      'import "../modules/__boundary_alpha__";\n',
      "src/config/__boundary-source.ts",
    ],
    [
      "control shared to app",
      "control",
      'import "../app/__boundary-target.js";\n',
      "src/shared/__boundary-source.ts",
    ],
  ];

  for (const [name, owner, source, filePath] of cases) {
    await t.test(name, async () => {
      assertForbidden(
        await lint(owner, source, filePath),
        "boundaries/dependencies",
      );
    });
  }
});

test("route, repository, UI, service, and workspace-escape restrictions are executable", async (t) => {
  const cases = [
    [
      "mobile relative service escape",
      "mobile",
      'import "../services/control-plane/src/index";\n',
      "app/__boundary-source.tsx",
    ],
    [
      "mobile relative contracts implementation escape",
      "mobile",
      'import "../packages/contracts/openapi/common";\n',
      "app/__boundary-source.tsx",
    ],
    [
      "contracts relative service escape",
      "contracts",
      'import "../../../services/control-plane/src/index.js";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "contracts relative mobile escape",
      "contracts",
      'import "../../../src/design-system";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "contracts fixture relative service escape",
      "contracts",
      'import "../../../services/control-plane/src/index.js";\n',
      "fixtures/__boundary-source.ts",
    ],
    [
      "contracts generator relative mobile escape",
      "contracts",
      'import "../../../src/design-system";\n',
      "generator/__boundary-source.ts",
    ],
    [
      "control relative contracts implementation escape",
      "control",
      'import "../../../../packages/contracts/openapi/common.js";\n',
      "src/app/__boundary-service.ts",
    ],
    [
      "control relative mobile escape",
      "control",
      'import "../../../../src/design-system";\n',
      "src/app/__boundary-service.ts",
    ],
    [
      "control route to platform",
      "control",
      'import "../../../platform/__boundary_fixture__/target.js";\n',
      "src/modules/__boundary_alpha__/routes/source.ts",
    ],
    [
      "control route to repository",
      "control",
      'import "../repositories/repository.js";\n',
      "src/modules/__boundary_alpha__/routes/source.ts",
    ],
    [
      "control repository to route",
      "control",
      'import "../routes/route.js";\n',
      "src/modules/__boundary_alpha__/repositories/source.ts",
    ],
  ];

  for (const [name, owner, source, filePath] of cases) {
    await t.test(name, async () => {
      const result = await lint(owner, source, filePath);
      assertForbidden(result, "boundaries/dependencies");
      assert.equal(
        result.messages.some(({ ruleId }) =>
          [
            "boundaries/no-unknown-dependencies",
            "boundaries/no-unknown-files",
          ].includes(ruleId),
        ),
        false,
        `workspace escape was masked as unknown:\n${formatMessages(result)}`,
      );
    });
  }
});

test("production test/support/fixture/generator targets are known and rejected as dependencies", async (t) => {
  const cases = [
    [
      "mobile support",
      "mobile",
      'import "../../tests/support/__boundary-target";\n',
      "src/bootstrap/__boundary-source.ts",
    ],
    [
      "contracts fixture",
      "contracts",
      'import "../fixtures/__boundary-target.js";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "contracts generator",
      "contracts",
      'import "../generator/__boundary-target.js";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "contracts test",
      "contracts",
      'import "../test/__boundary-target.js";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "control test",
      "control",
      'import "../../test/__boundary-target.js";\n',
      "src/app/__boundary-service.ts",
    ],
  ];

  for (const [name, owner, source, filePath] of cases) {
    await t.test(name, async () => {
      const result = await lint(owner, source, filePath);
      assertForbidden(result, "boundaries/dependencies");
      assert.equal(
        result.messages.some(
          ({ ruleId }) => ruleId === "boundaries/no-unknown-files",
        ),
        false,
        formatMessages(result),
      );
    });
  }
});

test("locked camel-case control route and repository filenames receive their categories", async (t) => {
  for (const filePath of [
    "src/modules/__boundary_alpha__/deviceRoutes.ts",
    "src/modules/__boundary_alpha__/tripRoutes.ts",
  ]) {
    await t.test(`${path.basename(filePath)} allows Fastify`, async () => {
      assertAllowed(await lint("control", 'import "fastify";\n', filePath));
    });
  }

  await t.test("deviceRoutes rejects its sibling repository", async () => {
    assertForbidden(
      await lint(
        "control",
        'import "./deviceRepository.js";\n',
        "src/modules/__boundary_alpha__/deviceRoutes.ts",
      ),
      "boundaries/dependencies",
    );
  });

  await t.test("deviceRepository rejects its sibling route", async () => {
    assertForbidden(
      await lint(
        "control",
        'import "./deviceRoutes.js";\n',
        "src/modules/__boundary_alpha__/deviceRepository.ts",
      ),
      "boundaries/dependencies",
    );
  });
});

test("production owners reject contracts fixture and generator subpaths in every dependency form", async (t) => {
  for (const [owner, filePath] of [
    ["mobile", "src/bootstrap/__boundary-source.ts"],
    ["control", "src/app/__boundary-service.ts"],
  ]) {
    for (const [form, source] of Object.entries(dependencyForms)) {
      await t.test(`${owner}:fixtures/http:${form}`, async () => {
        assertForbidden(
          await lint(
            owner,
            source("@crewroll/contracts/fixtures/http"),
            filePath,
          ),
          "boundaries/dependencies",
        );
      });
    }

    await t.test(`${owner}:generator`, async () => {
      assertForbidden(
        await lint(
          owner,
          'import "@crewroll/contracts/generator/private";\n',
          filePath,
        ),
        "boundaries/dependencies",
      );
    });
  }

  for (const [owner, filePath] of [
    ["mobile", "tests/support/__boundary-source.ts"],
    ["control", "test/__boundary-source.ts"],
  ]) {
    await t.test(`${owner} tests retain fixture consumption`, async () => {
      assertAllowed(
        await lint(
          owner,
          'import "@crewroll/contracts/fixtures/http";\n',
          filePath,
        ),
      );
    });
  }
});

test("all control composition roots reject workspace implementation escapes and arbitrary SDKs", async (t) => {
  const roots = [
    ["src/index.ts", "../../../"],
    ["src/app/buildApp.ts", "../../../../"],
    ["src/api/apiRuntime.ts", "../../../../"],
    ["src/api/main.ts", "../../../../"],
    ["src/api/productionApiFactories.ts", "../../../../"],
    ["src/worker/main.ts", "../../../../"],
  ];

  for (const [filePath, repositoryPrefix] of roots) {
    for (const [name, source] of [
      ["React", 'import "react";\n'],
      ["AWS SDK", 'import "@aws-sdk/client-s3";\n'],
      [
        "mobile implementation",
        `import ${JSON.stringify(`${repositoryPrefix}src/design-system`)};\n`,
      ],
      [
        "contracts implementation",
        `import ${JSON.stringify(
          `${repositoryPrefix}packages/contracts/openapi/common.js`,
        )};\n`,
      ],
    ]) {
      await t.test(`${filePath}:${name}`, async () => {
        const result = await lint("control", source, filePath);
        assertForbidden(result, "boundaries/dependencies");
        assert.equal(
          result.messages.some(({ ruleId }) =>
            [
              "boundaries/no-unknown-dependencies",
              "boundaries/no-unknown-files",
            ].includes(ruleId),
          ),
          false,
          `composition restriction was masked as unknown:\n${formatMessages(result)}`,
        );
      });
    }
  }
});

test("global fetch is rejected in mobile route/feature and locked camel-case control routes", async (t) => {
  for (const [name, owner, filePath] of [
    ["mobile route", "mobile", "app/__boundary-source.tsx"],
    ["mobile feature", "mobile", "src/features/__boundary_alpha__/source.ts"],
    [
      "control device route",
      "control",
      "src/modules/__boundary_alpha__/deviceRoutes.ts",
    ],
    [
      "control trip route",
      "control",
      "src/modules/__boundary_alpha__/tripRoutes.ts",
    ],
  ]) {
    const accesses = [
      ["bare", 'void fetch("https://example.invalid");\n'],
      ["globalThis", 'void globalThis.fetch("https://example.invalid");\n'],
      ...(owner === "mobile"
        ? [
            ["self", 'void self.fetch("https://example.invalid");\n'],
            ["window", 'void window.fetch("https://example.invalid");\n'],
          ]
        : []),
      ...(filePath.endsWith("deviceRoutes.ts")
        ? [["global", 'void global.fetch("https://example.invalid");\n']]
        : []),
    ];
    for (const [access, source] of accesses) {
      await t.test(`${name}:${access}`, async () => {
        assertForbidden(
          await lint(owner, source, filePath),
          "no-restricted-globals",
        );
      });
    }
  }
});

test("the oracle never owns locked future control composition entrypoints", () => {
  for (const relativePath of [
    "src/api/main.ts",
    "src/api/apiRuntime.ts",
    "src/api/productionApiFactories.ts",
    "src/worker/main.ts",
    "src/app/buildApp.ts",
  ]) {
    assert.equal(
      Object.hasOwn(fixtureFiles.control, relativePath),
      false,
      `${relativePath} must remain available for its planned implementation`,
    );
  }
});

test("Trip commands keep constant-time byte comparison behind a platform port", async () => {
  assertForbidden(
    await lint(
      "control",
      'import { timingSafeEqual } from "node:crypto";\nvoid timingSafeEqual;\n',
      "src/modules/trips/__boundary-internal.ts",
    ),
    "no-restricted-imports",
  );

  assertAllowed(
    await lint(
      "control",
      'import { timingSafeEqual } from "node:crypto";\nvoid timingSafeEqual;\n',
      "src/platform/__boundary_fixture__/source.ts",
    ),
  );
});

test("Trip database adapters consume only Trip ports through type imports", async (t) => {
  const tripAdapter = "src/db/trips/__boundary-adapter.ts";
  const tripPort = "../../modules/trips/ports/__boundary-port.js";

  await t.test("exact Trip type import is allowed", async () => {
    assertAllowed(
      await lint(
        "control",
        `import type { Port } from ${JSON.stringify(tripPort)};\nexport type AdapterPort = Port;\n`,
        tripAdapter,
      ),
    );
  });

  await t.test(
    "every Trip port value dependency form is rejected",
    async () => {
      assertForbiddenInEveryDependencyForm(
        await lint("control", everyDependencyForm([tripPort]), tripAdapter),
        Object.keys(dependencyForms).length,
      );
    },
  );

  for (const [name, source, filePath] of [
    [
      "type re-export",
      `export type { Port } from ${JSON.stringify(tripPort)};\n`,
      tripAdapter,
    ],
    [
      "other database adapter to Trip port",
      `import type { Port } from ${JSON.stringify(tripPort)};\nexport type AdapterPort = Port;\n`,
      "src/db/devices/__boundary-adapter.ts",
    ],
    [
      "Trip adapter to another module port",
      'import type { Port } from "../../modules/devices/ports/__boundary-port.js";\nexport type AdapterPort = Port;\n',
      tripAdapter,
    ],
    [
      "Trip adapter to Trip internal",
      'import type { target } from "../../modules/trips/__boundary-internal.js";\n',
      tripAdapter,
    ],
    [
      "reverse Trip port to database adapter",
      'import type {} from "../../../db/trips/__boundary-adapter.js";\n',
      "src/modules/trips/ports/__boundary-port.ts",
    ],
    [
      "Trip port to Kysely",
      'import type { Kysely } from "kysely";\n',
      "src/modules/trips/ports/__boundary-port.ts",
    ],
  ]) {
    await t.test(name, async () => {
      assertForbidden(
        await lint("control", source, filePath),
        "boundaries/dependencies",
      );
    });
  }

  for (const [name, source, filePath] of [
    [
      "type query from Trip adapter to Trip internal",
      'export type InternalTarget = import("../../modules/trips/__boundary-internal.js").target;\n',
      tripAdapter,
    ],
    [
      "type query from Trip adapter to another module port",
      'export type OtherPort = import("../../modules/devices/ports/__boundary-port.js").Port;\n',
      tripAdapter,
    ],
    [
      "reverse type query from Trip port to database adapter",
      'export type DatabaseAdapter = import("../../../db/trips/__boundary-adapter.js");\n',
      "src/modules/trips/ports/__boundary-port.ts",
    ],
    [
      "type query from Trip port to Kysely",
      'export type TripDatabase = import("kysely").Kysely<never>;\n',
      "src/modules/trips/ports/__boundary-port.ts",
    ],
    [
      "typeof import from Trip adapter to exact Trip port",
      `export type RuntimeTripPort = typeof import(${JSON.stringify(tripPort)});\n`,
      tripAdapter,
    ],
    [
      "import-equals runtime from Trip adapter to exact Trip port",
      `import TripPort = require(${JSON.stringify(tripPort)});\nvoid TripPort;\n`,
      tripAdapter,
    ],
  ]) {
    await t.test(name, async () => {
      assertForbidden(
        await lint("control", source, filePath),
        "boundaries/dependencies",
      );
    });
  }
});

test("real control composition entrypoints stay on the project service", async () => {
  assert.equal(controlCompositionPathSet.has("src/index.ts"), true);
  assert.equal(await pathExists(path.join(controlPath, "src/index.ts")), true);
  assertForbidden(
    await lint("control", 'import "react";\n', "src/index.ts"),
    "boundaries/dependencies",
  );
});

test("unknown production paths fail closed under each owning ESLint", async (t) => {
  for (const [owner, filePath] of [
    ["mobile", "src/__boundary-unknown/source.ts"],
    ["control", "src/__boundary-unknown/source.ts"],
  ]) {
    await t.test(owner, async () => {
      assertForbidden(
        await lintFile(owner, filePath),
        "boundaries/no-unknown-files",
      );
    });
  }

  await t.test("contracts", async () => {
    assertForbidden(
      await lintUnknownContractsFileInIsolatedProcess(),
      "boundaries/no-unknown-files",
    );
  });
});

test("every documented allowed edge passes with zero diagnostics", async (t) => {
  const cases = [
    [
      "mobile route to feature public",
      "mobile",
      'import "@/features/__boundary_alpha__";\n',
      "app/__boundary-source.tsx",
    ],
    [
      "mobile route to design public",
      "mobile",
      'import "@/design-system";\n',
      "app/__boundary-source.tsx",
    ],
    [
      "mobile route to bootstrap",
      "mobile",
      'import "@/bootstrap/__boundary_fixture__/target";\n',
      "app/__boundary-source.tsx",
    ],
    [
      "mobile bootstrap composition to infrastructure",
      "mobile",
      'import "../infrastructure/__boundary_alpha__";\n',
      "src/bootstrap/__boundary-source.ts",
    ],
    [
      "mobile bootstrap composition to public contracts",
      "mobile",
      'import "@crewroll/contracts";\n',
      "src/bootstrap/__boundary-source.ts",
    ],
    [
      "mobile design internal",
      "mobile",
      'import "./__boundary_fixture__/target";\n',
      "src/design-system/__boundary-source.tsx",
    ],
    [
      "mobile feature same-feature internal",
      "mobile",
      'import "./internal";\n',
      "src/features/__boundary_alpha__/source.ts",
    ],
    [
      "mobile feature to design",
      "mobile",
      'import "../../design-system";\n',
      "src/features/__boundary_alpha__/source.ts",
    ],
    [
      "mobile feature to application",
      "mobile",
      'import "../../application/__boundary_fixture__/target";\n',
      "src/features/__boundary_alpha__/source.ts",
    ],
    [
      "mobile application to domain",
      "mobile",
      'import "../domain/__boundary_fixture__/target";\n',
      "src/application/__boundary-source.ts",
    ],
    [
      "mobile domain internal",
      "mobile",
      'import "./__boundary_fixture__/target";\n',
      "src/domain/__boundary-source.ts",
    ],
    [
      "mobile infrastructure to application",
      "mobile",
      'import "../../application/__boundary_fixture__/target";\n',
      "src/infrastructure/__boundary_alpha__/source.ts",
    ],
    [
      "mobile infrastructure adapter internal",
      "mobile",
      'import "./internal";\n',
      "src/infrastructure/__boundary_alpha__/source.ts",
    ],
    [
      "mobile native infrastructure adapter to TypeBox value",
      "mobile",
      'import "@sinclair/typebox/value";\n',
      "src/infrastructure/native/__boundary-source.ts",
    ],
    [
      "mobile native bridge internal",
      "mobile",
      'import "./__boundary-target";\n',
      "modules/crewroll-transfer/src/__boundary-source.ts",
    ],
    [
      "mobile native bridge to contracts crypto protocol",
      "mobile",
      'import "@crewroll/contracts/crypto/protocol";\n',
      "modules/crewroll-transfer/src/__boundary-source.ts",
    ],
    [
      "mobile native bridge to contracts native protocol",
      "mobile",
      'import "@crewroll/contracts/native/protocol";\n',
      "modules/crewroll-transfer/src/__boundary-source.ts",
    ],
    [
      "mobile native bridge to Expo module loader",
      "mobile",
      'export { requireNativeModule } from "expo";\n',
      "modules/crewroll-transfer/src/__boundary-source.ts",
    ],
    [
      "contracts openapi js-to-ts",
      "contracts",
      'import "./__boundary-target.js";\n',
      "openapi/__boundary-source.ts",
    ],
    [
      "contracts native to crypto",
      "contracts",
      'import "../crypto/__boundary-target.js";\n',
      "native/__boundary-source.ts",
    ],
    [
      "contracts native to common schema types",
      "contracts",
      'import "../openapi/common.js";\n',
      "native/__boundary-source.ts",
    ],
    [
      "contracts native to identifier schema types",
      "contracts",
      'import "../openapi/ids.js";\n',
      "native/__boundary-source.ts",
    ],
    [
      "contracts storage to openapi schema",
      "contracts",
      'import "../openapi/index.js";\n',
      "storage/__boundary-source.ts",
    ],
    [
      "contracts fixture to definition",
      "contracts",
      'import "../openapi/__boundary-target.js";\n',
      "fixtures/__boundary-source.ts",
    ],
    [
      "contracts fixture to TypeBox",
      "contracts",
      'import "@sinclair/typebox";\n',
      "fixtures/__boundary-source.ts",
    ],
    [
      "contracts generator to definition",
      "contracts",
      'import "../native/__boundary-target.js";\n',
      "generator/__boundary-source.ts",
    ],
    [
      "contracts generator to Node filesystem",
      "contracts",
      'import "node:fs/promises";\n',
      "generator/__boundary-source.ts",
    ],
    [
      "contracts generator to TypeBox",
      "contracts",
      'import "@sinclair/typebox";\n',
      "generator/__boundary-source.ts",
    ],
    [
      "contracts test to definition",
      "contracts",
      'import "../storage/__boundary-target.js";\n',
      "test/__boundary-source.ts",
    ],
    [
      "control composition root to concrete db",
      "control",
      'import "./db/__boundary-target.js";\n',
      "src/index.ts",
    ],
    [
      "control buildApp composition to platform",
      "control",
      'import "../platform/__boundary_fixture__/target.js";\n',
      "src/app/buildApp.ts",
    ],
    [
      "control production factories composition to db",
      "control",
      'import "../db/__boundary-target.js";\n',
      "src/api/productionApiFactories.ts",
    ],
    [
      "control worker composition main to platform",
      "control",
      'import "../platform/__boundary_fixture__/target.js";\n',
      "src/worker/main.ts",
    ],
    [
      "control api to module public",
      "control",
      'import "../modules/__boundary_alpha__";\n',
      "src/api/__boundary-source.ts",
    ],
    [
      "control worker to app public",
      "control",
      'import "../app/index.js";\n',
      "src/worker/__boundary-source.ts",
    ],
    [
      "control module same-module internal",
      "control",
      'import "./internal.js";\n',
      "src/modules/__boundary_alpha__/source.ts",
    ],
    [
      "control module to shared",
      "control",
      'import "../../shared/__boundary-target.js";\n',
      "src/modules/__boundary_alpha__/source.ts",
    ],
    [
      "control db adapter to module port",
      "control",
      'import "../modules/__boundary_alpha__/ports/port.js";\n',
      "src/db/__boundary-adapter.ts",
    ],
    [
      "control platform adapter to module port",
      "control",
      'import "../../modules/__boundary_alpha__/ports/port.js";\n',
      "src/platform/__boundary_fixture__/source.ts",
    ],
    [
      "control test to production",
      "control",
      'import "../src/app/__boundary-target.js";\n',
      "test/__boundary-source.ts",
    ],
  ];

  for (const [name, owner, source, filePath] of cases) {
    await t.test(name, async () => {
      assertAllowed(await lint(owner, source, filePath));
    });
  }
});

test("removing the TypeScript resolver makes the alias oracle lose its boundary diagnostic", async () => {
  const source = 'import "@/infrastructure/__boundary_alpha__";\n';
  const filePath = "app/__boundary-resolver-source.tsx";
  const withResolver = await lint("mobile", source, filePath);
  assertForbidden(withResolver, "boundaries/dependencies");
  const isResolvedInfrastructureDiagnostic = ({ message, ruleId }) =>
    ruleId === "boundaries/dependencies" &&
    /elements? of type "infrastructure"/u.test(message);
  assert.equal(
    withResolver.messages.some(isResolvedInfrastructureDiagnostic),
    true,
    formatMessages(withResolver),
  );

  const actualRootConfig = rootRequire(path.join(rootPath, "eslint.config.js"));
  const configWithoutTypescriptResolver = actualRootConfig.map((config) => {
    const resolver = config.settings?.["import/resolver"];
    if (!resolver || typeof resolver !== "object" || Array.isArray(resolver)) {
      return config;
    }
    const remainingResolvers = Object.fromEntries(
      Object.entries(resolver).filter(([name]) => name !== "typescript"),
    );
    return {
      ...config,
      settings: {
        ...config.settings,
        "import/resolver": remainingResolvers,
      },
    };
  });
  const withoutResolver = new RootESLint({
    cwd: rootPath,
    overrideConfig: configWithoutTypescriptResolver,
    overrideConfigFile: true,
  });
  const effectiveConfig =
    await withoutResolver.calculateConfigForFile(filePath);
  assert.equal(
    effectiveConfig.settings["import/resolver"].typescript,
    undefined,
  );
  const result = await lint("mobile", source, filePath, withoutResolver);
  assertNoMasking(result);
  assert.equal(
    result.messages.some(isResolvedInfrastructureDiagnostic),
    false,
    `alias unexpectedly classified as infrastructure without TypeScript resolver:\n${formatMessages(result)}`,
  );
});

test("the existing source import graph stays green under effective configs", async () => {
  const targets = [
    ["mobile", rootPath, ["app", "src", "modules/crewroll-transfer"]],
    [
      "contracts",
      contractsPath,
      [
        "openapi",
        "crypto",
        "native",
        "storage",
        "fixtures",
        "generator",
        "test",
        "vitest.config.ts",
      ],
    ],
    ["control", controlPath, ["src"]],
  ];

  for (const [owner, cwd, patterns] of targets) {
    const results = (
      await lintExistingGraphInIsolatedProcess(owner, patterns)
    ).filter(
      ({ filePath }) =>
        !filePath.includes(`${path.sep}__boundary-unknown${path.sep}`),
    );
    const unexpected = results.filter(
      ({ errorCount, warningCount }) => errorCount > 0 || warningCount > 0,
    );
    assert.deepEqual(
      unexpected.map(({ filePath, messages }) => ({
        filePath: path.relative(cwd, filePath),
        messages: messages.map(({ message, ruleId }) => ({ message, ruleId })),
      })),
      [],
    );
  }
});

test("fixture setup never overwrites a tracked source file", async () => {
  const source = await readFile(
    path.join(rootPath, "src/features/home/HomeScreen.tsx"),
    "utf8",
  );
  assert.match(source, /export function HomeScreen/u);
});
