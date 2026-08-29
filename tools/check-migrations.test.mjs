import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

async function fixture(t) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "crewroll-b2b-i-cli-"));
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  await mkdir(path.join(rootPath, "tools"), { recursive: true });
  await writeFile(path.join(rootPath, "package.json"), '{"scripts":{}}\n');
  await mkdir(path.join(rootPath, "services/control-plane"), {
    recursive: true,
  });
  await writeFile(
    path.join(rootPath, "services/control-plane/package.json"),
    '{"scripts":{}}\n',
  );
  await cp(
    path.join(projectRoot, "tools/check-migrations.mjs"),
    path.join(rootPath, "tools/check-migrations.mjs"),
  );
  await cp(
    path.join(projectRoot, "tools/migration-contract.mjs"),
    path.join(rootPath, "tools/migration-contract.mjs"),
  );
  return rootPath;
}

async function run(rootPath, args = []) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["tools/check-migrations.mjs", ...args],
      {
        cwd: rootPath,
      },
    );
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stderr: error.stderr, stdout: error.stdout };
  }
}

async function makeComplete(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({
      scripts: {
        "test:integration": "node tools/run-future-suite.mjs integration",
        "test:integration:run":
          "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts",
      },
    }),
  );
  await writeFile(
    path.join(rootPath, "services/control-plane/package.json"),
    JSON.stringify({ scripts: { "db:migrate": "tsx src/db/migrate.ts" } }),
  );
  for (const relativePath of [
    "services/control-plane/src/db/migrate.ts",
    "services/control-plane/src/db/database.ts",
    "services/control-plane/src/db/schema/tables.ts",
    "services/control-plane/src/db/migrations/001_initial.ts",
    "tests/integration/vitest.config.ts",
    "tests/integration/contract.test.ts",
  ]) {
    const targetPath = path.join(rootPath, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "export {};\n");
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

test("complete topology remains fail-closed until B2b-ii-c", async (t) => {
  const rootPath = await fixture(t);
  await makeComplete(rootPath);
  const result = await run(rootPath);
  assert.equal(result.code, 65);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "CrewRoll migration check: complete DB-001 topology detected, but FND-002B2b-ii-c final static-analyzer composition is not installed; refusing activation.\n",
  );
});
