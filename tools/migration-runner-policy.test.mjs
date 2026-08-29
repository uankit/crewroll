import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeMigrationRunner } from "./migration-runner-policy.mjs";

const runnerPath = "services/control-plane/src/db/migrate.ts";
const databasePath = "services/control-plane/src/db/database.ts";
const schemaPath = "services/control-plane/src/db/schema";
const tablesPath = `${schemaPath}/tables.ts`;
const migrationFolderPath = "services/control-plane/src/db/migrations";

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

async function writeText(rootPath, relativePath, source = "export {};\n") {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, source, "utf8");
}

async function fixture(t, source = canonicalRunner) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "crewroll-b2b-ii-b-"));
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  await writeText(rootPath, databasePath);
  await mkdir(path.join(rootPath, schemaPath), { recursive: true });
  await writeText(rootPath, tablesPath, "export interface Database {}\n");
  await mkdir(path.join(rootPath, migrationFolderPath), { recursive: true });
  await writeText(
    rootPath,
    `${migrationFolderPath}/001_initial.ts`,
    "export async function up() {}\nexport async function down() {}\n",
  );
  await writeText(rootPath, runnerPath, source);
  return rootPath;
}

async function analyzeSource(t, source, fsAdapter) {
  const rootPath = await fixture(t, source);
  return analyzeMigrationRunner({ rootPath, fsAdapter });
}

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

function compareFindings(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
  );
}

