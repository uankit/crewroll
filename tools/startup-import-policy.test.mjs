import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeStartupGraph } from "./startup-import-policy.mjs";

const controlRoot = "services/control-plane";
const contractsManifestPath = "packages/contracts/package.json";
const controlManifestPath = `${controlRoot}/package.json`;
const sourceRoot = `${controlRoot}/src`;
const indexPath = `${sourceRoot}/index.ts`;
const apiPath = `${sourceRoot}/api/main.ts`;
const workerPath = `${sourceRoot}/worker/main.ts`;
const buildAppPath = `${sourceRoot}/app/buildApp.ts`;
const runnerPath = `${sourceRoot}/db/migrate.ts`;
const migrationPath = `${sourceRoot}/db/migrations/001_initial.ts`;

function rootManifest() {
  return {
    private: true,
    workspaces: ["packages/*", "services/*"],
    scripts: {},
  };
}

function controlManifest() {
  return {
    name: "@crewroll/control-plane",
    private: true,
    type: "module",
    exports: {
      ".": {
        types: "./dist/src/index.d.ts",
        import: "./dist/src/index.js",
      },
    },
    scripts: {},
  };
}

async function writeText(rootPath, relativePath, text) {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, text, "utf8");
}

async function writeJson(rootPath, relativePath, value) {
  await writeText(rootPath, relativePath, `${JSON.stringify(value)}\n`);
}

async function fixture(t, indexSource = 'import "@crewroll/contracts";\n') {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-b2b-ii-c-startup-"),
  );
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  await writeJson(rootPath, "package.json", rootManifest());
  await writeJson(rootPath, "packages/contracts/package.json", {
    name: "@crewroll/contracts",
    private: true,
    type: "module",
    scripts: {},
  });
  await writeJson(rootPath, controlManifestPath, controlManifest());
  await writeText(rootPath, indexPath, indexSource);
  return rootPath;
}

async function readJson(rootPath, relativePath) {
  return JSON.parse(await readFile(path.join(rootPath, relativePath), "utf8"));
}

async function readRepositoryJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );
}

function compareFindings(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
  );
}

function assertResultShape(result) {
  assert.deepEqual(Object.keys(result), ["protectedRoots", "findings"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.protectedRoots));
  assert.ok(Object.isFrozen(result.findings));
  assert.deepEqual(result.protectedRoots, [...result.protectedRoots].sort());
  assert.deepEqual(result.findings, [...result.findings].sort(compareFindings));
  for (const finding of result.findings) {
    assert.ok(Object.isFrozen(finding));
    assert.deepEqual(Object.keys(finding).sort(), [
      "code",
      "column",
      "line",
      "path",
    ]);
    assert.equal(path.isAbsolute(finding.path), false);
    assert.equal(finding.path.includes("\\"), false);
    assert.ok(Number.isInteger(finding.line) && finding.line > 0);
    assert.ok(Number.isInteger(finding.column) && finding.column > 0);
  }
}

function assertFinding(result, code, expectedPath) {
  assertResultShape(result);
  assert.ok(result.findings.length > 0);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === code &&
        (expectedPath === undefined || finding.path === expectedPath),
    ),
    `expected ${code}${expectedPath ? ` at ${expectedPath}` : ""}, received ${JSON.stringify(result.findings)}`,
  );
}

test("accepts the exact package entry and a closed static package graph", async (t) => {
  const rootPath = await fixture(t);
  const result = await analyzeStartupGraph({ rootPath });

  assert.deepEqual(result.protectedRoots, [indexPath]);
  assert.deepEqual(result.findings, []);
  assertResultShape(result);
});

test("protects every existing exact root and traverses all static edge forms", async (t) => {
  const rootPath = await fixture(
    t,
    `
      import "./app/buildApp.js";
      import type { Api } from "./types.js";
      export { worker } from "./worker/worker.js";
      export * from "./shared.js";
    `,
  );
  const manifest = await readJson(rootPath, controlManifestPath);
  manifest.scripts = {
    "start:api": "node dist/src/api/main.js",
    "start:worker": "node dist/src/worker/main.js",
  };
  await writeJson(rootPath, controlManifestPath, manifest);
  await writeText(rootPath, apiPath, 'import "node:http";\n');
  await writeText(rootPath, workerPath, 'import "@scope/worker/subpath";\n');
  await writeText(rootPath, buildAppPath, 'import "safe-package/sub_path";\n');
  await writeText(
    rootPath,
    `${sourceRoot}/types.ts`,
    "export interface Api {}\n",
  );
  await writeText(
    rootPath,
    `${sourceRoot}/worker/worker.ts`,
    "export const worker = true;\n",
  );
  await writeText(rootPath, `${sourceRoot}/shared.ts`, "export {};\n");

  const result = await analyzeStartupGraph({ rootPath });
  assert.deepEqual(result.protectedRoots, [
    apiPath,
    buildAppPath,
    indexPath,
    workerPath,
  ]);
  assert.deepEqual(result.findings, []);
  assertResultShape(result);
});

