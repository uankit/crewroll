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

import { classifyMigrationContract } from "./migration-contract.mjs";

const integrationCommand =
  "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts";
const CONTROL_MANIFEST = "services/control-plane/package.json";

async function fixture(t) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "crewroll-b2b-i-"));
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  await writeJson(rootPath, "package.json", {
    name: "fixture",
    scripts: {
      "test:integration": "node tools/run-future-suite.mjs integration",
    },
  });
  await writeJson(rootPath, "services/control-plane/package.json", {
    name: "@fixture/control-plane",
    scripts: {},
  });
  return rootPath;
}

async function writeJson(rootPath, relativePath, value) {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(rootPath, relativePath, value = "export {};\n") {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, value, "utf8");
}

async function makeComplete(rootPath) {
  await writeJson(rootPath, "package.json", {
    name: "fixture",
    scripts: {
      "test:integration": "node tools/run-future-suite.mjs integration",
      "test:integration:run": integrationCommand,
    },
  });
  await writeJson(rootPath, "services/control-plane/package.json", {
    name: "@fixture/control-plane",
    scripts: { "db:migrate": "tsx src/db/migrate.ts" },
  });
  await writeText(rootPath, "services/control-plane/src/db/migrate.ts");
  await writeText(rootPath, "services/control-plane/src/db/database.ts");
  await writeText(rootPath, "services/control-plane/src/db/schema/tables.ts");
  await writeText(
    rootPath,
    "services/control-plane/src/db/migrations/001_initial.ts",
  );
  await writeJson(rootPath, "tests/integration/.crewroll-suite.json", {
    schemaVersion: 1,
    suite: "integration",
    ownerTask: "DB-001",
  });
  await writeText(rootPath, "tests/integration/vitest.config.ts");
  await writeText(rootPath, "tests/integration/nested/schema.test.ts");
}

function compareFindings(left, right) {
  return `${left.path}:${left.code}`.localeCompare(
    `${right.path}:${right.code}`,
  );
}

function assertPartial(result) {
  assert.equal(result.state, "partial");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
  assert.ok(result.findings.length > 0);
  assert.deepEqual(result.findings, [...result.findings].sort(compareFindings));
  for (const finding of result.findings) assert.ok(Object.isFrozen(finding));
}

function assertFinding(result, expected) {
  assert.deepEqual(
    result.findings.filter(
      (finding) =>
        finding.code === expected.code && finding.path === expected.path,
    ),
    [expected],
  );
}

function deniedManifestAdapter(rootPath, relativePath) {
  const deniedPath = path.join(rootPath, relativePath);
  return {
    lstat,
    readdir,
    realpath,
    async readFile(candidate, encoding) {
      if (candidate === deniedPath) {
        const error = new Error("manifest is not readable");
        error.code = "EACCES";
        throw error;
      }
      return readFile(candidate, encoding);
    },
  };
}

test("classifies the real public integration dispatcher alone as dormant", async (t) => {
  const rootPath = await fixture(t);
  const result = await classifyMigrationContract({ rootPath });

  assert.equal(result.state, "dormant");
  assert.deepEqual(result.migrationFiles, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
});

test("each independent activation evidence axis returns frozen findings", async (t) => {
  const cases = [
    [
      "control db command",
      async (rootPath) => {
        await writeJson(rootPath, "services/control-plane/package.json", {
          scripts: { "db:migrate": "tsx src/db/migrate.ts" },
        });
      },
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/migrate.ts",
      },
    ],
    [
      "empty database root",
      (rootPath) =>
        mkdir(path.join(rootPath, "services/control-plane/src/db"), {
          recursive: true,
        }),
      { code: "MIGRATION_TOPOLOGY", path: "services/control-plane/src/db" },
    ],
    [
      "wrong database root type",
      (rootPath) => writeText(rootPath, "services/control-plane/src/db"),
      { code: "MIGRATION_TOPOLOGY", path: "services/control-plane/src/db" },
    ],
    [
      "symlinked database root",
      async (rootPath) => {
        await mkdir(path.join(rootPath, "services/control-plane/src"), {
          recursive: true,
        });
        await symlink(
          "missing-target",
          path.join(rootPath, "services/control-plane/src/db"),
        );
      },
      { code: "MIGRATION_SYMLINK", path: "services/control-plane/src/db" },
    ],
    [
      "database root",
      (rootPath) =>
        writeText(rootPath, "services/control-plane/src/db/migrate.ts"),
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/database.ts",
      },
    ],
    [
      "integration private command",
      async (rootPath) => {
        await writeJson(rootPath, "package.json", {
          scripts: { "test:integration:run": integrationCommand },
        });
      },
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/migrate.ts",
      },
    ],
    [
      "integration sentinel",
      (rootPath) =>
        writeText(rootPath, "tests/integration/.crewroll-suite.json", "{}\n"),
      {
        code: "MIGRATION_SENTINEL",
        path: "tests/integration/.crewroll-suite.json",
      },
    ],
    [
      "integration config",
      (rootPath) => writeText(rootPath, "tests/integration/vitest.config.ts"),
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/migrate.ts",
      },
    ],
    [
      "integration test",
      (rootPath) => writeText(rootPath, "tests/integration/contract.test.ts"),
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/migrate.ts",
      },
    ],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      await mutate(rootPath);
      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, expected);
    });
  }
});

