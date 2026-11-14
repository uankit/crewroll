import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Runs the actual JVM suite; device/OS acceptance remains a separate gate. */
export function runAndroidNativeTests({
  run = spawnSync,
  platform = process.platform,
} = {}) {
  const wrapper = path.join(
    root,
    "packages/contracts/crypto/conformance/kotlin",
    platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  const result = run(
    wrapper,
    [
      "-p",
      path.join(root, "modules/crewroll-transfer/android/native-key-tests"),
      "--no-daemon",
      "--max-workers=1",
      "test",
    ],
    { cwd: root, env: process.env, stdio: "inherit", timeout: 600_000 },
  );
  if (result.error || result.signal || result.status === null) {
    console.error(
      "Android native tests did not complete. Check Java 21, Gradle, and available disk space.",
    );
    return 1;
  }
  return result.status;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runAndroidNativeTests();
}