test("accepts actual node builtins, exact package grammar, and safe DB runtime imports", async (t) => {
  const rootPath = await fixture(
    t,
    `
      import fs from "node:fs";
      import * as pathApi from "node:path";
      import type * as moduleTypes from "node:module";
      export * as pathApiExport from "node:path";
      export type * as exportedModuleTypes from "node:module";
      import "node:fs/promises";
      import "package_name.v1~beta/sub-path";
      import "@scope-name/pkg_name/sub.path";
      import "./db/database.js";
      void fs;
      void pathApi;
      type ModuleTypes = typeof moduleTypes;
      void (undefined as unknown as ModuleTypes);
    `,
  );
  await writeText(
    rootPath,
    `${sourceRoot}/db/database.ts`,
    'import "pg";\nexport const database = true;\n',
  );
  const result = await analyzeStartupGraph({ rootPath });
  assert.deepEqual(result.findings, []);
  assertResultShape(result);
});

test("rejects runtime module-loader origins independent of aliasing and computed access", async (t) => {
  const cases = [
    [
      "namespace alias with computed name",
      `
        import * as moduleApi from "node:module";
        const loaderName = "create" + "Require";
        const load = moduleApi[loaderName](import.meta.url);
        load("./db/migrate.js");
      `,
    ],
    [
      "namespace alias with computed literal",
      `
        import * as moduleApi from "node:module";
        const load = moduleApi["createRequire"](import.meta.url);
        load("./db/migrate.js");
      `,
    ],
    [
      "default alias with destructuring",
      `
        import moduleApi from "node:module";
        const { createRequire: makeLoader } = moduleApi;
        const load = makeLoader(import.meta.url);
        load("./db/migrate.js");
      `,
    ],
    [
      "named alias",
      `
        import { createRequire as makeLoader } from "node:module";
        const load = makeLoader(import.meta.url);
        load("./db/migrate.js");
      `,
    ],
    [
      "legacy module package namespace alias",
      `
        import * as moduleApi from "module";
        const load = moduleApi["createRequire"](import.meta.url);
        load("./db/migrate.js");
      `,
    ],
  ];

  for (const [name, source] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest, source);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_UNSUPPORTED_LOADER", indexPath);
    });
  }
});

test("rejects runtime module-loader re-export origins across traversed local modules", async (t) => {
  for (const specifier of ["node:module", "module"]) {
    await t.test(specifier, async (subtest) => {
      const rootPath = await fixture(
        subtest,
        `
          import { moduleApi } from "./loader.js";
          const loaderName = "create" + "Require";
          const load = moduleApi[loaderName](import.meta.url);
          load("./db/migrate.js");
        `,
      );
      const loaderPath = `${sourceRoot}/loader.ts`;
      await writeText(
        rootPath,
        loaderPath,
        `export * as moduleApi from ${JSON.stringify(specifier)};\n`,
      );

      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_UNSUPPORTED_LOADER", loaderPath);
    });
  }
});

test("reads the root and every workspace manifest without evaluating source", async (t) => {
  const marker = "__crewrollStartupPolicyMustNotExecute";
  delete globalThis[marker];
  t.after(() => delete globalThis[marker]);
  const rootPath = await fixture(
    t,
    `globalThis.${marker} = true;\nexport const ready = true;\n`,
  );
  const reads = [];
  const result = await analyzeStartupGraph({
    rootPath,
    fsAdapter: {
      lstat,
      readdir,
      realpath,
      readFile: async (...args) => {
        reads.push(path.relative(rootPath, args[0]).split(path.sep).join("/"));
        return readFile(...args);
      },
    },
  });

  assert.equal(globalThis[marker], undefined);
  assert.deepEqual(
    [
      "package.json",
      "packages/contracts/package.json",
      controlManifestPath,
    ].filter((item) => !reads.includes(item)),
    [],
  );
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.deepEqual(result.findings, []);
});

