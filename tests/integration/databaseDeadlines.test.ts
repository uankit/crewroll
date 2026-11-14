import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
