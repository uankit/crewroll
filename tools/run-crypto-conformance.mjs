#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const defaultRepositoryDirectory = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

class ConformanceError extends Error {
  constructor(message, properties) {
    super(message);
    this.name = "ConformanceError";
    Object.assign(this, properties);
  }
}

async function defaultHashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultResolveExecutable(name) {
  if (name === "java" && process.env.JAVA_HOME) {
    const javaHomeExecutable = join(process.env.JAVA_HOME, "bin", "java");
    if (await isExecutable(javaHomeExecutable)) {
      return javaHomeExecutable;
    }
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function defaultExecute({ command, args, cwd }) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(
          new ConformanceError(
            `conformance command ${command} terminated by ${signal}`,
            { code: "COMMAND_SIGNALLED", signal },
          ),
        );
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

async function requireFile(path, executable = false) {
  try {
    await access(path, executable ? constants.X_OK : constants.R_OK);
  } catch {
    throw new ConformanceError(
      `required conformance input is unavailable: ${path}`,
      {
        code: "MISSING_INPUT",
        path,
      },
    );
  }
}

async function requireExecutable(name, resolveExecutable) {
  const executable = await resolveExecutable(name);
  if (executable === null || executable.length === 0) {
    throw new ConformanceError(`required executable is unavailable: ${name}`, {
      code: "MISSING_EXECUTABLE",
      executable: name,
    });
  }
  if (!isAbsolute(executable)) {
    throw new ConformanceError(
      `executable resolver returned a non-absolute path for ${name}`,
      { code: "INVALID_EXECUTABLE", executable: name },
    );
  }
  return executable;
}

async function runInvocation(invocation, execute) {
  const exitCode = await execute(invocation);
  if (exitCode !== 0) {
    throw new ConformanceError(
      `conformance command failed with exit code ${exitCode}: ${invocation.command}`,
      { code: "COMMAND_FAILED", exitCode },
    );
  }
}

async function createRunDirectory(repositoryDirectory) {
  const stateRoot = join(
    repositoryDirectory,
    ".superpowers",
    "crypto-conformance",
  );
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  return mkdtemp(join(stateRoot, "run-"));
}

export async function runCryptoConformance({
  repositoryDirectory = defaultRepositoryDirectory,
  execute = defaultExecute,
  resolveExecutable = defaultResolveExecutable,
  hashFile = defaultHashFile,
} = {}) {
  const root = resolve(repositoryDirectory);
  const vitest = join(root, "node_modules", ".bin", "vitest");
  const swiftPackage = join(
    root,
    "packages/contracts/crypto/conformance/swift/Package.swift",
  );
  const kotlinRoot = join(root, "packages/contracts/crypto/conformance/kotlin");
  const gradleWrapper = join(kotlinRoot, "gradlew");
  const gradleLock = join(kotlinRoot, "gradle.lockfile");
  const verificationMetadata = join(
    kotlinRoot,
    "gradle/verification-metadata.xml",
  );

  await Promise.all([
    requireFile(vitest, true),
    requireFile(swiftPackage),
    requireFile(gradleWrapper, true),
    requireFile(gradleLock),
    requireFile(verificationMetadata),
  ]);

  const swift = await requireExecutable("swift", resolveExecutable);
  await requireExecutable("java", resolveExecutable);

  const lockedHashes = new Map(
    await Promise.all(
      [gradleLock, verificationMetadata].map(async (path) => [
        path,
        await hashFile(path),
      ]),
    ),
  );

  const runDirectory = await createRunDirectory(root);
  try {
    const invocations = [
      {
        command: vitest,
        args: [
          "run",
          "packages/contracts/test/crypto-vectors.test.ts",
          "packages/contracts/test/crypto-mutations.test.ts",
        ],
        cwd: repositoryDirectory,
      },
      {
        command: swift,
        args: [
          "test",
          "--package-path",
          "packages/contracts/crypto/conformance/swift",
          "--scratch-path",
          join(runDirectory, "swift-scratch"),
        ],
        cwd: repositoryDirectory,
      },
      {
        command: gradleWrapper,
        args: [
          "-p",
          "packages/contracts/crypto/conformance/kotlin",
          "--project-cache-dir",
          join(runDirectory, "kotlin-project-cache"),
          `-PcrewrollConformanceBuildDirectory=${join(
            runDirectory,
            "kotlin-build",
          )}`,
          "test",
          "--dependency-verification=strict",
          "--no-daemon",
        ],
        cwd: repositoryDirectory,
      },
    ];

    for (const invocation of invocations) {
      await runInvocation(invocation, execute);
    }

    for (const [path, expectedHash] of lockedHashes) {
      if ((await hashFile(path)) !== expectedHash) {
        throw new ConformanceError(
          `locked dependency input changed during conformance: ${path}`,
          { code: "LOCK_DRIFT", path },
        );
      }
    }
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
  try {
    await runCryptoConformance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode =
      typeof error === "object" &&
      error !== null &&
      "exitCode" in error &&
      Number.isInteger(error.exitCode)
        ? error.exitCode
        : 1;
  }
}