test("rejects every control export and executable field mutation", async (t) => {
  const cases = [
    ["main field", (value) => (value.main = "./dist/src/index.js")],
    ["module field", (value) => (value.module = "./dist/src/index.js")],
    ["bin field", (value) => (value.bin = "./dist/src/index.js")],
    ["custom entry field", (value) => (value.entry = "./dist/src/index.js")],
    ["missing exports", (value) => delete value.exports],
    ["extra export", (value) => (value.exports["./admin"] = "./dist/admin.js")],
    [
      "string root export",
      (value) => (value.exports["."] = "./dist/src/index.js"),
    ],
    [
      "extra condition",
      (value) => (value.exports["."].require = "./dist/src/index.cjs"),
    ],
    [
      "wrong types target",
      (value) => (value.exports["."].types = "./dist/index.d.ts"),
    ],
    [
      "wrong import target",
      (value) => (value.exports["."].import = "./dist/index.js"),
    ],
    [
      "condition order",
      (value) => {
        value.exports["."] = {
          import: "./dist/src/index.js",
          types: "./dist/src/index.d.ts",
        };
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      const manifest = await readJson(rootPath, controlManifestPath);
      mutate(manifest);
      await writeJson(rootPath, controlManifestPath, manifest);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", controlManifestPath);
    });
  }
});

test("requires API and worker roots and scripts to activate atomically", async (t) => {
  const cases = [
    ["api root only", apiPath, null, null],
    ["api script only", null, "start:api", "node dist/src/api/main.js"],
    ["api wrong script only", null, "start:api", "echo disabled"],
    ["api wrong script", apiPath, "start:api", "tsx src/api/main.ts"],
    ["worker root only", workerPath, null, null],
    [
      "worker script only",
      null,
      "start:worker",
      "node dist/src/worker/main.js",
    ],
    ["worker wrong script only", null, "start:worker", "echo disabled"],
    [
      "worker wrong script",
      workerPath,
      "start:worker",
      "node dist/src/index.js",
    ],
  ];

  for (const [name, sourcePath, scriptName, scriptValue] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      if (sourcePath) await writeText(rootPath, sourcePath, "export {};\n");
      if (scriptName) {
        const manifest = await readJson(rootPath, controlManifestPath);
        manifest.scripts[scriptName] = scriptValue;
        await writeJson(rootPath, controlManifestPath, manifest);
      }
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE");
    });
  }

  for (const hook of [
    "prestart:api",
    "poststart:api",
    "prestart:worker",
    "poststart:worker",
  ]) {
    await t.test(hook, async (subtest) => {
      const rootPath = await fixture(subtest);
      const manifest = await readJson(rootPath, controlManifestPath);
      manifest.scripts[hook] = "node dist/src/index.js";
      await writeJson(rootPath, controlManifestPath, manifest);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", controlManifestPath);
    });
  }
});

test("rejects direct, indirect, shell, npm-exec, and out-of-contract launchers", async (t) => {
  const cases = [
    ["control direct", controlManifestPath, "serve", "node dist/src/index.js"],
    ["control source", controlManifestPath, "serve", "tsx src/index.ts"],
    [
      "control shell",
      controlManifestPath,
      "serve",
      'sh -c "node dist/src/index.js"',
    ],
    [
      "control npm exec",
      controlManifestPath,
      "serve",
      "npm exec -- tsx src/index.ts",
    ],
    ["outside target", controlManifestPath, "serve", "node server.js"],
    [
      "tool-name backdoor",
      controlManifestPath,
      "test:backdoor",
      "node server.js",
    ],
    ["control indirect", controlManifestPath, "serve", "npm run start:api"],
    [
      "misplaced exact API launcher",
      "package.json",
      "start:api",
      "node dist/src/api/main.js",
    ],
    [
      "root direct",
      "package.json",
      "serve",
      "node services/control-plane/dist/src/index.js",
    ],
    [
      "root indirect",
      "package.json",
      "serve",
      "npm run start:api --workspace @crewroll/control-plane",
    ],
  ];

  for (const [name, manifestPath, scriptName, command] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      const manifest = await readJson(rootPath, manifestPath);
      manifest.scripts[scriptName] = command;
      await writeJson(rootPath, manifestPath, manifest);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", manifestPath);
    });
  }
});

