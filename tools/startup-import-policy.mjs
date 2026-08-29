import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import ts from "typescript";

const CONTROL_ROOT = "services/control-plane";
const CONTROL_MANIFEST = `${CONTROL_ROOT}/package.json`;
const SOURCE_ROOT = `${CONTROL_ROOT}/src`;
const INDEX_PATH = `${SOURCE_ROOT}/index.ts`;
const API_PATH = `${SOURCE_ROOT}/api/main.ts`;
const WORKER_PATH = `${SOURCE_ROOT}/worker/main.ts`;
const BUILD_APP_PATH = `${SOURCE_ROOT}/app/buildApp.ts`;
const RUNNER_PATH = `${SOURCE_ROOT}/db/migrate.ts`;
const MIGRATION_ROOT = `${SOURCE_ROOT}/db/migrations`;
const OPTIONAL_ENTRIES = [
  {
    path: API_PATH,
    script: "start:api",
    command: "node dist/src/api/main.js",
  },
  {
    path: WORKER_PATH,
    script: "start:worker",
    command: "node dist/src/worker/main.js",
  },
];
const FORBIDDEN_LIFECYCLE = new Set([
  "prestart:api",
  "poststart:api",
  "prestart:worker",
  "poststart:worker",
]);
const VALID_ENTRY_MAIN_PATHS = new Set([API_PATH, WORKER_PATH]);
const LOADER_PROPERTY_NAMES = new Set(["require", "createRequire", "dlopen"]);
const LOADER_MODULE_SPECIFIERS = new Set(["module", "node:module"]);
const EXECUTABLE_CONSTRUCTORS = new Set(["eval", "Function", "AsyncFunction"]);
const LOADER_IDENTIFIERS = new Set([
  "require",
  "createRequire",
  "eval",
  "Function",
  "AsyncFunction",
  "exports",
]);
const BUILTINS = new Set(
  builtinModules.map((name) =>
    name.startsWith("node:") ? name.slice("node:".length) : name,
  ),
);
const PACKAGE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/u;
const CONTROL_TARGET =
  /(?:^|[\s'"=])(?:\.\/)?(?:services\/control-plane\/)?(?:src|dist)\//u;
const ROOT_CONTROL_TARGET = /services\/control-plane\/(?:src|dist)\//u;
const APPROVED_ROOT_SCRIPTS = new Map([
  ["prestart", "npm run build --workspace @crewroll/contracts"],
  ["start", "expo start --dev-client"],
  ["prestart:clean", "npm run build --workspace @crewroll/contracts"],
  ["start:clean", "expo start --dev-client --clear"],
  ["preandroid", "npm run build --workspace @crewroll/contracts"],
  ["android", "expo run:android"],
  ["preandroid:device", "npm run build --workspace @crewroll/contracts"],
  ["android:device", "expo run:android --device"],
  ["preios", "npm run build --workspace @crewroll/contracts"],
  ["ios", "expo run:ios"],
  ["preios:device", "npm run build --workspace @crewroll/contracts"],
  ["ios:device", "expo run:ios --device"],
  ["format:check", "prettier . --check --ignore-unknown"],
  ["prelint", "npm run build --workspace @crewroll/contracts"],
  [
    "lint",
    "expo lint app src modules __tests__ tests tools eslint.config.js vitest.config.ts --no-cache --max-warnings=0 -- --no-error-on-unmatched-pattern && npm run lint --workspace @crewroll/contracts && npm run lint --workspace @crewroll/control-plane",
  ],
  [
    "typecheck",
    "npm run typecheck --workspace @crewroll/contracts && npm run build --workspace @crewroll/contracts && tsc --noEmit && npm run typecheck --workspace @crewroll/control-plane",
  ],
  ["test", "npm run test:unit"],
  [
    "test:unit",
    "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && npm run test:production-resolution && npm run test:tools && npm run test:ui && vitest run --config vitest.config.ts",
  ],
  [
    "test:production-resolution",
    "node tools/verify-native-production-resolution.mjs",
  ],
  ["test:tools", 'node --test "tools/*.test.mjs"'],
  ["test:ui", "jest --runInBand"],
  ["test:ui:watch", "jest --watch"],
  ["test:integration", "node tools/run-future-suite.mjs integration"],
  ["test:native:ios", "node tools/run-future-suite.mjs native-ios"],
  ["test:native:android", "node tools/run-future-suite.mjs native-android"],
  ["test:e2e", "node tools/run-future-suite.mjs e2e"],
  ["test:load", "node tools/run-future-suite.mjs load"],
  ["migrations:check", "node tools/check-migrations.mjs"],
  ["doctor", "expo-doctor"],
  ["verify:identity", "node tools/verify-app-identity.mjs"],
  ["preverify:bundle", "npm run build --workspace @crewroll/contracts"],
  [
    "verify:bundle",
    "expo export:embed --entry-file src/infrastructure/native/crewRollTransfer.ts --platform ios --dev false --minify false --bundle-output dist/native-adapter.ios.js --max-workers 1 && expo export --platform ios --output-dir dist/ios && expo export --platform android --output-dir dist/android",
  ],
  [
    "check",
    "npm run verify:identity && npm run format:check && npm run lint && npm run typecheck && npm run --ignore-scripts migrations:check && npm run test:unit && npm run doctor",
  ],
  ["eas-build-post-install", "npm run build --workspace @crewroll/contracts"],
  [
    "build:dev:android",
    "npx --yes eas-cli@22.4.0 build --profile development --platform android",
  ],
  [
    "build:dev:ios",
    "npx --yes eas-cli@22.4.0 build --profile development --platform ios",
  ],
  [
    "build:preview:android",
    "npx --yes eas-cli@22.4.0 build --profile preview --platform android",
  ],
  [
    "build:preview:ios",
    "npx --yes eas-cli@22.4.0 build --profile preview --platform ios",
  ],
  [
    "test:integration:run",
    "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts",
  ],
]);
const APPROVED_CONTRACT_SCRIPTS = new Map([
  [
    "build",
    "node ../../tools/clean-workspace-dist.mjs && tsc -p tsconfig.build.json",
  ],
  [
    "lint",
    "eslint crypto fixtures generator native openapi storage test vitest.config.ts --max-warnings=0",
  ],
  ["typecheck", "tsc -p tsconfig.json --noEmit"],
  ["test", "npm run build && vitest run"],
  ["openapi:generate", "tsx generator/generate-openapi.ts"],
  ["openapi:check", "tsx generator/check-openapi.ts"],
]);
const APPROVED_CONTROL_SCRIPTS = new Map([
  [
    "build",
    "node ../../tools/clean-workspace-dist.mjs && tsc -p tsconfig.build.json",
  ],
  ["typecheck", "tsc -p tsconfig.json --noEmit"],
  ["prelint", "npm run build --workspace @crewroll/contracts"],
  ["lint", "eslint src test --max-warnings=0"],
  ["test", "npm run build && vitest run"],
  ["test:coverage", "npm run build && vitest run --coverage"],
  ["start:api", "node dist/src/api/main.js"],
  ["start:worker", "node dist/src/worker/main.js"],
  ["db:migrate", "tsx src/db/migrate.ts"],
]);
const APPROVED_MANIFEST_SCRIPTS = new Map([
  ["package.json", APPROVED_ROOT_SCRIPTS],
  ["packages/contracts/package.json", APPROVED_CONTRACT_SCRIPTS],
  [CONTROL_MANIFEST, APPROVED_CONTROL_SCRIPTS],
]);

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
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
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
  const addPath = (relativePath, code) => {
    add({ code, path: relativePath, line: 1, column: 1 });
  };
  const addSource = (sourceFile, nodeOrPosition, code) => {
    add({
      code,
      path: sourceFile.fileName,
      ...positionOf(sourceFile, nodeOrPosition),
    });
  };
  return { addPath, addSource, findings };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    isObject(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key, index) => key === expected[index])
  );
}

