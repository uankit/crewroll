import assert from "node:assert/strict";
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
import { pathToFileURL } from "node:url";

import { runMigrationCheck } from "./check-migrations.mjs";
import { analyzeMigrationModules } from "./migration-policy.mjs";
import { analyzeMigrationRunner } from "./migration-runner-policy.mjs";
import { analyzeStartupGraph } from "./startup-import-policy.mjs";
const controlManifest = {
  name: "@crewroll/control-plane",
  type: "module",
  exports: {
    ".": {
      types: "./dist/src/index.d.ts",
      import: "./dist/src/index.js",
    },
  },
  scripts: {},
};
const canonicalRunner = `
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Kysely } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { createDatabase } from "./database.js";
import type { Database } from "./schema/tables.js";

const migrationFolder = fileURLToPath(
  new URL("./migrations/", import.meta.url),
);

export async function migrateToLatest(
  database: Kysely<Database>,
): Promise<void> {
  const provider = new FileMigrationProvider({ fs, path, migrationFolder });
  const migrator = new Migrator({ db: database, provider });
  const result = await migrator.migrateToLatest();

  if (result.error !== undefined) {
    throw new Error("CrewRoll database migration failed", {
      cause: result.error,
    });
  }
}

export async function main(source: NodeJS.ProcessEnv): Promise<number> {
  const connectionString = source.DATABASE_URL;

  if (typeof connectionString !== "string" || connectionString.length === 0) {
    return 1;
  }

  const database = createDatabase(connectionString);

  try {
    await migrateToLatest(database);
    return 0;
  } catch {
    return 1;
  } finally {
    await database.destroy();
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void main(process.env).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
`;
const canonicalMigration = `
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("users").execute();
}
`;
const migrationPath = "services/control-plane/src/db/migrations/001_initial.ts";
const runnerPath = "services/control-plane/src/db/migrate.ts";
const indexPath = "services/control-plane/src/index.ts";

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  assert.notEqual(index, -1, `missing mutation source: ${before}`);
  assert.equal(
    source.indexOf(before, index + before.length),
    -1,
    `ambiguous mutation source: ${before}`,
  );
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

async function readJson(rootPath, relativePath) {
  return JSON.parse(await readFile(path.join(rootPath, relativePath), "utf8"));
}

async function fixture(t) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "crewroll-b2b-i-cli-"));
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  await mkdir(path.join(rootPath, "tools"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    `${JSON.stringify({ workspaces: ["services/*"], scripts: {} })}\n`,
  );
  await mkdir(path.join(rootPath, "services/control-plane"), {
    recursive: true,
  });
  await writeFile(
    path.join(rootPath, "services/control-plane/package.json"),
    `${JSON.stringify(controlManifest)}\n`,
  );
  await mkdir(path.join(rootPath, "services/control-plane/src"), {
    recursive: true,
  });
  await writeFile(
    path.join(rootPath, "services/control-plane/src/index.ts"),
    'import "@crewroll/contracts";\nexport const ready = true;\n',
  );
  return rootPath;
}

async function run(rootPath, args = [], fsAdapter) {
  let stdout = "";
  let stderr = "";
  const code = await runMigrationCheck({
    argv: [process.execPath, "tools/check-migrations.mjs", ...args],
    moduleUrl: pathToFileURL(path.join(rootPath, "tools/check-migrations.mjs"))
      .href,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    fsAdapter,
  });
  return { code, stderr, stdout };
}

async function makeComplete(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({
      workspaces: ["services/*"],
      scripts: {
        "test:integration": "node tools/run-future-suite.mjs integration",
        "test:integration:run":
          "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts",
      },
    }),
  );
  await writeFile(
    path.join(rootPath, "services/control-plane/package.json"),
    JSON.stringify({
      ...controlManifest,
      scripts: { "db:migrate": "tsx src/db/migrate.ts" },
    }),
  );
  const files = new Map([
    ["services/control-plane/src/db/migrate.ts", canonicalRunner],
    ["services/control-plane/src/db/database.ts", "export {};\n"],
    [
      "services/control-plane/src/db/schema/tables.ts",
      "export interface Database {}\n",
    ],
    [
      "services/control-plane/src/db/migrations/001_initial.ts",
      canonicalMigration,
    ],
    ["tests/integration/vitest.config.ts", "export {};\n"],
    ["tests/integration/contract.test.ts", "export {};\n"],
  ]);
  for (const [relativePath, source] of files) {
    const targetPath = path.join(rootPath, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
  }
  const sentinelPath = path.join(
    rootPath,
    "tests/integration/.crewroll-suite.json",
  );
  await writeFile(
    sentinelPath,
    JSON.stringify({
      schemaVersion: 1,
      suite: "integration",
      ownerTask: "DB-001",
    }),
  );
}