test("accepts every approved manifest script and rejects every exact-value mutation", async (t) => {
  const approved = new Map(
    await Promise.all(
      ["package.json", contractsManifestPath, controlManifestPath].map(
        async (relativePath) => [
          relativePath,
          await readRepositoryJson(relativePath),
        ],
      ),
    ),
  );

  const installApprovedManifests = async (rootPath, manifests = approved) => {
    for (const [relativePath, manifest] of manifests) {
      await writeJson(rootPath, relativePath, structuredClone(manifest));
    }
    const controlScripts = manifests.get(controlManifestPath)?.scripts ?? {};
    for (const { scriptName, sourcePath } of [
      {
        scriptName: "start:api",
        sourcePath: apiPath,
      },
      {
        scriptName: "start:worker",
        sourcePath: workerPath,
      },
    ]) {
      if (Object.hasOwn(controlScripts, scriptName)) {
        await writeText(rootPath, sourcePath, "export {};\n");
      }
    }
  };

  const rootPath = await fixture(t);
  await installApprovedManifests(rootPath);
  const accepted = await analyzeStartupGraph({ rootPath });
  assert.deepEqual(accepted.findings, []);
  assertResultShape(accepted);

  for (const { command, scriptName, sourcePath } of [
    {
      command: "node dist/src/api/main.js",
      scriptName: "start:api",
      sourcePath: apiPath,
    },
    {
      command: "node dist/src/worker/main.js",
      scriptName: "start:worker",
      sourcePath: workerPath,
    },
  ]) {
    await t.test(
      `${controlManifestPath} ${scriptName} activation is atomic`,
      async (subtest) => {
        const activated = new Map(
          [...approved].map(([relativePath, manifest]) => [
            relativePath,
            structuredClone(manifest),
          ]),
        );
        activated.get(controlManifestPath).scripts[scriptName] = command;

        const activationRoot = await fixture(subtest);
        await installApprovedManifests(activationRoot, activated);
        const activation = await analyzeStartupGraph({
          rootPath: activationRoot,
        });
        assert.deepEqual(activation.findings, []);
        assert.equal(activation.protectedRoots.includes(sourcePath), true);

        await rm(path.join(activationRoot, sourcePath));
        const removed = await analyzeStartupGraph({ rootPath: activationRoot });
        assertFinding(
          removed,
          "STARTUP_EXECUTABLE_SURFACE",
          controlManifestPath,
        );

        const mutationRoot = await fixture(subtest);
        activated.get(controlManifestPath).scripts[scriptName] = `${command} `;
        await installApprovedManifests(mutationRoot, activated);
        const mutated = await analyzeStartupGraph({ rootPath: mutationRoot });
        assert.equal(mutated.protectedRoots.includes(sourcePath), true);
        assertFinding(
          mutated,
          "STARTUP_EXECUTABLE_SURFACE",
          controlManifestPath,
        );
      },
    );
  }

  for (const [relativePath, manifest] of approved) {
    for (const [scriptName, command] of Object.entries(
      manifest.scripts ?? {},
    )) {
      await t.test(`${relativePath} ${scriptName}`, async (subtest) => {
        const mutationRoot = await fixture(subtest);
        await installApprovedManifests(mutationRoot);
        const mutated = await readJson(mutationRoot, relativePath);
        mutated.scripts[scriptName] = `${command} `;
        await writeJson(mutationRoot, relativePath, mutated);
        const result = await analyzeStartupGraph({ rootPath: mutationRoot });
        assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", relativePath);
      });
    }
  }
});

test("rejects every unknown script key independent of shell spelling or inert behavior", async (t) => {
  const commands = [
    ["POSIX node executable", '"$npm_node_execpath" "$PWD/dist/src/index.js"'],
    [
      "POSIX braced executable and working directory",
      '"${npm_node_execpath}" "${PWD}/src/index.ts"',
    ],
    [
      "POSIX env wrapper",
      '/usr/bin/env "$npm_node_execpath" "$PWD/dist/src/index.js"',
    ],
    [
      "POSIX npm executable from the invocation root",
      '"$npm_execpath" exec --call \'"$npm_node_execpath" "$PWD/dist/src/index.js"\'',
    ],
    [
      "POSIX command substitution",
      'echo "$("$npm_node_execpath" "$PWD/dist/src/index.js")"',
    ],
    [
      "POSIX split alias",
      'runtime="$npm_node_execpath"; "$runtime" "$PWD/dist/src/index.js"',
    ],
    [
      "POSIX braced default target",
      '"${npm_node_execpath}" "${PWD:-.}/dist/src/index.js"',
    ],
    [
      "Windows cmd node executable",
      '"%npm_node_execpath%" "%CD%\\dist\\src\\index.js"',
    ],
    [
      "Windows cmd wrapper",
      'cmd /d /s /c "\\"%npm_node_execpath%\\" \\"%CD%\\dist\\src\\index.js\\""',
    ],
    [
      "Windows cmd npm executable from the invocation root",
      'call "%npm_execpath%" exec --call "\\"%npm_node_execpath%\\" \\"%CD%\\dist\\src\\index.js\\""',
    ],
    [
      "Windows cmd split alias",
      'set "RUNTIME=%npm_node_execpath%" & call "%RUNTIME%" "%CD%\\dist\\src\\index.js"',
    ],
    [
      "Windows cmd delayed expansion",
      'cmd /v:on /d /s /c "\\"!npm_node_execpath!\\" \\"!CD!\\dist\\src\\index.js\\""',
    ],
    [
      "Windows PowerShell node executable",
      '& "$env:npm_node_execpath" "$PWD\\dist\\src\\index.js"',
    ],
    [
      "Windows PowerShell process wrapper",
      'Start-Process "$env:npm_node_execpath" -ArgumentList "$PWD\\dist\\src\\index.js"',
    ],
    [
      "Windows PowerShell split alias",
      '$runtime = $env:npm_node_execpath; & $runtime "$PWD\\dist\\src\\index.js"',
    ],
    [
      "Windows PowerShell braced environment",
      '& "${env:npm_node_execpath}" "${PWD}\\dist\\src\\index.js"',
    ],
    ["POSIX inert echo", 'echo "$npm_node_execpath"'],
    [
      "POSIX wrapped inert echo",
      'command echo "$npm_node_execpath $PWD/dist/src/index.js"',
    ],
    [
      "POSIX inert printf",
      "printf '%s\\n' 'literal; $npm_node_execpath $PWD/dist/src/index.js'",
    ],
    [
      "Windows cmd inert assignment",
      'set "DIAGNOSTIC=%npm_node_execpath% %CD%\\dist\\src\\index.js"',
    ],
    [
      "Windows PowerShell inert assignment",
      '$diagnostic = "$env:npm_node_execpath $PWD\\dist\\src\\index.js"',
    ],
    [
      "Windows PowerShell inert output",
      'Write-Output "$env:npm_node_execpath $PWD\\dist\\src\\index.js"',
    ],
  ];

  for (const [name, command] of commands) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      const manifest = await readJson(rootPath, controlManifestPath);
      manifest.scripts.unknown = command;
      await writeJson(rootPath, controlManifestPath, manifest);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", controlManifestPath);
    });
  }
});

