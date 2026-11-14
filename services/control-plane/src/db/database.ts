import { Kysely } from "kysely";
import { Pool } from "pg";

import type { Database } from "./schema/tables.js";
import { boundedPostgresPool } from "./boundedPostgresPool.js";
import { TransactionScopedPostgresDialect } from "./transactionScopedPostgresDialect.js";

export const interactiveDatabaseTimeouts = Object.freeze({
  queryTimeoutMillis: 15_000,
  statementTimeoutMillis: 10_000,
  lockTimeoutMillis: 5_000,
  idleTransactionTimeoutMillis: 15_000,
});

export function createDatabase(
  connectionString: string,
  options: Readonly<{
    maxConnections?: number;
    connectionTimeoutMillis?: number;
    queryTimeoutMillis?: number;
    statementTimeoutMillis?: number;
    lockTimeoutMillis?: number;
    idleTransactionTimeoutMillis?: number;
    transactionPooling?: boolean;
  }> = {},
): Kysely<Database> {
  if (connectionString.length === 0) {
    throw new Error("A PostgreSQL connection string is required");
  }

  return new Kysely<Database>({
    dialect: new TransactionScopedPostgresDialect(
      {
        pool: boundedPostgresPool(
          new Pool({
            application_name: "crewroll-control-plane",
            connectionString,
            max: options.maxConnections ?? 10,
            connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
            // Keep the shared migration factory bounded while allowing DDL more
            // time than interactive requests. API factories use a shorter deadline.
            // The dialect also applies server limits after BEGIN, on the same
            // origin transaction. A transaction pool must not rely on startup
            // GUCs carrying across pooled origin connections.
            query_timeout: options.queryTimeoutMillis ?? 120_000,
            ...(options.transactionPooling ||
            options.statementTimeoutMillis === undefined
              ? {}
              : { statement_timeout: options.statementTimeoutMillis }),
            ...(options.transactionPooling ||
            options.lockTimeoutMillis === undefined
              ? {}
              : { lock_timeout: options.lockTimeoutMillis }),
            ...(options.transactionPooling ||
            options.idleTransactionTimeoutMillis === undefined
              ? {}
              : {
                  idle_in_transaction_session_timeout:
                    options.idleTransactionTimeoutMillis,
                }),
          }),
        ),
      },
      options,
    ),
  });
}
