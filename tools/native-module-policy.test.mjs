import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const autolinker = path.join(
  root,
  "node_modules",
  ".bin",
  "expo-modules-autolinking",
);

function search(platform) {
  const result = spawnSync(
    autolinker,
    ["search", "--platform", platform, "--json", "modules"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout)["crewroll-transfer"];
}

function resolve(platform) {
  const result = spawnSync(
    autolinker,
    ["resolve", "--platform", platform, "--json", "modules"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).modules.find(
    (module) => module.packageName === "crewroll-transfer",
  );
}

test("Expo autolinking discovers only the canonical CrewRoll native shells", () => {
  const apple = search("apple");
  const android = search("android");

  assert.ok(apple, "Apple autolinking did not discover crewroll-transfer");
  assert.ok(android, "Android autolinking did not discover crewroll-transfer");
  assert.deepEqual(apple.config.apple.modules, ["CrewRollTransferModule"]);
  assert.deepEqual(android.config.android.modules, [
    "com.uankit53.crewroll.transfer.CrewRollTransferModule",
  ]);
  assert.equal(
    path.resolve(apple.path),
    path.join(root, "modules", "crewroll-transfer"),
  );
  assert.equal(path.resolve(android.path), path.resolve(apple.path));

  const resolvedApple = resolve("apple");
  const resolvedAndroid = resolve("android");
  assert.deepEqual(resolvedApple.pods, [
    {
      podName: "CrewRollTransfer",
      podspecDir: path.join(root, "modules", "crewroll-transfer", "ios"),
    },
  ]);
  assert.deepEqual(resolvedApple.modules, [
    { name: null, class: "CrewRollTransferModule" },
  ]);
  assert.deepEqual(resolvedAndroid.projects, [
    {
      name: "crewroll-transfer",
      sourceDir: path.join(root, "modules", "crewroll-transfer", "android"),
      modules: [
        {
          classifier: "com.uankit53.crewroll.transfer.CrewRollTransferModule",
          name: null,
        },
      ],
      services: [],
      packages: [],
    },
  ]);
});

test("native bridges keep the closed protocol and wire only implemented transfer engines", () => {
  const moduleRoot = path.join(root, "modules", "crewroll-transfer");
  const swift = readFileSync(
    path.join(moduleRoot, "ios", "CrewRollTransferModule.swift"),
    "utf8",
  );
  const kotlin = readFileSync(
    path.join(
      moduleRoot,
      "android",
      "src",
      "main",
      "java",
      "com",
      "uankit53",
      "crewroll",
      "transfer",
      "CrewRollTransferModule.kt",
    ),
    "utf8",
  );
  const keyMethodNames = [
    "ensureDeviceIdentity",
    "installDeviceSession",
    "clearDeviceSession",
    "createTripKey",
    "discardProvisionalTripKey",
    "wrapTripKey",
    "importTripKey",
    "activateTrip",
    "deactivateTrip",
  ];
  const pendingEngineMethodNames = [
    "setTransferPolicy",
    "reconcileNow",
    "retry",
  ];
  const mutationNames = [...keyMethodNames, ...pendingEngineMethodNames];
  const allMethodNames = [...mutationNames, "getSnapshot", "listAssets"];

  for (const source of [swift, kotlin]) {
    assert.deepEqual(
      [...source.matchAll(/AsyncFunction\("([^"]+)"\)/g)].map(
        (match) => match[1],
      ),
      allMethodNames,
    );
    assert.equal(
      (source.match(/Events\("engineInvalidated"\)/g) ?? []).length,
      1,
    );
    assert.doesNotMatch(source, /ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED/);
    assert.equal(
      (source.match(/AsyncFunction\("discardProvisionalTripKey"\)/g) ?? [])
        .length,
      1,
    );
    for (const method of keyMethodNames) {
      assert.match(source, new RegExp(`lifecycle\\.${method}`));
    }
  }
  assert.doesNotMatch(swift, /pendingScopeException|inactiveSnapshot/);
  assert.match(swift, /ApplePhotoTransferEngine/);
  for (const method of ["setPolicy", "wake", "retry", "snapshot", "listAssets"])
    assert.match(swift, new RegExp(`await engine\\.${method}`));
  assert.doesNotMatch(
    kotlin,
    /pendingScopeException|inactiveSnapshot|TRANSFER_SCOPE_PENDING/,
  );
  assert.match(kotlin, /NativePhotoTransferEngine/);
  for (const method of ["policy", "wake", "retry", "snapshot", "assets"])
    assert.match(kotlin, new RegExp(`engine\\(\\)\\.${method}`));
  assert.match(swift, /"protocolVersion": 1/);
  assert.match(kotlin, /"protocolVersion" to 1/);
});
