import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("boots the contracts workspace through explicit exports and exact dependencies", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    exports: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  expect(manifest.exports).toMatchObject({
    ".": "./openapi/index.ts",
    "./native/protocol": "./native/protocol.ts",
    "./storage/ports": "./storage/ports.ts",
  });
  for (const version of [...Object.values(manifest.dependencies), ...Object.values(manifest.devDependencies)]) {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  }
  const contracts = await import("@crewroll/contracts");
  expect(contracts.ApiVersionSchema).toBeDefined();
});
