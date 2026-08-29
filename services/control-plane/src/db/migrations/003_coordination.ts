import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("inbox_events")
    .addColumn("sequence", "bigint", (column) =>
      column.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn("recipient_device_id", "uuid", (column) => column.notNull())
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("event_type", "varchar(128)", (column) => column.notNull())
    .addColumn("aggregate_id", "uuid", (column) => column.notNull())
    .addColumn("available_at", "timestamptz", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addForeignKeyConstraint(
      "inbox_events_recipient_device_id_fk",
      ["recipient_device_id"],
      "devices",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "inbox_events_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "inbox_events_event_type_check",
      sql`event_type = btrim(event_type) and char_length(event_type) between 1 and 128`,
    )
    .addCheckConstraint(
      "inbox_events_payload_check",
      sql`jsonb_typeof(payload) = 'object' and octet_length(payload::text) between 2 and 65536`,
    )
    .execute();

  await db.schema
    .createTable("outbox_events")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("event_type", "varchar(128)", (column) => column.notNull())
    .addColumn("aggregate_id", "uuid", (column) => column.notNull())
    .addColumn("dedupe_key", "varchar(255)", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("available_at", "timestamptz", (column) => column.notNull())
    .addColumn("published_at", "timestamptz")
    .addColumn("attempt_count", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("outbox_events_dedupe_key_unique", ["dedupe_key"])
    .addCheckConstraint(
      "outbox_events_event_type_check",
      sql`event_type = btrim(event_type) and char_length(event_type) between 1 and 128`,
    )
    .addCheckConstraint(
      "outbox_events_dedupe_key_check",
      sql`dedupe_key = btrim(dedupe_key) and char_length(dedupe_key) between 1 and 255`,
    )
    .addCheckConstraint(
      "outbox_events_payload_check",
      sql`jsonb_typeof(payload) = 'object' and octet_length(payload::text) between 2 and 65536`,
    )
    .addCheckConstraint(
      "outbox_events_attempt_count_check",
      sql`attempt_count >= 0`,
    )
    .addCheckConstraint(
      "outbox_events_lifecycle_check",
      sql`(published_at is null or published_at >= created_at) and (last_error is null or (last_error = btrim(last_error) and char_length(last_error) between 1 and 2048))`,
    )
    .execute();

  await db.schema
    .createTable("api_idempotency")
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("route_key", "varchar(255)", (column) => column.notNull())
    .addColumn("idempotency_key", "uuid", (column) => column.notNull())
    .addColumn("request_sha256", "bytea", (column) => column.notNull())
    .addColumn("response_status", "smallint", (column) => column.notNull())
    .addColumn("response_body", "jsonb", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("api_idempotency_pk", [
      "user_id",
      "route_key",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "api_idempotency_user_id_fk",
      ["user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "api_idempotency_route_key_check",
      sql`route_key = btrim(route_key) and char_length(route_key) between 1 and 255`,
    )
    .addCheckConstraint(
      "api_idempotency_request_sha256_check",
      sql`octet_length(request_sha256) = 32`,
    )
    .addCheckConstraint(
      "api_idempotency_response_status_check",
      sql`response_status between 100 and 599`,
    )
    .addCheckConstraint(
      "api_idempotency_response_body_check",
      sql`jsonb_typeof(response_body) = 'object' and octet_length(response_body::text) between 2 and 1048576`,
    )
    .execute();

  await db.schema
    .createTable("audit_events")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("trip_id", "uuid")
    .addColumn("actor_user_id", "uuid")
    .addColumn("actor_device_id", "uuid")
    .addColumn("event_type", "varchar(128)", (column) => column.notNull())
    .addColumn("metadata", "jsonb", (column) => column.notNull())
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull())
    .addForeignKeyConstraint(
      "audit_events_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "audit_events_actor_user_id_fk",
      ["actor_user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "audit_events_actor_user_device_fk",
      ["actor_user_id", "actor_device_id"],
      "devices",
      ["user_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "audit_events_event_type_check",
      sql`event_type = btrim(event_type) and char_length(event_type) between 1 and 128`,
    )
    .addCheckConstraint(
      "audit_events_metadata_check",
      sql`jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) between 2 and 65536`,
    )
    .addCheckConstraint(
      "audit_events_actor_check",
      sql`actor_device_id is null or actor_user_id is not null`,
    )
    .execute();

  await db.schema
    .createTable("clerk_webhook_events")
    .addColumn("event_id", "varchar(255)", (column) => column.primaryKey())
    .addColumn("event_type", "varchar(128)", (column) => column.notNull())
    .addColumn("processed_at", "timestamptz", (column) => column.notNull())
    .addCheckConstraint(
      "clerk_webhook_events_event_id_check",
      sql`event_id = btrim(event_id) and char_length(event_id) between 1 and 255`,
    )
    .addCheckConstraint(
      "clerk_webhook_events_event_type_check",
      sql`event_type = btrim(event_type) and char_length(event_type) between 1 and 128`,
    )
    .execute();

  await db.schema
    .createIndex("inbox_events_device_sequence_idx")
    .on("inbox_events")
    .columns(["recipient_device_id", "sequence"])
    .execute();

  await db.schema
    .createIndex("inbox_events_trip_id_idx")
    .on("inbox_events")
    .column("trip_id")
    .execute();

  await db.schema
    .createIndex("outbox_events_unpublished_available_idx")
    .on("outbox_events")
    .column<"available_at" | "published_at">("available_at")
    .where("published_at", "is", null)
    .execute();

  await db.schema
    .createIndex("audit_events_trip_occurred_idx")
    .on("audit_events")
    .columns(["trip_id", "occurred_at"])
    .execute();

  await db.schema
    .createIndex("audit_events_actor_user_device_idx")
    .on("audit_events")
    .columns(["actor_user_id", "actor_device_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("audit_events_actor_user_device_idx").execute();
  await db.schema.dropIndex("audit_events_trip_occurred_idx").execute();
  await db.schema
    .dropIndex("outbox_events_unpublished_available_idx")
    .execute();
  await db.schema.dropIndex("inbox_events_trip_id_idx").execute();
  await db.schema.dropIndex("inbox_events_device_sequence_idx").execute();
  await db.schema.dropTable("clerk_webhook_events").execute();
  await db.schema.dropTable("audit_events").execute();
  await db.schema.dropTable("api_idempotency").execute();
  await db.schema.dropTable("outbox_events").execute();
  await db.schema.dropTable("inbox_events").execute();
}
