import type { PostgresCursor, PostgresPool, PostgresQueryResult } from "kysely";
import { Client, Pool, type QueryResultRow } from "pg";

/** A timed-out wire connection cannot safely serve another request. */
export function boundedPostgresPool(pool: Pool): PostgresPool {
  // PostgreSQL emits errors on idle clients too. Without a listener, a brief
  // upstream outage becomes an uncaught EventEmitter error in the Node API.
  pool.on("error", () => {
    console.error(JSON.stringify({ event: "database_idle_connection_failed" }));
  });
  return {
    Client,
    options: pool.options,
    end: () => pool.end(),
    async connect() {
      const client = await pool.connect();
      let released = false;
      function release(discard = false) {
        if (released) return;
        released = true;
        client.release(discard);
      }
      async function execute<R>(
        text: string,
        values: ReadonlyArray<unknown>,
      ): Promise<PostgresQueryResult<R>> {
        try {
          const result = await client.query<R & QueryResultRow>(text, [
            ...values,
          ]);
          const command = result.command;
          return {
            command:
              command === "INSERT" ||
              command === "UPDATE" ||
              command === "DELETE" ||
              command === "MERGE"
                ? command
                : "SELECT",
            rowCount: result.rowCount ?? 0,
            rows: result.rows,
          };
        } catch (error) {
          // pg's query_timeout rejects the caller without terminating an active
          // server query. Destroying its socket prevents a stuck query/rollback
          // from poisoning the pool and allows request teardown to complete.
          if (error instanceof Error && error.message === "Query read timeout")
            release(true);
          throw error;
        }
      }
      function query<R>(
        text: string,
        values: ReadonlyArray<unknown>,
      ): Promise<PostgresQueryResult<R>>;
      function query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
      function query<R>(
        input: string | PostgresCursor<R>,
        values: ReadonlyArray<unknown> = [],
      ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
        if (typeof input !== "string")
          throw new Error("PostgreSQL cursor support is not configured");
        return execute<R>(input, values);
      }
      return { query, release: () => release() };
    },
  };
}
