import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { Database } from "./schema/tables.js";
import { boundedPostgresPool } from "./boundedPostgresPool.js";

export function createDatabase(
  connectionString: string,
  options: Readonly<{
    maxConnections?: number;
    connectionTimeoutMillis?: number;
    queryTimeoutMillis?: number;
    statementTimeoutMillis?: number;
    lockTimeoutMillis?: number;
    idleTransactionTimeoutMillis?: number;
  }> = {},
): Kysely<Database> {
  if (connectionString.length === 0) {
    throw new Error("A PostgreSQL connection string is required");
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: boundedPostgresPool(
        new Pool({
          application_name: "crewroll-control-plane",
          connectionString,
          max: options.maxConnections ?? 10,
          connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
          // Keep the shared migration factory bounded while allowing DDL more
          // time than interactive requests. API factories use a shorter deadline.
          // This is a client deadline; origin statement limits are configured
          // separately, including for Hyperdrive's pooled database connections.
          query_timeout: options.queryTimeoutMillis ?? 120_000,
          ...(options.statementTimeoutMillis === undefined
            ? {}
            : { statement_timeout: options.statementTimeoutMillis }),
          ...(options.lockTimeoutMillis === undefined
            ? {}
            : { lock_timeout: options.lockTimeoutMillis }),
          ...(options.idleTransactionTimeoutMillis === undefined
            ? {}
            : {
                idle_in_transaction_session_timeout:
                  options.idleTransactionTimeoutMillis,
              }),
        }),
      ),
    }),
  });
}