test("manifest parsing is regular-file-only and never follows external symlinks", async (t) => {
  for (const relativePath of ["package.json", CONTROL_MANIFEST]) {
    await t.test(
      `${relativePath}: sibling external symlink`,
      async (subtest) => {
        const rootPath = await fixture(subtest);
        await makeComplete(rootPath);
        const targetPath = path.join(rootPath, relativePath);
        const externalPath = path.join(
          path.dirname(rootPath),
          `${path.basename(rootPath)}-${relativePath.replaceAll("/", "-")}`,
        );
        subtest.after(async () => rm(externalPath, { force: true }));
        await writeFile(
          externalPath,
          await readFile(targetPath, "utf8"),
          "utf8",
        );
        await rm(targetPath);
        await symlink(externalPath, targetPath);

        const result = await classifyMigrationContract({ rootPath });
        assertPartial(result);
        assertFinding(result, {
          code: "MIGRATION_SYMLINK",
          path: relativePath,
        });
      },
    );

    await t.test(`${relativePath}: wrong type`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      const targetPath = path.join(rootPath, relativePath);
      await rm(targetPath);
      await mkdir(targetPath);

      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, { code: "MIGRATION_TOPOLOGY", path: relativePath });
    });

    await t.test(relativePath, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await writeText(rootPath, relativePath, "{ invalid json\n");
      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, { code: "MIGRATION_TOPOLOGY", path: relativePath });
    });

    await t.test(`${relativePath}: unreadable`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      const result = await classifyMigrationContract({
        rootPath,
        fsAdapter: deniedManifestAdapter(rootPath, relativePath),
      });
      assert.equal(result.state, "internal");
      assert.deepEqual(result.migrationFiles, []);
      assert.deepEqual(result.findings, []);
    });
  }

  await t.test("sentinel", async (subtest) => {
    const rootPath = await fixture(subtest);
    await makeComplete(rootPath);
    await writeText(
      rootPath,
      "tests/integration/.crewroll-suite.json",
      "{ invalid json\n",
    );
    const result = await classifyMigrationContract({ rootPath });
    assertPartial(result);
    assert.deepEqual(result.findings, [
      {
        code: "MIGRATION_SENTINEL",
        path: "tests/integration/.crewroll-suite.json",
      },
    ]);
  });
});

test("requires every canonical DB target to be a regular non-symlink entry", async (t) => {
  for (const [relativePath, kind] of [
    ["services/control-plane/src/db/migrate.ts", "file"],
    ["services/control-plane/src/db/database.ts", "file"],
    ["services/control-plane/src/db/schema", "directory"],
    ["services/control-plane/src/db/schema/tables.ts", "file"],
  ]) {
    await t.test(`${relativePath}: missing`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await rm(path.join(rootPath, relativePath), {
        force: true,
        recursive: true,
      });
      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, { code: "MIGRATION_TOPOLOGY", path: relativePath });
    });

    await t.test(`${relativePath}: wrong type`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await rm(path.join(rootPath, relativePath), {
        force: true,
        recursive: true,
      });
      if (kind === "directory") {
        await writeText(rootPath, relativePath);
      } else {
        await mkdir(path.join(rootPath, relativePath), { recursive: true });
      }
      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, { code: "MIGRATION_TOPOLOGY", path: relativePath });
    });

    await t.test(`${relativePath}: symlink`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      const targetPath = path.join(rootPath, relativePath);
      await rm(targetPath, { force: true, recursive: true });
      await symlink("missing-target", targetPath);
      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, { code: "MIGRATION_SYMLINK", path: relativePath });
    });
  }
});

