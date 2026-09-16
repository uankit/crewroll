import type { Kysely } from "kysely";

/** Legacy rows remain null: never guess a capture time from an upload time. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("upload_sessions")
    .addColumn("captured_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("assets")
    .addColumn("captured_at", "timestamptz")
    .execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("assets").dropColumn("captured_at").execute();
  await db.schema
    .alterTable("upload_sessions")
    .dropColumn("captured_at")
    .execute();
}
