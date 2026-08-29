import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FUTURE_SUITE_DEFINITIONS,
  FUTURE_SUITE_EXIT_CODES,
} from "./future-suite-policy.mjs";
import { dispatchFutureSuite } from "./run-future-suite.mjs";

const expectedSuites = [
  {
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
  {
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
  {
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
  {
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
  {
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
];

const discoveredFixturePaths = {
  integration: "tests/integration/photo-flow.test.ts",
  "native-ios":
    "modules/crewroll-transfer/ios/Tests/CrewRollTests/TransferTests.swift",
  "native-android":
    "modules/crewroll-transfer/android/src/test/kotlin/TransferTest.kt",
  e2e: "tests/maestro/photo-flow.yaml",
};

const expectedExitCodes = {
  usage: 64,
  partial: 65,
  unavailable: 69,
  internal: 70,
  dormant: 78,
};

const sourcePolicyPath = fileURLToPath(
  new URL("future-suite-policy.mjs", import.meta.url),
);
const sourceRunnerPath = fileURLToPath(
  new URL("run-future-suite.mjs", import.meta.url),
);
const checkoutRoot = await realpath(
  fileURLToPath(new URL("../", import.meta.url)),
);

function sentinelValue(definition) {
  return {
    schemaVersion: 1,
    suite: definition.suite,
    ownerTask: definition.ownerTask,
  };
}

function privateHooks(definition) {
  return [`pre${definition.privateScript}`, `post${definition.privateScript}`];
}

async function writeFixtureFile(root, path, contents = "fixture\n") {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function writeManifest(root, scripts = {}) {
  await writeFixtureFile(
    root,
    "package.json",
    `${JSON.stringify({ name: "crewroll-policy-fixture", private: true, scripts }, null, 2)}\n`,
  );
}

async function makeRepositoryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "crewroll-future-suite-"));
  const canonicalRoot = await realpath(root);
  const toolsRoot = join(canonicalRoot, "tools");
  const rootDistance = relative(checkoutRoot, canonicalRoot);

  assert.ok(
    rootDistance === ".." ||
      rootDistance.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    "behavior fixtures must stay outside the real checkout",
  );

  await mkdir(toolsRoot, { recursive: true });
  await copyFile(sourcePolicyPath, join(toolsRoot, "future-suite-policy.mjs"));
  await copyFile(sourceRunnerPath, join(toolsRoot, "run-future-suite.mjs"));
  await writeManifest(canonicalRoot);

  t.after(async () => {
    await rm(canonicalRoot, { recursive: true, force: true });
  });

  const cacheKey = `${Date.now()}-${Math.random()}`;
  const policy = await import(
    `${pathToFileURL(join(toolsRoot, "future-suite-policy.mjs")).href}?${cacheKey}`
  );
  const runner = await import(
    `${pathToFileURL(join(toolsRoot, "run-future-suite.mjs")).href}?${cacheKey}`
  );

  return { root: canonicalRoot, policy, runner };
}

async function clearSuiteEvidence(root, definition) {
  const paths = new Set([
    definition.ownedRoot,
    definition.sentinel,
    ...definition.fixedHarness,
    ...definition.activationArtifacts,
    ...definition.passiveHarness,
  ]);
  for (const path of paths) {
    await rm(join(root, path), { recursive: true, force: true });
  }
}

async function writeSentinel(
  root,
  definition,
  value = sentinelValue(definition),
) {
  await writeFixtureFile(
    root,
    definition.sentinel,
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
  );
}

async function writeCompleteHarness(root, definition) {
  switch (definition.suite) {
    case "integration":
      await writeFixtureFile(
        root,
        "tests/integration/vitest.config.ts",
        "export default {};\n",
      );
      await writeFixtureFile(
        root,
        "tests/integration/photo-flow.test.ts",
        "export {};\n",
      );
      break;
    case "native-ios":
      await writeFixtureFile(
        root,
        "modules/crewroll-transfer/ios/Package.swift",
        "// swift-tools-version: 6.0\n",
      );
      await writeFixtureFile(
        root,
        "modules/crewroll-transfer/ios/Tests/CrewRollTests/TransferTests.swift",
        "import Testing\n",
      );
      break;
    case "native-android":
      await writeFixtureFile(
        root,
        "modules/crewroll-transfer/android/build.gradle",
        "plugins {}\n",
      );
      await writeFixtureFile(
        root,
        "modules/crewroll-transfer/android/src/test/kotlin/TransferTest.kt",
        "class TransferTest\n",
      );
      await writeFixtureFile(
        root,
        "tools/run-android-native-tests.mjs",
        "process.exitCode = 0;\n",
      );
      break;
    case "e2e":
      await writeFixtureFile(
        root,
        "tests/maestro/photo-flow.yaml",
        "appId: com.uankit53.airmesh\n---\n",
      );
      break;
    case "load":
      await writeFixtureFile(
        root,
        "tests/load/photo-flow.js",
        "export default function () {}\n",
      );
      break;
    default:
      assert.fail(`Unknown fixture suite ${definition.suite}`);
  }
}

async function writeHarnessFragment(root, definition) {
  switch (definition.suite) {
    case "integration":
      await writeFixtureFile(
        root,
        "tests/integration/vitest.config.ts",
        "export default {};\n",
      );
      break;
    case "native-ios":
      await writeFixtureFile(
        root,
        "modules/crewroll-transfer/ios/Package.swift",
        "// swift-tools-version: 6.0\n",
      );
      break;
    case "native-android":
      await writeFixtureFile(
        root,
        "tools/run-android-native-tests.mjs",
        "process.exitCode = 0;\n",
      );
      break;
    case "e2e":
      await writeFixtureFile(
        root,
        "tests/maestro/photo-flow.yaml",
        "appId: fixture\n",
      );
      break;
    case "load":
      await writeFixtureFile(
        root,
        "tests/load/photo-flow.js",
        "export default function () {}\n",
      );
      break;
    default:
      assert.fail(`Unknown fixture suite ${definition.suite}`);
  }
}

async function writeIncompleteHarness(root, definition) {
  if (
    ["integration", "native-ios", "native-android"].includes(definition.suite)
  ) {
    await writeHarnessFragment(root, definition);
    return;
  }

  await writeFixtureFile(
    root,
    `${definition.ownedRoot}/notes.txt`,
    "incomplete\n",
  );
}

async function applyFilesystemState(root, definition, state) {
  await clearSuiteEvidence(root, definition);

  switch (state) {
    case "none":
      return;
    case "empty-root":
      await mkdir(join(root, definition.ownedRoot), { recursive: true });
      return;
    case "sentinel-no-harness":
      await writeSentinel(root, definition);
      return;
    case "fragment-no-sentinel":
      await writeHarnessFragment(root, definition);
      return;
    case "complete-no-sentinel":
      await writeCompleteHarness(root, definition);
      return;
    case "sentinel-incomplete":
      await writeSentinel(root, definition);
      await writeIncompleteHarness(root, definition);
      return;
    case "complete":
      await writeSentinel(root, definition);
      await writeCompleteHarness(root, definition);
      return;
    default:
      assert.fail(`Unknown filesystem fixture state ${state}`);
  }
}

function manifestStates(definition) {
  const [preHook, postHook] = privateHooks(definition);
  const scriptStates = [
    { label: "no-script", value: undefined },
    { label: "exact-script", value: definition.privateCommand },
    {
      label: "mutated-script",
      value: `${definition.privateCommand} --mutated`,
    },
  ];
  const hookStates = [
    { label: "no-hooks", hooks: [] },
    { label: "pre-hook", hooks: [preHook] },
    { label: "post-hook", hooks: [postHook] },
    { label: "both-hooks", hooks: [preHook, postHook] },
  ];

  return scriptStates.flatMap((scriptState) =>
    hookStates.map((hookState) => {
      const scripts = {};
      if (scriptState.value !== undefined) {
        scripts[definition.privateScript] = scriptState.value;
      }
      for (const hook of hookState.hooks) scripts[hook] = "forbidden hook";

      return {
        label: `${scriptState.label}/${hookState.label}`,
        scripts,
        exact:
          scriptState.label === "exact-script" &&
          hookState.label === "no-hooks",
        empty:
          scriptState.label === "no-script" && hookState.label === "no-hooks",
      };
    }),
  );
}

function successResult() {
  return { status: 0, signal: null };
}

function makeRunOptions(definition, root, overrides = {}) {
  const env = {
    npm_execpath: join(root, "toolchain/npm-cli.js"),
    CREWROLL_STAGING_URL: "https://staging.invalid",
    CREWROLL_LOAD_AUTH_FIXTURE: "never-log-this-auth-fixture",
    ...overrides.env,
  };

  if (
    definition.suite === "native-android" &&
    !Object.hasOwn(overrides.env ?? {}, "ANDROID_HOME") &&
    !Object.hasOwn(overrides.env ?? {}, "ANDROID_SDK_ROOT")
  ) {
    env.ANDROID_HOME = join(root, "android-sdk");
  }

  return {
    args: [definition.suite],
    env,
    platform:
      overrides.platform ??
      (definition.suite === "native-ios" ? "darwin" : process.platform),
    probe: overrides.probe ?? (() => successResult()),
    spawn: overrides.spawn ?? (() => successResult()),
    stderr: overrides.stderr ?? (() => {}),
  };
}

async function activateSuite(root, definition) {
  await writeManifest(root, {
    [definition.privateScript]: definition.privateCommand,
  });
  await applyFilesystemState(root, definition, "complete");
  if (definition.suite === "native-android") {
    await mkdir(join(root, "android-sdk"), { recursive: true });
  }
}

test("publishes the five frozen suite contracts and stable exit codes", () => {
  assert.deepEqual(FUTURE_SUITE_EXIT_CODES, expectedExitCodes);
  assert.equal(Object.isFrozen(FUTURE_SUITE_EXIT_CODES), true);
  assert.equal(Object.isFrozen(FUTURE_SUITE_DEFINITIONS), true);

  assert.deepEqual(Object.values(FUTURE_SUITE_DEFINITIONS), expectedSuites);

  for (const definition of Object.values(FUTURE_SUITE_DEFINITIONS)) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.fixedHarness), true);
    assert.equal(Object.isFrozen(definition.discoveredHarness), true);
    assert.equal(Object.isFrozen(definition.activationArtifacts), true);
    assert.equal(Object.isFrozen(definition.passiveHarness), true);
    for (const discovery of definition.discoveredHarness) {
      assert.equal(Object.isFrozen(discovery), true);
      assert.equal(Object.isFrozen(discovery.suffixes), true);
    }
  }
});

