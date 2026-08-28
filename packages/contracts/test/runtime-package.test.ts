import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("builds a plain-Node runtime package with only approved dist exports", () => {
  const workspace = new URL("../", import.meta.url);
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { existsSync } from "node:fs";
        const expected = [
          ["@crewroll/contracts", "/dist/openapi/index.js"],
          ["@crewroll/contracts/fixtures/http", "/dist/fixtures/http.js"],
          ["@crewroll/contracts/crypto/protocol", "/dist/crypto/protocol.js"],
          ["@crewroll/contracts/native/protocol", "/dist/native/protocol.js"],
          ["@crewroll/contracts/storage/ports", "/dist/storage/ports.js"],
        ];
        for (const [specifier, suffix] of expected) {
          const resolved = import.meta.resolve(specifier);
          if (!resolved.endsWith(suffix)) throw new Error(specifier + " resolved to " + resolved);
          await import(specifier);
        }
        for (const forbidden of ["dist/test", "dist/generator", "dist/vitest.config.js"]) {
          if (existsSync(forbidden)) throw new Error("build published " + forbidden);
        }
        process.stdout.write("plain-node-import-ok");
      `,
    ],
    { cwd: workspace, encoding: "utf8" },
  );

  expect(result).toBe("plain-node-import-ok");
});
