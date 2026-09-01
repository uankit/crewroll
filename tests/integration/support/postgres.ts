import { sql, type Kysely } from "kysely";
import { Client } from "pg";

import { createDatabase } from "../../../services/control-plane/src/db/database.js";
import { migrateToLatest } from "../../../services/control-plane/src/db/migrate.js";
import type { Database } from "../../../services/control-plane/src/db/schema/tables.js";

const EXTERNAL_POSTGRES_OPT_IN = "DISPOSABLE_LOOPBACK_ONLY";
const EXTERNAL_POSTGRES_URL =
  "postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17";
const PROCESS_LOCK_KEY = 1_123_955_636;

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
  readonly connectionString: string;
  readonly db: Kysely<Database>;
  stop(): Promise<void>;
}

export interface StartMigratedPostgresOptions {
  readonly databaseFactory?: typeof createDatabase;
}

export interface ProcessLockConnection {
  close(): Promise<void>;
  unlock(): Promise<void>;
}

export type ProcessLockConnectionFactory = (
  connectionString: string,
) => Promise<ProcessLockConnection>;

export interface ProcessLockCoordinator {
  acquire(connectionString: string): Promise<() => Promise<void>>;
}

interface ProcessLock {
  readonly connection: ProcessLockConnection;
  references: number;
}

async function createProcessLockConnection(
  connectionString: string,
): Promise<ProcessLockConnection> {
  const client = new Client({
    application_name: "crewroll-integration-process-lock",
    connectionString,
  });
  await client.connect();

  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1) as acquired",
      [PROCESS_LOCK_KEY],
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error(
        "Another CrewRoll integration process owns the dedicated PostgreSQL database",
      );
    }
  } catch (error) {
    await client.end();
    throw error;
  }

  return {
    close: () => client.end(),
    async unlock() {
      await client.query("select pg_advisory_unlock($1)", [PROCESS_LOCK_KEY]);
    },
  };
}

export function createProcessLockCoordinator(
  createConnection: ProcessLockConnectionFactory,
): ProcessLockCoordinator {
  let processLock: ProcessLock | undefined;
  let transition: Promise<void> = Promise.resolve();

  function serialize<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = transition.then(operation, operation);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    acquire(connectionString) {
      return serialize(async () => {
        if (processLock === undefined) {
          processLock = {
            connection: await createConnection(connectionString),
            references: 0,
          };
        }

        const acquiredLock = processLock;
        acquiredLock.references += 1;
        let released = false;

        return async () => {
          if (released) return;
          released = true;

          await serialize(async () => {
            acquiredLock.references -= 1;
            if (acquiredLock.references !== 0) return;

            try {
              await acquiredLock.connection.unlock();
            } finally {
              try {
                await acquiredLock.connection.close();
              } finally {
                if (processLock === acquiredLock) processLock = undefined;
              }
            }
          });
        };
      });
    },
  };
}

const processLockCoordinator = createProcessLockCoordinator(
  createProcessLockConnection,
);

export function resolveExplicitExternalPostgresUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const connectionString = environment.CREWROLL_TEST_EXTERNAL_POSTGRES_URL;
  const optIn = environment.CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN;

  if (connectionString === undefined || optIn !== EXTERNAL_POSTGRES_OPT_IN) {
    throw new Error(
      "External CrewRoll PostgreSQL requires an explicit disposable-loopback opt-in",
    );
  }

  if (connectionString !== EXTERNAL_POSTGRES_URL) {
    throw new Error(
      "External CrewRoll PostgreSQL must be the approved disposable loopback cluster",
    );
  }

  return connectionString;
}

export function assertPostgres17Version(
  versionNumber: string | undefined,
): void {
  const numericVersion = Number(versionNumber);

  if (
    versionNumber === undefined ||
    !/^\d+$/.test(versionNumber) ||
    !Number.isSafeInteger(numericVersion) ||
    Math.floor(numericVersion / 10_000) !== 17
  ) {
    throw new Error("PostgreSQL 17 is required for CrewRoll integration tests");
  }
}

export async function assertPostgres17(db: Kysely<Database>): Promise<void> {
  const result = await sql<{ server_version_num: string }>`
    show server_version_num
  `.execute(db);
  assertPostgres17Version(result.rows[0]?.server_version_num);
}

export async function startMigratedPostgres({
  databaseFactory = createDatabase,
}: StartMigratedPostgresOptions = {}): Promise<PostgresTestContext> {
  const connectionString = resolveExplicitExternalPostgresUrl();
  const db = databaseFactory(connectionString);
  let releaseProcessLock: (() => Promise<void>) | undefined;

  try {
    releaseProcessLock = await processLockCoordinator.acquire(connectionString);
    await assertPostgres17(db);
    await migrateToLatest(db);
  } catch (error) {
    try {
      await db.destroy();
    } finally {
      await releaseProcessLock?.();
    }
    throw error;
  }

  return {
    connectionString,
    db,
    async stop() {
      try {
        await db.destroy();
      } finally {
        await releaseProcessLock?.();
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
