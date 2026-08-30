import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const EXPECTED_ANDROID_COORDINATES = [
  "com.goterl:lazysodium-android:5.2.0",
  "net.java.dev.jna:jna:5.17.0",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(file) {
  return sha256(await fs.readFile(file));
}

function resolveInside(root, portablePath) {
  if (typeof portablePath !== "string" || portablePath.includes("\\")) {
    throw new Error("native crypto lock contains a non-portable path");
  }
  const resolved = path.resolve(root, portablePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("native crypto lock escapes the repository");
  }
  return resolved;
}

async function assertFileHash(root, portablePath, expected) {
  const actual = await fileSha256(resolveInside(root, portablePath));
  if (actual !== expected) {
    throw new Error(`native crypto artifact hash mismatch: ${portablePath}`);
  }
}

async function walkFiles(root, directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const portablePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `native crypto inventory contains a symlink: ${portablePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolutePath, portablePath)));
    } else if (entry.isFile()) {
      files.push(portablePath);
    } else {
      throw new Error(
        `native crypto inventory contains a special file: ${portablePath}`,
      );
    }
  }
  return files;
}

async function inventory(root, portableRoot) {
  const absoluteRoot = resolveInside(root, portableRoot);
  const files = (await walkFiles(root, absoluteRoot)).sort();
  const digest = createHash("sha256");
  for (const portablePath of files) {
    digest.update(portablePath, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(
      createHash("sha256")
        .update(await fs.readFile(path.join(absoluteRoot, portablePath)))
        .digest(),
    );
  }
  return { fileCount: files.length, sha256: digest.digest("hex") };
}

function archiveEntrySha256(archive, entry) {
  try {
    return sha256(
      execFileSync("unzip", ["-p", archive, entry], {
        encoding: null,
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  } catch {
    throw new Error(`native crypto archive entry is unavailable: ${entry}`);
  }
}

export async function verifyNativeCryptoIntegrity(root) {
  const appleLock = JSON.parse(
    await fs.readFile(
      path.join(
        root,
        "modules/crewroll-transfer/ios/Vendor/native-crypto-lock.json",
      ),
      "utf8",
    ),
  );
  if (
    appleLock.schemaVersion !== 1 ||
    appleLock.swiftSodiumVersion !== "0.11.0" ||
    appleLock.libsodiumVersion !== "1.0.22"
  ) {
    throw new Error("Apple native crypto metadata is not the reviewed version");
  }
  const appleInventory = await inventory(root, appleLock.xcframeworkPath);
  if (
    appleInventory.fileCount !== appleLock.fileCount ||
    appleInventory.sha256 !== appleLock.inventorySha256
  ) {
    throw new Error("Apple native crypto inventory does not match its lock");
  }
  await assertFileHash(
    root,
    appleLock.macosSlicePath,
    appleLock.macosSliceSha256,
  );
  await assertFileHash(
    root,
    appleLock.infoPlistPath,
    appleLock.infoPlistSha256,
  );
  await assertFileHash(root, appleLock.licensePath, appleLock.licenseSha256);

  const versionHeader = await fs.readFile(
    path.join(
      root,
      appleLock.xcframeworkPath,
      "macos-arm64_arm64e_x86_64/Headers/Clibsodium/sodium/version.h",
    ),
    "utf8",
  );
  if (!versionHeader.includes('#define SODIUM_VERSION_STRING "1.0.22"')) {
    throw new Error("Apple vendored libsodium version header drifted");
  }
  const podspec = await fs.readFile(
    path.join(root, "modules/crewroll-transfer/ios/CrewRollTransfer.podspec"),
    "utf8",
  );
  if (
    !podspec.includes(
      "s.vendored_frameworks = 'Vendor/Clibsodium.xcframework'",
    ) ||
    !podspec.includes("'IdentityKeys/Sources/**/*.{h,m,mm,swift}'") ||
    !podspec.includes(
      `XCFramework inventory SHA-256: ${appleLock.inventorySha256}`,
    )
  ) {
    throw new Error("Apple production podspec is not bound to reviewed crypto");
  }

  const androidLock = JSON.parse(
    await fs.readFile(
      path.join(
        root,
        "modules/crewroll-transfer/android/Vendor/native-crypto-lock.json",
      ),
      "utf8",
    ),
  );
  if (
    androidLock.schemaVersion !== 1 ||
    !Array.isArray(androidLock.artifacts) ||
    androidLock.artifacts.length !== 2 ||
    JSON.stringify(
      androidLock.artifacts.map(({ coordinate }) => coordinate),
    ) !== JSON.stringify(EXPECTED_ANDROID_COORDINATES)
  ) {
    throw new Error("Android native crypto metadata is not the reviewed set");
  }

  const gradle = await fs.readFile(
    path.join(root, "modules/crewroll-transfer/android/build.gradle"),
    "utf8",
  );
  for (const artifact of androidLock.artifacts) {
    if (artifact.packaging !== "aar") {
      throw new Error("Android native crypto packaging must remain AAR");
    }
    await assertFileHash(root, artifact.path, artifact.sha256);
    await assertFileHash(root, artifact.licensePath, artifact.licenseSha256);
    if (artifact.selectedLicensePath) {
      await assertFileHash(
        root,
        artifact.selectedLicensePath,
        artifact.selectedLicenseSha256,
      );
    }
    const archive = resolveInside(root, artifact.path);
    if (
      archiveEntrySha256(archive, "classes.jar") !== artifact.classesJarSha256
    ) {
      throw new Error(`Android native classes drifted: ${artifact.coordinate}`);
    }
    if (
      artifact.aarMetadataSha256 &&
      archiveEntrySha256(
        archive,
        "META-INF/com/android/build/gradle/aar-metadata.properties",
      ) !== artifact.aarMetadataSha256
    ) {
      throw new Error(`Android AAR metadata drifted: ${artifact.coordinate}`);
    }
    const fileName = path.posix.basename(artifact.path);
    if (!gradle.includes(`implementation files('Vendor/${fileName}')`)) {
      throw new Error(
        `Android production Gradle binding is missing: ${fileName}`,
      );
    }
  }
  for (const coordinate of EXPECTED_ANDROID_COORDINATES) {
    if (gradle.includes(coordinate)) {
      throw new Error(
        "Android production Gradle must use only reviewed local AARs",
      );
    }
  }

  return {
    appleFileCount: appleInventory.fileCount,
    appleInventorySha256: appleInventory.sha256,
    appleMacosSliceSha256: appleLock.macosSliceSha256,
    appleInfoPlistSha256: appleLock.infoPlistSha256,
    appleLicenseSha256: appleLock.licenseSha256,
    lazysodiumAndroidSha256: androidLock.artifacts[0].sha256,
    lazysodiumClassesJarSha256: androidLock.artifacts[0].classesJarSha256,
    lazysodiumAarMetadataSha256: androidLock.artifacts[0].aarMetadataSha256,
    lazysodiumLicenseSha256: androidLock.artifacts[0].licenseSha256,
    jnaAndroidSha256: androidLock.artifacts[1].sha256,
    jnaClassesJarSha256: androidLock.artifacts[1].classesJarSha256,
    jnaLicenseSha256: androidLock.artifacts[1].licenseSha256,
    jnaSelectedLicenseSha256: androidLock.artifacts[1].selectedLicenseSha256,
  };
}
