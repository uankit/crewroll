import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const CONTROL_MANIFEST = "services/control-plane/package.json";
const DB_ROOT = "services/control-plane/src/db";
const INTEGRATION_ROOT = "tests/integration";
const integrationCommand =
  "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts";
const migrationPattern = /^\d{3}_[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.ts$/u;
const migrationHooks = [
  "pretest:integration",
  "posttest:integration",
  "pretest:integration:run",
  "posttest:integration:run",
];
const controlHooks = ["predb:migrate", "postdb:migrate"];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function result(state, migrationFiles = [], findings = []) {
  return deepFreeze({
    state,
    migrationFiles: [...migrationFiles],
    findings: [...findings].sort((left, right) =>
      `${left.path}:${left.code}`.localeCompare(`${right.path}:${right.code}`),
    ),
  });
}

function isMissing(error) {
  return (
    error &&
    typeof error === "object" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function symlinkPathError(relativePath) {
  const error = new Error("repository symlink");
  error.code = "MIGRATION_SYMLINK";
  error.relativePath = relativePath;
  return error;
}

export async function classifyMigrationContract({ rootPath, fsAdapter } = {}) {
  const fs = fsAdapter ?? { lstat, readdir, readFile, realpath };
  if (!rootPath || !fs || typeof fs.lstat !== "function")
    return result("internal");

  try {
    const absoluteRoot = path.resolve(rootPath);
    const canonicalRoot =
      typeof fs.realpath === "function"
        ? await fs.realpath(absoluteRoot)
        : absoluteRoot;

    const target = (relativePath) => {
      const resolved = path.resolve(absoluteRoot, relativePath);
      if (!isInside(absoluteRoot, resolved)) throw new Error("outside root");
      return resolved;
    };
    const canonicalExistingParent = async (targetPath) => {
      let cursor = targetPath;
      while (isInside(absoluteRoot, cursor)) {
        try {
          return await fs.realpath(cursor);
        } catch (error) {
          if (!isMissing(error)) throw error;
          if (cursor === absoluteRoot) throw error;
          cursor = path.dirname(cursor);
        }
      }
      throw new Error("outside root");
    };
    const safeLstat = async (relativePath) => {
      const targetPath = target(relativePath);
      const ancestorSegments = path
        .relative(absoluteRoot, path.dirname(targetPath))
        .split(path.sep)
        .filter(Boolean);
      let ancestor = absoluteRoot;
      for (const segment of ancestorSegments) {
        ancestor = path.join(ancestor, segment);
        try {
          const stats = await fs.lstat(ancestor);
          if (stats.isSymbolicLink()) {
            throw symlinkPathError(path.relative(absoluteRoot, ancestor));
          }
        } catch (error) {
          if (isMissing(error)) break;
          throw error;
        }
      }
      const parentCanonical =
        typeof fs.realpath === "function"
          ? await canonicalExistingParent(path.dirname(targetPath))
          : path.dirname(targetPath);
      if (!isInside(canonicalRoot, parentCanonical))
        throw new Error("outside root");
      try {
        return await fs.lstat(targetPath);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    };
    const safeRegularRead = async (relativePath) => {
      const stats = await safeLstat(relativePath);
      if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
        return { stats, text: null };
      }
      try {
        return {
          stats,
          text: await fs.readFile(target(relativePath), "utf8"),
        };
      } catch (error) {
        if (isMissing(error)) return { stats: null, text: null };
        throw error;
      }
    };
    const safeRead = async (relativePath) =>
      (await safeRegularRead(relativePath)).text;
    const safeDir = async (relativePath) => {
      const stats = await safeLstat(relativePath);
      if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return null;
      try {
        return await fs.readdir(target(relativePath));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    };
    const parseManifest = async (relativePath) => {
      const { stats, text } = await safeRegularRead(relativePath);
      if (text === null) {
        return {
          valid: false,
          value: null,
          code: stats?.isSymbolicLink()
            ? "MIGRATION_SYMLINK"
            : "MIGRATION_TOPOLOGY",
        };
      }
      try {
        const value = JSON.parse(text);
        return value && typeof value === "object" && !Array.isArray(value)
          ? { valid: true, value, code: null }
          : { valid: false, value: null, code: "MIGRATION_TOPOLOGY" };
      } catch {
        return { valid: false, value: null, code: "MIGRATION_TOPOLOGY" };
      }
    };
    const rootManifest = await parseManifest("package.json");
    const controlManifest = await parseManifest(CONTROL_MANIFEST);
    const findings = [];
    const findingKeys = new Set();
    const mark = (pathValue, code = "MIGRATION_TOPOLOGY") => {
      const key = `${pathValue}\u0000${code}`;
      if (findingKeys.has(key)) return;
      findingKeys.add(key);
      findings.push({ code, path: pathValue });
    };

    if (!rootManifest.valid) mark("package.json", rootManifest.code);
    if (!controlManifest.valid) mark(CONTROL_MANIFEST, controlManifest.code);
    const rootScripts = rootManifest.value?.scripts;
    const controlScripts = controlManifest.value?.scripts;
    const hasControlScript =
      controlHooks.some(
        (name) => controlScripts && Object.hasOwn(controlScripts, name),
      ) ||
      Boolean(controlScripts && Object.hasOwn(controlScripts, "db:migrate"));
    const hasIntegrationScript = [
      "test:integration:run",
      ...migrationHooks,
    ].some((name) => rootScripts && Object.hasOwn(rootScripts, name));

    const dbStats = await safeLstat(DB_ROOT);
    const integrationStats = await safeLstat(INTEGRATION_ROOT);
    const hasDbEvidence = Boolean(dbStats);
    const hasIntegrationEvidence =
      Boolean(integrationStats) || hasIntegrationScript;
    const hasEvidence =
      !rootManifest.valid ||
      !controlManifest.valid ||
      hasControlScript ||
      hasDbEvidence ||
      hasIntegrationEvidence;
    if (!hasEvidence) return result("dormant");

    const expectedControlScripts =
      controlScripts &&
      controlScripts["db:migrate"] === "tsx src/db/migrate.ts" &&
      !controlHooks.some((name) => Object.hasOwn(controlScripts, name));
    if (!expectedControlScripts) mark(CONTROL_MANIFEST);
    if (
      migrationHooks.some(
        (name) => rootScripts && Object.hasOwn(rootScripts, name),
      )
    ) {
      mark("package.json");
    }
    if (rootScripts?.["test:integration:run"] !== integrationCommand) {
      mark("package.json");
    }

    const expect = async (relativePath, kind) => {
      const stats = await safeLstat(relativePath);
      const valid =
        stats &&
        !stats.isSymbolicLink() &&
        (kind === "file" ? stats.isFile() : stats.isDirectory());
      if (!valid)
        mark(
          relativePath,
          stats?.isSymbolicLink() ? "MIGRATION_SYMLINK" : undefined,
        );
      return Boolean(valid);
    };
    const runner = await expect(`${DB_ROOT}/migrate.ts`, "file");
    const database = await expect(`${DB_ROOT}/database.ts`, "file");
    const schema = await expect(`${DB_ROOT}/schema`, "directory");
    const tables = await expect(`${DB_ROOT}/schema/tables.ts`, "file");
    const migrations = await expect(`${DB_ROOT}/migrations`, "directory");

    const dbEntries = await safeDir(DB_ROOT);
    const requiredDbEntries = [
      "migrate.ts",
      "database.ts",
      "schema",
      "migrations",
    ];
    const optionalApiRepositories = ["devices", "identity"];
    if (
      !dbEntries ||
      new Set(dbEntries).size !== dbEntries.length ||
      !requiredDbEntries.every((entry) => dbEntries.includes(entry)) ||
      dbEntries.some(
        (entry) =>
          !requiredDbEntries.includes(entry) &&
          !optionalApiRepositories.includes(entry),
      )
    ) {
      mark(DB_ROOT);
    }
    for (const repository of optionalApiRepositories) {
      if (dbEntries?.includes(repository)) {
        await expect(`${DB_ROOT}/${repository}`, "directory");
      }
    }

    if (schema) {
      const entries = await safeDir(`${DB_ROOT}/schema`);
      if (!entries || !entries.includes("tables.ts")) {
        mark(`${DB_ROOT}/schema`);
      } else {
        for (const entry of entries) {
          const relativePath = `${DB_ROOT}/schema/${entry}`;
          const stats = await safeLstat(relativePath);
          if (
            !stats ||
            stats.isSymbolicLink() ||
            !stats.isFile() ||
            !entry.endsWith(".ts")
          ) {
            mark(
              relativePath,
              stats?.isSymbolicLink() ? "MIGRATION_SYMLINK" : undefined,
            );
          }
        }
      }
    }

    const migrationFiles = [];
    if (migrations) {
      const entries = await safeDir(`${DB_ROOT}/migrations`);
      if (!entries || entries.length === 0) {
        mark(`${DB_ROOT}/migrations`);
      } else {
        for (const entry of entries) {
          const relativePath = `${DB_ROOT}/migrations/${entry}`;
          const stats = await safeLstat(relativePath);
          if (
            !stats ||
            stats.isSymbolicLink() ||
            !stats.isFile() ||
            !migrationPattern.test(entry)
          ) {
            mark(
              relativePath,
              stats?.isSymbolicLink() ? "MIGRATION_SYMLINK" : undefined,
            );
          } else {
            migrationFiles.push(relativePath);
          }
        }
        const numbers = migrationFiles
          .map((file) => Number(path.basename(file).slice(0, 3)))
          .sort((a, b) => a - b);
        if (
          numbers.length !== entries.length ||
          numbers.some((number, index) => number !== index + 1)
        ) {
          mark(`${DB_ROOT}/migrations`, "MIGRATION_SEQUENCE");
        }
      }
    }

    const sentinelPath = `${INTEGRATION_ROOT}/.crewroll-suite.json`;
    const configPath = `${INTEGRATION_ROOT}/vitest.config.ts`;
    const sentinel = await safeRead(sentinelPath);
    let validSentinel = false;
    try {
      const parsed = JSON.parse(sentinel ?? "");
      validSentinel =
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).sort().join(",") ===
          "ownerTask,schemaVersion,suite" &&
        parsed.schemaVersion === 1 &&
        parsed.suite === "integration" &&
        parsed.ownerTask === "DB-001";
    } catch {}
    if (!validSentinel || !(await expect(sentinelPath, "file")))
      mark(sentinelPath, "MIGRATION_SENTINEL");
    await expect(configPath, "file");

    let integrationTests = 0;
    const inspectIntegration = async (relativePath) => {
      const entries = await safeDir(relativePath);
      if (!entries) return;
      for (const entry of entries) {
        const child = `${relativePath}/${entry}`;
        const stats = await safeLstat(child);
        if (!stats || stats.isSymbolicLink()) {
          mark(child, "MIGRATION_SYMLINK");
        } else if (stats.isDirectory()) {
          await inspectIntegration(child);
        } else if (stats.isFile() && entry.endsWith(".test.ts")) {
          integrationTests += 1;
        }
      }
    };
    if (
      integrationStats &&
      integrationStats.isDirectory() &&
      !integrationStats.isSymbolicLink()
    ) {
      await inspectIntegration(INTEGRATION_ROOT);
    } else {
      mark(
        INTEGRATION_ROOT,
        integrationStats?.isSymbolicLink() ? "MIGRATION_SYMLINK" : undefined,
      );
    }
    if (integrationTests === 0) mark(INTEGRATION_ROOT);

    if (
      !runner ||
      !database ||
      !schema ||
      !tables ||
      !migrations ||
      findings.length > 0
    ) {
      return result("partial", [], findings);
    }
    return result("complete", migrationFiles.sort());
  } catch (error) {
    if (error?.code === "MIGRATION_SYMLINK") {
      return result(
        "partial",
        [],
        [{ code: "MIGRATION_SYMLINK", path: error.relativePath ?? "." }],
      );
    }
    return result("internal");
  }
}
