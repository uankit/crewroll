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
const CONTROL_INDIRECT = /@crewroll\/control-plane/u;
const INDIRECT_ENTRY = /(?:start:api|start:worker|db:migrate)/u;
const COMMAND_LOADER =
  /(?:^|[\s;&|])(?:node|tsx|npx|bun|sh|bash|zsh)(?:[\s;&|]|$)|(?:^|[\s;&|])npm\s+(?:exec|x)(?:[\s;&|]|$)|(?:^|[\s;&|])(?:pnpm|yarn)\s+dlx(?:[\s;&|]|$)|(?:^|[\s;&|])eval(?:[\s;&|]|$)/u;
const NPM_ENV_EXECUTABLE_REFERENCE =
  /(?:\$(?:npm_(?:node_)?execpath)|\$\{npm_(?:node_)?execpath\}|%npm_(?:node_)?execpath%|\$env:npm_(?:node_)?execpath)/iu;
const CONTROL_ENV_TARGET =
  /(?:\$(?:PWD|INIT_CWD)|\$\{(?:PWD|INIT_CWD)\}|%(?:CD|INIT_CWD)%|\$env:(?:PWD|INIT_CWD))\/(?:services\/control-plane\/)?(?:src|dist)\//iu;
const ROOT_ENV_CONTROL_TARGET =
  /(?:\$(?:PWD|INIT_CWD)|\$\{(?:PWD|INIT_CWD)\}|%(?:CD|INIT_CWD)%|\$env:(?:PWD|INIT_CWD))\/services\/control-plane\/(?:src|dist)\//iu;
const INERT_COMMANDS = new Set(["echo", "printf"]);
const ALLOWED_CONTROL_LOADER_SCRIPTS = new Map([
  [
    "build",
    "node ../../tools/clean-workspace-dist.mjs && tsc -p tsconfig.build.json",
  ],
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

function isUnsupportedLoaderNode(node) {
  if (
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

function splitCommandSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== null) {
      current += character;
      escaped = true;
    } else if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      current += character;
      quote = character;
    } else if (character === ";" || character === "&" || character === "|") {
      if (current.trim().length > 0) segments.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim().length > 0) segments.push(current);
  return segments;
}

function hasActiveCommandSubstitution(segment) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"') {
      quote = quote === '"' ? null : '"';
    } else if (character === "'") {
      quote = "'";
    } else if (
      character === "`" ||
      (character === "$" && segment[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function hasNpmEnvironmentControlLauncher(command, isControl) {
  const targetPattern = isControl
    ? CONTROL_ENV_TARGET
    : ROOT_ENV_CONTROL_TARGET;
  return splitCommandSegments(command).some((rawSegment) => {
    const segment = rawSegment
      .replace(/\\(?=["'])/gu, "")
      .replaceAll("\\", "/")
      .replace(/["']/gu, "");
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    let commandIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[commandIndex] ?? ""))
      commandIndex += 1;
    const commandName = path.posix
      .basename(tokens[commandIndex] ?? "")
      .replace(/^@/u, "")
      .toLowerCase();
    return (
      commandName.length > 0 &&
      (!INERT_COMMANDS.has(commandName) ||
        hasActiveCommandSubstitution(rawSegment)) &&
      NPM_ENV_EXECUTABLE_REFERENCE.test(tokens.join(" ")) &&
      targetPattern.test(tokens.join(" "))
    );
  });
}

function scriptIsSuspicious({ command, manifestPath, scriptName }) {
  if (typeof command !== "string") return false;
  const isControl = manifestPath === CONTROL_MANIFEST;
  if (
    isControl &&
    ((scriptName === "start:api" && command === "node dist/src/api/main.js") ||
      (scriptName === "start:worker" &&
        command === "node dist/src/worker/main.js") ||
      (scriptName === "db:migrate" && command === "tsx src/db/migrate.ts"))
  ) {
    return false;
  }
  if (
    !isControl &&
    (scriptName === "start:api" ||
      scriptName === "start:worker" ||
      command === "node dist/src/api/main.js" ||
      command === "node dist/src/worker/main.js")
  ) {
    return true;
  }
  if (hasNpmEnvironmentControlLauncher(command, isControl)) return true;
  if (isControl && CONTROL_TARGET.test(command)) return true;
  if (!isControl && ROOT_CONTROL_TARGET.test(command)) return true;
  if (CONTROL_INDIRECT.test(command) && INDIRECT_ENTRY.test(command))
    return true;
  if (isControl && INDIRECT_ENTRY.test(command)) return true;
  return (
    isControl &&
    COMMAND_LOADER.test(command) &&
    ALLOWED_CONTROL_LOADER_SCRIPTS.get(scriptName) !== command
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
      if (listed.entries === null) continue;
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