function assertFindingShape(result) {
  assert.deepEqual(Object.keys(result), ["findings"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
  assert.deepEqual(result.findings, [...result.findings].sort(compareFindings));
  for (const finding of result.findings) {
    assert.ok(Object.isFrozen(finding));
    assert.deepEqual(Object.keys(finding).sort(), [
      "code",
      "column",
      "line",
      "path",
    ]);
    assert.ok(
      [
        runnerPath,
        databasePath,
        schemaPath,
        tablesPath,
        migrationFolderPath,
      ].includes(finding.path),
    );
    assert.ok(Number.isInteger(finding.line) && finding.line > 0);
    assert.ok(Number.isInteger(finding.column) && finding.column > 0);
  }
}

async function assertRejected(t, source, expectedCode) {
  const result = await analyzeSource(t, source);
  assertFindingShape(result);
  assert.ok(result.findings.length > 0);
  assert.ok(
    result.findings.some(({ code }) => code === expectedCode),
    `expected ${expectedCode}, received ${JSON.stringify(result.findings)}`,
  );
  return result;
}

test("accepts only the exact canonical runner and returns a frozen result", async (t) => {
  const result = await analyzeSource(t, canonicalRunner);
  assertFindingShape(result);
  assert.deepEqual(result.findings, []);
});

test("ignores comments, quote choice, formatting, and declaration semicolons", async (t) => {
  const formatted = `/* reviewed runner */\n${canonicalRunner
    .replaceAll('"', "'")
    .replaceAll(";", "")
    .replace(
      "export async function migrateToLatest",
      "// provider entry\nexport async function migrateToLatest",
    )}`;
  const result = await analyzeSource(t, formatted);
  assert.deepEqual(result.findings, []);
  assertFindingShape(result);
});

test("rejects parse failures without evaluating or leaking target source", async (t) => {
  const marker = "__crewrollMigrationRunnerMustNotExecute";
  delete globalThis[marker];
  t.after(() => delete globalThis[marker]);
  const result = await analyzeSource(
    t,
    `${canonicalRunner}\nglobalThis.${marker} = true;\nif (`,
  );
  assertFindingShape(result);
  assert.equal(globalThis[marker], undefined);
  assert.ok(
    result.findings.some(({ code }) => code === "MIGRATION_RUNNER_PARSE"),
  );
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test("rejects every import, alias, type-only, order, and source mutation", async (t) => {
  const cases = [
    [
      "filesystem alias",
      'import { promises as fs } from "node:fs";',
      'import { promises as fileSystem } from "node:fs";',
    ],
    [
      "filesystem subpath",
      'import { promises as fs } from "node:fs";',
      'import * as fs from "node:fs/promises";',
    ],
    [
      "path namespace",
      'import path from "node:path";',
      'import * as path from "node:path";',
    ],
    [
      "path lookalike",
      'import path from "node:path";',
      'import path from "path";',
    ],
    [
      "URL helper alias",
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      'import { fileURLToPath as toPath, pathToFileURL } from "node:url";',
    ],
    [
      "URL helper order",
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      'import { pathToFileURL, fileURLToPath } from "node:url";',
    ],
    [
      "Kysely value import",
      'import type { Kysely } from "kysely";',
      'import { Kysely } from "kysely";',
    ],
    [
      "Kysely alias",
      'import type { Kysely } from "kysely";',
      'import type { Kysely as DatabaseClient } from "kysely";',
    ],
    [
      "provider alias",
      'import { FileMigrationProvider, Migrator } from "kysely/migration";',
      'import { FileMigrationProvider as Provider, Migrator } from "kysely/migration";',
    ],
    ["provider root", 'from "kysely/migration";', 'from "kysely";'],
    [
      "database factory alias",
      'import { createDatabase } from "./database.js";',
      'import { createDatabase as openDatabase } from "./database.js";',
    ],
    ["database extension", 'from "./database.js";', 'from "./database.ts";'],
    [
      "schema value import",
      'import type { Database } from "./schema/tables.js";',
      'import { Database } from "./schema/tables.js";',
    ],
    [
      "schema alias",
      'import type { Database } from "./schema/tables.js";',
      'import type { Database as Tables } from "./schema/tables.js";',
    ],
    [
      "schema alternate",
      'from "./schema/tables.js";',
      'from "./schema/index.js";',
    ],
    [
      "reordered declarations",
      'import path from "node:path";\nimport { fileURLToPath, pathToFileURL } from "node:url";',
      'import { fileURLToPath, pathToFileURL } from "node:url";\nimport path from "node:path";',
    ],
    [
      "extra import",
      'import type { Database } from "./schema/tables.js";',
      'import type { Database } from "./schema/tables.js";\nimport os from "node:os";',
    ],
    [
      "direct migration import",
      'import type { Database } from "./schema/tables.js";',
      'import type { Database } from "./schema/tables.js";\nimport "./migrations/001_initial.js";',
    ],
  ];

  for (const [name, before, after] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        replaceOnce(canonicalRunner, before, after),
        "MIGRATION_RUNNER_IMPORT_SHAPE",
      ),
    );
  }
});

test("rejects coherent aliases after every use is propagated", async (t) => {
  const cases = [
    [
      "filesystem binding",
      canonicalRunner
        .replace(
          'import { promises as fs } from "node:fs";',
          'import { promises as fileSystem } from "node:fs";',
        )
        .replace(
          "{ fs, path, migrationFolder }",
          "{ fs: fileSystem, path, migrationFolder }",
        ),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "path binding",
      canonicalRunner
        .replace(
          'import path from "node:path";',
          'import nodePath from "node:path";',
        )
        .replace(
          "{ fs, path, migrationFolder }",
          "{ fs, path: nodePath, migrationFolder }",
        ),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "URL bindings",
      canonicalRunner
        .replace(
          "{ fileURLToPath, pathToFileURL }",
          "{ fileURLToPath as fromFileUrl, pathToFileURL as toFileUrl }",
        )
        .replace("fileURLToPath(", "fromFileUrl(")
        .replace("pathToFileURL(", "toFileUrl("),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "Kysely type binding",
      canonicalRunner
        .replace("{ Kysely }", "{ Kysely as DatabaseClient }")
        .replace("Kysely<Database>", "DatabaseClient<Database>"),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "provider bindings",
      canonicalRunner
        .replace(
          "{ FileMigrationProvider, Migrator }",
          "{ FileMigrationProvider as Provider, Migrator as MigrationRunner }",
        )
        .replace("new FileMigrationProvider(", "new Provider(")
        .replace("new Migrator(", "new MigrationRunner("),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "database factory binding",
      canonicalRunner
        .replace("{ createDatabase }", "{ createDatabase as openDatabase }")
        .replace(
          "createDatabase(connectionString)",
          "openDatabase(connectionString)",
        ),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "schema type binding",
      canonicalRunner
        .replace("{ Database }", "{ Database as DatabaseSchema }")
        .replace("Kysely<Database>", "Kysely<DatabaseSchema>"),
      "MIGRATION_RUNNER_IMPORT_SHAPE",
    ],
    [
      "folder binding",
      canonicalRunner
        .replace("const migrationFolder =", "const migrationsRoot =")
        .replace(
          "{ fs, path, migrationFolder }",
          "{ fs, path, migrationFolder: migrationsRoot }",
        ),
      "MIGRATION_RUNNER_FOLDER_SHAPE",
    ],
    [
      "provider local",
      canonicalRunner
        .replace("const provider =", "const migrationProvider =")
        .replace(
          "{ db: database, provider }",
          "{ db: database, provider: migrationProvider }",
        ),
      "MIGRATION_RUNNER_PROVIDER_SHAPE",
    ],
    [
      "migrator and result locals",
      canonicalRunner
        .replace("const migrator =", "const migrationRunner =")
        .replace(
          "migrator.migrateToLatest()",
          "migrationRunner.migrateToLatest()",
        )
        .replace("const result =", "const migrationResult =")
        .replaceAll("result.error", "migrationResult.error"),
      "MIGRATION_RUNNER_PROVIDER_SHAPE",
    ],
    [
      "migration function binding",
      canonicalRunner.replaceAll("migrateToLatest", "runAllMigrations"),
      "MIGRATION_RUNNER_PROVIDER_SHAPE",
    ],
    [
      "main and environment bindings",
      canonicalRunner
        .replace("function main(source", "function run(environment")
        .replace("source.DATABASE_URL", "environment.DATABASE_URL")
        .replace("main(process.env)", "run(process.env)"),
      "MIGRATION_RUNNER_ENTRY_SHAPE",
    ],
  ];

  for (const [name, source, expectedCode] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(subtest, source, expectedCode),
    );
  }
});

test("rejects literal, nonliteral, require, and provider-callback loaders", async (t) => {
  const cases = [
    ["literal dynamic import", 'void import("./migrations/001_initial.js");'],
    [
      "nonliteral dynamic import",
      'const target = "./migrations/001_initial.js";\nvoid import(target);',
    ],
    ["require loader", 'void require("./migrations/001_initial.js");'],
  ];
  for (const [name, statement] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        `${canonicalRunner}\n${statement}\n`,
        "MIGRATION_RUNNER_IMPORT_SHAPE",
      ),
    );
  }

  const callbackSource = replaceOnce(
    canonicalRunner,
    "new FileMigrationProvider({ fs, path, migrationFolder })",
    "new FileMigrationProvider({ fs, path, migrationFolder, import: (module) => import(module) })",
  );
  await assertRejected(t, callbackSource, "MIGRATION_RUNNER_PROVIDER_SHAPE");
});

