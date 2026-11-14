import type { Kysely } from "kysely";

/** Request admission and successful writes have separate, restore-safe ordering. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("devices")
    .addColumn("push_token_request_revision", "bigint", (c) =>
      c.notNull().defaultTo(0),
    )
    .execute();
  await db.schema
    .alterTable("devices")
    .addColumn("push_token_committed_revision", "bigint", (c) =>
      c.notNull().defaultTo(0),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("devices")
    .dropColumn("push_token_committed_revision")
    .execute();
  await db.schema
    .alterTable("devices")
    .dropColumn("push_token_request_revision")
    .execute();
}