test("removing any required sentinel or harness artifact makes an otherwise complete suite partial", async (t) => {
  for (const definition of expectedSuites) {
    const requiredPaths = [
      definition.sentinel,
      ...definition.fixedHarness,
      ...definition.activationArtifacts,
      ...definition.passiveHarness,
    ];
    const discoveredPath = discoveredFixturePaths[definition.suite];
    if (discoveredPath) requiredPaths.push(discoveredPath);

    for (const requiredPath of requiredPaths) {
      await t.test(`${definition.suite}/${requiredPath}`, async (suiteTest) => {
        const fixture = await makeRepositoryFixture(suiteTest);
        await activateSuite(fixture.root, definition);
        assert.equal(
          (await fixture.policy.classifyFutureSuiteRepository(definition.suite))
            .state,
          "active",
          "complete fixture precondition",
        );

        await rm(join(fixture.root, requiredPath), {
          recursive: true,
          force: true,
        });
        const result = await fixture.policy.classifyFutureSuiteRepository(
          definition.suite,
        );
        assert.equal(result.state, "partial", requiredPath);
      });
    }
  }
});

test("all five suites are dormant in isolated clean repositories", async (t) => {
  const fixture = await makeRepositoryFixture(t);

  for (const definition of expectedSuites) {
    const result = await fixture.policy.classifyFutureSuiteRepository(
      definition.suite,
    );
    assert.equal(result.state, "dormant", definition.suite);
    assert.deepEqual(result.contractClasses, [], definition.suite);
  }
});