test("rejects every alternate migration folder expression", async (t) => {
  const cases = [
    [
      "parent folder",
      'new URL("./migrations/", import.meta.url)',
      'new URL("../migrations/", import.meta.url)',
    ],
    [
      "missing trailing slash",
      'new URL("./migrations/", import.meta.url)',
      'new URL("./migrations", import.meta.url)',
    ],
    [
      "absolute path",
      'fileURLToPath(\n  new URL("./migrations/", import.meta.url),\n)',
      '"/tmp/migrations"',
    ],
    [
      "file URL",
      'new URL("./migrations/", import.meta.url)',
      'new URL("file:///tmp/migrations/", import.meta.url)',
    ],
    [
      "glob",
      'new URL("./migrations/", import.meta.url)',
      'new URL("./migrations/*.ts", import.meta.url)',
    ],
    [
      "cwd",
      'fileURLToPath(\n  new URL("./migrations/", import.meta.url),\n)',
      'path.join(process.cwd(), "migrations")',
    ],
    [
      "environment folder",
      'fileURLToPath(\n  new URL("./migrations/", import.meta.url),\n)',
      "process.env.MIGRATION_FOLDER",
    ],
    [
      "alternate URL base",
      "import.meta.url),",
      "pathToFileURL(process.argv[1]).href),",
    ],
    [
      "renamed binding",
      "const migrationFolder = fileURLToPath",
      "const migrationsRoot = fileURLToPath",
    ],
    [
      "mutable binding",
      "const migrationFolder = fileURLToPath",
      "let migrationFolder = fileURLToPath",
    ],
    [
      "generic URL constructor",
      'new URL("./migrations/", import.meta.url)',
      'new URL<string>("./migrations/", import.meta.url)',
    ],
  ];
  for (const [name, before, after] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        replaceOnce(canonicalRunner, before, after),
        "MIGRATION_RUNNER_FOLDER_SHAPE",
      ),
    );
  }
});