function hasControlTarget(value) {
  if (typeof value === "string") return ROOT_CONTROL_TARGET.test(value);
  if (Array.isArray(value)) return value.some(hasControlTarget);
  if (!isObject(value)) return false;
  return Object.values(value).some(hasControlTarget);
}

function hasLocalControlTarget(value) {
  if (typeof value === "string") return CONTROL_TARGET.test(value);
  if (Array.isArray(value)) return value.some(hasLocalControlTarget);
  if (!isObject(value)) return false;
  return Object.values(value).some(hasLocalControlTarget);
}

function isValidPackageSpecifier(specifier) {
  if (specifier.startsWith("node:")) {
    return BUILTINS.has(specifier.slice("node:".length));
  }
  if (
    specifier === "@crewroll/control-plane" ||
    specifier.startsWith("@crewroll/control-plane/") ||
    !/^[\x00-\x7f]+$/u.test(specifier)
  ) {
    return false;
  }
  const segments = specifier.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return false;
  }
  if (specifier.startsWith("@")) {
    if (segments.length < 2 || !segments[0].startsWith("@")) return false;
    return (
      PACKAGE_SEGMENT.test(segments[0].slice(1)) &&
      segments.slice(1).every((segment) => PACKAGE_SEGMENT.test(segment))
    );
  }
  return segments.every((segment) => PACKAGE_SEGMENT.test(segment));
}