test("rejects unknown script keys in the root and every workspace manifest", async (t) => {
  const cases = [
    ["root", "package.json", false],
    ["contracts", contractsManifestPath, false],
    ["unapproved workspace", "packages/unapproved/package.json", true],
  ];

  for (const [name, manifestPath, createManifest] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      const manifest = createManifest
        ? {
            name: "@crewroll/unapproved",
            private: true,
            scripts: {},
          }
        : await readJson(rootPath, manifestPath);
      manifest.scripts.diagnostics = 'echo "CrewRoll diagnostics"';
      await writeJson(rootPath, manifestPath, manifest);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", manifestPath);
    });
  }
});

test("rejects every declared workspace glob base that is not a direct regular directory", async (t) => {
  const hiddenManifest = {
    name: "@crewroll/contracts",
    private: true,
    scripts: { backdoor: "node malicious.js" },
  };
  const cases = [
    {
      name: "symlinked base",
      mutate: async (rootPath) => {
        await rm(path.join(rootPath, "packages"), {
          force: true,
          recursive: true,
        });
        await writeJson(
          rootPath,
          "workspace-shadow/contracts/package.json",
          hiddenManifest,
        );
        await symlink(
          "workspace-shadow",
          path.join(rootPath, "packages"),
          "dir",
        );

        const npmResult = spawnSync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["pkg", "get", "name", "--workspace", "@crewroll/contracts"],
          { cwd: rootPath, encoding: "utf8" },
        );
        assert.equal(npmResult.status, 0, npmResult.stderr);
        assert.match(npmResult.stdout, /@crewroll\/contracts/u);
      },
    },
    {
      name: "symlinked ancestor",
      mutate: async (rootPath) => {
        const manifest = await readJson(rootPath, "package.json");
        manifest.workspaces = ["workspace-root/packages/*", "services/*"];
        await writeJson(rootPath, "package.json", manifest);
        await writeJson(
          rootPath,
          "workspace-shadow/packages/contracts/package.json",
          hiddenManifest,
        );
        await symlink(
          "workspace-shadow",
          path.join(rootPath, "workspace-root"),
          "dir",
        );
      },
    },
    {
      name: "missing base",
      mutate: async (rootPath) =>
        rm(path.join(rootPath, "packages"), { force: true, recursive: true }),
    },
    {
      name: "non-directory base",
      mutate: async (rootPath) => {
        await rm(path.join(rootPath, "packages"), {
          force: true,
          recursive: true,
        });
        await writeText(rootPath, "packages", "not a directory\n");
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const rootPath = await fixture(subtest);
      await testCase.mutate(rootPath);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", "package.json");
    });
  }
});

