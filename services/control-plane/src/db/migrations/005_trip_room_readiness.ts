import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("trip_members")
    .addColumn("full_photo_library_access", "boolean", (column) =>
      column.notNull().defaultTo(false),
    )
    .execute();

  await db.schema
    .alterTable("trips")
    .alterColumn("version", (column) => column.setDefault(1))
    .execute();
  await db.schema
    .alterTable("trips")
    .dropConstraint("trips_version_check")
    .execute();
  await db.schema
    .alterTable("trips")
    .addCheckConstraint("trips_version_check", sql`version >= 1`)
    .execute();

  await db.schema
    .alterTable("trip_key_envelopes")
    .dropConstraint("trip_key_envelopes_wrapped_key_check")
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .addCheckConstraint(
      "trip_key_envelopes_wrapped_key_check",
      sql`octet_length(wrapped_key) = 148`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("trip_key_envelopes")
    .dropConstraint("trip_key_envelopes_wrapped_key_check")
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .addCheckConstraint(
      "trip_key_envelopes_wrapped_key_check",
      sql`octet_length(wrapped_key) between 1 and 4096`,
    )
    .execute();

  await db.schema
    .alterTable("trips")
    .dropConstraint("trips_version_check")
    .execute();
  await db.schema
    .alterTable("trips")
    .addCheckConstraint("trips_version_check", sql`version >= 0`)
    .execute();
  await db.schema
    .alterTable("trips")
    .alterColumn("version", (column) => column.setDefault(0))
    .execute();

  await db.schema
    .alterTable("trip_members")
    .dropColumn("full_photo_library_access")
    .execute();
}
