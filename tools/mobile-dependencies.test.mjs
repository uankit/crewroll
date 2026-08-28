import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("keeps the root Expo shape and approved client stack", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(root.name, "crewroll");
  assert.equal(root.main, "expo-router/entry");
  assert.deepEqual(root.workspaces, ["packages/*", "services/*"]);
  for (const name of [
    "@clerk/expo",
    "@shopify/flash-list",
    "@tanstack/react-query",
    "openapi-fetch",
    "react-hook-form",
    "zod",
    "zustand",
  ]) {
    assert.equal(typeof root.dependencies[name], "string", `missing ${name}`);
  }
  assert.equal(root.dependencies["@clerk/clerk-expo"], undefined);
  assert.equal(root.devDependencies["openapi-typescript"], undefined);
});
