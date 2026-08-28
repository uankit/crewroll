import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("builds a plain-Node control-plane package without test or config artifacts", () => {
  const workspace = new URL("../", import.meta.url);
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { existsSync } from "node:fs";
        const resolved = import.meta.resolve("@crewroll/control-plane");
        if (!resolved.endsWith("/dist/src/index.js")) throw new Error("resolved to " + resolved);
        const runtime = await import("@crewroll/control-plane");
        if (runtime.controlPlaneWorkspace.apiVersion !== "v1") throw new Error("runtime export missing");
        for (const forbidden of ["dist/test", "dist/vitest.config.js", "dist/eslint.config.js"]) {
          if (existsSync(forbidden)) throw new Error("build published " + forbidden);
        }
        process.stdout.write("plain-node-import-ok");
      `,
    ],
    { cwd: workspace, encoding: "utf8" },
  );

  expect(result).toBe("plain-node-import-ok");
});