test("NAT production native parents and passive Android build files do not activate test suites", async (t) => {
  const fixture = await makeRepositoryFixture(t);

  await writeFixtureFile(
    fixture.root,
    "modules/crewroll-transfer/ios/Sources/CrewRollTransfer.swift",
    "public struct CrewRollTransfer {}\n",
  );
  await writeFixtureFile(
    fixture.root,
    "modules/crewroll-transfer/ios/CrewRollTransfer.podspec",
    "Pod::Spec.new do |spec|\nend\n",
  );
  await mkdir(
    join(fixture.root, "modules/crewroll-transfer/ios/.build/products"),
    { recursive: true },
  );
  await symlink(
    "products",
    join(fixture.root, "modules/crewroll-transfer/ios/.build/debug"),
  );
  await writeFixtureFile(
    fixture.root,
    "modules/crewroll-transfer/android/build.gradle",
    "plugins {}\n",
  );
  await writeFixtureFile(
    fixture.root,
    "modules/crewroll-transfer/android/src/main/AndroidManifest.xml",
    "<manifest />\n",
  );
  await writeFixtureFile(
    fixture.root,
    "modules/crewroll-transfer/android/src/main/kotlin/CrewRollTransfer.kt",
    "class CrewRollTransfer\n",
  );

  for (const suite of ["native-ios", "native-android"]) {
    const result = await fixture.policy.classifyFutureSuiteRepository(suite);
    assert.equal(result.state, "dormant", suite);
  }
});

