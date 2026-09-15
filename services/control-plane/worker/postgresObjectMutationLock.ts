import { sql, type Kysely } from "kysely";
import type { Database } from "../src/db/schema/tables.js";
import type { ObjectMutationLock } from "./r2CiphertextStore.js";

/** Cleanup and PUT share a DB-backed lock, including across Worker isolates. */
export function createPostgresObjectMutationLock(
  db: Kysely<Database>,
): ObjectMutationLock {
  return {
    run: (key, action) =>
      db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`crewroll/r2/${key}`}, 0))`.execute(
          tx,
        );
        return action();
      }),
  };
}
