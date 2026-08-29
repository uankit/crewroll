import assert from "node:assert/strict";

const fields = [
  "name",
  "slug",
  "scheme",
  "iosBundleIdentifier",
  "androidPackage",
  "easProjectId",
  "updatesUrl",
  "runtimeVersionPolicy",
  "appVersionSource",
  "productionAutoIncrement",
];

export function assertRootManifest(manifest) {
  assert.equal(manifest.name, "crewroll", "package name must remain crewroll");
  assert.equal(manifest.private, true, "root package must remain private");
  assert.equal(
    manifest.main,
    "expo-router/entry",
    "Expo Router must stay at repository root",
  );
  assert.deepEqual(
    manifest.workspaces,
    ["packages/*", "services/*"],
    "workspace topology",
  );
  assert.match(manifest.dependencies?.expo ?? "", /^~57\./, "Expo SDK 57");
}

export function identityFromConfigs(publicConfig, easConfig) {
  return {
    name: publicConfig.name,
    slug: publicConfig.slug,
    scheme: publicConfig.scheme,
    iosBundleIdentifier: publicConfig.ios?.bundleIdentifier,
    androidPackage: publicConfig.android?.package,
    easProjectId: publicConfig.extra?.eas?.projectId,
    updatesUrl: publicConfig.updates?.url,
    runtimeVersionPolicy: publicConfig.runtimeVersion?.policy,
    appVersionSource: easConfig.cli?.appVersionSource,
    productionAutoIncrement: easConfig.build?.production?.autoIncrement,
  };
}

export function assertIdentity(actual, expected) {
  const mismatches = fields
    .filter((field) => actual[field] !== expected[field])
    .map(
      (field) =>
        `${field}: expected ${String(expected[field])}, received ${String(actual[field])}`,
    );

  if (mismatches.length > 0) {
    throw new Error(
      `CrewRoll release identity drifted:\n${mismatches.join("\n")}`,
    );
  }
}
