import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FUTURE_SUITE_EXIT_CODES = Object.freeze({
  usage: 64,
  partial: 65,
  unavailable: 69,
  internal: 70,
  dormant: 78,
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const FUTURE_SUITE_DEFINITIONS = deepFreeze({
  integration: {
    suite: "integration",
    ownerTask: "DB-001",
    privateScript: "test:integration:run",
    privateCommand:
      "npm run build --workspace @crewroll/contracts && npm run build --workspace @crewroll/control-plane && vitest run --config tests/integration/vitest.config.ts",
    ownedRoot: "tests/integration",
    sentinel: "tests/integration/.crewroll-suite.json",
    fixedHarness: ["tests/integration/vitest.config.ts"],
    discoveredHarness: [{ under: "tests/integration", suffixes: [".test.ts"] }],
    activationArtifacts: [],
    passiveHarness: [],
  },
  "native-ios": {
    suite: "native-ios",
    ownerTask: "IOS-001",
    privateScript: "test:native:ios:run",
    privateCommand:
      "swift test --package-path modules/crewroll-transfer/ios --scratch-path .expo/crewroll-native-ios-tests",
    ownedRoot: "modules/crewroll-transfer/ios/Tests",
    sentinel: "modules/crewroll-transfer/ios/.crewroll-suite.json",
    fixedHarness: [],
    discoveredHarness: [
      {
        under: "modules/crewroll-transfer/ios/Tests",
        suffixes: [".swift"],
      },
    ],
    activationArtifacts: ["modules/crewroll-transfer/ios/Package.swift"],
    passiveHarness: [],
  },
  "native-android": {
    suite: "native-android",
    ownerTask: "AND-001",
    privateScript: "test:native:android:run",
    privateCommand: "node tools/run-android-native-tests.mjs",
    ownedRoot: "modules/crewroll-transfer/android/src/test",
    sentinel: "modules/crewroll-transfer/android/.crewroll-suite.json",
    fixedHarness: [],
    discoveredHarness: [
      {
        under: "modules/crewroll-transfer/android/src/test",
        suffixes: [".kt"],
      },
    ],
    activationArtifacts: ["tools/run-android-native-tests.mjs"],
    passiveHarness: ["modules/crewroll-transfer/android/build.gradle"],
  },
  e2e: {
    suite: "e2e",
    ownerTask: "WOW-001",
    privateScript: "test:e2e:run",
    privateCommand: "maestro test tests/maestro",
    ownedRoot: "tests/maestro",
    sentinel: "tests/maestro/.crewroll-suite.json",
    fixedHarness: [],
    discoveredHarness: [
      { under: "tests/maestro", suffixes: [".yaml", ".yml"] },
    ],
    activationArtifacts: [],
    passiveHarness: [],
  },
  load: {
    suite: "load",
    ownerTask: "REL-001",
    privateScript: "test:load:run",
    privateCommand: "k6 run tests/load/photo-flow.js",
    ownedRoot: "tests/load",
    sentinel: "tests/load/.crewroll-suite.json",
    fixedHarness: ["tests/load/photo-flow.js"],
    discoveredHarness: [],
    activationArtifacts: [],
    passiveHarness: [],
  },
});

const lexicalRepositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function resolveContainedPath(root, repositoryRelativePath) {
  if (
    typeof repositoryRelativePath !== "string" ||
    repositoryRelativePath === "" ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath.includes("\0")
  ) {
    throw new Error(
      "Future suite definition path must be repository-contained",
    );
  }

  const target = resolve(root, repositoryRelativePath);
  const distance = relative(root, target);
  if (
    distance === "" ||
    distance === ".." ||
    distance.startsWith(`..${sep}`) ||
    isAbsolute(distance)
  ) {
    throw new Error(
      "Future suite definition path escapes repository containment",
    );
  }

  return target;
}

for (const definition of Object.values(FUTURE_SUITE_DEFINITIONS)) {
  for (const path of [
    definition.ownedRoot,
    definition.sentinel,
    ...definition.fixedHarness,
    ...definition.activationArtifacts,
    ...definition.passiveHarness,
    ...definition.discoveredHarness.map(({ under }) => under),
  ]) {
    resolveContainedPath(lexicalRepositoryRoot, path);
  }
}

const canonicalRepositoryRootPromise = realpath(lexicalRepositoryRoot);

async function lstatResult(path) {
  try {
    return { kind: "present", stats: await lstat(path) };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

function toRepositoryPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

async function inspectRealAncestors(root, repositoryRelativePath) {
  const target = resolveContainedPath(root, repositoryRelativePath);
  const parts = relative(root, target).split(sep);
  let cursor = root;

  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    const result = await lstatResult(cursor);
    if (result.kind === "missing") return { kind: "missing", target };
    if (
      result.kind === "invalid" ||
      result.stats.isSymbolicLink() ||
      !result.stats.isDirectory()
    ) {
      return { kind: "invalid", target };
    }
  }

  return { kind: "valid", target };
}

async function scanOwnedRoot(root, repositoryRelativePath) {
  const ancestry = await inspectRealAncestors(root, repositoryRelativePath);
  if (ancestry.kind === "missing") {
    return { evidence: false, invalid: false, files: new Set() };
  }
  if (ancestry.kind === "invalid") {
    return { evidence: true, invalid: true, files: new Set() };
  }

  const rootResult = await lstatResult(ancestry.target);
  if (rootResult.kind === "missing") {
    return { evidence: false, invalid: false, files: new Set() };
  }
  if (
    rootResult.kind === "invalid" ||
    rootResult.stats.isSymbolicLink() ||
    !rootResult.stats.isDirectory()
  ) {
    return { evidence: true, invalid: true, files: new Set() };
  }

  const files = new Set();
  let invalid = false;

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      invalid = true;
      return;
    }

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry);
      const result = await lstatResult(absolutePath);
      if (result.kind !== "present" || result.stats.isSymbolicLink()) {
        invalid = true;
      } else if (result.stats.isDirectory()) {
        await visit(absolutePath);
      } else if (result.stats.isFile()) {
        files.add(toRepositoryPath(root, absolutePath));
      } else {
        invalid = true;
      }
    }
  }

  await visit(ancestry.target);
  return { evidence: true, invalid, files };
}

