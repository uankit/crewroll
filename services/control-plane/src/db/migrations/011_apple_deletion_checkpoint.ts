import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("account_deletions")
    .addColumn("apple_grant", "text")
    .execute();
  await db.schema
    .alterTable("account_deletions")
    .addColumn("apple_revoked", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();
  await db.schema
    .alterTable("users")
    .addColumn("suspended_at", "timestamptz")
    .execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("account_deletions")
    .dropColumn("apple_grant")
    .execute();
  await db.schema
    .alterTable("account_deletions")
    .dropColumn("apple_revoked")
    .execute();
  await db.schema.alterTable("users").dropColumn("suspended_at").execute();
}