test("the root-anchored dispatcher reports dormant topology", async (t) => {
  const rootPath = await fixture(t);
  const result = await run(rootPath);
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    "CrewRoll migration check: dormant — DB-001 has not activated a complete migration and real-PostgreSQL integration contract; no migration source was analyzed, and no safety or reversibility claim is made.\n",
  );
  assert.equal(result.stderr, "");
});

test("arguments return usage without inspecting repository topology", async (t) => {
  const rootPath = await fixture(t);
  const result = await run(rootPath, ["--unexpected"]);
  assert.equal(result.code, 64);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "CrewRoll migration check: this command takes no arguments.\n",
  );
});

test("complete safe topology reaches the composed active policy", async (t) => {
  const rootPath = await fixture(t);
  await makeComplete(rootPath);
  const result = await run(rootPath);
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    "CrewRoll migration check: known-risk static policy passed for 1 contiguous migration(s); this is not proof of safety, reversibility, PostgreSQL compatibility, or runtime success — DB-001 integration tests remain authoritative.\n",
  );
  assert.equal(result.stderr, "");
});

test("usage returns before any repository adapter is inspected", async (t) => {
  const rootPath = await fixture(t);
  const fail = async () => {
    throw new Error("usage must not inspect the repository");
  };
  const result = await run(rootPath, ["--unexpected"], {
    lstat: fail,
    readFile: fail,
    readdir: fail,
    realpath: fail,
  });
  assert.deepEqual(result, {
    code: 64,
    stdout: "",
    stderr: "CrewRoll migration check: this command takes no arguments.\n",
  });
});

test("dormant startup findings are rejected instead of bypassed", async (t) => {
  const rootPath = await fixture(t);
  await writeFile(
    path.join(rootPath, indexPath),
    "void import(target);\n",
    "utf8",
  );
  const result = await run(rootPath);
  assert.equal(result.code, 65);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "CrewRoll migration check: rejected with 1 deterministic finding(s); the static known-risk policy did not pass.\n",
  );
});

test("partial topology keeps precedence while startup still runs", async (t) => {
  const rootPath = await fixture(t);
  const manifestPath = path.join(
    rootPath,
    "services/control-plane/package.json",
  );
  const manifest = await readJson(
    rootPath,
    "services/control-plane/package.json",
  );
  manifest.scripts["db:migrate"] = "tsx src/db/migrate.ts";
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await writeFile(
    path.join(rootPath, indexPath),
    "void import(target);\n",
    "utf8",
  );

  const reads = [];
  const result = await run(rootPath, [], {
    lstat,
    readdir,
    realpath,
    readFile: async (...args) => {
      reads.push(path.relative(rootPath, args[0]).split(path.sep).join("/"));
      return readFile(...args);
    },
  });
  assert.equal(result.code, 65);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "CrewRoll migration check: partial DB-001 activation — complete the exact migration and integration contract atomically.\n",
  );
  assert.ok(reads.includes(indexPath));
});