function parseRelativeSpecifier(specifier, importerPath) {
  if (
    typeof specifier !== "string" ||
    !/^[\x20-\x7e]+$/u.test(specifier) ||
    specifier.includes("\\") ||
    specifier.includes("%") ||
    specifier.includes("?") ||
    specifier.includes("#") ||
    !(specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    return null;
  }

  const segments = specifier.split("/");
  let index = 0;
  if (segments[0] === ".") {
    index = 1;
  } else {
    while (segments[index] === "..") index += 1;
  }
  const fileSegments = segments.slice(index);
  if (
    fileSegments.length === 0 ||
    fileSegments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~-]+$/u.test(segment),
    ) ||
    !fileSegments.at(-1).endsWith(".js") ||
    fileSegments.at(-1) === ".js"
  ) {
    return null;
  }

  const sourceSpecifier = `${specifier.slice(0, -3)}.ts`;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), sourceSpecifier),
  );
  if (resolved !== SOURCE_ROOT && !resolved.startsWith(`${SOURCE_ROOT}/`)) {
    return null;
  }
  return resolved;
}

function isMigrationTarget(relativePath) {
  return (
    relativePath === RUNNER_PATH ||
    relativePath.startsWith(`${MIGRATION_ROOT}/`)
  );
}

function hasImportAttributes(statement) {
  return Boolean(statement.attributes ?? statement.assertClause);
}

function isRuntimeImportOrExportDeclaration(node) {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
      return true;
    }
    return (
      node.exportClause.elements.length === 0 ||
      node.exportClause.elements.some((element) => !element.isTypeOnly)
    );
  }

  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || !clause.namedBindings) return true;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return (
    clause.namedBindings.elements.length === 0 ||
    clause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function isUnsupportedLoaderNode(node) {
  if (
    ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      LOADER_MODULE_SPECIFIERS.has(node.moduleSpecifier.text) &&
      isRuntimeImportOrExportDeclaration(node)) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isImportTypeNode(node) ||
    (ts.isExportAssignment(node) && node.isExportEquals)
  )
    return true;
  if (ts.isIdentifier(node) && LOADER_IDENTIFIERS.has(node.text)) return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    LOADER_PROPERTY_NAMES.has(node.name.text)
  ) {
    return true;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ((ts.isIdentifier(node.expression) &&
      ["module", "process", "globalThis"].includes(node.expression.text)) ||
      (ts.isStringLiteral(node.argumentExpression) &&
        (LOADER_PROPERTY_NAMES.has(node.argumentExpression.text) ||
          EXECUTABLE_CONSTRUCTORS.has(node.argumentExpression.text))))
  ) {
    return true;
  }
  return (
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    EXECUTABLE_CONSTRUCTORS.has(node.expression.text)
  );
}

function scriptIsSuspicious({ command, manifestPath, scriptName }) {
  return (
    APPROVED_MANIFEST_SCRIPTS.get(manifestPath)?.get(scriptName) !== command
  );
}

