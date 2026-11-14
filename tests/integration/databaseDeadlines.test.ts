import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../services/control-plane/src/db/database.js";
import {
  startMigratedPostgres,
  type PostgresTestContext,
} from "./support/postgres.js";

describe("database server deadlines", () => {
  let context: PostgresTestContext;
  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  afterAll(async () => {
    await context?.stop();
  });

  it("cancels a slow statement on PostgreSQL and leaves the pool usable", async () => {
    const database = createDatabase(context.connectionString, {
      maxConnections: 1,
      queryTimeoutMillis: 1_000,
      statementTimeoutMillis: 50,
      lockTimeoutMillis: 25,
      idleTransactionTimeoutMillis: 1_000,
    });
    try {
      await expect(
        sql`select pg_sleep(5)`.execute(database),
      ).rejects.toMatchObject({
        code: "57014",
      });
      const recovered = await sql<{
        result: number;
      }>`select 1 as result`.execute(database);
      expect(recovered.rows).toEqual([{ result: 1 }]);
    } finally {
      await database.destroy();
    }
  });

  it("bounds row-lock waits and rolls back before retrying the connection", async () => {
    const database = createDatabase(context.connectionString, {
      maxConnections: 1,
      queryTimeoutMillis: 1_000,
      statementTimeoutMillis: 1_000,
      lockTimeoutMillis: 50,
    });
    let release!: () => void;
    let locked!: () => void;
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = context.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(9934512)`.execute(tx);
      locked();
      await releaseLock;
    });
    try {
      await lockAcquired;
      await sql`select set_config('lock_timeout', '0', false)`.execute(
        database,
      );
      await expect(
        database.transaction().execute(async (tx) => {
          await sql`select pg_advisory_xact_lock(9934512)`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      const recovered = await sql<{
        result: number;
      }>`select 1 as result`.execute(database);
      expect(recovered.rows).toEqual([{ result: 1 }]);
    } finally {
      release();
      await holder;
      await database.destroy();
    }
  });

  it("reapplies limits after a transaction-pool reset and does not leak them after commit", async () => {
    const database = createDatabase(context.connectionString, {
      maxConnections: 1,
      queryTimeoutMillis: 1_000,
      statementTimeoutMillis: 60,
      lockTimeoutMillis: 25,
      idleTransactionTimeoutMillis: 1_000,
      transactionPooling: true,
    });
    const settings = sql<{
      statement: string;
      lock: string;
      idle: string;
    }>`select current_setting('statement_timeout') as statement,
      current_setting('lock_timeout') as lock,
      current_setting('idle_in_transaction_session_timeout') as idle`;
    try {
      expect((await settings.execute(database)).rows).toEqual([
        { statement: "0", lock: "0", idle: "0" },
      ]);
      // Model an origin connection whose previous transaction settings were
      // reset by Hyperdrive. Startup connection parameters alone cannot pass.
      await sql`select set_config('statement_timeout', '0', false),
        set_config('lock_timeout', '0', false),
        set_config('idle_in_transaction_session_timeout', '0', false)`.execute(
        database,
      );
      await database.transaction().execute(async (tx) => {
        expect((await settings.execute(tx)).rows).toEqual([
          { statement: "60ms", lock: "25ms", idle: "1s" },
        ]);
      });
      expect((await settings.execute(database)).rows).toEqual([
        { statement: "0", lock: "0", idle: "0" },
      ]);
      await expect(
        database.transaction().execute(async (tx) => {
          await sql`select pg_sleep(5)`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: "57014" });
      expect((await settings.execute(database)).rows).toEqual([
        { statement: "0", lock: "0", idle: "0" },
      ]);
    } finally {
      await database.destroy();
    }
  });

  it("discards a connection killed while its transaction is idle and recovers", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const database = createDatabase(context.connectionString, {
      maxConnections: 1,
      queryTimeoutMillis: 1_000,
      idleTransactionTimeoutMillis: 50,
    });
    let originalPid: number | undefined;
    try {
      await expect(
        database.transaction().execute(async (tx) => {
          originalPid = (
            await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
              tx,
            )
          ).rows[0]?.pid;
          await new Promise((resolve) => setTimeout(resolve, 200));
          await sql`select 1`.execute(tx);
        }),
      ).rejects.toThrow(/not queryable|Connection terminated/i);
      expect(logged).toHaveBeenCalledWith(
        JSON.stringify({ event: "database_active_connection_failed" }),
      );
      const recovered = await sql<{
        pid: number;
      }>`select pg_backend_pid() as pid`.execute(database);
      expect(originalPid).toEqual(expect.any(Number));
      expect(recovered.rows[0]?.pid).not.toBe(originalPid);
      expect(
        (await sql<{ result: number }>`select 1 as result`.execute(database))
          .rows,
      ).toEqual([{ result: 1 }]);
    } finally {
      await database.destroy();
      logged.mockRestore();
    }
  });
});
