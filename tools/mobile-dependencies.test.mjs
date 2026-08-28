import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

const expoManagedDependencies = [
  "expo-dev-client",
  "expo-updates",
  "expo-constants",
  "expo-linking",
  "expo-haptics",
  "expo-image",
  "expo-splash-screen",
  "expo-status-bar",
  "expo-system-ui",
  "expo-build-properties",
  "expo-secure-store",
  "expo-notifications",
  "expo-task-manager",
  "expo-device",
];

const applicationDependencies = [
  "@clerk/expo",
  "@tanstack/react-query",
  "zustand",
  "zod",
  "openapi-fetch",
  "react-hook-form",
  "@hookform/resolvers",
  "@shopify/flash-list",
];

const sdk57Range = /^~57\.0\.(0|[1-9]\d*)$/;
const exactSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const rootDependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function cloneManifestAndLock() {
  return { manifest: structuredClone(root), lockfile: structuredClone(lock) };
}

function setRootDependency(manifest, lockfile, section, name, version) {
  manifest[section] ??= {};
  lockfile.packages[""][section] ??= {};
  manifest[section][name] = version;
  lockfile.packages[""][section][name] = version;
}

function removeRootDependency(manifest, lockfile, section, name) {
  delete manifest[section]?.[name];
  delete lockfile.packages[""][section]?.[name];
}

function parseExactSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match?.slice(1).map(Number) ?? null;
}

function satisfiesSdk57Tilde(declaration, resolution) {
  const declared = sdk57Range.exec(declaration);
  const installed = parseExactSemver(resolution);
  if (!declared || !installed) {
    return false;
  }

  return (
    installed[0] === 57 &&
    installed[1] === 0 &&
    installed[2] >= Number(declared[1])
  );
}

function assertForbiddenPackageAbsent(manifest, lockfile, name) {
  for (const section of rootDependencySections) {
    assert.equal(manifest[section]?.[name], undefined, `${name} must be absent from ${section}`);
  }
  assert.equal(
    lockfile.packages?.[`node_modules/${name}`],
    undefined,
    `${name} lockfile entry must be absent`,
  );
}

function assertMobileDependencyPolicy(manifest, lockfile) {
  assert.equal(manifest.name, "crewroll");
  assert.equal(manifest.main, "expo-router/entry");
  assert.deepEqual(manifest.workspaces, ["packages/*", "services/*"]);
  for (const name of expoManagedDependencies) {
    assert.match(
      manifest.dependencies?.[name] ?? "",
      sdk57Range,
      `${name} must use an SDK 57 compatible range`,
    );
  }
  for (const name of applicationDependencies) {
    assert.match(
      manifest.dependencies?.[name] ?? "",
      exactSemver,
      `${name} must use an exact application version`,
    );
  }
  assertForbiddenPackageAbsent(manifest, lockfile, "@clerk/clerk-expo");
  assertForbiddenPackageAbsent(manifest, lockfile, "openapi-typescript");

  const lockRoot = lockfile.packages?.[""];
  for (const section of rootDependencySections) {
    assert.deepEqual(
      lockRoot?.[section],
      manifest[section],
      `lockfile root ${section} must match manifest`,
    );
  }
  for (const name of expoManagedDependencies) {
    const resolution = lockfile.packages?.[`node_modules/${name}`]?.version ?? "";
    assert.match(resolution, exactSemver, `lockfile must concretely resolve ${name}`);
    assert.ok(
      satisfiesSdk57Tilde(manifest.dependencies[name], resolution),
      `${name} lock version must satisfy ${manifest.dependencies[name]}`,
    );
  }
  for (const name of applicationDependencies) {
    const resolution = lockfile.packages?.[`node_modules/${name}`]?.version ?? "";
    assert.match(resolution, exactSemver, `lockfile must concretely resolve ${name}`);
    assert.equal(
      resolution,
      manifest.dependencies[name],
      `${name} lock version must equal exact manifest pin`,
    );
  }
}

