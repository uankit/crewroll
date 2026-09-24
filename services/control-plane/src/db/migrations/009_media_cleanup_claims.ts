import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Recoverable work ownership; storage I/O never owns a database transaction. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("media_cleanup_claims")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("trip_id", "uuid", (c) =>
      c.notNull().references("trips.id").onDelete("cascade"),
    )
    .addColumn("token", "uuid", (c) => c.notNull())
    .addColumn("available_at", "timestamptz", (c) => c.notNull())
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(1))
    .addCheckConstraint(
      "media_cleanup_claims_attempt_count",
      sql`attempt_count > 0`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("media_cleanup_claims").execute();
}