test("rejects provider and migrator construction bypasses", async (t) => {
  const providerExpression =
    "new FileMigrationProvider({ fs, path, migrationFolder })";
  const migratorExpression = "new Migrator({ db: database, provider })";
  const cases = [
    ["alternate provider", providerExpression, "new CustomProvider()"],
    [
      "provider without new",
      providerExpression,
      "FileMigrationProvider({ fs, path, migrationFolder })",
    ],
    [
      "provider option order",
      providerExpression,
      "new FileMigrationProvider({ path, fs, migrationFolder })",
    ],
    [
      "provider spread",
      providerExpression,
      "new FileMigrationProvider({ ...{ fs, path, migrationFolder } })",
    ],
    [
      "provider getter",
      providerExpression,
      "new FileMigrationProvider({ get fs() { return fs; }, path, migrationFolder })",
    ],
    [
      "provider computed option",
      providerExpression,
      'new FileMigrationProvider({ ["fs"]: fs, path, migrationFolder })',
    ],
    [
      "provider table override",
      providerExpression,
      'new FileMigrationProvider({ fs, path, migrationFolder, migrationTableName: "migrations" })',
    ],
    [
      "provider generic",
      providerExpression,
      "new FileMigrationProvider<Database>({ fs, path, migrationFolder })",
    ],
    ["alternate migrator", migratorExpression, "new CustomMigrator()"],
    [
      "migrator option order",
      migratorExpression,
      "new Migrator({ provider, db: database })",
    ],
    [
      "migrator spread",
      migratorExpression,
      "new Migrator({ ...{ db: database, provider } })",
    ],
    [
      "unordered migrations",
      migratorExpression,
      "new Migrator({ db: database, provider, allowUnorderedMigrations: true })",
    ],
    [
      "migration table override",
      migratorExpression,
      'new Migrator({ db: database, provider, migrationTableName: "crewroll" })',
    ],
    [
      "migration lock override",
      migratorExpression,
      'new Migrator({ db: database, provider, migrationLockTableName: "locks" })',
    ],
    [
      "disable transactions",
      migratorExpression,
      "new Migrator({ db: database, provider, disableTransactions: true })",
    ],
    [
      "name comparator",
      migratorExpression,
      "new Migrator({ db: database, provider, nameComparator: () => 0 })",
    ],
    [
      "computed db",
      migratorExpression,
      'new Migrator({ ["db"]: database, provider })',
    ],
    [
      "renamed provider local",
      "const provider = new FileMigrationProvider",
      "const migrationProvider = new FileMigrationProvider",
    ],
    [
      "renamed migrator local",
      "const migrator = new Migrator",
      "const migrationRunner = new Migrator",
    ],
    [
      "shadowed constructor",
      "  const provider = new FileMigrationProvider",
      "  const FileMigrationProvider = class {};\n  const provider = new FileMigrationProvider",
    ],
  ];
  for (const [name, before, after] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        replaceOnce(canonicalRunner, before, after),
        "MIGRATION_RUNNER_PROVIDER_SHAPE",
      ),
    );
  }
});

