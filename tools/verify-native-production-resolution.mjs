import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contractsDist = path.join(root, "packages", "contracts", "dist");
const bundleDist = path.join(root, "dist");
const adapterBundle = path.join(bundleDist, "native-adapter.ios.js");
const runtimeExports = [
  ["@crewroll/contracts", "installCrewRollFormats"],
  ["@crewroll/contracts/native/protocol", "ActivateTripCommandSchema"],
];

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runtimeImport(specifier, expectedExport) {
  return run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const loaded = await import(${JSON.stringify(specifier)}); if (!Object.hasOwn(loaded, ${JSON.stringify(expectedExport)})) throw new Error(${JSON.stringify(`Missing ${expectedExport} from ${specifier}`)});`,
  ]);
}

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function buildNpmCliInvocation({ execPath, npmExecPath }) {
  if (typeof npmExecPath !== "string" || npmExecPath.trim() === "") {
    throw new TypeError(
      "npm_execpath must be a non-empty path to the npm CLI.",
    );
  }

  return {
    command: execPath,
    args: [npmExecPath, "run", "verify:bundle"],
  };
}

async function verifyNativeProductionResolution() {
  const bundleInvocation = buildNpmCliInvocation({
    execPath: process.execPath,
    npmExecPath: process.env.npm_execpath,
  });

  await rm(contractsDist, { recursive: true, force: true });
  await rm(bundleDist, { recursive: true, force: true });

  for (const [specifier, expectedExport] of runtimeExports) {
    const cleanResolution = runtimeImport(specifier, expectedExport);
    assert.notEqual(
      cleanResolution.status,
      0,
      `${specifier} unexpectedly resolved without contracts dist`,
    );
    assert.match(
      commandOutput(cleanResolution),
      /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/u,
    );
  }

  const bundleVerification = run(
    bundleInvocation.command,
    bundleInvocation.args,
  );
  assert.equal(
    bundleVerification.status,
    0,
    `production bundle verification failed:\n${commandOutput(bundleVerification)}`,
  );

  for (const [specifier, expectedExport] of runtimeExports) {
    const builtResolution = runtimeImport(specifier, expectedExport);
    assert.equal(
      builtResolution.status,
      0,
      `${specifier} did not resolve after verify:bundle lifecycle:\n${commandOutput(builtResolution)}`,
    );
  }

  const bundleStats = await stat(adapterBundle);
  assert.ok(
    bundleStats.size > 1_000,
    "native adapter bundle is unexpectedly empty",
  );
  const bundleSource = await readFile(adapterBundle, "utf8");
  assert.match(bundleSource, /ERR_CREWROLL_NATIVE_PROTOCOL/u);
  assert.match(bundleSource, /CrewRollTransfer/u);

  console.log(
    "Clean production lifecycle rebuilt both contract exports and bundled the native adapter graph.",
  );
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) await verifyNativeProductionResolution();
