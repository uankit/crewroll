import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql, type Kysely } from "kysely";

import { createDatabase } from "../../../services/control-plane/src/db/database.js";
import { migrateToLatest } from "../../../services/control-plane/src/db/migrate.js";
import type { Database } from "../../../services/control-plane/src/db/schema/tables.js";

const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";

const OWNED_TABLES = [
  "trip_key_envelopes",
  "trip_members",
  "trip_invites",
  "user_active_trips",
  "trips",
  "devices",
  "users",
] as const;

export interface PostgresTestContext {
  readonly container: StartedPostgreSqlContainer;
  readonly db: Kysely<Database>;
  stop(): Promise<void>;
}

export interface StartMigratedPostgresOptions {
  readonly databaseFactory?: typeof createDatabase;
  readonly onContainerStarted?: (container: StartedPostgreSqlContainer) => void;
}

export async function startMigratedPostgres({
  databaseFactory = createDatabase,
  onContainerStarted,
}: StartMigratedPostgresOptions = {}): Promise<PostgresTestContext> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("crewroll_test")
    .withUsername("crewroll")
    .withPassword("crewroll_test_only")
    .start();
  let db: Kysely<Database>;

  try {
    onContainerStarted?.(container);
    db = databaseFactory(container.getConnectionUri());
  } catch (error) {
    await container.stop();
    throw error;
  }

  try {
    await migrateToLatest(db);
  } catch (error) {
    try {
      await db?.destroy();
    } finally {
      await container.stop();
    }
    throw error;
  }

  return {
    container,
    db,
    async stop() {
      try {
        await db.destroy();
      } finally {
        await container.stop();
      }
    },
  };
}

export async function truncateIdentityTripTables(
  db: Kysely<Database>,
): Promise<void> {
  await sql`
    truncate table ${sql.join(
      OWNED_TABLES.map((table) => sql.table(table)),
      sql`, `,
    )} restart identity cascade
  `.execute(db);
}
