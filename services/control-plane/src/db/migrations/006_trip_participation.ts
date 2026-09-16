import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("trip_members")
    .addColumn("leaving_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addColumn("left_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addColumn("left_incomplete", "boolean", (c) =>
      c.notNull().defaultTo(false),
    )
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addColumn("sharing_paused_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addColumn("sharing_pauses", "jsonb", (c) =>
      c.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addColumn("drained_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addCheckConstraint(
      "trip_members_departure_order_check",
      sql`(left_at is null or (leaving_at is not null and left_at >= leaving_at)) and jsonb_typeof(sharing_pauses) = 'array'`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("trip_members")
    .dropConstraint("trip_members_departure_order_check")
    .execute();
  await db.schema.alterTable("trip_members").dropColumn("drained_at").execute();
  await db.schema
    .alterTable("trip_members")
    .dropColumn("sharing_pauses")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .dropColumn("sharing_paused_at")
    .execute();
  await db.schema.alterTable("trip_members").dropColumn("left_at").execute();
  await db.schema
    .alterTable("trip_members")
    .dropColumn("left_incomplete")
    .execute();
  await db.schema.alterTable("trip_members").dropColumn("leaving_at").execute();
}
