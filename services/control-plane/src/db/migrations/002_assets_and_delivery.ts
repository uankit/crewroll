import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("upload_sessions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("client_asset_id", "uuid", (column) => column.notNull())
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("source_device_id", "uuid", (column) => column.notNull())
    .addColumn("source_asset_key", "varchar(128)", (column) => column.notNull())
    .addColumn("media_type", "text", (column) => column.notNull())
    .addColumn("key_epoch", "smallint", (column) => column.notNull())
    .addColumn("encryption_version", "smallint", (column) => column.notNull())
    .addColumn("encrypted_manifest", "bytea", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("upload_sessions_client_asset_id_unique", [
      "client_asset_id",
    ])
    .addUniqueConstraint("upload_sessions_source_unique", [
      "trip_id",
      "source_device_id",
      "source_asset_key",
    ])
    .addForeignKeyConstraint(
      "upload_sessions_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "upload_sessions_source_member_fk",
      ["trip_id", "source_device_id"],
      "trip_members",
      ["trip_id", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "upload_sessions_source_asset_key_check",
      sql`source_asset_key ~ '^src_[A-Za-z0-9_-]{28,124}$'`,
    )
    .addCheckConstraint(
      "upload_sessions_media_type_check",
      sql`media_type = 'PHOTO'`,
    )
    .addCheckConstraint(
      "upload_sessions_key_versions_check",
      sql`key_epoch = 1 and encryption_version = 1`,
    )
    .addCheckConstraint(
      "upload_sessions_manifest_check",
      sql`octet_length(encrypted_manifest) between 1 and 65536`,
    )
    .addCheckConstraint(
      "upload_sessions_state_check",
      sql`state in ('CREATED', 'VERIFIED', 'COMMITTED', 'EXPIRED')`,
    )
    .addCheckConstraint(
      "upload_sessions_expiry_check",
      sql`expires_at > created_at`,
    )
    .execute();

  await db.schema
    .createTable("upload_objects")
    .addColumn("upload_session_id", "uuid", (column) => column.notNull())
    .addColumn("variant", "text", (column) => column.notNull())
    .addColumn("s3_key", "text", (column) => column.notNull())
    .addColumn("expected_ciphertext_bytes", "bigint", (column) =>
      column.notNull(),
    )
    .addColumn("expected_ciphertext_sha256", "bytea", (column) =>
      column.notNull(),
    )
    .addColumn("etag", "text")
    .addColumn("verified_at", "timestamptz")
    .addPrimaryKeyConstraint("upload_objects_pk", [
      "upload_session_id",
      "variant",
    ])
    .addUniqueConstraint("upload_objects_s3_key_unique", ["s3_key"])
    .addForeignKeyConstraint(
      "upload_objects_upload_session_id_fk",
      ["upload_session_id"],
      "upload_sessions",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "upload_objects_variant_check",
      sql`variant in ('PREVIEW', 'ORIGINAL')`,
    )
    .addCheckConstraint(
      "upload_objects_s3_key_check",
      sql`s3_key = btrim(s3_key) and char_length(s3_key) between 1 and 1024`,
    )
    .addCheckConstraint(
      "upload_objects_ciphertext_check",
      sql`variant not in ('PREVIEW', 'ORIGINAL') or (variant = 'PREVIEW' and expected_ciphertext_bytes between 1 and 524288) or (variant = 'ORIGINAL' and expected_ciphertext_bytes between 1 and 52428800)`,
    )
    .addCheckConstraint(
      "upload_objects_checksum_check",
      sql`octet_length(expected_ciphertext_sha256) = 32`,
    )
    .addCheckConstraint(
      "upload_objects_verification_check",
      sql`(etag is null and verified_at is null) or (etag is not null and verified_at is not null and etag = btrim(etag) and char_length(etag) between 1 and 256)`,
    )
    .execute();

  await db.schema
    .createTable("assets")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("source_device_id", "uuid", (column) => column.notNull())
    .addColumn("source_asset_key", "varchar(128)", (column) => column.notNull())
    .addColumn("committed_at", "timestamptz", (column) => column.notNull())
    .addColumn("media_type", "text", (column) => column.notNull())
    .addColumn("key_epoch", "smallint", (column) => column.notNull())
    .addColumn("encryption_version", "smallint", (column) => column.notNull())
    .addColumn("encrypted_manifest", "bytea", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("purge_pending_at", "timestamptz")
    .addColumn("purged_at", "timestamptz")
    .addColumn("expired_at", "timestamptz")
    .addUniqueConstraint("assets_source_unique", [
      "trip_id",
      "source_device_id",
      "source_asset_key",
    ])
    .addForeignKeyConstraint(
      "assets_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "assets_source_member_fk",
      ["trip_id", "source_device_id"],
      "trip_members",
      ["trip_id", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "assets_source_asset_key_check",
      sql`source_asset_key ~ '^src_[A-Za-z0-9_-]{28,124}$'`,
    )
    .addCheckConstraint("assets_media_type_check", sql`media_type = 'PHOTO'`)
    .addCheckConstraint(
      "assets_key_versions_check",
      sql`key_epoch = 1 and encryption_version = 1`,
    )
    .addCheckConstraint(
      "assets_manifest_check",
      sql`octet_length(encrypted_manifest) between 1 and 65536`,
    )
    .addCheckConstraint(
      "assets_state_check",
      sql`state in ('COMMITTED', 'PURGE_PENDING', 'PURGED', 'EXPIRED')`,
    )
    .addCheckConstraint(
      "assets_lifecycle_check",
      sql`state not in ('COMMITTED', 'PURGE_PENDING', 'PURGED', 'EXPIRED') or (state = 'COMMITTED' and purge_pending_at is null and purged_at is null and expired_at is null) or (state = 'PURGE_PENDING' and purge_pending_at is not null and purged_at is null and expired_at is null) or (state = 'PURGED' and purge_pending_at is not null and purged_at is not null and expired_at is null) or (state = 'EXPIRED' and purge_pending_at is null and purged_at is null and expired_at is not null)`,
    )
    .addCheckConstraint(
      "assets_lifecycle_order_check",
      sql`(purge_pending_at is null or purge_pending_at >= committed_at) and (purged_at is null or purged_at >= purge_pending_at) and (expired_at is null or expired_at >= committed_at)`,
    )
    .execute();

  await db.schema
    .createTable("asset_objects")
    .addColumn("asset_id", "uuid", (column) => column.notNull())
    .addColumn("variant", "text", (column) => column.notNull())
    .addColumn("s3_key", "text", (column) => column.notNull())
    .addColumn("ciphertext_bytes", "bigint", (column) => column.notNull())
    .addColumn("ciphertext_sha256", "bytea", (column) => column.notNull())
    .addColumn("etag", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .addPrimaryKeyConstraint("asset_objects_pk", ["asset_id", "variant"])
    .addUniqueConstraint("asset_objects_s3_key_unique", ["s3_key"])
    .addForeignKeyConstraint(
      "asset_objects_asset_id_fk",
      ["asset_id"],
      "assets",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "asset_objects_variant_check",
      sql`variant in ('PREVIEW', 'ORIGINAL')`,
    )
    .addCheckConstraint(
      "asset_objects_s3_key_check",
      sql`s3_key = btrim(s3_key) and char_length(s3_key) between 1 and 1024`,
    )
    .addCheckConstraint(
      "asset_objects_ciphertext_check",
      sql`variant not in ('PREVIEW', 'ORIGINAL') or (variant = 'PREVIEW' and ciphertext_bytes between 1 and 524288) or (variant = 'ORIGINAL' and ciphertext_bytes between 1 and 52428800)`,
    )
    .addCheckConstraint(
      "asset_objects_checksum_check",
      sql`octet_length(ciphertext_sha256) = 32`,
    )
    .addCheckConstraint(
      "asset_objects_etag_check",
      sql`etag = btrim(etag) and char_length(etag) between 1 and 256`,
    )
    .addCheckConstraint(
      "asset_objects_deletion_check",
      sql`deleted_at is null or deleted_at >= created_at`,
    )
    .execute();

  await db.schema
    .createTable("deliveries")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("asset_id", "uuid", (column) => column.notNull())
    .addColumn("recipient_user_id", "uuid", (column) => column.notNull())
    .addColumn("recipient_device_id", "uuid", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("available_at", "timestamptz", (column) => column.notNull())
    .addColumn("saved_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("deliveries_asset_device_unique", [
      "asset_id",
      "recipient_device_id",
    ])
    .addForeignKeyConstraint(
      "deliveries_asset_id_fk",
      ["asset_id"],
      "assets",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "deliveries_recipient_user_id_fk",
      ["recipient_user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "deliveries_recipient_user_device_fk",
      ["recipient_user_id", "recipient_device_id"],
      "devices",
      ["user_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "deliveries_state_check",
      sql`state in ('HELD', 'READY', 'SAVED_LOCALLY', 'EXPIRED')`,
    )
    .addCheckConstraint(
      "deliveries_lifecycle_check",
      sql`state not in ('HELD', 'READY', 'SAVED_LOCALLY', 'EXPIRED') or (state in ('HELD', 'READY', 'EXPIRED') and saved_at is null) or (state = 'SAVED_LOCALLY' and saved_at is not null)`,
    )
    .addCheckConstraint(
      "deliveries_lifecycle_order_check",
      sql`saved_at is null or saved_at >= available_at`,
    )
    .execute();

  await db.schema
    .createTable("receipts")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("delivery_id", "uuid", (column) => column.notNull())
    .addColumn("receipt_type", "text", (column) => column.notNull())
    .addColumn("client_event_id", "uuid", (column) => column.notNull())
    .addColumn("client_observed_at", "timestamptz", (column) =>
      column.notNull(),
    )
    .addColumn("accepted_at", "timestamptz", (column) => column.notNull())
    .addUniqueConstraint("receipts_client_event_id_unique", ["client_event_id"])
    .addUniqueConstraint("receipts_delivery_type_unique", [
      "delivery_id",
      "receipt_type",
    ])
    .addForeignKeyConstraint(
      "receipts_delivery_id_fk",
      ["delivery_id"],
      "deliveries",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "receipts_type_check",
      sql`receipt_type in ('SOURCE_PRESENT', 'SAVED_LOCALLY')`,
    )
    .execute();

  await db.schema
    .createIndex("upload_sessions_state_expires_idx")
    .on("upload_sessions")
    .columns(["state", "expires_at"])
    .execute();

  await db.schema
    .createIndex("assets_trip_committed_id_idx")
    .on("assets")
    .columns(["trip_id", "committed_at", "id"])
    .execute();

  await db.schema
    .createIndex("assets_state_committed_idx")
    .on("assets")
    .columns(["state", "committed_at"])
    .execute();

  await db.schema
    .createIndex("deliveries_device_state_available_idx")
    .on("deliveries")
    .columns(["recipient_device_id", "state", "available_at"])
    .execute();

  await db.schema
    .createIndex("deliveries_asset_state_idx")
    .on("deliveries")
    .columns(["asset_id", "state"])
    .execute();

  await db.schema
    .createIndex("deliveries_recipient_user_device_idx")
    .on("deliveries")
    .columns(["recipient_user_id", "recipient_device_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("deliveries_recipient_user_device_idx").execute();
  await db.schema.dropIndex("deliveries_asset_state_idx").execute();
  await db.schema.dropIndex("deliveries_device_state_available_idx").execute();
  await db.schema.dropIndex("assets_state_committed_idx").execute();
  await db.schema.dropIndex("assets_trip_committed_id_idx").execute();
  await db.schema.dropIndex("upload_sessions_state_expires_idx").execute();
  await db.schema.dropTable("receipts").execute();
  await db.schema.dropTable("deliveries").execute();
  await db.schema.dropTable("asset_objects").execute();
  await db.schema.dropTable("assets").execute();
  await db.schema.dropTable("upload_objects").execute();
  await db.schema.dropTable("upload_sessions").execute();
}
