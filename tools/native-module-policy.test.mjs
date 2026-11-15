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

test("Android Expo dependencies support precompiled publications and source projects", () => {
  const gradle = readFileSync(
    path.join(root, "modules", "crewroll-transfer", "android", "build.gradle"),
    "utf8",
  );

  // SDK 57 may omit Expo source projects when autolinking selects their Maven
  // publications. The module plugin resolves the dependency for either graph.
  assert.match(gradle, /id\s+['"]expo-module-gradle-plugin['"]/);
  assert.match(
    gradle,
    /implementation\s+expoModule\.getExpoDependency\(['"]expo-notifications['"]\)/,
  );
  assert.doesNotMatch(
    gradle,
    /\bproject\s*\(\s*['"]:expo-[^'"]+['"]\s*\)/,
    "Expo modules must not require source projects absent from publication builds",
  );
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
    "prepareDeviceSession",
    "ensureDeviceIdentity",
    "getActiveTripSelection",
    "restoreDeviceSession",
    "installDeviceSession",
    "refreshDeviceSession",
    "clearDeviceSession",
    "eraseAccount",
    "createTripKey",
    "discardProvisionalTripKey",
    "wrapTripKey",
    "importTripKey",
    "importAndActivateTrip",
    "importAndActivateTripWithAlbum",
    "activateTrip",
    "deactivateTrip",
  ];
  const pendingEngineMethodNames = [
    "setTransferPolicy",
    "reconcileNow",
    "retryPhotoOrganization",
    "retry",
  ];
  const mutationNames = [...keyMethodNames, ...pendingEngineMethodNames];
  const allMethodNames = [...mutationNames, "getSnapshot", "listAssets"];

  for (const [platform, source] of [
    ["iOS", swift],
    ["Android", kotlin],
  ]) {
    const registrations = [...source.matchAll(/AsyncFunction\("([^"]+)"\)/g)];
    const registeredNames = registrations.map((match) => match[1]);
    assert.equal(
      new Set(registeredNames).size,
      registeredNames.length,
      `${platform} must not register a command twice`,
    );
    assert.deepEqual(
      [...registeredNames].sort(),
      [...allMethodNames].sort(),
      `${platform} must expose exactly the closed protocol commands`,
    );
    const events = [...source.matchAll(/\bEvents\s*\(([^)]*)\)/g)];
    assert.equal(
      events.length,
      1,
      `${platform} must have one canonical event registration`,
    );
    assert.match(
      events[0][1],
      /^\s*"[^"]+"(?:\s*,\s*"[^"]+")*\s*$/,
      `${platform} event registration must use a closed literal list`,
    );
    assert.deepEqual(
      [...events[0][1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
      ["engineInvalidated", "pushHint"],
      `${platform} may expose only revision invalidations and opaque push hints`,
    );
    // Fencing may wrap lifecycle calls, but every command still has to enter a
    // closed decoder in its own registration. A validator elsewhere in the
    // module must not make an unvalidated bridge method pass this policy.
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index];
      const method = registration[1];
      if (method === "getSnapshot") continue; // No command argument.
      const body = source.slice(
        registration.index,
        registrations[index + 1]?.index ?? source.length,
      );
      if (platform === "iOS") {
        const decoder =
          method === "importAndActivateTripWithAlbum"
            ? /NativeTripAlbumCommand\.decode\(command\)/
            : [
                  "clearDeviceSession",
                  "eraseAccount",
                  ...pendingEngineMethodNames,
                  "listAssets",
                ].includes(method)
              ? /Self\.require\(\s*command,\s*keys:/
              : new RegExp(
                  `NativeCommandDecoder\\.require\\(\\s*command,\\s*for:\\s*\\.${method}\\s*\\)`,
                );
        assert.match(
          body,
          decoder,
          `${platform} ${method} must validate its closed command`,
        );
        if (method === "importAndActivateTripWithAlbum") {
          const albumDecoder = readFileSync(
            path.join(
              moduleRoot,
              "ios/IdentityKeys/Sources/CrewRollNativeKeys/NativeTripAlbums.swift",
            ),
            "utf8",
          );
          assert.match(
            albumDecoder,
            /Set\(command\.keys\) == \["protocolVersion", "envelope", "activation", "album"\]/,
          );
          assert.match(albumDecoder, /Set\(album\.keys\) == \["tripName"\]/);
          assert.match(
            albumDecoder,
            /NativeCommandDecoder\.require\(core, for: \.importAndActivateTrip\)/,
          );
        }
      } else if (method === "setTransferPolicy") {
        assert.match(body, /NativeCommandDecoder\.requireProtocol\(command\)/);
        assert.match(
          body,
          /command\.keys\s*!=\s*setOf\("protocolVersion",\s*"paused",\s*"cellularAllowed"\)/,
        );
      } else {
        const decoder = [
          "clearDeviceSession",
          "eraseAccount",
          "reconcileNow",
          "retryPhotoOrganization",
          "retry",
          "listAssets",
        ].includes(method)
          ? /requireCommand\(\s*command,\s*setOf\(/
          : new RegExp(
              `NativeCommandDecoder\\.require\\(\\s*command,\\s*NativeCommandKind\\.${method.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}\\s*\\)`,
            );
        assert.match(
          body,
          decoder,
          `${platform} ${method} must validate its closed command`,
        );
      }
    }
    assert.doesNotMatch(source, /ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED/);
    assert.equal(
      (source.match(/AsyncFunction\("discardProvisionalTripKey"\)/g) ?? [])
        .length,
      1,
    );
    for (const method of keyMethodNames) {
      const lifecycleMethod =
        method === "importAndActivateTripWithAlbum"
          ? "importAndActivateTrip"
          : method;
      assert.match(
        source,
        new RegExp(`lifecycle(?:\\(\\))?\\.${lifecycleMethod}`),
      );
    }
  }
  assert.doesNotMatch(swift, /pendingScopeException|inactiveSnapshot/);
  assert.match(swift, /ApplePhotoTransferEngine/);
  for (const method of [
    "setPolicy",
    "reconcileNow",
    "retry",
    "snapshot",
    "listAssets",
  ])
    assert.match(swift, new RegExp(`await engine\\.${method}`));
  assert.doesNotMatch(
    kotlin,
    /pendingScopeException|inactiveSnapshot|TRANSFER_SCOPE_PENDING/,
  );
  assert.match(kotlin, /NativePhotoTransferEngine/);
  assert.match(kotlin, /runtime\(\)\.applyTransferPolicy\(/);
  const androidRuntime = readFileSync(
    path.join(
      moduleRoot,
      "android/src/main/java/com/uankit53/crewroll/transfer/CrewRollNativeRuntime.kt",
    ),
    "utf8",
  );
  assert.match(androidRuntime, /fun applyTransferPolicy\(/);
  assert.match(androidRuntime, /\.policy\(/);
  for (const method of ["requestReconcile", "retry", "snapshot", "assets"])
    assert.match(kotlin, new RegExp(`engine\\(\\)\\.${method}`));
  assert.match(swift, /"protocolVersion": 1/);
  assert.match(kotlin, /"protocolVersion" to 1/);
});
