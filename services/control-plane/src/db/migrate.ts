import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Kysely } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";

import { createDatabase } from "./database.js";
import type { Database } from "./schema/tables.js";

const migrationFolder = fileURLToPath(
  new URL("./migrations/", import.meta.url),
);

export async function migrateToLatest(
  database: Kysely<Database>,
): Promise<void> {
  const provider = new FileMigrationProvider({ fs, path, migrationFolder });
  const migrator = new Migrator({ db: database, provider });
  const result = await migrator.migrateToLatest();

  if (result.error !== undefined) {
    throw new Error("CrewRoll database migration failed", {
      cause: result.error,
    });
  }
}

export async function main(source: NodeJS.ProcessEnv): Promise<number> {
  const connectionString = source.DATABASE_URL;

  if (typeof connectionString !== "string" || connectionString.length === 0) {
    return 1;
  }

  const database = createDatabase(connectionString);

  try {
    await migrateToLatest(database);
    return 0;
  } catch {
    return 1;
  } finally {
    await database.destroy();
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void main(process.env).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
