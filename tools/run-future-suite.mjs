import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FUTURE_SUITE_EXIT_CODES,
  classifyFutureSuiteRepository,
  getFutureSuiteDefinition,
} from "./future-suite-policy.mjs";

const productionProbe = (executable, args, options) =>
  spawnSync(executable, args, options);
const productionSpawn = (executable, args, options) =>
  spawnSync(executable, args, options);
const productionStderr = (message) => process.stderr.write(`${message}\n`);

function emit(stderr, message) {
  try {
    stderr(message);
    return true;
  } catch {
    return false;
  }
}

function internal(stderr, definition) {
  const prefix = definition
    ? `future-suite ${definition.suite} internal ${definition.ownerTask}`
    : "future-suite internal";
  emit(stderr, `${prefix}: internal dispatcher failure.`);
  return FUTURE_SUITE_EXIT_CODES.internal;
}

function unavailable(stderr, definition) {
  if (
    !emit(
      stderr,
      `future-suite ${definition.suite} unavailable ${definition.ownerTask}: required host, toolchain, or environment is unavailable.`,
    )
  ) {
    return FUTURE_SUITE_EXIT_CODES.internal;
  }
  return FUTURE_SUITE_EXIT_CODES.unavailable;
}

function nonemptyEnvironmentValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function mapProbe(probe, executable, args, options) {
  let result;
  try {
    result = await probe(executable, args, options);
  } catch (error) {
    return error?.code === "ENOENT" ? "unavailable" : "internal";
  }

  if (result === null || typeof result !== "object") return "internal";
  if (result.error !== undefined && result.error !== null) {
    return result.error?.code === "ENOENT" ? "unavailable" : "internal";
  }
  if (result.signal !== undefined && result.signal !== null) {
    return "unavailable";
  }
  if (result.status === null) return "unavailable";
  if (!Number.isInteger(result.status)) return "internal";
  return result.status === 0 ? "available" : "unavailable";
}

async function inspectDirectory(path) {
  try {
    return (await stat(path)).isDirectory() ? "available" : "unavailable";
  } catch (error) {
    if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) {
      return "unavailable";
    }
    return "internal";
  }
}

async function checkAvailability({ definition, root, env, platform, probe }) {
  const npmExecPath = env?.npm_execpath;
  if (!nonemptyEnvironmentValue(npmExecPath)) return "unavailable";

  const probeOptions = {
    cwd: root,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  };
  const npmResult = await mapProbe(
    probe,
    process.execPath,
    [npmExecPath, "--version"],
    probeOptions,
  );
  if (npmResult !== "available") return npmResult;

  switch (definition.suite) {
    case "integration":
      return mapProbe(
        probe,
        process.execPath,
        [join(root, "node_modules/vitest/vitest.mjs"), "--version"],
        probeOptions,
      );
    case "native-ios": {
      if (platform !== "darwin") return "unavailable";
      const swift = await mapProbe(probe, "swift", ["--version"], probeOptions);
      if (swift !== "available") return swift;
      return mapProbe(probe, "xcodebuild", ["-version"], probeOptions);
    }
    case "native-android": {
      const java = await mapProbe(probe, "java", ["-version"], probeOptions);
      if (java !== "available") return java;
      const sdkRoots = [env?.ANDROID_HOME, env?.ANDROID_SDK_ROOT].filter(
        nonemptyEnvironmentValue,
      );
      if (sdkRoots.length === 0) return "unavailable";

      let unexpectedDirectoryResult = false;
      for (const sdkRoot of sdkRoots) {
        const directory = await inspectDirectory(sdkRoot);
        if (directory === "available") return "available";
        if (directory === "internal") unexpectedDirectoryResult = true;
      }
      return unexpectedDirectoryResult ? "internal" : "unavailable";
    }
    case "e2e":
      return mapProbe(probe, "maestro", ["--version"], probeOptions);
    case "load":
      if (
        !nonemptyEnvironmentValue(env?.CREWROLL_STAGING_URL) ||
        !nonemptyEnvironmentValue(env?.CREWROLL_LOAD_AUTH_FIXTURE)
      ) {
        return "unavailable";
      }
      return mapProbe(probe, "k6", ["version"], probeOptions);
    default:
      return "internal";
  }
}

async function invokePrivateSuite({ definition, root, npmExecPath, spawn }) {
  let result;
  try {
    result = await spawn(
      process.execPath,
      [npmExecPath, "run", definition.privateScript],
      {
        cwd: root,
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
  } catch {
    return { kind: "internal" };
  }

  if (
    result === null ||
    typeof result !== "object" ||
    (result.error !== undefined && result.error !== null) ||
    (result.signal !== undefined && result.signal !== null) ||
    result.status === null ||
    !Number.isInteger(result.status)
  ) {
    return { kind: "internal" };
  }

  return { kind: "status", status: result.status };
}

export async function dispatchFutureSuite({
  args = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  probe = productionProbe,
  spawn = productionSpawn,
  stderr = productionStderr,
} = {}) {
  let definition;
  try {
    if (!Array.isArray(args) || args.length !== 1) {
      if (
        !emit(stderr, "future-suite usage: expected exactly one known suite.")
      ) {
        return FUTURE_SUITE_EXIT_CODES.internal;
      }
      return FUTURE_SUITE_EXIT_CODES.usage;
    }

    definition = getFutureSuiteDefinition(args[0]);
    if (!definition) {
      if (
        !emit(stderr, "future-suite usage: expected exactly one known suite.")
      ) {
        return FUTURE_SUITE_EXIT_CODES.internal;
      }
      return FUTURE_SUITE_EXIT_CODES.usage;
    }

    const repository = await classifyFutureSuiteRepository(definition.suite);
    if (repository.state === "dormant") {
      if (
        !emit(
          stderr,
          `future-suite ${definition.suite} dormant ${definition.ownerTask}: owner task has not activated the complete harness.`,
        )
      ) {
        return FUTURE_SUITE_EXIT_CODES.internal;
      }
      return FUTURE_SUITE_EXIT_CODES.dormant;
    }

    if (repository.state === "partial") {
      if (
        !emit(
          stderr,
          `future-suite ${definition.suite} partial ${definition.ownerTask}: incomplete repository contract classes ${repository.contractClasses.join(",")}.`,
        )
      ) {
        return FUTURE_SUITE_EXIT_CODES.internal;
      }
      return FUTURE_SUITE_EXIT_CODES.partial;
    }

    if (repository.state !== "active") return internal(stderr, definition);

    const availability = await checkAvailability({
      definition,
      root: repository.root,
      env,
      platform,
      probe,
    });
    if (availability === "unavailable") return unavailable(stderr, definition);
    if (availability !== "available") return internal(stderr, definition);

    const child = await invokePrivateSuite({
      definition,
      root: repository.root,
      npmExecPath: env.npm_execpath,
      spawn,
    });
    if (child.kind !== "status") {
      return internal(stderr, definition);
    }
    return child.status;
  } catch {
    return internal(stderr, definition);
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await dispatchFutureSuite();
}
