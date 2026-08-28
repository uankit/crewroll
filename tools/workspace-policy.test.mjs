import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);

const forbiddenDependencies = [
  "@noble/ciphers",
  "@noble/curves",
  "@noble/hashes",
  "react-native-reanimated",
  "react-native-tcp-socket",
  "react-native-worklets",
];

test("root remains the CrewRoll Expo application and owns the workspaces", () => {
  assert.equal(packageJson.name, "crewroll");
  assert.equal(packageJson.main, "expo-router/entry");
  assert.deepEqual(packageJson.workspaces, ["packages/*", "services/*"]);
  assert.equal(packageJson.engines.node, ">=22.13.0 <23");
  assert.equal(packageJson.packageManager, "npm@10.9.2");
});

test("greenfield mobile shell does not carry legacy transfer or JS crypto", () => {
  for (const dependency of forbiddenDependencies) {
    assert.equal(
      packageJson.dependencies?.[dependency],
      undefined,
      `${dependency} must not be in the greenfield mobile runtime`,
    );
  }
});

test("Expo 57 transitive peers stay on the official template versions", () => {
  assert.deepEqual(packageJson.overrides, {
    "react-dom": "19.2.3",
    "react-native-reanimated": "4.5.1",
    "react-native-worklets": "0.10.1",
  });
});

test("test-only packages are development dependencies", () => {
  const expected = [
    "@testing-library/react-native",
    "@types/jest",
    "jest",
    "jest-expo",
  ];

  for (const dependency of expected) {
    assert.equal(packageJson.dependencies?.[dependency], undefined);
    assert.ok(packageJson.devDependencies?.[dependency]);
  }
});

test("quality scripts include identity, types, lint, tests, and Expo Doctor", () => {
  assert.match(packageJson.scripts.check, /verify:identity/);
  assert.match(packageJson.scripts.check, /typecheck/);
  assert.match(packageJson.scripts.check, /lint/);
  assert.match(packageJson.scripts.check, /test/);
  assert.match(packageJson.scripts.check, /doctor/);
});
