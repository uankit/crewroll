import { fileURLToPath } from "node:url";

import { classifyMigrationContract } from "./migration-contract.mjs";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const messages = {
  dormant:
    "CrewRoll migration check: dormant — DB-001 has not activated a complete migration and real-PostgreSQL integration contract; no migration source was analyzed, and no safety or reversibility claim is made.",
  partial:
    "CrewRoll migration check: partial DB-001 activation — complete the exact migration and integration contract atomically.",
  internal: "CrewRoll migration check: internal policy error.",
  complete:
    "CrewRoll migration check: complete DB-001 topology detected, but FND-002B2b-ii-c final static-analyzer composition is not installed; refusing activation.",
  usage: "CrewRoll migration check: this command takes no arguments.",
};

function print(message, stream) {
  stream.write(`${message}\n`);
}

if (process.argv.length !== 2) {
  print(messages.usage, process.stderr);
  process.exitCode = 64;
} else {
  const contract = await classifyMigrationContract({ rootPath });
  if (contract.state === "dormant") {
    print(messages.dormant, process.stdout);
  } else if (contract.state === "partial") {
    print(messages.partial, process.stderr);
    process.exitCode = 65;
  } else if (contract.state === "complete") {
    print(messages.complete, process.stderr);
    process.exitCode = 65;
  } else {
    print(messages.internal, process.stderr);
    process.exitCode = 70;
  }
}