test("every realizable ancestor-closed manifest/filesystem cross-product fails partial except dormant and exact active", async (t) => {
  const filesystemStates = [
    "none",
    "empty-root",
    "sentinel-no-harness",
    "fragment-no-sentinel",
    "complete-no-sentinel",
    "sentinel-incomplete",
    "complete",
  ];

  for (const definition of expectedSuites) {
    await t.test(definition.suite, async (suiteTest) => {
      const fixture = await makeRepositoryFixture(suiteTest);
      let dormantCount = 0;
      let activeCount = 0;
      let partialCount = 0;

      for (const manifestState of manifestStates(definition)) {
        for (const filesystemState of filesystemStates) {
          await writeManifest(fixture.root, manifestState.scripts);
          await applyFilesystemState(fixture.root, definition, filesystemState);

          const result = await fixture.policy.classifyFutureSuiteRepository(
            definition.suite,
          );
          const label = `${manifestState.label}/${filesystemState}`;

          if (manifestState.empty && filesystemState === "none") {
            assert.equal(result.state, "dormant", label);
            dormantCount += 1;
          } else if (manifestState.exact && filesystemState === "complete") {
            assert.equal(result.state, "active", label);
            activeCount += 1;
          } else {
            assert.equal(result.state, "partial", label);
            assert.ok(result.contractClasses.length > 0, label);
            partialCount += 1;
          }
        }
      }

      assert.equal(dormantCount, 1);
      assert.equal(activeCount, 1);
      assert.equal(partialCount, manifestStates(definition).length * 7 - 2);
    });
  }
});

test("malformed sentinels, non-regular evidence, and symlinked evidence fail partial", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[0];
  const sentinelVariants = [
    {
      label: "missing key",
      value: { schemaVersion: 1, suite: definition.suite },
    },
    {
      label: "extra key",
      value: { ...sentinelValue(definition), status: "active" },
    },
    {
      label: "wrong version",
      value: { ...sentinelValue(definition), schemaVersion: 2 },
    },
    {
      label: "wrong suite",
      value: { ...sentinelValue(definition), suite: "load" },
    },
    {
      label: "wrong owner",
      value: { ...sentinelValue(definition), ownerTask: "FND-002" },
    },
    { label: "invalid JSON", value: "{not-json\n" },
  ];

  await writeManifest(fixture.root, {
    [definition.privateScript]: definition.privateCommand,
  });

  for (const { label, value } of sentinelVariants) {
    await applyFilesystemState(fixture.root, definition, "complete");
    await writeSentinel(fixture.root, definition, value);
    const result = await fixture.policy.classifyFutureSuiteRepository(
      definition.suite,
    );
    assert.equal(result.state, "partial", label);
    assert.ok(result.contractClasses.includes("sentinel"), label);
  }

  await clearSuiteEvidence(fixture.root, definition);
  await mkdir(join(fixture.root, definition.sentinel), { recursive: true });
  assert.equal(
    (await fixture.policy.classifyFutureSuiteRepository(definition.suite))
      .state,
    "partial",
    "directory sentinel",
  );

  await applyFilesystemState(fixture.root, definition, "complete");
  await rm(join(fixture.root, "tests/integration/vitest.config.ts"));
  await mkdir(join(fixture.root, "tests/integration/vitest.config.ts"));
  assert.equal(
    (await fixture.policy.classifyFutureSuiteRepository(definition.suite))
      .state,
    "partial",
    "non-regular harness file",
  );

  const outside = await mkdtemp(join(tmpdir(), "crewroll-suite-symlink-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFixtureFile(
    outside,
    "sentinel.json",
    `${JSON.stringify(sentinelValue(definition))}\n`,
  );
  await applyFilesystemState(fixture.root, definition, "complete");
  await rm(join(fixture.root, definition.sentinel));
  await symlink(
    join(outside, "sentinel.json"),
    join(fixture.root, definition.sentinel),
  );
  assert.equal(
    (await fixture.policy.classifyFutureSuiteRepository(definition.suite))
      .state,
    "partial",
    "symlinked evidence file",
  );

  await applyFilesystemState(fixture.root, definition, "complete");
  await mkdir(join(outside, "linked-directory"), { recursive: true });
  await symlink(
    join(outside, "linked-directory"),
    join(fixture.root, definition.ownedRoot, "linked-directory"),
  );
  assert.equal(
    (await fixture.policy.classifyFutureSuiteRepository(definition.suite))
      .state,
    "partial",
    "recursive symlink directory",
  );
});

test("symlinked repository-relative ancestors fail partial without traversal", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[0];
  const outside = await mkdtemp(join(tmpdir(), "crewroll-suite-ancestor-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  await writeManifest(fixture.root, {
    [definition.privateScript]: definition.privateCommand,
  });
  await mkdir(join(outside, "tests/integration"), { recursive: true });
  await symlink(join(outside, "tests"), join(fixture.root, "tests"));
  await writeSentinel(fixture.root, definition);
  await writeCompleteHarness(fixture.root, definition);

  const result = await fixture.policy.classifyFutureSuiteRepository(
    definition.suite,
  );
  assert.equal(result.state, "partial");
  assert.ok(result.contractClasses.includes("evidence"));
});

