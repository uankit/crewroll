import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { assertIdentity, identityFromConfigs } from "./app-identity.mjs";

const repositoryRoot = new URL("../", import.meta.url);
const snapshot = JSON.parse(
  await readFile(new URL("./app-identity.snapshot.json", import.meta.url), "utf8"),
);
const easConfig = JSON.parse(
  await readFile(new URL("../eas.json", import.meta.url), "utf8"),
);

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["expo", "config", "--type", "public", "--json"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (result.status !== 0) {
  throw new Error(
    `Unable to resolve Expo public config:\n${result.stderr || result.stdout}`,
  );
}

const publicConfig = JSON.parse(result.stdout);
assertIdentity(identityFromConfigs(publicConfig, easConfig), snapshot);
console.log("CrewRoll App Store, Play, and EAS identity is unchanged.");
