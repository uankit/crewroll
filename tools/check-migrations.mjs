import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyMigrationContract } from "./migration-contract.mjs";
import { analyzeStartupGraph } from "./startup-import-policy.mjs";
import { analyzeMigrationRunner } from "./migration-runner-policy.mjs";
import { analyzeMigrationModules } from "./migration-policy.mjs";

const messages = {
  dormant:
    "CrewRoll migration check: dormant — DB-001 has not activated a complete migration and real-PostgreSQL integration contract; no migration source was analyzed, and no safety or reversibility claim is made.",
  partial:
    "CrewRoll migration check: partial DB-001 activation — complete the exact migration and integration contract atomically.",
  internal: "CrewRoll migration check: internal policy error.",
  rejected: (count) =>
    `CrewRoll migration check: rejected with ${count} deterministic finding(s); the static known-risk policy did not pass.`,
  active: (count) =>
    `CrewRoll migration check: known-risk static policy passed for ${count} contiguous migration(s); this is not proof of safety, reversibility, PostgreSQL compatibility, or runtime success — DB-001 integration tests remain authoritative.`,
  usage: "CrewRoll migration check: this command takes no arguments.",
};

function print(message, stream) {
  stream.write(`${message}\n`);
}

export async function runMigrationCheck({
  argv = process.argv,
  moduleUrl = import.meta.url,
  stdout = process.stdout,
  stderr = process.stderr,
  fsAdapter,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 2) {
    print(messages.usage, stderr);
    return 64;
  }

  try {
    const rootPath = fileURLToPath(new URL("../", moduleUrl));
    const startup = await analyzeStartupGraph({ rootPath, fsAdapter });
    const contract = await classifyMigrationContract({ rootPath, fsAdapter });

    if (contract.state === "internal") {
      print(messages.internal, stderr);
      return 70;
    }
    if (contract.state === "partial") {
      print(messages.partial, stderr);
      return 65;
    }
    if (contract.state === "dormant") {
      if (startup.findings.length > 0) {
        print(messages.rejected(startup.findings.length), stderr);
        return 65;
      }
      print(messages.dormant, stdout);
      return 0;
    }

    const runner = await analyzeMigrationRunner({ rootPath, fsAdapter });
    const migrations = await analyzeMigrationModules({
      rootPath,
      migrationFiles: contract.migrationFiles,
      fsAdapter,
    });
    const findingCount =
      startup.findings.length +
      runner.findings.length +
      migrations.findings.length;
    if (findingCount > 0) {
      print(messages.rejected(findingCount), stderr);
      return 65;
    }

    print(messages.active(migrations.migrationCount), stdout);
    return 0;
  } catch {
    print(messages.internal, stderr);
    return 70;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await runMigrationCheck();
}