test("rejects alternate main files, TypeScript shebangs, and source-tree symlinks", async (t) => {
  await t.test("alternate main", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(rootPath, `${sourceRoot}/admin/main.ts`, "export {};\n");
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(
      result,
      "STARTUP_EXECUTABLE_SURFACE",
      `${sourceRoot}/admin/main.ts`,
    );
  });

  await t.test("shebang", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(
      rootPath,
      `${sourceRoot}/tool.ts`,
      "#!/usr/bin/env node\nexport {};\n",
    );
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(
      result,
      "STARTUP_EXECUTABLE_SURFACE",
      `${sourceRoot}/tool.ts`,
    );
  });

  await t.test("TSX shebang", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(
      rootPath,
      `${sourceRoot}/tool.tsx`,
      "#!/usr/bin/env node\nexport {};\n",
    );
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(
      result,
      "STARTUP_EXECUTABLE_SURFACE",
      `${sourceRoot}/tool.tsx`,
    );
  });

  await t.test("source symlink", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(rootPath, `${sourceRoot}/actual.ts`, "export {};\n");
    await symlink(
      "actual.ts",
      path.join(rootPath, sourceRoot, "linked.ts"),
      "file",
    );
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(
      result,
      "STARTUP_EXECUTABLE_SURFACE",
      `${sourceRoot}/linked.ts`,
    );
  });
});

test("analyzes every protected root instead of treating its presence as sufficient", async (t) => {
  for (const protectedPath of [indexPath, apiPath, workerPath, buildAppPath]) {
    await t.test(protectedPath, async (subtest) => {
      const rootPath = await fixture(subtest);
      const manifest = await readJson(rootPath, controlManifestPath);
      if (protectedPath === apiPath) {
        manifest.scripts["start:api"] = "node dist/src/api/main.js";
      }
      if (protectedPath === workerPath) {
        manifest.scripts["start:worker"] = "node dist/src/worker/main.js";
      }
      await writeJson(rootPath, controlManifestPath, manifest);
      await writeText(rootPath, protectedPath, "void import(target);\n");
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_UNSUPPORTED_LOADER", protectedPath);
    });
  }
});

test("rejects control targets exported from another workspace manifest", async (t) => {
  const rootPath = await fixture(t);
  const contractsPath = "packages/contracts/package.json";
  const manifest = await readJson(rootPath, contractsPath);
  manifest.exports = {
    ".": "../../services/control-plane/dist/src/index.js",
  };
  await writeJson(rootPath, contractsPath, manifest);
  const result = await analyzeStartupGraph({ rootPath });
  assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", contractsPath);
});

test("requires the manifest-bound index to remain a regular file", async (t) => {
  await t.test("missing", async (subtest) => {
    const rootPath = await fixture(subtest);
    await rm(path.join(rootPath, indexPath));
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(result, "STARTUP_IMPORT_RESOLUTION", indexPath);
  });

  await t.test("symlink", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(rootPath, `${sourceRoot}/actual-index.ts`, "export {};\n");
    await rm(path.join(rootPath, indexPath));
    await symlink("actual-index.ts", path.join(rootPath, indexPath), "file");
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(result, "STARTUP_IMPORT_RESOLUTION", indexPath);
  });
});

test("rejects parse diagnostics without leaking or evaluating source", async (t) => {
  const marker = "__crewrollStartupParseSecret";
  delete globalThis[marker];
  t.after(() => delete globalThis[marker]);
  const rootPath = await fixture(t, `globalThis.${marker} = true;\nif (`);
  const result = await analyzeStartupGraph({ rootPath });
  assertFinding(result, "STARTUP_PARSE", indexPath);
  assert.equal(globalThis[marker], undefined);
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test("rejects malformed relative, URL, absolute, and package import grammar", async (t) => {
  const cases = [
    ["direct TypeScript", "./leaf.ts"],
    ["extensionless", "./leaf"],
    ["backslash", ".\\leaf.js"],
    ["empty segment", "./dir//leaf.js"],
    ["encoded", "./%6ceaf.js"],
    ["query", "./leaf.js?raw"],
    ["fragment", "./leaf.js#x"],
    ["control", "./leaf\u0001.js"],
    ["absolute", "/tmp/leaf.js"],
    ["drive", "C:/leaf.js"],
    ["UNC", "//server/leaf.js"],
    ["file URL", "file:///tmp/leaf.js"],
    ["data URL", "data:text/javascript,export{}"],
    ["HTTP URL", "https://example.com/leaf.js"],
    ["package alias", "#leaf"],
    ["uppercase package", "Package"],
    ["Unicode package", "café"],
    ["leading punctuation", "-package"],
    ["malformed scope", "@scope"],
    ["dot package segment", "scope/../leaf"],
    ["empty package segment", "scope//leaf"],
    ["unknown builtin", "node:not-a-real-builtin"],
    ["self package", "@crewroll/control-plane"],
    ["self subpath", "@crewroll/control-plane/private"],
  ];

  for (const [name, specifier] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(
        subtest,
        `import ${JSON.stringify(specifier)};\n`,
      );
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_IMPORT_GRAMMAR", indexPath);
    });
  }
});