async function createRepository(rootPath, fs) {
  const absoluteRoot = path.resolve(rootPath);
  const rootStats = await fs.lstat(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new TypeError("Invalid startup import analyzer root");
  }
  const canonicalRoot = await fs.realpath(absoluteRoot);

  const entry = async (relativePath) => {
    const targetPath = path.resolve(absoluteRoot, relativePath);
    if (!isInside(absoluteRoot, targetPath)) return { state: "unsafe" };
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
        if (isMissing(error)) return { state: "missing" };
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        return { state: "unsafe" };
      }
    }

    let stats;
    try {
      stats = await fs.lstat(targetPath);
    } catch (error) {
      if (isMissing(error)) return { state: "missing" };
      throw error;
    }
    if (stats.isSymbolicLink()) return { state: "unsafe", stats };

    let canonicalTarget;
    try {
      canonicalTarget = await fs.realpath(targetPath);
    } catch (error) {
      if (isMissing(error)) return { state: "missing" };
      throw error;
    }
    if (
      !isInside(canonicalRoot, canonicalTarget) ||
      canonicalTarget !== path.resolve(canonicalRoot, relativePath)
    ) {
      return { state: "unsafe", stats };
    }
    return { state: "ready", stats, targetPath };
  };

  const read = async (relativePath) => {
    const inspected = await entry(relativePath);
    if (inspected.state !== "ready" || !inspected.stats.isFile()) {
      return { ...inspected, text: null };
    }
    try {
      return {
        ...inspected,
        text: await fs.readFile(inspected.targetPath, "utf8"),
      };
    } catch (error) {
      if (isMissing(error)) return { state: "missing", text: null };
      throw error;
    }
  };

  const list = async (relativePath) => {
    const inspected = await entry(relativePath);
    if (inspected.state !== "ready" || !inspected.stats.isDirectory()) {
      return { ...inspected, entries: null };
    }
    try {
      return {
        ...inspected,
        entries: await fs.readdir(inspected.targetPath),
      };
    } catch (error) {
      if (isMissing(error)) return { state: "missing", entries: null };
      throw error;
    }
  };

  return { entry, list, read };
}

async function readManifest(repository, collector, relativePath) {
  const loaded = await repository.read(relativePath);
  if (loaded.text === null) {
    collector.addPath(relativePath, "STARTUP_EXECUTABLE_SURFACE");
    return null;
  }
  try {
    const value = JSON.parse(loaded.text);
    if (!isObject(value)) throw new TypeError("manifest object required");
    return value;
  } catch {
    collector.addPath(relativePath, "STARTUP_EXECUTABLE_SURFACE");
    return null;
  }
}

function inspectManifestSurface(collector, relativePath, manifest) {
  if (!manifest) return;
  const scripts = manifest.scripts;
  if (scripts !== undefined && !isObject(scripts)) {
    collector.addPath(relativePath, "STARTUP_EXECUTABLE_SURFACE");
    return;
  }
  for (const [scriptName, command] of Object.entries(scripts ?? {})) {
    if (
      FORBIDDEN_LIFECYCLE.has(scriptName) ||
      scriptIsSuspicious({ command, manifestPath: relativePath, scriptName })
    ) {
      collector.addPath(relativePath, "STARTUP_EXECUTABLE_SURFACE");
    }
  }
  const otherFields = Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) =>
        key !== "scripts" &&
        (relativePath !== CONTROL_MANIFEST || key !== "exports"),
    ),
  );
  if (hasControlTarget(otherFields)) {
    collector.addPath(relativePath, "STARTUP_EXECUTABLE_SURFACE");
  }
}

function inspectControlManifest(collector, manifest) {
  if (!manifest) return;
  if (["main", "module", "bin"].some((key) => Object.hasOwn(manifest, key))) {
    collector.addPath(CONTROL_MANIFEST, "STARTUP_EXECUTABLE_SURFACE");
  }
  const rootExport = manifest.exports?.["."];
  if (
    !exactKeys(manifest.exports, ["."]) ||
    !exactKeys(rootExport, ["types", "import"]) ||
    rootExport.types !== "./dist/src/index.d.ts" ||
    rootExport.import !== "./dist/src/index.js"
  ) {
    collector.addPath(CONTROL_MANIFEST, "STARTUP_EXECUTABLE_SURFACE");
  }
  const otherFields = Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) =>
        key !== "scripts" &&
        key !== "exports" &&
        key !== "main" &&
        key !== "module" &&
        key !== "bin",
    ),
  );
  if (hasLocalControlTarget(otherFields)) {
    collector.addPath(CONTROL_MANIFEST, "STARTUP_EXECUTABLE_SURFACE");
  }
}