test("fixed repository definitions reject lexical escape before filesystem access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crewroll-suite-escape-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tools"), { recursive: true });

  const source = await readFile(sourcePolicyPath, "utf8");
  const mutated = source.replace(
    '"tests/load/photo-flow.js"',
    '"../outside-photo-flow.js"',
  );
  assert.notEqual(mutated, source);
  await writeFixtureFile(root, "tools/future-suite-policy.mjs", mutated);

  await assert.rejects(
    import(
      `${pathToFileURL(join(root, "tools/future-suite-policy.mjs")).href}?escape`
    ),
    /escape|contain/u,
  );
});

test("invalid CLI arguments return usage before repository or tool inspection", async () => {
  const forbiddenAdapter = () => {
    throw new Error("adapter must not run");
  };

  for (const args of [
    [],
    ["unknown"],
    ["toString"],
    ["__proto__"],
    ["constructor"],
    ["integration", "--watch"],
  ]) {
    const messages = [];
    const status = await dispatchFutureSuite({
      args,
      env: {},
      platform: "linux",
      probe: forbiddenAdapter,
      spawn: forbiddenAdapter,
      stderr: (message) => messages.push(message),
    });

    assert.equal(status, 64, JSON.stringify(args));
    assert.equal(messages.length, 1, JSON.stringify(args));
    assert.doesNotMatch(messages[0], /adapter must not run/u);
  }
});

test("dormant suites classify before host, tools, and environment", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const forbiddenAdapter = () => {
    throw new Error("inactive suite inspected a tool");
  };

  for (const definition of expectedSuites) {
    const messages = [];
    const status = await fixture.runner.dispatchFutureSuite({
      args: [definition.suite],
      env: {},
      platform: definition.suite === "native-ios" ? "linux" : process.platform,
      probe: forbiddenAdapter,
      spawn: forbiddenAdapter,
      stderr: (message) => messages.push(message),
    });

    assert.equal(status, 78, definition.suite);
    assert.equal(messages.length, 1, definition.suite);
    assert.match(messages[0], new RegExp(definition.suite, "u"));
    assert.match(messages[0], new RegExp(definition.ownerTask, "u"));
    assert.match(messages[0], /dormant/u);
    assert.match(messages[0], /has not activated the complete harness/u);
    assert.doesNotMatch(messages[0], /PASS|skipped successfully|optional/u);
  }
});

test("partial suites never perform availability probes or spawn npm", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[4];
  const messages = [];
  const forbiddenAdapter = () => {
    throw new Error("partial suite inspected a tool");
  };

  await writeManifest(fixture.root, {
    [definition.privateScript]: definition.privateCommand,
  });

  const status = await fixture.runner.dispatchFutureSuite({
    args: [definition.suite],
    env: {},
    platform: "linux",
    probe: forbiddenAdapter,
    spawn: forbiddenAdapter,
    stderr: (message) => messages.push(message),
  });

  assert.equal(status, 65);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /load.*partial.*REL-001/u);
  assert.match(messages[0], /sentinel|harness|evidence/u);
  assert.doesNotMatch(messages[0], /partial suite inspected a tool/u);
});

test("every exact active contract reaches suite-specific availability checks", async (t) => {
  for (const definition of expectedSuites) {
    await t.test(definition.suite, async (suiteTest) => {
      const fixture = await makeRepositoryFixture(suiteTest);
      const probes = [];
      const spawns = [];
      await activateSuite(fixture.root, definition);

      const status = await fixture.runner.dispatchFutureSuite(
        makeRunOptions(definition, fixture.root, {
          probe: (executable, args, options) => {
            probes.push({ executable, args, options });
            return successResult();
          },
          spawn: (executable, args, options) => {
            spawns.push({ executable, args, options });
            return successResult();
          },
        }),
      );

      assert.equal(status, 0);
      assert.ok(probes.length >= 2);
      assert.equal(spawns.length, 1);
      for (const probe of probes) {
        assert.equal(probe.options.cwd, fixture.root);
        assert.equal(probe.options.shell, false);
        assert.equal(probe.options.stdio, "ignore");
        assert.equal(probe.options.windowsHide, true);
      }
    });
  }
});

