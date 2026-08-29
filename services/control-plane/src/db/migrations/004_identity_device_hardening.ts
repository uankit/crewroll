import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("devices")
    .dropConstraint("devices_authentication_key_check")
    .execute();
  await db.schema
    .alterTable("devices")
    .addCheckConstraint(
      "devices_authentication_key_check",
      sql`authentication_key_algorithm = 'P-256' and authentication_key_version = 1 and octet_length(authentication_public_key) = 65 and get_byte(authentication_public_key, 0) = 4`,
    )
    .execute();
  await db.schema
    .createIndex("api_idempotency_expires_at_idx")
    .on("api_idempotency")
    .column("expires_at")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("api_idempotency_expires_at_idx").execute();
  await db.schema
    .alterTable("devices")
    .dropConstraint("devices_authentication_key_check")
    .execute();
  await db.schema
    .alterTable("devices")
    .addCheckConstraint(
      "devices_authentication_key_check",
      sql`authentication_key_algorithm = 'P-256' and authentication_key_version = 1 and octet_length(authentication_public_key) between 1 and 1024`,
    )
    .execute();
}