async function inspectArtifact(root, repositoryRelativePath) {
  const ancestry = await inspectRealAncestors(root, repositoryRelativePath);
  if (ancestry.kind === "missing") {
    return { evidence: false, invalid: false, regularFile: false };
  }
  if (ancestry.kind === "invalid") {
    return { evidence: true, invalid: true, regularFile: false };
  }

  const result = await lstatResult(ancestry.target);
  if (result.kind === "missing") {
    return { evidence: false, invalid: false, regularFile: false };
  }
  if (
    result.kind === "invalid" ||
    result.stats.isSymbolicLink() ||
    !result.stats.isFile()
  ) {
    return { evidence: true, invalid: true, regularFile: false };
  }

  return { evidence: true, invalid: false, regularFile: true };
}

async function readRootScripts(root) {
  const manifestPath = resolveContainedPath(root, "package.json");
  const result = await lstatResult(manifestPath);
  if (
    result.kind !== "present" ||
    result.stats.isSymbolicLink() ||
    !result.stats.isFile()
  ) {
    return { valid: false, scripts: {} };
  }

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      (manifest.scripts !== undefined &&
        (manifest.scripts === null ||
          typeof manifest.scripts !== "object" ||
          Array.isArray(manifest.scripts)))
    ) {
      return { valid: false, scripts: {} };
    }

    return { valid: true, scripts: manifest.scripts ?? {} };
  } catch {
    return { valid: false, scripts: {} };
  }
}

function isExactSentinel(value, definition) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value).sort();
  return (
    keys.length === 3 &&
    keys[0] === "ownerTask" &&
    keys[1] === "schemaVersion" &&
    keys[2] === "suite" &&
    value.schemaVersion === 1 &&
    value.suite === definition.suite &&
    value.ownerTask === definition.ownerTask
  );
}

async function hasExactSentinel(root, sentinelArtifact, definition) {
  if (!sentinelArtifact.regularFile) return false;
  try {
    const value = JSON.parse(
      await readFile(resolveContainedPath(root, definition.sentinel), "utf8"),
    );
    return isExactSentinel(value, definition);
  } catch {
    return false;
  }
}

