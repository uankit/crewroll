import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertIdentity,
  assertRootManifest,
  identityFromConfigs,
} from "./app-identity.mjs";

const snapshot = JSON.parse(
  await readFile(
    new URL("./app-identity.snapshot.json", import.meta.url),
    "utf8",
  ),
);

const publicConfig = {
  name: "CrewRoll",
  slug: "AirMesh",
  scheme: "airmesh",
  ios: { bundleIdentifier: "com.uankit53.airmesh" },
  android: { package: "com.uankit53.airmesh" },
  extra: {
    eas: { projectId: "fe1de141-5c42-4250-9c1f-f7313845dc8e" },
  },
  updates: {
    url: "https://u.expo.dev/fe1de141-5c42-4250-9c1f-f7313845dc8e",
  },
  runtimeVersion: { policy: "appVersion" },
};

const easConfig = {
  cli: { appVersionSource: "remote" },
  build: { production: { autoIncrement: true } },
};

const validRoot = {
  name: "crewroll",
  private: true,
  main: "expo-router/entry",
  workspaces: ["packages/*", "services/*"],
  dependencies: { expo: "~57.0.18" },
};

test("accepts the locked root Expo manifest", () => {
  assert.doesNotThrow(() => assertRootManifest(validRoot));
});

test("rejects a renamed root application", () => {
  assert.throws(
    () => assertRootManifest({ ...validRoot, name: "mobile" }),
    /package name/,
  );
});

test("extracts the protected App Store, Play, and EAS identity", () => {
  assert.deepEqual(identityFromConfigs(publicConfig, easConfig), snapshot);
});

test("rejects identity drift with a field-specific error", () => {
  const drifted = identityFromConfigs(
    {
      ...publicConfig,
      ios: { bundleIdentifier: "com.example.replacement" },
    },
    easConfig,
  );

  assert.throws(
    () => assertIdentity(drifted, snapshot),
    /iosBundleIdentifier: expected com\.uankit53\.airmesh, received com\.example\.replacement/,
  );
});

test("rejects missing production auto-increment instead of defaulting it", () => {
  const incomplete = identityFromConfigs(publicConfig, {
    cli: { appVersionSource: "remote" },
    build: { production: {} },
  });

  assert.throws(
    () => assertIdentity(incomplete, snapshot),
    /productionAutoIncrement: expected true, received undefined/,
  );
});