test("rejects alternate migration execution and result handling", async (t) => {
  const call = "const result = await migrator.migrateToLatest();";
  const condition = "result.error !== undefined";
  const safeThrow = `throw new Error("CrewRoll database migration failed", {
      cause: result.error,
    });`;
  const cases = [
    ["ignored result", call, "await migrator.migrateToLatest();"],
    [
      "renamed result",
      call,
      "const migrationResult = await migrator.migrateToLatest();",
    ],
    [
      "destructured result",
      call,
      "const { error } = await migrator.migrateToLatest();",
    ],
    ["migrate up", "migrator.migrateToLatest()", "migrator.migrateUp()"],
    ["migrate down", "migrator.migrateToLatest()", "migrator.migrateDown()"],
    [
      "migrate to",
      "migrator.migrateToLatest()",
      'migrator.migrateTo("001_initial")',
    ],
    [
      "migrate options",
      "migrator.migrateToLatest()",
      "migrator.migrateToLatest({})",
    ],
    [
      "generic migrate call",
      "migrator.migrateToLatest()",
      "migrator.migrateToLatest<void>()",
    ],
    ["truthy error", condition, "result.error"],
    ["null error", condition, "result.error !== null"],
    ["equality error", condition, "result.error != undefined"],
    ["computed error", condition, 'result["error"] !== undefined'],
    ["optional error", condition, "result?.error !== undefined"],
    ["direct unknown throw", safeThrow, "throw result.error;"],
    [
      "changed safe text",
      "CrewRoll database migration failed",
      "Migration failed",
    ],
    [
      "missing cause",
      safeThrow,
      'throw new Error("CrewRoll database migration failed");',
    ],
    ["changed cause", "cause: result.error", "cause: new Error()"],
    ["computed cause", "cause: result.error", '["cause"]: result.error'],
    [
      "cause spread",
      "{\n      cause: result.error,\n    }",
      "{ ...{ cause: result.error } }",
    ],
    [
      "extra error option",
      "cause: result.error,",
      'cause: result.error, name: "MigrationError",',
    ],
    [
      "multiple migrate calls",
      call,
      `${call}\n  await migrator.migrateToLatest();`,
    ],
    [
      "raw database execution",
      call,
      `${call}\n  await database.executeQuery({});`,
    ],
  ];
  for (const [name, before, after] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        replaceOnce(canonicalRunner, before, after),
        "MIGRATION_RUNNER_PROVIDER_SHAPE",
      ),
    );
  }
});

test("rejects main, secret, failure, and destroy-path mutations", async (t) => {
  const cases = [
    [
      "renamed environment parameter",
      "main(source: NodeJS.ProcessEnv)",
      "main(environment: NodeJS.ProcessEnv)",
    ],
    [
      "untyped environment parameter",
      "main(source: NodeJS.ProcessEnv)",
      "main(source)",
    ],
    [
      "alternate return type",
      "main(source: NodeJS.ProcessEnv): Promise<number>",
      "main(source: NodeJS.ProcessEnv): Promise<void>",
    ],
    [
      "alternate environment key",
      "source.DATABASE_URL",
      "source.CREWROLL_DATABASE_URL",
    ],
    [
      "environment destructure",
      "const connectionString = source.DATABASE_URL;",
      "const { DATABASE_URL: connectionString } = source;",
    ],
    [
      "truthy secret check",
      'typeof connectionString !== "string" || connectionString.length === 0',
      "!connectionString",
    ],
    [
      "trimmed secret check",
      "connectionString.length === 0",
      "connectionString.trim().length === 0",
    ],
    [
      "alternate invalid exit",
      "    return 1;\n  }\n\n  const database",
      "    return 2;\n  }\n\n  const database",
    ],
    [
      "factory without secret",
      "createDatabase(connectionString)",
      "createDatabase()",
    ],
    [
      "factory options",
      "createDatabase(connectionString)",
      "createDatabase(connectionString, {})",
    ],
    ["missing migration call", "    await migrateToLatest(database);\n", ""],
    [
      "duplicate migration call",
      "    await migrateToLatest(database);",
      "    await migrateToLatest(database);\n    await migrateToLatest(database);",
    ],
    [
      "migration call not awaited",
      "await migrateToLatest(database)",
      "migrateToLatest(database)",
    ],
    ["success exit mutation", "    return 0;", "    return 1;"],
    [
      "catch binding",
      "  } catch {\n    return 1;",
      "  } catch (error) {\n    return 1;",
    ],
    [
      "printed provider error",
      "  } catch {\n    return 1;",
      "  } catch (error) {\n    console.error(error);\n    return 1;",
    ],
    [
      "printed secret",
      "  const database = createDatabase(connectionString);",
      "  console.log(connectionString);\n  const database = createDatabase(connectionString);",
    ],
    [
      "missing finally",
      "  } finally {\n    await database.destroy();\n  }",
      "  }",
    ],
    ["destroy not awaited", "await database.destroy()", "database.destroy()"],
    ["alternate destroy", "database.destroy()", "database.close()"],
    [
      "duplicate destroy",
      "    await database.destroy();",
      "    await database.destroy();\n    await database.destroy();",
    ],
    [
      "renamed main export",
      "export async function main",
      "export async function run",
    ],
    ["unexported main", "export async function main", "async function main"],
  ];
  for (const [name, before, after] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        replaceOnce(canonicalRunner, before, after),
        "MIGRATION_RUNNER_ENTRY_SHAPE",
      ),
    );
  }
});