async function workspaceManifestPaths(repository, collector, rootValue) {
  const found = new Set([CONTROL_MANIFEST]);
  if (!Array.isArray(rootValue?.workspaces)) return [...found];
  for (const pattern of rootValue.workspaces) {
    if (typeof pattern !== "string") {
      collector.addPath("package.json", "STARTUP_EXECUTABLE_SURFACE");
      continue;
    }
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const base = pattern.slice(0, -2);
      const listed = await repository.list(base);
      if (
        listed.state !== "ready" ||
        !listed.stats.isDirectory() ||
        listed.entries === null
      ) {
        collector.addPath("package.json", "STARTUP_EXECUTABLE_SURFACE");
        continue;
      }
      for (const child of listed.entries) {
        const workspacePath = `${base}/${child}`;
        const inspected = await repository.entry(workspacePath);
        if (inspected.state === "ready" && inspected.stats.isDirectory()) {
          found.add(`${workspacePath}/package.json`);
        } else if (inspected.state === "unsafe") {
          collector.addPath(
            `${workspacePath}/package.json`,
            "STARTUP_EXECUTABLE_SURFACE",
          );
        }
      }
    } else if (!pattern.includes("*") && !pattern.includes("\\")) {
      found.add(`${pattern}/package.json`);
    } else {
      collector.addPath("package.json", "STARTUP_EXECUTABLE_SURFACE");
    }
  }
  return [...found].sort(compareText);
}

async function scanSourceTree(repository, collector, relativePath) {
  const listed = await repository.list(relativePath);
  if (listed.entries === null) {
    collector.addPath(relativePath, "STARTUP_IMPORT_RESOLUTION");
    return;
  }
  for (const name of [...listed.entries].sort(compareText)) {
    const childPath = `${relativePath}/${name}`;
    const inspected = await repository.entry(childPath);
    if (inspected.state !== "ready") {
      collector.addPath(childPath, "STARTUP_EXECUTABLE_SURFACE");
    } else if (inspected.stats.isDirectory()) {
      await scanSourceTree(repository, collector, childPath);
    } else if (!inspected.stats.isFile()) {
      collector.addPath(childPath, "STARTUP_EXECUTABLE_SURFACE");
    } else if (/\.(?:[cm]?ts|tsx)$/u.test(name)) {
      if (name === "main.ts" && !VALID_ENTRY_MAIN_PATHS.has(childPath)) {
        collector.addPath(childPath, "STARTUP_EXECUTABLE_SURFACE");
      }
      const loaded = await repository.read(childPath);
      if (loaded.text?.startsWith("#!")) {
        collector.addPath(childPath, "STARTUP_EXECUTABLE_SURFACE");
      }
    }
  }
}

async function hasAmbiguousSibling(repository, relativePath) {
  const stem = relativePath.slice(0, -3);
  for (const extension of [".tsx", ".d.ts", ".js", ".jsx"]) {
    const candidate = await repository.entry(`${stem}${extension}`);
    if (candidate.state !== "missing") return true;
  }
  return false;
}

