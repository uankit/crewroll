import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyMigrationContract } from "./migration-contract.mjs";

const integrationCommand =
  "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts";

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

test("classifies the real public integration dispatcher alone as dormant", async (t) => {
  const rootPath = await fixture(t);
  const result = await classifyMigrationContract({ rootPath });

  assert.equal(result.state, "dormant");
  assert.deepEqual(result.migrationFiles, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
});

test("each independent activation evidence axis is partial", async (t) => {
  const cases = [
    [
      "control db command",
      async (rootPath) => {
        await writeJson(rootPath, "services/control-plane/package.json", {
          scripts: { "db:migrate": "tsx src/db/migrate.ts" },
        });
      },
    ],
    [
      "empty database root",
      (rootPath) =>
        mkdir(path.join(rootPath, "services/control-plane/src/db"), {
          recursive: true,
        }),
    ],
    [
      "wrong database root type",
      (rootPath) => writeText(rootPath, "services/control-plane/src/db"),
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
    ],
    [
      "database root",
      (rootPath) =>
        writeText(rootPath, "services/control-plane/src/db/migrate.ts"),
    ],
    [
      "integration private command",
      async (rootPath) => {
        await writeJson(rootPath, "package.json", {
          scripts: { "test:integration:run": integrationCommand },
        });
      },
    ],
    [
      "integration sentinel",
      (rootPath) =>
        writeText(rootPath, "tests/integration/.crewroll-suite.json", "{}\n"),
    ],
    [
      "integration config",
      (rootPath) => writeText(rootPath, "tests/integration/vitest.config.ts"),
    ],
    [
      "integration test",
      (rootPath) => writeText(rootPath, "tests/integration/contract.test.ts"),
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      await mutate(rootPath);
      assert.equal(
        (await classifyMigrationContract({ rootPath })).state,
        "partial",
      );
    });
  }
});

test("malformed manifests and malformed sentinel fail closed as partial", async (t) => {
  for (const relativePath of [
    "package.json",
    "services/control-plane/package.json",
  ]) {
    await t.test(relativePath, async (subtest) => {
      const rootPath = await fixture(subtest);
      await writeText(rootPath, relativePath, "{ invalid json\n");
      assert.equal(
        (await classifyMigrationContract({ rootPath })).state,
        "partial",
      );
    });
  }

  await t.test("sentinel", async (subtest) => {
    const rootPath = await fixture(subtest);
    await writeText(
      rootPath,
      "tests/integration/.crewroll-suite.json",
      "{ invalid json\n",
    );
    assert.equal(
      (await classifyMigrationContract({ rootPath })).state,
      "partial",
    );
  });
});

test("requires every canonical DB target to be a regular non-symlink entry", async (t) => {
  for (const relativePath of [
    "services/control-plane/src/db/migrate.ts",
    "services/control-plane/src/db/database.ts",
    "services/control-plane/src/db/schema",
    "services/control-plane/src/db/schema/tables.ts",
  ]) {
    await t.test(`${relativePath}: missing`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await rm(path.join(rootPath, relativePath), {
        force: true,
        recursive: true,
      });
      assert.equal(
        (await classifyMigrationContract({ rootPath })).state,
        "partial",
      );
    });

    await t.test(`${relativePath}: wrong type`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await rm(path.join(rootPath, relativePath), {
        force: true,
        recursive: true,
      });
      await mkdir(path.join(rootPath, relativePath), { recursive: true });
      assert.equal(
        (await classifyMigrationContract({ rootPath })).state,
        "partial",
      );
    });

    await t.test(`${relativePath}: symlink`, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      const targetPath = path.join(rootPath, relativePath);
      await rm(targetPath, { force: true, recursive: true });
      await symlink("missing-target", targetPath);
      assert.equal(
        (await classifyMigrationContract({ rootPath })).state,
        "partial",
      );
    });
  }
});

test("rejects unclassified schema and migration topology while accepting only contiguous migrations", async (t) => {
  for (const [name, mutate] of [
    [
      "nested schema entry",
      (rootPath) =>
        writeText(
          rootPath,
          "services/control-plane/src/db/schema/nested/extra.ts",
        ),
    ],
    [
      "non-TypeScript schema entry",
      (rootPath) =>
        writeText(rootPath, "services/control-plane/src/db/schema/notes.txt"),
    ],
    [
      "symlinked schema entry",
      (rootPath) =>
        symlink(
          "tables.ts",
          path.join(rootPath, "services/control-plane/src/db/schema/linked.ts"),
        ),
    ],
    [
      "extra database root entry",
      (rootPath) =>
        writeText(rootPath, "services/control-plane/src/db/extra.ts"),
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
    ],
    [
      "invalid migration basename",
      (rootPath) =>
        writeText(
          rootPath,
          "services/control-plane/src/db/migrations/001_BAD.ts",
        ),
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const rootPath = await fixture(subtest);
      await makeComplete(rootPath);
      await mutate(rootPath);
      assert.equal(
        (await classifyMigrationContract({ rootPath })).state,
        "partial",
      );
    });
  }
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
