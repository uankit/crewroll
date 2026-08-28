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

const sdk57Range = /^~57\.0\.\d+$/;
const exactSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

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
  assert.equal(manifest.dependencies?.["@clerk/clerk-expo"], undefined);
  assert.equal(manifest.devDependencies?.["openapi-typescript"], undefined);

  const lockRoot = lockfile.packages?.[""];
  assert.deepEqual(lockRoot?.dependencies, manifest.dependencies);
  assert.deepEqual(lockRoot?.devDependencies, manifest.devDependencies);
  for (const name of [...expoManagedDependencies, ...applicationDependencies]) {
    assert.match(
      lockfile.packages?.[`node_modules/${name}`]?.version ?? "",
      exactSemver,
      `lockfile must concretely resolve ${name}`,
    );
  }
}

test("keeps the root Expo shape and approved client stack", () => {
  assert.doesNotThrow(() => assertMobileDependencyPolicy(root, lock));
});

test("rejects removal of required mobile dependencies", () => {
  const withoutNotifications = structuredClone(root);
  delete withoutNotifications.dependencies["expo-notifications"];
  assert.throws(() => assertMobileDependencyPolicy(withoutNotifications, lock));

  const withoutResolvers = structuredClone(root);
  delete withoutResolvers.dependencies["@hookform/resolvers"];
  assert.throws(() => assertMobileDependencyPolicy(withoutResolvers, lock));
});

test("rejects ranges for exact application dependency pins", () => {
  const ranged = structuredClone(root);
  ranged.dependencies["@clerk/expo"] = "^4.6.1";
  assert.throws(() => assertMobileDependencyPolicy(ranged, lock));
});
