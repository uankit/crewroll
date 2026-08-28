import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

import { controlPlaneWorkspace } from "../src/index.js";

it("boots the control-plane workspace without external connections", async () => {
  expect(controlPlaneWorkspace).toEqual({ apiVersion: "v1", workerEnabled: true });
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    exports: Record<string, { import: string; types: string }>;
    files: string[];
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  expect(manifest.exports["."]).toEqual({
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js",
  });
  expect(manifest.files).toEqual(["dist"]);
  expect(manifest.dependencies["@crewroll/contracts"]).toBe("0.1.0");
  for (const version of [...Object.values(manifest.dependencies), ...Object.values(manifest.devDependencies)]) {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  }
  expect(manifest.dependencies).not.toHaveProperty("env-schema");
});
