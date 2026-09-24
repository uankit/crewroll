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
  ios: { bundleIdentifier: "app.crewroll.mobile" },
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
    /iosBundleIdentifier: expected app\.crewroll\.mobile, received com\.example\.replacement/,
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

test("TestFlight uses production authentication while retaining the existing app identities", async () => {
  const readConfig = async (filename) =>
    JSON.parse(
      await readFile(new URL(`../${filename}`, import.meta.url), "utf8"),
    );
  const [app, eas, manifest, lockfile] = await Promise.all(
    ["app.json", "eas.json", "package.json", "package-lock.json"].map(
      readConfig,
    ),
  );

  assert.equal(app.expo.ios.bundleIdentifier, "app.crewroll.mobile");
  assert.notEqual(
    app.expo.ios.infoPlist?.ITSAppUsesNonExemptEncryption,
    false,
    "Complete Apple's encryption questionnaire before asserting an exemption",
  );
  assert.equal(app.expo.android.package, "com.uankit53.airmesh");
  assert.deepEqual(eas.build.testflight, {
    extends: "production",
    distribution: "store",
    channel: "testflight",
    environment: "production",
  });
  assert.equal(eas.submit.testflight.ios.ascAppId, "6797897853");
  assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.production.environment, "production");
  assert.equal(app.expo.runtimeVersion.policy, "appVersion");
  assert.equal(manifest.version, app.expo.version);
  assert.equal(lockfile.version, app.expo.version);
  assert.equal(lockfile.packages[""].version, app.expo.version);
});