test("complete composition rejects each isolated source, runner, startup, and symlink mutation", async (t) => {
  const cases = [
    {
      name: "migration side-effect import",
      code: "MIGRATION_IMPORT_SHAPE",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          `import "./side-effect.js";\n${canonicalMigration}`,
          "utf8",
        ),
    },
    {
      name: "migration top-level getter",
      code: "MIGRATION_TOP_LEVEL_SHAPE",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          replaceOnce(
            canonicalMigration,
            "export async function up",
            "const value = { get secret() { return 1; } };\nexport async function up",
          ),
          "utf8",
        ),
    },
    {
      name: "migration top-level spread",
      code: "MIGRATION_TOP_LEVEL_SHAPE",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          replaceOnce(
            canonicalMigration,
            "export async function up",
            "const value = { ...other };\nexport async function up",
          ),
          "utf8",
        ),
    },
    {
      name: "migration shadowed db",
      code: "MIGRATION_BINDING_SHAPE",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          replaceOnce(
            canonicalMigration,
            '.addColumn("id", "uuid")',
            '.addColumn("id", "uuid", (db) => db.notNull())',
          ),
          "utf8",
        ),
    },
    {
      name: "migration shadowed sql",
      code: "MIGRATION_BINDING_SHAPE",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          replaceOnce(
            replaceOnce(
              canonicalMigration,
              'import type { Kysely } from "kysely";',
              'import { sql } from "kysely";\nimport type { Kysely } from "kysely";',
            ),
            '.addColumn("id", "uuid")',
            '.addColumn("id", "uuid", (sql) => sql.defaultTo(sql`now()`))',
          ),
          "utf8",
        ),
    },
    {
      name: "migration unknown builder method",
      code: "MIGRATION_UP_OPAQUE_CALL",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          replaceOnce(
            canonicalMigration,
            '.addColumn("id", "uuid")\n    .execute()',
            '.addColumn("id", "uuid")\n    .totallyUnknownMethod()\n    .execute()',
          ),
          "utf8",
        ),
    },
    {
      name: "migration createIndex callback bypass",
      code: "MIGRATION_UP_OPAQUE_CALL",
      kind: "migration",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, migrationPath),
          `
            import type { Kysely } from "kysely";
            export async function up(db: Kysely<unknown>): Promise<void> {
              await db.schema.createIndex("idx").on("users").column((builder) => builder.ref("id")).execute();
            }
            export async function down(db: Kysely<unknown>): Promise<void> {
              await db.schema.dropIndex("idx").execute();
            }
          `,
          "utf8",
        ),
    },
    {
      name: "runner alternate provider",
      code: "MIGRATION_RUNNER_PROVIDER_SHAPE",
      kind: "runner",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, runnerPath),
          replaceOnce(
            canonicalRunner,
            "new FileMigrationProvider({ fs, path, migrationFolder })",
            "new AlternateProvider({ fs, path, migrationFolder })",
          ),
          "utf8",
        ),
    },
    {
      name: "runner alternate root",
      code: "MIGRATION_RUNNER_FOLDER_SHAPE",
      kind: "runner",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, runnerPath),
          replaceOnce(
            canonicalRunner,
            'new URL("./migrations/", import.meta.url)',
            'new URL("../migrations/", import.meta.url)',
          ),
          "utf8",
        ),
    },
    {
      name: "startup direct migration reachability",
      code: "STARTUP_MIGRATION_REACHABILITY",
      kind: "startup",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, indexPath),
          'import "./db/migrate.js";\n',
          "utf8",
        ),
    },
    {
      name: "startup transitive migration reachability",
      code: "STARTUP_MIGRATION_REACHABILITY",
      kind: "startup",
      mutate: async (rootPath) => {
        await writeFile(
          path.join(rootPath, indexPath),
          'import "./bridge.js";\n',
          "utf8",
        );
        await writeFile(
          path.join(rootPath, "services/control-plane/src/bridge.ts"),
          'export * from "./db/migrations/001_initial.js";\n',
          "utf8",
        );
      },
    },
    {
      name: "startup dynamic migration reachability",
      code: "STARTUP_MIGRATION_REACHABILITY",
      kind: "startup",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, indexPath),
          'void import("./db/migrations/001_initial.js");\n',
          "utf8",
        ),
    },
    {
      name: "startup alternate executable script",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const relativePath = "services/control-plane/package.json";
        const manifest = await readJson(rootPath, relativePath);
        manifest.scripts.serve = "node dist/src/index.js";
        await writeFile(
          path.join(rootPath, relativePath),
          JSON.stringify(manifest),
          "utf8",
        );
      },
    },
    {
      name: "startup npm environment executable launcher",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const relativePath = "services/control-plane/package.json";
        const manifest = await readJson(rootPath, relativePath);
        manifest.scripts.backdoor =
          '"$npm_node_execpath" "$PWD/dist/src/index.js"';
        await writeFile(
          path.join(rootPath, relativePath),
          JSON.stringify(manifest),
          "utf8",
        );
      },
    },
    {
      name: "startup POSIX split executable alias",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const relativePath = "services/control-plane/package.json";
        const manifest = await readJson(rootPath, relativePath);
        manifest.scripts.backdoor =
          'runtime="$npm_node_execpath"; "$runtime" "$PWD/dist/src/index.js"';
        await writeFile(
          path.join(rootPath, relativePath),
          JSON.stringify(manifest),
          "utf8",
        );
      },
    },
    {
      name: "startup cmd delayed executable",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const relativePath = "services/control-plane/package.json";
        const manifest = await readJson(rootPath, relativePath);
        manifest.scripts.backdoor =
          'cmd /v:on /d /s /c "\\"!npm_node_execpath!\\" \\"!CD!\\dist\\src\\index.js\\""';
        await writeFile(
          path.join(rootPath, relativePath),
          JSON.stringify(manifest),
          "utf8",
        );
      },
    },
    {
      name: "startup PowerShell braced executable",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const relativePath = "services/control-plane/package.json";
        const manifest = await readJson(rootPath, relativePath);
        manifest.scripts.backdoor =
          '& "${env:npm_node_execpath}" "${PWD}\\dist\\src\\index.js"';
        await writeFile(
          path.join(rootPath, relativePath),
          JSON.stringify(manifest),
          "utf8",
        );
      },
    },
    {
      name: "startup inert unknown diagnostic",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const relativePath = "services/control-plane/package.json";
        const manifest = await readJson(rootPath, relativePath);
        manifest.scripts.diagnostics = 'echo "$npm_node_execpath"';
        await writeFile(
          path.join(rootPath, relativePath),
          JSON.stringify(manifest),
          "utf8",
        );
      },
    },
    {
      name: "startup symlinked workspace glob base",
      code: "STARTUP_EXECUTABLE_SURFACE",
      kind: "startup",
      mutate: async (rootPath) => {
        const manifest = await readJson(rootPath, "package.json");
        manifest.workspaces = ["packages/*", "services/*"];
        await writeFile(
          path.join(rootPath, "package.json"),
          JSON.stringify(manifest),
          "utf8",
        );
        await mkdir(path.join(rootPath, "workspace-shadow/contracts"), {
          recursive: true,
        });
        await writeFile(
          path.join(rootPath, "workspace-shadow/contracts/package.json"),
          JSON.stringify({
            name: "@crewroll/contracts",
            scripts: { backdoor: "node malicious.js" },
          }),
          "utf8",
        );
        await symlink(
          "workspace-shadow",
          path.join(rootPath, "packages"),
          "dir",
        );
      },
    },
    {
      name: "startup declaration-only runtime target",
      code: "STARTUP_IMPORT_RESOLUTION",
      kind: "startup",
      mutate: async (rootPath) => {
        await writeFile(
          path.join(rootPath, indexPath),
          'import "./ghost.d.js";\n',
          "utf8",
        );
        await writeFile(
          path.join(rootPath, "services/control-plane/src/ghost.d.ts"),
          "export {};\n",
          "utf8",
        );
      },
    },
    {
      name: "startup computed node module loader origin",
      code: "STARTUP_UNSUPPORTED_LOADER",
      kind: "startup",
      mutate: async (rootPath) =>
        writeFile(
          path.join(rootPath, indexPath),
          `
            import * as moduleApi from "node:module";
            const loaderName = "create" + "Require";
            const load = moduleApi[loaderName](import.meta.url);
            load("./db/migrate.js");
          `,
          "utf8",
        ),
    },
    {
      name: "startup symlinked resolution",
      code: "STARTUP_IMPORT_RESOLUTION",
      kind: "startup",
      mutate: async (rootPath) => {
        await writeFile(
          path.join(rootPath, indexPath),
          'import "./linked.js";\n',
          "utf8",
        );
        await writeFile(
          path.join(rootPath, "services/control-plane/src/actual.ts"),
          "export {};\n",
          "utf8",
        );
        await symlink(
          "actual.ts",
          path.join(rootPath, "services/control-plane/src/linked.ts"),
          "file",
        );
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await testCase.mutate(rootPath);

      const direct =
        testCase.kind === "migration"
          ? await analyzeMigrationModules({
              rootPath,
              migrationFiles: [migrationPath],
            })
          : testCase.kind === "runner"
            ? await analyzeMigrationRunner({ rootPath })
            : await analyzeStartupGraph({ rootPath });
      assert.ok(
        direct.findings.some(({ code }) => code === testCase.code),
        `${testCase.name}: expected ${testCase.code}, received ${JSON.stringify(direct.findings)}`,
      );

      const result = await run(rootPath);
      assert.equal(result.code, 65);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /^CrewRoll migration check: rejected with [1-9][0-9]* deterministic finding\(s\); the static known-risk policy did not pass\.\n$/u,
      );
    });
  }
});

test("unexpected adapter failures are sanitized as internal exit 70", async (t) => {
  const rootPath = await fixture(t);
  const marker = "adapter secret must never be printed";
  const fail = async () => {
    throw new Error(marker);
  };
  const result = await run(rootPath, [], {
    lstat: fail,
    readFile,
    readdir,
    realpath,
  });
  assert.deepEqual(result, {
    code: 70,
    stdout: "",
    stderr: "CrewRoll migration check: internal policy error.\n",
  });
  assert.equal(JSON.stringify(result).includes(marker), false);
});