test("rejects escaping, missing, ambiguous, directory, and symlinked resolution", async (t) => {
  const cases = [
    ["normalized escape", "../outside.js", "escape"],
    ["missing", "./missing.js", "missing"],
    ["ambiguous", "./leaf.js", "ambiguous"],
    ["directory", "./leaf.js", "directory"],
    ["symlink", "./leaf.js", "symlink"],
    ["symlink ancestor", "./linked/leaf.js", "ancestor"],
  ];

  for (const [name, specifier, setup] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(
        subtest,
        `import ${JSON.stringify(specifier)};\n`,
      );
      if (setup === "escape") {
        await writeText(rootPath, `${controlRoot}/outside.ts`, "export {};\n");
      } else if (setup === "ambiguous") {
        await writeText(rootPath, `${sourceRoot}/leaf.ts`, "export {};\n");
        await writeText(rootPath, `${sourceRoot}/leaf.tsx`, "export {};\n");
      } else if (setup === "directory") {
        await mkdir(path.join(rootPath, sourceRoot, "leaf.ts"), {
          recursive: true,
        });
      } else if (setup === "symlink") {
        await writeText(rootPath, `${sourceRoot}/actual.ts`, "export {};\n");
        await symlink(
          "actual.ts",
          path.join(rootPath, sourceRoot, "leaf.ts"),
          "file",
        );
      } else if (setup === "ancestor") {
        await mkdir(path.join(rootPath, sourceRoot, "actual"), {
          recursive: true,
        });
        await writeText(
          rootPath,
          `${sourceRoot}/actual/leaf.ts`,
          "export {};\n",
        );
        await symlink(
          "actual",
          path.join(rootPath, sourceRoot, "linked"),
          "dir",
        );
      }
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(
        result,
        setup === "escape"
          ? "STARTUP_IMPORT_GRAMMAR"
          : "STARTUP_IMPORT_RESOLUTION",
        indexPath,
      );
    });
  }
});

test("rejects declaration-only runtime targets while preserving exact runtime path mapping", async (t) => {
  const rejected = [
    [
      "explicit declaration target",
      "./ghost.d.js",
      [`${sourceRoot}/ghost.d.ts`],
    ],
    [
      "nested explicit declaration target",
      "./types/ghost.d.js",
      [`${sourceRoot}/types/ghost.d.ts`],
    ],
    [
      "declaration sibling cannot replace a missing runtime source",
      "./ghost.js",
      [`${sourceRoot}/ghost.d.ts`],
    ],
    [
      "declaration sibling makes a runtime source ambiguous",
      "./ghost.js",
      [`${sourceRoot}/ghost.ts`, `${sourceRoot}/ghost.d.ts`],
    ],
  ];

  for (const [name, specifier, sourcePaths] of rejected) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(
        subtest,
        `import ${JSON.stringify(specifier)};\n`,
      );
      for (const sourcePath of sourcePaths) {
        await writeText(rootPath, sourcePath, "export {};\n");
      }
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_IMPORT_RESOLUTION", indexPath);
    });
  }

  for (const [specifier, sourcePath] of [
    ["./ghost.data.js", `${sourceRoot}/ghost.data.ts`],
    ["./types.d/ghost.js", `${sourceRoot}/types.d/ghost.ts`],
  ]) {
    await t.test(`runtime source ${sourcePath}`, async (subtest) => {
      const rootPath = await fixture(
        subtest,
        `import ${JSON.stringify(specifier)};\n`,
      );
      await writeText(rootPath, sourcePath, "export {};\n");
      const result = await analyzeStartupGraph({ rootPath });
      assert.deepEqual(result.findings, []);
      assertResultShape(result);
    });
  }
});