test("two native-iOS runs keep SwiftPM output in the external scratch path and remain active", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[1];
  const packageBuild = join(
    fixture.root,
    "modules/crewroll-transfer/ios/.build",
  );
  const scratchRoot = join(fixture.root, ".expo/crewroll-native-ios-tests");
  await activateSuite(fixture.root, definition);

  const faithfulSwiftSpawn = async () => {
    const manifest = JSON.parse(
      await readFile(join(fixture.root, "package.json"), "utf8"),
    );
    const command = manifest.scripts[definition.privateScript];
    const scratchMatch = command.match(/--scratch-path\s+([^\s]+)/u);
    const outputRoot = scratchMatch
      ? join(fixture.root, scratchMatch[1])
      : packageBuild;
    await mkdir(join(outputRoot, "debug-target"), { recursive: true });
    await rm(join(outputRoot, "debug"), { force: true });
    await symlink("debug-target", join(outputRoot, "debug"));
    return successResult();
  };

  const statuses = [];
  for (let run = 0; run < 2; run += 1) {
    statuses.push(
      await fixture.runner.dispatchFutureSuite(
        makeRunOptions(definition, fixture.root, {
          spawn: faithfulSwiftSpawn,
        }),
      ),
    );
  }

  assert.deepEqual(statuses, [0, 0]);
  await assert.rejects(lstat(packageBuild), { code: "ENOENT" });
  assert.equal(
    (await lstat(join(scratchRoot, "debug"))).isSymbolicLink(),
    true,
  );
});

test("active suites reject missing required host, tool, SDK, and load environment without spawning", async (t) => {
  for (const definition of expectedSuites) {
    await t.test(definition.suite, async (suiteTest) => {
      const fixture = await makeRepositoryFixture(suiteTest);
      await activateSuite(fixture.root, definition);
      let finalSpawns = 0;
      const spawn = () => {
        finalSpawns += 1;
        return successResult();
      };

      const missingNpm = await fixture.runner.dispatchFutureSuite(
        makeRunOptions(definition, fixture.root, {
          env: { npm_execpath: "" },
          spawn,
        }),
      );
      assert.equal(missingNpm, 69, "npm_execpath");

      if (definition.suite === "integration") {
        let call = 0;
        const status = await fixture.runner.dispatchFutureSuite(
          makeRunOptions(definition, fixture.root, {
            probe: () => {
              call += 1;
              return call === 2 ? { status: 1, signal: null } : successResult();
            },
            spawn,
          }),
        );
        assert.equal(status, 69, "repository-local Vitest");
      }

      if (definition.suite === "native-ios") {
        assert.equal(
          await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              platform: "linux",
              spawn,
            }),
          ),
          69,
          "Darwin host",
        );

        for (const failedProbe of [2, 3]) {
          let call = 0;
          const status = await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              probe: () => {
                call += 1;
                return call === failedProbe
                  ? { status: 1, signal: null }
                  : successResult();
              },
              spawn,
            }),
          );
          assert.equal(status, 69, failedProbe === 2 ? "Swift" : "Xcode");
        }
      }

      if (definition.suite === "native-android") {
        let call = 0;
        assert.equal(
          await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              probe: () => {
                call += 1;
                return call === 2
                  ? { status: 1, signal: null }
                  : successResult();
              },
              spawn,
            }),
          ),
          69,
          "Java",
        );

        assert.equal(
          await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              env: { ANDROID_HOME: "", ANDROID_SDK_ROOT: "" },
              spawn,
            }),
          ),
          69,
          "Android SDK environment",
        );

        assert.equal(
          await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              env: {
                ANDROID_HOME: join(fixture.root, "missing-android-sdk"),
              },
              spawn,
            }),
          ),
          69,
          "Android SDK directory",
        );
      }

      if (definition.suite === "e2e") {
        let call = 0;
        assert.equal(
          await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              probe: () => {
                call += 1;
                return call === 2
                  ? { status: 1, signal: null }
                  : successResult();
              },
              spawn,
            }),
          ),
          69,
          "Maestro",
        );
      }

      if (definition.suite === "load") {
        for (const name of [
          "CREWROLL_STAGING_URL",
          "CREWROLL_LOAD_AUTH_FIXTURE",
        ]) {
          assert.equal(
            await fixture.runner.dispatchFutureSuite(
              makeRunOptions(definition, fixture.root, {
                env: { [name]: "" },
                spawn,
              }),
            ),
            69,
            name,
          );
        }

        let call = 0;
        assert.equal(
          await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              probe: () => {
                call += 1;
                return call === 2
                  ? { status: 1, signal: null }
                  : successResult();
              },
              spawn,
            }),
          ),
          69,
          "k6",
        );
      }

      assert.equal(finalSpawns, 0);
    });
  }
});