test("rejects CLI guard, promise, exit, and executable-surface mutations", async (t) => {
  const cases = [
    [
      "argv zero",
      "  process.argv[1] !== undefined",
      "  process.argv[0] !== undefined",
    ],
    ["missing argv presence guard", "  process.argv[1] !== undefined &&\n", ""],
    [
      "loose argv presence guard",
      "process.argv[1] !== undefined",
      "process.argv[1] != undefined",
    ],
    [
      "direct URL comparison",
      "pathToFileURL(process.argv[1]).href",
      "pathToFileURL(process.argv[1])",
    ],
    [
      "file path entry conversion",
      "pathToFileURL(process.argv[1]).href",
      "fileURLToPath(process.argv[1])",
    ],
    ["changed module comparison", "=== import.meta.url", "!== import.meta.url"],
    ["main without environment", "main(process.env)", "main({})"],
    ["missing void", "  void main(process.env)", "  main(process.env)"],
    [
      "catch instead of rejection handler",
      "  void main(process.env).then(",
      "  void main(process.env).catch(",
    ],
    ["process exit", "process.exitCode = exitCode", "process.exit(exitCode)"],
    [
      "success handler constant",
      "process.exitCode = exitCode",
      "process.exitCode = 0",
    ],
    [
      "rejection handler rethrows",
      "process.exitCode = 1;\n    },\n  );",
      'throw new Error("runner failed");\n    },\n  );',
    ],
    [
      "extra executable statement",
      canonicalRunner,
      `${canonicalRunner}\nmain(process.env);`,
    ],
    [
      "extra executable export",
      canonicalRunner,
      `${canonicalRunner}\nexport async function migrateDown() { return; }`,
    ],
    [
      "top-level secret print",
      canonicalRunner,
      `${canonicalRunner}\nconsole.log(process.env.DATABASE_URL);`,
    ],
  ];
  for (const [name, before, after] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        replaceOnce(canonicalRunner, before, after),
        "MIGRATION_RUNNER_ENTRY_SHAPE",
      ),
    );
  }
});

test("requires every fixed runner target to remain regular and non-symlinked", async (t) => {
  const targets = [
    [runnerPath, "file", "MIGRATION_RUNNER_ENTRY_SHAPE"],
    [databasePath, "file", "MIGRATION_RUNNER_FOLDER_SHAPE"],
    [schemaPath, "directory", "MIGRATION_RUNNER_FOLDER_SHAPE"],
    [tablesPath, "file", "MIGRATION_RUNNER_FOLDER_SHAPE"],
    [migrationFolderPath, "directory", "MIGRATION_RUNNER_FOLDER_SHAPE"],
  ];
  for (const [relativePath, kind, code] of targets) {
    await t.test(`${relativePath}: missing`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await rm(path.join(rootPath, relativePath), {
        force: true,
        recursive: true,
      });
      const result = await analyzeMigrationRunner({ rootPath });
      assertFindingShape(result);
      assert.ok(result.findings.some((finding) => finding.code === code));
    });

    await t.test(`${relativePath}: wrong type`, async (subtest) => {
      const rootPath = await fixture(subtest);
      const targetPath = path.join(rootPath, relativePath);
      await rm(targetPath, { force: true, recursive: true });
      if (kind === "file") await mkdir(targetPath, { recursive: true });
      else await writeFile(targetPath, "not a directory\n", "utf8");
      const result = await analyzeMigrationRunner({ rootPath });
      assertFindingShape(result);
      assert.ok(result.findings.some((finding) => finding.code === code));
    });

    await t.test(`${relativePath}: symlink`, async (subtest) => {
      const rootPath = await fixture(subtest);
      const targetPath = path.join(rootPath, relativePath);
      const externalRoot = await mkdtemp(
        path.join(os.tmpdir(), "crewroll-b2b-ii-b-external-"),
      );
      subtest.after(async () =>
        rm(externalRoot, { force: true, recursive: true }),
      );
      const externalTarget = path.join(
        externalRoot,
        path.basename(relativePath),
      );
      if (kind === "file") {
        await writeFile(
          externalTarget,
          relativePath === runnerPath ? canonicalRunner : "export {};\n",
          "utf8",
        );
      } else {
        await mkdir(externalTarget);
      }
      await rm(targetPath, { force: true, recursive: true });
      await symlink(externalTarget, targetPath);
      const result = await analyzeMigrationRunner({ rootPath });
      assertFindingShape(result);
      assert.ok(result.findings.some((finding) => finding.code === code));
    });
  }
});

