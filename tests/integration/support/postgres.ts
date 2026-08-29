import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql, type Kysely } from "kysely";

import { createDatabase } from "../../../services/control-plane/src/db/database.js";
import { migrateToLatest } from "../../../services/control-plane/src/db/migrate.js";
import type { Database } from "../../../services/control-plane/src/db/schema/tables.js";

const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const EXTERNAL_POSTGRES_OPT_IN = "DISPOSABLE_LOOPBACK_ONLY";

const OWNED_TABLES = [
  "clerk_webhook_events",
  "audit_events",
  "api_idempotency",
  "outbox_events",
  "inbox_events",
  "receipts",
  "deliveries",
  "asset_objects",
  "assets",
  "upload_objects",
  "upload_sessions",
  "trip_key_envelopes",
  "trip_members",
  "trip_invites",
  "user_active_trips",
  "trips",
  "devices",
  "users",
] as const;

export interface PostgresTestContext {
  readonly container?: StartedPostgreSqlContainer;
  readonly db: Kysely<Database>;
  readonly runtime: "external-loopback" | "testcontainers";
  stop(): Promise<void>;
}

export interface StartMigratedPostgresOptions {
  readonly databaseFactory?: typeof createDatabase;
  readonly onContainerStarted?: (container: StartedPostgreSqlContainer) => void;
}

export function resolveExplicitExternalPostgresUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const connectionString = environment.CREWROLL_TEST_EXTERNAL_POSTGRES_URL;
  const optIn = environment.CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN;

  if (connectionString === undefined && optIn === undefined) return null;
  if (connectionString === undefined || optIn !== EXTERNAL_POSTGRES_OPT_IN) {
    throw new Error(
      "External CrewRoll PostgreSQL requires an explicit disposable-loopback opt-in",
    );
  }

  const parsed = new URL(connectionString);
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55432" ||
    !["/postgres", "/crewroll_test_task4_green"].includes(parsed.pathname) ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "External CrewRoll PostgreSQL must be the approved disposable loopback cluster",
    );
  }

  return connectionString;
}

export function usesExplicitExternalPostgres(): boolean {
  return resolveExplicitExternalPostgresUrl() !== null;
}

export async function startMigratedPostgres({
  databaseFactory = createDatabase,
  onContainerStarted,
}: StartMigratedPostgresOptions = {}): Promise<PostgresTestContext> {
  const externalConnectionString = resolveExplicitExternalPostgresUrl();
  if (externalConnectionString !== null) {
    const externalDb = databaseFactory(externalConnectionString);

    try {
      await migrateToLatest(externalDb);
    } catch (error) {
      await externalDb.destroy();
      throw error;
    }

    return {
      db: externalDb,
      runtime: "external-loopback",
      async stop() {
        await externalDb.destroy();
      },
    };
  }

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
    runtime: "testcontainers",
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
