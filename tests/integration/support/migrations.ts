import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";

import type { Database } from "../../../services/control-plane/src/db/schema/tables.js";

const migrationFolder = fileURLToPath(
  new URL(
    "../../../services/control-plane/src/db/migrations/",
    import.meta.url,
  ),
);

async function assertCanonicalMigrationFolder(): Promise<void> {
  const [folderStat, canonicalFolder] = await Promise.all([
    fs.lstat(migrationFolder),
    fs.realpath(migrationFolder),
  ]);

  if (
    folderStat.isSymbolicLink() ||
    !folderStat.isDirectory() ||
    canonicalFolder !== path.resolve(migrationFolder)
  ) {
    throw new Error("Canonical production migration folder is required");
  }
}

export async function migrateDown(database: Kysely<Database>): Promise<void> {
  await assertCanonicalMigrationFolder();

  const provider = new FileMigrationProvider({ fs, path, migrationFolder });
  const migrator = new Migrator({ db: database, provider });
  const result = await migrator.migrateDown();

  if (result.error !== undefined) {
    throw new Error("CrewRoll database rollback failed", {
      cause: result.error,
    });
  }
}
