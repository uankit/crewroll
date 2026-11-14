import {
  type CompiledQuery,
  type DatabaseConnection,
  type PostgresPool,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import { TransactionScopedPostgresDialect } from "../../src/db/transactionScopedPostgresDialect.js";

const unusedPool: PostgresPool = {
  options: {},
  connect() {
    return Promise.reject(new Error("Unexpected pool access"));
  },
  end: () => Promise.resolve(),
};

function connection(fail?: (query: CompiledQuery) => Error | undefined) {
  const calls: CompiledQuery[] = [];
  const value: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      calls.push(query);
      const error = fail?.(query);
      return error ? Promise.reject(error) : Promise.resolve({ rows: [] });
    },
    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("Unexpected cursor access");
    },
  };
  return { calls, value };
}

describe("transaction-scoped database limits", () => {
  it("keeps migrations without interactive limits and preserves transaction settings", async () => {
    const driver = new TransactionScopedPostgresDialect(
      { pool: unusedPool },
      {},
    ).createDriver();
    const peer = connection();
    await driver.beginTransaction(peer.value, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(peer.calls.map((query) => query.sql)).toEqual([
      "start transaction isolation level repeatable read read only",
    ]);
  });

  it("configures only the new transaction with bound millisecond values", async () => {
    const driver = new TransactionScopedPostgresDialect(
      { pool: unusedPool },
      {
        statementTimeoutMillis: 10_000,
        lockTimeoutMillis: 5_000,
        idleTransactionTimeoutMillis: 15_000,
      },
    ).createDriver();
    const peer = connection();
    await driver.beginTransaction(peer.value, {});
    expect(peer.calls).toHaveLength(2);
    expect(peer.calls[0]?.sql).toBe("begin");
    expect(peer.calls[1]?.sql).toContain(
      "set_config('lock_timeout', $2, true)",
    );
    expect(peer.calls[1]?.parameters).toEqual(["10000ms", "5000ms", "15000ms"]);
  });

  it("rolls back a configuration failure before returning the original error", async () => {
    const failure = new Error("configuration unavailable");
    const peer = connection((query) =>
      query.sql.startsWith("select set_config") ? failure : undefined,
    );
    const driver = new TransactionScopedPostgresDialect(
      { pool: unusedPool },
      { lockTimeoutMillis: 5_000 },
    ).createDriver();
    await expect(driver.beginTransaction(peer.value, {})).rejects.toBe(failure);
    expect(peer.calls.map((query) => query.sql)).toEqual([
      "begin",
      "select set_config('lock_timeout', $1, true)",
      "rollback",
    ]);
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])(
    "rejects an invalid server budget %s before connecting",
    (value) => {
      expect(() =>
        new TransactionScopedPostgresDialect(
          { pool: unusedPool },
          { lockTimeoutMillis: value },
        ).createDriver(),
      ).toThrow("Database timeouts must be positive milliseconds");
    },
  );
});