test("expected availability probe failures map to unavailable while unexpected errors map to sanitized internal", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[0];
  await activateSuite(fixture.root, definition);

  const expectedFailures = [
    {
      label: "returned ENOENT",
      probe: () => ({
        status: null,
        signal: null,
        error: Object.assign(new Error("private-value"), { code: "ENOENT" }),
      }),
    },
    {
      label: "thrown ENOENT",
      probe: () => {
        throw Object.assign(new Error("private-value"), { code: "ENOENT" });
      },
    },
    {
      label: "numeric nonzero",
      probe: () => ({ status: 9, signal: null }),
    },
    {
      label: "null status",
      probe: () => ({ status: null, signal: null }),
    },
    {
      label: "signal",
      probe: () => ({ status: null, signal: "SIGTERM" }),
    },
  ];

  for (const { label, probe } of expectedFailures) {
    let spawns = 0;
    const messages = [];
    const status = await fixture.runner.dispatchFutureSuite(
      makeRunOptions(definition, fixture.root, {
        probe,
        spawn: () => {
          spawns += 1;
          return successResult();
        },
        stderr: (message) => messages.push(message),
      }),
    );
    assert.equal(status, 69, label);
    assert.equal(spawns, 0, label);
    assert.doesNotMatch(messages.join("\n"), /private-value/u, label);
  }

  const unexpectedFailures = [
    {
      label: "returned non-ENOENT error wins over null",
      probe: () => ({
        status: null,
        signal: null,
        error: Object.assign(new Error("private-value"), { code: "EACCES" }),
      }),
    },
    {
      label: "unexpected thrown error",
      probe: () => {
        throw Object.assign(new Error("private-value"), { code: "EACCES" });
      },
    },
  ];

  for (const { label, probe } of unexpectedFailures) {
    let spawns = 0;
    const messages = [];
    const status = await fixture.runner.dispatchFutureSuite(
      makeRunOptions(definition, fixture.root, {
        probe,
        spawn: () => {
          spawns += 1;
          return successResult();
        },
        stderr: (message) => messages.push(message),
      }),
    );
    assert.equal(status, 70, label);
    assert.equal(spawns, 0, label);
    assert.doesNotMatch(messages.join("\n"), /private-value|EACCES/u, label);
  }
});

test("toolchain symlinks are accepted because repository anti-symlink policy does not inspect tools", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[0];
  await activateSuite(fixture.root, definition);
  await writeFixtureFile(
    fixture.root,
    "toolchain/npm-target.js",
    "process.exitCode = 0;\n",
  );
  await symlink(
    join(fixture.root, "toolchain/npm-target.js"),
    join(fixture.root, "toolchain/npm-link.js"),
  );

  const options = makeRunOptions(definition, fixture.root, {
    env: { npm_execpath: join(fixture.root, "toolchain/npm-link.js") },
  });
  assert.equal(await fixture.runner.dispatchFutureSuite(options), 0);
});

test("Android accepts either configured SDK variable when it names an existing directory", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[2];
  const validSdkRoot = join(fixture.root, "alternate-android-sdk");
  await activateSuite(fixture.root, definition);
  await mkdir(validSdkRoot, { recursive: true });

  const status = await fixture.runner.dispatchFutureSuite(
    makeRunOptions(definition, fixture.root, {
      env: {
        ANDROID_HOME: join(fixture.root, "missing-android-home"),
        ANDROID_SDK_ROOT: validSdkRoot,
      },
    }),
  );

  assert.equal(status, 0);
});

test("invalid nonempty Android SDK paths are unavailable rather than internal", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[2];
  const loopPath = join(fixture.root, "sdk-loop");
  await activateSuite(fixture.root, definition);
  await symlink("sdk-loop", loopPath);

  const invalidSdkPaths = [
    { label: "NUL", path: `${fixture.root}/sdk\0root` },
    { label: "ELOOP", path: loopPath },
    { label: "ENAMETOOLONG", path: join(fixture.root, "a".repeat(5000)) },
  ];

  for (const { label, path } of invalidSdkPaths) {
    const messages = [];
    const status = await fixture.runner.dispatchFutureSuite(
      makeRunOptions(definition, fixture.root, {
        env: { ANDROID_HOME: path, ANDROID_SDK_ROOT: "" },
        stderr: (message) => messages.push(message),
      }),
    );
    assert.equal(status, 69, label);
    assert.match(messages.join("\n"), /native-android.*unavailable.*AND-001/u);
  }
});

