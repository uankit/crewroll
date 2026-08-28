import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const app = JSON.parse(await readFile(new URL("app.json", root), "utf8")).expo;
const eas = JSON.parse(await readFile(new URL("eas.json", root), "utf8"));

test("greenfield config contains no legacy LAN or relay architecture", () => {
  assert.equal(app.extra?.airmesh, undefined);
  assert.equal(app.ios?.infoPlist?.NSLocalNetworkUsageDescription, undefined);

  for (const profile of Object.values(eas.build)) {
    assert.equal(profile.env?.EXPO_PUBLIC_AIRMESH_TRANSPORT, undefined);
  }
});

test("Android requests image access without legacy write permission", () => {
  assert.ok(app.android.permissions.includes("android.permission.READ_MEDIA_IMAGES"));
  assert.equal(
    app.android.permissions.includes("android.permission.WRITE_EXTERNAL_STORAGE"),
    false,
  );
  assert.equal(
    app.android.permissions.includes(
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    ),
    false,
  );
});

test("resolved Android config blocks legacy media writes while retaining reads", () => {
  const publicResult = spawnSync(
    "node_modules/expo/bin/cli",
    ["config", "--type", "public", "--json"],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(publicResult.status, 0, publicResult.stderr || publicResult.stdout);
  const publicConfig = JSON.parse(publicResult.stdout);
  assert.ok(
    publicConfig.android.blockedPermissions.includes(
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ),
  );

  const introspectResult = spawnSync(
    "node_modules/expo/bin/cli",
    ["config", "--type", "introspect", "--json"],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(
    introspectResult.status,
    0,
    introspectResult.stderr || introspectResult.stdout,
  );
  const resolved = JSON.parse(introspectResult.stdout);
  const permissions = resolved.android.permissions;

  assert.equal(
    permissions.includes("android.permission.WRITE_EXTERNAL_STORAGE"),
    false,
  );
  assert.equal(
    permissions.includes("android.permission.READ_EXTERNAL_STORAGE"),
    true,
  );
  assert.equal(
    permissions.includes("android.permission.READ_MEDIA_IMAGES"),
    true,
  );
  assert.ok(
    resolved.android.blockedPermissions.includes(
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ),
  );
});

test("photo permission copy describes automatic trip sharing", () => {
  const mediaLibraryPlugin = app.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-media-library",
  );

  assert.ok(mediaLibraryPlugin);
  assert.match(mediaLibraryPlugin[1].photosPermission, /active trip/i);
  assert.match(mediaLibraryPlugin[1].photosPermission, /automatically/i);
  assert.match(mediaLibraryPlugin[1].savePhotosPermission, /exact originals/i);
});

test("app config registers only installed, required greenfield plugins", () => {
  const pluginNames = app.plugins.map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin,
  );

  assert.deepEqual(pluginNames, [
    "expo-router",
    "expo-splash-screen",
    "expo-media-library",
    "expo-secure-store",
  ]);
});
