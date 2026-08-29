import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const RUNNER_PATH = "services/control-plane/src/db/migrate.ts";
const DATABASE_PATH = "services/control-plane/src/db/database.ts";
const SCHEMA_PATH = "services/control-plane/src/db/schema";
const TABLES_PATH = `${SCHEMA_PATH}/tables.ts`;
const MIGRATION_FOLDER_PATH = "services/control-plane/src/db/migrations";

const CANONICAL_RUNNER = `
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

const EXPECTED_CODES = [
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_IMPORT_SHAPE",
  "MIGRATION_RUNNER_FOLDER_SHAPE",
  "MIGRATION_RUNNER_PROVIDER_SHAPE",
  "MIGRATION_RUNNER_ENTRY_SHAPE",
  "MIGRATION_RUNNER_ENTRY_SHAPE",
];

const FIXED_TARGETS = [
  {
    path: RUNNER_PATH,
    kind: "file",
    code: "MIGRATION_RUNNER_ENTRY_SHAPE",
  },
  {
    path: DATABASE_PATH,
    kind: "file",
    code: "MIGRATION_RUNNER_FOLDER_SHAPE",
  },
  {
    path: SCHEMA_PATH,
    kind: "directory",
    code: "MIGRATION_RUNNER_FOLDER_SHAPE",
  },
  {
    path: TABLES_PATH,
    kind: "file",
    code: "MIGRATION_RUNNER_FOLDER_SHAPE",
  },
  {
    path: MIGRATION_FOLDER_PATH,
    kind: "directory",
    code: "MIGRATION_RUNNER_FOLDER_SHAPE",
  },
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFindings(left, right) {
  return (
    compareText(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.code, right.code)
  );
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function isMissing(error) {
  return (
    error &&
    typeof error === "object" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function positionOf(sourceFile, nodeOrPosition) {
  const position =
    typeof nodeOrPosition === "number"
      ? nodeOrPosition
      : nodeOrPosition.getStart(sourceFile, false);
  const { line, character } =
    sourceFile.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

function createFindingCollector() {
  const findings = [];
  const keys = new Set();
  const add = (finding) => {
    const key = `${finding.path}\u0000${finding.line}\u0000${finding.column}\u0000${finding.code}`;
    if (!keys.has(key)) {
      keys.add(key);
      findings.push(finding);
    }
  };
  const addSource = (sourceFile, nodeOrPosition, code) => {
    add({ code, path: RUNNER_PATH, ...positionOf(sourceFile, nodeOrPosition) });
  };
  const addPath = (relativePath, code) => {
    add({ code, path: relativePath, line: 1, column: 1 });
  };
  return { addPath, addSource, findings };
}

function structuralAttributes(node) {
  const attributes = [];
  if (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node)
  ) {
    attributes.push(node.text);
  }
  if (ts.isImportClause(node) || ts.isImportSpecifier(node)) {
    attributes.push(node.isTypeOnly ? "type" : "value");
  }
  if (ts.isExportDeclaration(node) || ts.isExportSpecifier(node)) {
    attributes.push(node.isTypeOnly ? "type" : "value");
  }
  if (ts.isVariableDeclarationList(node)) {
    attributes.push(
      node.flags & ts.NodeFlags.Const
        ? "const"
        : node.flags & ts.NodeFlags.Let
          ? "let"
          : "var",
    );
  }
  if (Object.hasOwn(node, "typeArguments")) {
    attributes.push(
      node.typeArguments === undefined
        ? "no-type-arguments"
        : `type-arguments:${node.typeArguments.length}`,
    );
  }
  if (Object.hasOwn(node, "typeParameters")) {
    attributes.push(
      node.typeParameters === undefined
        ? "no-type-parameters"
        : `type-parameters:${node.typeParameters.length}`,
    );
  }
  return attributes;
}

function fingerprint(node) {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(fingerprint(child));
  });
  return JSON.stringify([node.kind, structuralAttributes(node), children]);
}

function sourceStatements(sourceFile) {
  return sourceFile.statements.filter(
    (statement) => !ts.isEmptyStatement(statement),
  );
}

const expectedSourceFile = ts.createSourceFile(
  RUNNER_PATH,
  CANONICAL_RUNNER,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const expectedFingerprints =
  sourceStatements(expectedSourceFile).map(fingerprint);

function containsUnsupportedLoader(node) {
  let found = false;
  const visit = (current) => {
    if (
      ts.isCallExpression(current) &&
      (current.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(current.expression) &&
          current.expression.text === "require"))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function analyzeSource(sourceFile, collector) {
  if (sourceFile.parseDiagnostics.length > 0) {
    for (const diagnostic of sourceFile.parseDiagnostics) {
      collector.addSource(
        sourceFile,
        diagnostic.start ?? 0,
        "MIGRATION_RUNNER_PARSE",
      );
    }
    return;
  }

  const statements = sourceStatements(sourceFile);
  for (let index = 0; index < expectedFingerprints.length; index += 1) {
    const statement = statements[index];
    if (!statement || fingerprint(statement) !== expectedFingerprints[index]) {
      collector.addSource(
        sourceFile,
        statement ?? sourceFile.end,
        EXPECTED_CODES[index],
      );
    }
  }

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const isImportSurface =
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier) ||
      containsUnsupportedLoader(statement);
    if (
      isImportSurface &&
      (index >= 7 || fingerprint(statement) !== expectedFingerprints[index])
    ) {
      collector.addSource(
        sourceFile,
        statement,
        "MIGRATION_RUNNER_IMPORT_SHAPE",
      );
    }
    if (index >= expectedFingerprints.length) {
      collector.addSource(
        sourceFile,
        statement,
        isImportSurface
          ? "MIGRATION_RUNNER_IMPORT_SHAPE"
          : "MIGRATION_RUNNER_ENTRY_SHAPE",
      );
    }
  }
}

async function inspectTarget({
  absoluteRoot,
  canonicalRoot,
  relativePath,
  kind,
  fs,
}) {
  const targetPath = path.resolve(absoluteRoot, relativePath);
  if (!isInside(absoluteRoot, targetPath)) return false;

  const segments = path
    .relative(absoluteRoot, path.dirname(targetPath))
    .split(path.sep)
    .filter(Boolean);
  let ancestor = absoluteRoot;
  for (const segment of segments) {
    ancestor = path.join(ancestor, segment);
    let stats;
    try {
      stats = await fs.lstat(ancestor);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  }

  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (
    stats.isSymbolicLink() ||
    (kind === "file" ? !stats.isFile() : !stats.isDirectory())
  ) {
    return false;
  }

  let canonicalTarget;
  try {
    canonicalTarget = await fs.realpath(targetPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  return (
    isInside(canonicalRoot, canonicalTarget) &&
    canonicalTarget === path.resolve(canonicalRoot, relativePath)
  );
}

export async function analyzeMigrationRunner({ rootPath, fsAdapter } = {}) {
  const fs = fsAdapter ?? { lstat, readFile, realpath };
  if (
    typeof rootPath !== "string" ||
    rootPath.length === 0 ||
    typeof fs?.lstat !== "function" ||
    typeof fs?.readFile !== "function" ||
    typeof fs?.realpath !== "function"
  ) {
    throw new TypeError("Invalid migration runner analyzer input");
  }

  const absoluteRoot = path.resolve(rootPath);
  const rootStats = await fs.lstat(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new TypeError("Invalid migration runner analyzer root");
  }
  const canonicalRoot = await fs.realpath(absoluteRoot);
  const collector = createFindingCollector();
  let runnerReady = false;

  for (const target of FIXED_TARGETS) {
    const valid = await inspectTarget({
      absoluteRoot,
      canonicalRoot,
      relativePath: target.path,
      kind: target.kind,
      fs,
    });
    if (!valid) collector.addPath(target.path, target.code);
    if (target.path === RUNNER_PATH) runnerReady = valid;
  }

  if (runnerReady) {
    const absoluteRunnerPath = path.join(absoluteRoot, RUNNER_PATH);
    let sourceText;
    try {
      sourceText = await fs.readFile(absoluteRunnerPath, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        collector.addPath(RUNNER_PATH, "MIGRATION_RUNNER_ENTRY_SHAPE");
      } else {
        throw error;
      }
    }
    if (sourceText !== undefined) {
      const sourceFile = ts.createSourceFile(
        RUNNER_PATH,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      analyzeSource(sourceFile, collector);
    }
  }

  return deepFreeze({
    findings: collector.findings.sort(compareFindings),
  });
}