test("keeps the root Expo shape and approved client stack", () => {
  assert.doesNotThrow(() => assertMobileDependencyPolicy(root, lock));
});

test("rejects removal of required mobile dependencies", () => {
  const { manifest: withoutNotifications, lockfile: notificationsLock } = cloneManifestAndLock();
  removeRootDependency(
    withoutNotifications,
    notificationsLock,
    "dependencies",
    "expo-notifications",
  );
  assert.throws(
    () => assertMobileDependencyPolicy(withoutNotifications, notificationsLock),
    /expo-notifications must use an SDK 57 compatible range/,
  );

  const { manifest: withoutResolvers, lockfile: resolversLock } = cloneManifestAndLock();
  removeRootDependency(
    withoutResolvers,
    resolversLock,
    "dependencies",
    "@hookform/resolvers",
  );
  assert.throws(
    () => assertMobileDependencyPolicy(withoutResolvers, resolversLock),
    /@hookform\/resolvers must use an exact application version/,
  );
});

test("rejects ranges for exact application dependency pins", () => {
  const { manifest: ranged, lockfile } = cloneManifestAndLock();
  setRootDependency(ranged, lockfile, "dependencies", "@clerk/expo", "^4.6.1");
  assert.throws(
    () => assertMobileDependencyPolicy(ranged, lockfile),
    /@clerk\/expo must use an exact application version/,
  );
});

test("rejects malformed SDK 57 dependency declarations", () => {
  const { manifest, lockfile } = cloneManifestAndLock();
  setRootDependency(
    manifest,
    lockfile,
    "dependencies",
    "expo-notifications",
    "~57.0.01",
  );
  assert.throws(
    () => assertMobileDependencyPolicy(manifest, lockfile),
    /expo-notifications must use an SDK 57 compatible range/,
  );
});

test("rejects forbidden packages in every root dependency section", () => {
  for (const [name, version] of [
    ["@clerk/clerk-expo", "2.20.0"],
    ["openapi-typescript", "7.13.0"],
  ]) {
    for (const section of rootDependencySections) {
      const { manifest, lockfile } = cloneManifestAndLock();
      setRootDependency(manifest, lockfile, section, name, version);
      assert.throws(
        () => assertMobileDependencyPolicy(manifest, lockfile),
        new RegExp(`${name} must be absent from ${section}`),
      );
    }
  }
});

test("rejects lock resolutions outside the approved declarations", () => {
  const { manifest: badClerk, lockfile: badClerkLock } = cloneManifestAndLock();
  badClerkLock.packages["node_modules/@clerk/expo"].version = "99.0.0";
  assert.throws(
    () => assertMobileDependencyPolicy(badClerk, badClerkLock),
    /@clerk\/expo lock version must equal exact manifest pin/,
  );

  for (const version of ["57.0.14", "57.1.0", "58.0.0"]) {
    const { manifest, lockfile } = cloneManifestAndLock();
    lockfile.packages["node_modules/expo-notifications"].version = version;
    assert.throws(
      () => assertMobileDependencyPolicy(manifest, lockfile),
      /expo-notifications lock version must satisfy ~57\.0\.\d+/,
    );
  }
});

test("rejects forbidden direct lockfile entries", () => {
  const { manifest: oldClerk, lockfile: oldClerkLock } = cloneManifestAndLock();
  oldClerkLock.packages["node_modules/@clerk/clerk-expo"] = { version: "2.20.0" };
  assert.throws(
    () => assertMobileDependencyPolicy(oldClerk, oldClerkLock),
    /@clerk\/clerk-expo lockfile entry must be absent/,
  );

  const { manifest: generator, lockfile: generatorLock } = cloneManifestAndLock();
  generatorLock.packages["node_modules/openapi-typescript"] = { version: "7.13.0" };
  assert.throws(
    () => assertMobileDependencyPolicy(generator, generatorLock),
    /openapi-typescript lockfile entry must be absent/,
  );
});