test("rejects import attributes and every unsupported loader spelling", async (t) => {
  await t.test("import attributes", async (subtest) => {
    const rootPath = await fixture(
      subtest,
      'import data from "./data.js" with { type: "json" };\nvoid data;\n',
    );
    await writeText(rootPath, `${sourceRoot}/data.ts`, "export default {};\n");
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(result, "STARTUP_IMPORT_GRAMMAR", indexPath);
  });

  const cases = [
    ["literal dynamic import", 'void import("./leaf.js");'],
    ["nonliteral dynamic import", "void import(target);"],
    ["require call", 'require("./leaf.js");'],
    ["require alias", "const load = require; void load;"],
    ["require property", "const load = globalThis.require; void load;"],
    ["module require", 'module.require("./leaf.js");'],
    ["computed require", 'module["require"]("./leaf.js");'],
    [
      "import equals require",
      'import loader = require("./leaf.js"); void loader;',
    ],
    [
      "createRequire import",
      'import { createRequire as makeLoader } from "node:module"; void makeLoader;',
    ],
    [
      "createRequire alias",
      "const makeLoader = createRequire; void makeLoader;",
    ],
    ["process dlopen", 'process.dlopen(module, "addon.node");'],
    ["computed dlopen", 'process["dlopen"](module, "addon.node");'],
    ["eval", 'eval("require(\\"x\\")");'],
    ["Function", 'Function("return require(\\"x\\")")();'],
    ["AsyncFunction", 'new AsyncFunction("return import(\\"x\\")");'],
    ["computed eval", 'globalThis["eval"]("x");'],
    ["computed loader variable", "module[loaderName](target);"],
    ["eval alias", "const execute = eval; execute(source);"],
    ["Function alias", "const Constructor = Function; void Constructor;"],
    ["CommonJS exports", "module.exports = {};"],
    ["exports alias", "exports.ready = true;"],
    ["import type query", 'type Lazy = import("./leaf.js").Lazy;'],
  ];

  for (const [name, source] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest, `${source}\n`);
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_UNSUPPORTED_LOADER", indexPath);
    });
  }
});

test("rejects direct, transitive, barrel, and dynamic migration reachability", async (t) => {
  const cases = [
    ["direct runner", `import "./db/migrate.js";\n`, runnerPath],
    [
      "direct migration",
      `import "./db/migrations/001_initial.js";\n`,
      migrationPath,
    ],
    [
      "dynamic migration",
      `void import("./db/migrations/001_initial.js");\n`,
      migrationPath,
    ],
  ];

  for (const [name, source, targetPath] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest, source);
      await writeText(rootPath, targetPath, "export {};\n");
      const result = await analyzeStartupGraph({ rootPath });
      assertFinding(result, "STARTUP_MIGRATION_REACHABILITY", indexPath);
      if (name === "dynamic migration") {
        assertFinding(result, "STARTUP_UNSUPPORTED_LOADER", indexPath);
      }
    });
  }

  await t.test("transitive", async (subtest) => {
    const rootPath = await fixture(subtest, 'import "./bridge.js";\n');
    await writeText(
      rootPath,
      `${sourceRoot}/bridge.ts`,
      'import "./db/migrate.js";\n',
    );
    await writeText(rootPath, runnerPath, "export {};\n");
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(
      result,
      "STARTUP_MIGRATION_REACHABILITY",
      `${sourceRoot}/bridge.ts`,
    );
  });

  await t.test("barrel", async (subtest) => {
    const rootPath = await fixture(subtest, 'export * from "./barrel.js";\n');
    await writeText(
      rootPath,
      `${sourceRoot}/barrel.ts`,
      'export * from "./db/migrations/001_initial.js";\n',
    );
    await writeText(rootPath, migrationPath, "export {};\n");
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(
      result,
      "STARTUP_MIGRATION_REACHABILITY",
      `${sourceRoot}/barrel.ts`,
    );
  });
});

test("rejects missing, malformed, and symlinked manifests fail closed", async (t) => {
  await t.test("malformed root", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(rootPath, "package.json", "{");
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", "package.json");
  });

  await t.test("missing control", async (subtest) => {
    const rootPath = await fixture(subtest);
    await rm(path.join(rootPath, controlManifestPath));
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", controlManifestPath);
  });

  await t.test("symlinked control", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeJson(
      rootPath,
      `${controlRoot}/manifest-real.json`,
      controlManifest(),
    );
    await rm(path.join(rootPath, controlManifestPath));
    await symlink(
      "manifest-real.json",
      path.join(rootPath, controlManifestPath),
      "file",
    );
    const result = await analyzeStartupGraph({ rootPath });
    assertFinding(result, "STARTUP_EXECUTABLE_SURFACE", controlManifestPath);
  });
});

test("validates inputs and propagates unexpected adapter failures", async (t) => {
  await assert.rejects(
    analyzeStartupGraph(),
    /Invalid startup import analyzer input/u,
  );
  const rootPath = await fixture(t);
  const failure = new Error("adapter secret must be sanitized by dispatcher");
  await assert.rejects(
    analyzeStartupGraph({
      rootPath,
      fsAdapter: {
        lstat: async () => {
          throw failure;
        },
        readFile,
        readdir,
        realpath,
      },
    }),
    (error) => error === failure,
  );
});