test("rejects symlinked ancestors and canonical-path escapes", async (t) => {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-b2b-ii-b-link-"),
  );
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  const externalRoot = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-b2b-ii-b-db-"),
  );
  t.after(async () => rm(externalRoot, { force: true, recursive: true }));
  await writeText(externalRoot, "migrate.ts", canonicalRunner);
  await writeText(externalRoot, "database.ts");
  await writeText(externalRoot, "schema/tables.ts");
  await mkdir(path.join(externalRoot, "migrations"), { recursive: true });
  await mkdir(path.join(rootPath, "services/control-plane/src"), {
    recursive: true,
  });
  await symlink(
    externalRoot,
    path.join(rootPath, "services/control-plane/src/db"),
  );
  const linkedResult = await analyzeMigrationRunner({ rootPath });
  assertFindingShape(linkedResult);
  assert.ok(
    linkedResult.findings.some(
      ({ code }) => code === "MIGRATION_RUNNER_ENTRY_SHAPE",
    ),
  );

  const canonicalRoot = await fixture(t);
  const canonicalFolder = path.join(canonicalRoot, migrationFolderPath);
  const escapeResult = await analyzeMigrationRunner({
    rootPath: canonicalRoot,
    fsAdapter: {
      lstat,
      readFile,
      async realpath(targetPath) {
        if (targetPath === canonicalFolder) return path.dirname(canonicalRoot);
        return realpath(targetPath);
      },
    },
  });
  assertFindingShape(escapeResult);
  assert.ok(
    escapeResult.findings.some(
      ({ code }) => code === "MIGRATION_RUNNER_FOLDER_SHAPE",
    ),
  );
});

test("lstats and canonicalizes every fixed target without loading target code", async (t) => {
  const marker = "__crewrollStaticRunnerProof";
  delete globalThis[marker];
  t.after(() => delete globalThis[marker]);
  const source = `${canonicalRunner}\n// globalThis.${marker} = true;\n`;
  const rootPath = await fixture(t, source);
  const lstatted = [];
  const canonicalized = [];
  const result = await analyzeMigrationRunner({
    rootPath,
    fsAdapter: {
      async lstat(targetPath) {
        lstatted.push(targetPath);
        return lstat(targetPath);
      },
      readFile,
      async realpath(targetPath) {
        canonicalized.push(targetPath);
        return realpath(targetPath);
      },
    },
  });
  assert.deepEqual(result.findings, []);
  assert.equal(globalThis[marker], undefined);
  for (const relativePath of [
    runnerPath,
    databasePath,
    schemaPath,
    tablesPath,
    migrationFolderPath,
  ]) {
    assert.ok(lstatted.includes(path.join(rootPath, relativePath)));
    assert.ok(canonicalized.includes(path.join(rootPath, relativePath)));
  }
});

test("validates analyzer inputs and propagates unexpected adapter failures", async (t) => {
  await assert.rejects(() => analyzeMigrationRunner(), TypeError);
  await assert.rejects(
    () => analyzeMigrationRunner({ rootPath: "", fsAdapter: {} }),
    TypeError,
  );
  const rootPath = await fixture(t);
  await assert.rejects(
    () =>
      analyzeMigrationRunner({
        rootPath,
        fsAdapter: {
          async lstat() {
            const error = new Error("adapter secret");
            error.code = "EACCES";
            throw error;
          },
          readFile,
          realpath,
        },
      }),
    /adapter secret/u,
  );
});