async function analyzeGraph({ repository, collector, roots }) {
  const visited = new Set();
  const queue = [...roots];

  const inspectRelativeEdge = async ({
    sourceFile,
    node,
    specifier,
    traverse,
  }) => {
    const resolved = parseRelativeSpecifier(specifier, sourceFile.fileName);
    if (!resolved) {
      collector.addSource(sourceFile, node, "STARTUP_IMPORT_GRAMMAR");
      return;
    }
    if (resolved.endsWith(".d.ts")) {
      collector.addSource(sourceFile, node, "STARTUP_IMPORT_RESOLUTION");
      return;
    }
    if (isMigrationTarget(resolved)) {
      collector.addSource(sourceFile, node, "STARTUP_MIGRATION_REACHABILITY");
      return;
    }
    if (!traverse) return;

    const target = await repository.entry(resolved);
    if (
      target.state !== "ready" ||
      !target.stats.isFile() ||
      (await hasAmbiguousSibling(repository, resolved))
    ) {
      collector.addSource(sourceFile, node, "STARTUP_IMPORT_RESOLUTION");
      return;
    }
    queue.push(resolved);
  };

  const inspectSpecifier = async ({ sourceFile, node, specifier }) => {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      await inspectRelativeEdge({
        sourceFile,
        node,
        specifier,
        traverse: true,
      });
    } else if (!isValidPackageSpecifier(specifier)) {
      collector.addSource(sourceFile, node, "STARTUP_IMPORT_GRAMMAR");
    }
  };

  while (queue.length > 0) {
    const relativePath = queue.shift();
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const loaded = await repository.read(relativePath);
    if (loaded.text === null) {
      collector.addPath(relativePath, "STARTUP_IMPORT_RESOLUTION");
      continue;
    }
    const sourceFile = ts.createSourceFile(
      relativePath,
      loaded.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if (sourceFile.parseDiagnostics.length > 0) {
      for (const diagnostic of sourceFile.parseDiagnostics) {
        collector.addSource(sourceFile, diagnostic.start ?? 0, "STARTUP_PARSE");
      }
      continue;
    }

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          hasImportAttributes(statement)
        ) {
          collector.addSource(sourceFile, statement, "STARTUP_IMPORT_GRAMMAR");
        } else {
          await inspectSpecifier({
            sourceFile,
            node: statement.moduleSpecifier,
            specifier: statement.moduleSpecifier.text,
          });
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier
      ) {
        if (
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          hasImportAttributes(statement)
        ) {
          collector.addSource(sourceFile, statement, "STARTUP_IMPORT_GRAMMAR");
        } else {
          await inspectSpecifier({
            sourceFile,
            node: statement.moduleSpecifier,
            specifier: statement.moduleSpecifier.text,
          });
        }
      }
    }

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        collector.addSource(sourceFile, node, "STARTUP_UNSUPPORTED_LOADER");
        const [argument] = node.arguments;
        if (ts.isStringLiteral(argument)) {
          void inspectRelativeEdge({
            sourceFile,
            node: argument,
            specifier: argument.text,
            traverse: false,
          });
        }
      } else if (isUnsupportedLoaderNode(node)) {
        collector.addSource(sourceFile, node, "STARTUP_UNSUPPORTED_LOADER");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

export async function analyzeStartupGraph({ rootPath, fsAdapter } = {}) {
  const fs = fsAdapter ?? { lstat, readFile, readdir, realpath };
  if (
    typeof rootPath !== "string" ||
    rootPath.length === 0 ||
    typeof fs?.lstat !== "function" ||
    typeof fs?.readFile !== "function" ||
    typeof fs?.readdir !== "function" ||
    typeof fs?.realpath !== "function"
  ) {
    throw new TypeError("Invalid startup import analyzer input");
  }

  const repository = await createRepository(rootPath, fs);
  const collector = createFindingCollector();
  const rootValue = await readManifest(repository, collector, "package.json");
  const manifestPaths = await workspaceManifestPaths(
    repository,
    collector,
    rootValue,
  );
  const manifests = new Map();
  manifests.set("package.json", rootValue);
  for (const manifestPath of manifestPaths) {
    manifests.set(
      manifestPath,
      await readManifest(repository, collector, manifestPath),
    );
  }
  for (const [manifestPath, manifest] of manifests) {
    inspectManifestSurface(collector, manifestPath, manifest);
  }
  const controlValue = manifests.get(CONTROL_MANIFEST);
  inspectControlManifest(collector, controlValue);

  const protectedRoots = [];
  const inspectRoot = async (relativePath, required = false) => {
    const inspected = await repository.entry(relativePath);
    if (inspected.state === "ready" && inspected.stats.isFile()) {
      protectedRoots.push(relativePath);
      return true;
    }
    if (required || inspected.state !== "missing") {
      collector.addPath(relativePath, "STARTUP_IMPORT_RESOLUTION");
    }
    return false;
  };

  await inspectRoot(INDEX_PATH, true);
  const scripts = isObject(controlValue?.scripts) ? controlValue.scripts : {};
  for (const entry of OPTIONAL_ENTRIES) {
    const sourceExists = await inspectRoot(entry.path);
    const scriptExists = Object.hasOwn(scripts, entry.script);
    const scriptMatches = scripts[entry.script] === entry.command;
    if (sourceExists !== scriptExists || (scriptExists && !scriptMatches)) {
      collector.addPath(
        sourceExists || scriptExists ? CONTROL_MANIFEST : entry.path,
        "STARTUP_EXECUTABLE_SURFACE",
      );
    }
  }
  await inspectRoot(BUILD_APP_PATH);

  const source = await repository.entry(SOURCE_ROOT);
  if (source.state === "ready" && source.stats.isDirectory()) {
    await scanSourceTree(repository, collector, SOURCE_ROOT);
  } else {
    collector.addPath(SOURCE_ROOT, "STARTUP_IMPORT_RESOLUTION");
  }

  await analyzeGraph({
    repository,
    collector,
    roots: protectedRoots.sort(compareText),
  });

  return deepFreeze({
    protectedRoots: [...new Set(protectedRoots)].sort(compareText),
    findings: collector.findings.sort(compareFindings),
  });
}
