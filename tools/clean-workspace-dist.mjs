import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const workspace = process.cwd();
const manifest = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8"));
const allowed = new Set(["@crewroll/contracts", "@crewroll/control-plane"]);

if (!allowed.has(manifest.name)) {
  throw new Error(`Refusing to clean dist for unexpected package ${String(manifest.name)}`);
}

await rm(resolve(workspace, "dist"), { recursive: true, force: true });
