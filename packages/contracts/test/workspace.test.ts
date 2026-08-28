import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("boots the contracts workspace through explicit exports and exact dependencies", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    exports: Record<string, string | { import: string; types: string }>;
    files: string[];
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  expect(manifest.exports).toMatchObject({
    ".": { types: "./dist/openapi/index.d.ts", import: "./dist/openapi/index.js" },
    "./native/protocol": { types: "./dist/native/protocol.d.ts", import: "./dist/native/protocol.js" },
    "./storage/ports": { types: "./dist/storage/ports.d.ts", import: "./dist/storage/ports.js" },
  });
  expect(manifest.files).toEqual(["dist", "generated/crewroll.openapi.json"]);
  expect(Object.keys(manifest.exports)).not.toEqual(expect.arrayContaining([expect.stringMatching(/test|generator|config/)]));
  for (const version of [...Object.values(manifest.dependencies), ...Object.values(manifest.devDependencies)]) {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  }
  const contracts = await import("@crewroll/contracts");
  expect(contracts.ApiVersionSchema).toBeDefined();
});