test("probe-time private command or hook drift is reclassified before npm spawn", async (t) => {
  const probeCounts = {
    integration: 2,
    "native-ios": 3,
    "native-android": 2,
    e2e: 2,
    load: 2,
  };

  for (const definition of expectedSuites) {
    await t.test(definition.suite, async (suiteTest) => {
      const fixture = await makeRepositoryFixture(suiteTest);
      const mutations = [
        {
          label: "private command",
          scripts: {
            [definition.privateScript]: `${definition.privateCommand} --mutated`,
          },
        },
        {
          label: "private hook",
          scripts: {
            [definition.privateScript]: definition.privateCommand,
            [`pre${definition.privateScript}`]: "forbidden hook",
          },
        },
      ];

      for (const { label, scripts } of mutations) {
        for (
          let mutateAtProbe = 1;
          mutateAtProbe <= probeCounts[definition.suite];
          mutateAtProbe += 1
        ) {
          await activateSuite(fixture.root, definition);
          let probeCalls = 0;
          let finalSpawns = 0;
          const messages = [];

          const status = await fixture.runner.dispatchFutureSuite(
            makeRunOptions(definition, fixture.root, {
              probe: async () => {
                probeCalls += 1;
                if (probeCalls === mutateAtProbe) {
                  await writeManifest(fixture.root, scripts);
                }
                return successResult();
              },
              spawn: () => {
                finalSpawns += 1;
                return successResult();
              },
              stderr: (message) => messages.push(message),
            }),
          );

          const labelAtProbe = `${definition.suite}/${label}/probe-${mutateAtProbe}`;
          assert.equal(status, 65, labelAtProbe);
          assert.equal(finalSpawns, 0, labelAtProbe);
          assert.match(
            messages.join("\n"),
            new RegExp(
              `${definition.suite}.*partial.*${definition.ownerTask}`,
              "u",
            ),
          );
        }
      }
    });
  }
});

test("active invocation uses the exact Node/npm vector once and propagates numeric child statuses", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[4];
  await activateSuite(fixture.root, definition);
  const npmExecPath = join(fixture.root, "fixed-toolchain/npm-cli.js");

  for (const childStatus of [0, 1, 37, 70]) {
    const calls = [];
    const messages = [];
    const status = await fixture.runner.dispatchFutureSuite(
      makeRunOptions(definition, fixture.root, {
        env: { npm_execpath: npmExecPath },
        spawn: (executable, args, options) => {
          calls.push({ executable, args, options });
          return { status: childStatus, signal: null };
        },
        stderr: (message) => messages.push(message),
      }),
    );

    assert.equal(status, childStatus);
    assert.deepEqual(
      messages,
      [],
      `child status ${childStatus} is not remapped`,
    );
    assert.deepEqual(calls, [
      {
        executable: process.execPath,
        args: [
          npmExecPath,
          "run",
          "--ignore-scripts",
          definition.privateScript,
        ],
        options: {
          cwd: fixture.root,
          shell: false,
          stdio: "inherit",
          windowsHide: true,
        },
      },
    ]);
  }
});

test("final npm-child throw, error, null status, and signal map to sanitized internal", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const definition = expectedSuites[3];
  await activateSuite(fixture.root, definition);
  const outcomes = [
    {
      label: "throw",
      spawn: () => {
        throw new Error("private-child-value");
      },
    },
    {
      label: "returned error",
      spawn: () => ({
        status: null,
        signal: null,
        error: new Error("private-child-value"),
      }),
    },
    {
      label: "null status",
      spawn: () => ({ status: null, signal: null }),
    },
    {
      label: "signal",
      spawn: () => ({ status: null, signal: "SIGKILL" }),
    },
  ];

  for (const { label, spawn } of outcomes) {
    const messages = [];
    const status = await fixture.runner.dispatchFutureSuite(
      makeRunOptions(definition, fixture.root, {
        spawn,
        stderr: (message) => messages.push(message),
      }),
    );
    assert.equal(status, 70, label);
    assert.doesNotMatch(messages.join("\n"), /private-child-value|SIGKILL/u);
  }
});

test("unexpected output-adapter failures become deterministic internal results", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const status = await fixture.runner.dispatchFutureSuite({
    args: ["integration"],
    env: {},
    platform: "linux",
    probe: () => successResult(),
    spawn: () => successResult(),
    stderr: () => {
      throw new Error("programmer-secret");
    },
  });

  assert.equal(status, 70);
});

test("copied entrypoint resolves its repository from import.meta.url instead of cwd", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const otherCwd = await mkdtemp(join(tmpdir(), "crewroll-other-cwd-"));
  t.after(async () => rm(otherCwd, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [join(fixture.root, "tools/run-future-suite.mjs"), "integration"],
    {
      cwd: otherCwd,
      env: {},
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 78);
  assert.match(result.stderr, /integration.*dormant.*DB-001/u);
  assert.match(result.stderr, /has not activated the complete harness/u);
});

test("copied entrypoint executes through a symlinked repository alias", async (t) => {
  const fixture = await makeRepositoryFixture(t);
  const aliasParent = await mkdtemp(join(tmpdir(), "crewroll-runner-alias-"));
  const aliasRoot = join(aliasParent, "repository-alias");
  t.after(async () => rm(aliasParent, { recursive: true, force: true }));
  await symlink(fixture.root, aliasRoot, "dir");

  const result = spawnSync(
    process.execPath,
    [join(aliasRoot, "tools/run-future-suite.mjs"), "integration"],
    {
      cwd: aliasParent,
      env: {},
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 78);
  assert.match(result.stderr, /integration.*dormant.*DB-001/u);
});