function hasCompleteHarness(
  files,
  activationArtifacts,
  passiveHarness,
  definition,
) {
  for (const path of definition.fixedHarness) {
    if (!files.has(path)) return false;
  }

  for (const path of definition.activationArtifacts) {
    if (!activationArtifacts.get(path)?.regularFile) return false;
  }

  for (const path of definition.passiveHarness) {
    if (!passiveHarness.get(path)?.regularFile) return false;
  }

  for (const discovery of definition.discoveredHarness) {
    const prefix = `${discovery.under}/`;
    const found = [...files].some(
      (path) =>
        path.startsWith(prefix) &&
        discovery.suffixes.some((suffix) => path.endsWith(suffix)),
    );
    if (!found) return false;
  }

  return true;
}

export function getFutureSuiteDefinition(suite) {
  return Object.hasOwn(FUTURE_SUITE_DEFINITIONS, suite)
    ? FUTURE_SUITE_DEFINITIONS[suite]
    : undefined;
}

export async function classifyFutureSuiteRepository(suite) {
  const definition = getFutureSuiteDefinition(suite);
  if (!definition) throw new Error("Unknown future suite policy definition");

  const root = await canonicalRepositoryRootPromise;
  const manifest = await readRootScripts(root);
  const preHook = `pre${definition.privateScript}`;
  const postHook = `post${definition.privateScript}`;
  const hasPrivateScript = Object.hasOwn(
    manifest.scripts,
    definition.privateScript,
  );
  const hasPreHook = Object.hasOwn(manifest.scripts, preHook);
  const hasPostHook = Object.hasOwn(manifest.scripts, postHook);
  const manifestEvidence = hasPrivateScript || hasPreHook || hasPostHook;

  const ownedRoot = await scanOwnedRoot(root, definition.ownedRoot);
  const sentinelArtifact = await inspectArtifact(root, definition.sentinel);
  const activationArtifacts = new Map();
  for (const path of definition.activationArtifacts) {
    activationArtifacts.set(path, await inspectArtifact(root, path));
  }
  const passiveHarness = new Map();
  for (const path of definition.passiveHarness) {
    passiveHarness.set(path, await inspectArtifact(root, path));
  }

  const filesystemEvidence =
    ownedRoot.evidence ||
    sentinelArtifact.evidence ||
    [...activationArtifacts.values()].some(({ evidence }) => evidence);

  if (manifest.valid && !manifestEvidence && !filesystemEvidence) {
    return {
      state: "dormant",
      suite: definition.suite,
      ownerTask: definition.ownerTask,
      contractClasses: [],
      root,
    };
  }

  const exactPrivateScript =
    hasPrivateScript &&
    manifest.scripts[definition.privateScript] === definition.privateCommand;
  const sentinelExact = await hasExactSentinel(
    root,
    sentinelArtifact,
    definition,
  );
  const harnessComplete = hasCompleteHarness(
    ownedRoot.files,
    activationArtifacts,
    passiveHarness,
    definition,
  );
  const invalidEvidence =
    ownedRoot.invalid ||
    sentinelArtifact.invalid ||
    [...activationArtifacts.values()].some(({ invalid }) => invalid);
  const invalidHarness = [...passiveHarness.values()].some(
    ({ invalid }) => invalid,
  );

  if (
    manifest.valid &&
    exactPrivateScript &&
    !hasPreHook &&
    !hasPostHook &&
    ownedRoot.evidence &&
    !invalidEvidence &&
    !invalidHarness &&
    sentinelExact &&
    harnessComplete
  ) {
    return {
      state: "active",
      suite: definition.suite,
      ownerTask: definition.ownerTask,
      contractClasses: [],
      root,
    };
  }

  const contractClasses = new Set();
  if (!manifest.valid || !exactPrivateScript) contractClasses.add("manifest");
  if (hasPreHook || hasPostHook) contractClasses.add("lifecycle");
  if (!ownedRoot.evidence || invalidEvidence) contractClasses.add("evidence");
  if (!sentinelExact) contractClasses.add("sentinel");
  if (!harnessComplete || invalidHarness) contractClasses.add("harness");

  return {
    state: "partial",
    suite: definition.suite,
    ownerTask: definition.ownerTask,
    contractClasses: [...contractClasses],
    root,
  };
}