test("rejects unclassified schema and migration topology while accepting only contiguous migrations", async (t) => {
  for (const [name, mutate, expected] of [
    [
      "nested schema entry",
      (rootPath) =>
        writeText(
          rootPath,
          "services/control-plane/src/db/schema/nested/extra.ts",
        ),
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/schema/nested",
      },
    ],
    [
      "non-TypeScript schema entry",
      (rootPath) =>
        writeText(rootPath, "services/control-plane/src/db/schema/notes.txt"),
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/schema/notes.txt",
      },
    ],
    [
      "symlinked schema entry",
      (rootPath) =>
        symlink(
          "tables.ts",
          path.join(rootPath, "services/control-plane/src/db/schema/linked.ts"),
        ),
      {
        code: "MIGRATION_SYMLINK",
        path: "services/control-plane/src/db/schema/linked.ts",
      },
    ],
    [
      "extra database root entry",
      (rootPath) =>
        writeText(rootPath, "services/control-plane/src/db/extra.ts"),
      { code: "MIGRATION_TOPOLOGY", path: "services/control-plane/src/db" },
    ],
    [
      "migration sequence gap",
      async (rootPath) => {
        await rm(
          path.join(
            rootPath,
            "services/control-plane/src/db/migrations/001_initial.ts",
          ),
        );
        await writeText(
          rootPath,
          "services/control-plane/src/db/migrations/002_next.ts",
        );
      },
      {
        code: "MIGRATION_SEQUENCE",
        path: "services/control-plane/src/db/migrations",
      },
    ],
    [
      "invalid migration basename",
      (rootPath) =>
        writeText(
          rootPath,
          "services/control-plane/src/db/migrations/001_BAD.ts",
        ),
      {
        code: "MIGRATION_TOPOLOGY",
        path: "services/control-plane/src/db/migrations/001_BAD.ts",
      },
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await mutate(rootPath);
      const result = await classifyMigrationContract({ rootPath });
      assertPartial(result);
      assertFinding(result, expected);
    });
  }
});

test("runner-only partial topology returns frozen deterministic findings", async (t) => {
  const rootPath = await fixture(t);
  await writeText(rootPath, "services/control-plane/src/db/migrate.ts");

  const result = await classifyMigrationContract({ rootPath });
  assertPartial(result);
  assertFinding(result, {
    code: "MIGRATION_TOPOLOGY",
    path: "services/control-plane/package.json",
  });
  assertFinding(result, {
    code: "MIGRATION_TOPOLOGY",
    path: "services/control-plane/src/db/database.ts",
  });
});

test("complete topology reports bounded, repository-relative migrations", async (t) => {
  const rootPath = await fixture(t);
  await makeComplete(rootPath);
  await writeText(
    rootPath,
    "services/control-plane/src/db/migrations/002_add_index.ts",
  );

  const result = await classifyMigrationContract({ rootPath });
  assert.equal(result.state, "complete");
  assert.deepEqual(result.migrationFiles, [
    "services/control-plane/src/db/migrations/001_initial.ts",
    "services/control-plane/src/db/migrations/002_add_index.ts",
  ]);
  assert.deepEqual(result.findings, []);
});

test("complete topology admits only the bounded API identity repositories", async (t) => {
  const rootPath = await fixture(t);
  await makeComplete(rootPath);
  await mkdir(path.join(rootPath, "services/control-plane/src/db/devices"));
  await mkdir(path.join(rootPath, "services/control-plane/src/db/identity"));

  const result = await classifyMigrationContract({ rootPath });

  assert.equal(result.state, "complete");
  assert.deepEqual(result.findings, []);
});

test("adapter failures are internal and never leak raw exceptions", async (t) => {
  const rootPath = await fixture(t);
  const result = await classifyMigrationContract({
    rootPath,
    fsAdapter: {
      async lstat() {
        throw new Error("sensitive fixture failure");
      },
    },
  });

  assert.equal(result.state, "internal");
  assert.deepEqual(result.migrationFiles, []);
  assert.deepEqual(result.findings, []);
});
