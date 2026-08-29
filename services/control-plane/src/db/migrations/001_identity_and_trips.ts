import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("clerk_subject", "varchar(255)", (column) =>
      column.notNull().unique(),
    )
    .addColumn("display_name", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "users_clerk_subject_check",
      sql`char_length(clerk_subject) between 1 and 255`,
    )
    .addCheckConstraint(
      "users_display_name_check",
      sql`display_name = btrim(display_name) and char_length(display_name) between 1 and 80`,
    )
    .execute();

  await db.schema
    .createTable("devices")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("installation_id", "varchar(128)", (column) => column.notNull())
    .addColumn("platform", "text", (column) => column.notNull())
    .addColumn("authentication_key_algorithm", "text", (column) =>
      column.notNull(),
    )
    .addColumn("authentication_public_key", "bytea", (column) =>
      column.notNull(),
    )
    .addColumn("authentication_key_version", "smallint", (column) =>
      column.notNull(),
    )
    .addColumn("e2ee_key_algorithm", "text", (column) => column.notNull())
    .addColumn("e2ee_public_key", "bytea", (column) => column.notNull())
    .addColumn("e2ee_key_version", "smallint", (column) => column.notNull())
    .addColumn("background_credential_hash", "bytea", (column) =>
      column.notNull().unique(),
    )
    .addColumn("background_credential_expires_at", "timestamptz", (column) =>
      column.notNull(),
    )
    .addColumn("encrypted_push_token", "bytea")
    .addColumn("push_token_hash", "bytea")
    .addColumn("app_version", "varchar(128)", (column) => column.notNull())
    .addColumn("last_seen_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("revoked_at", "timestamptz")
    .addUniqueConstraint("devices_installation_id_unique", ["installation_id"])
    .addUniqueConstraint("devices_user_id_id_unique", ["user_id", "id"])
    .addForeignKeyConstraint(
      "devices_user_id_fk",
      ["user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "devices_installation_id_check",
      sql`installation_id ~ '^[A-Za-z0-9_-]{8,128}$'`,
    )
    .addCheckConstraint(
      "devices_platform_check",
      sql`platform in ('ios', 'android')`,
    )
    .addCheckConstraint(
      "devices_authentication_key_check",
      sql`authentication_key_algorithm = 'P-256' and authentication_key_version = 1 and octet_length(authentication_public_key) between 1 and 1024`,
    )
    .addCheckConstraint(
      "devices_e2ee_key_check",
      sql`e2ee_key_algorithm = 'X25519' and e2ee_key_version = 1 and octet_length(e2ee_public_key) = 32`,
    )
    .addCheckConstraint(
      "devices_background_credential_check",
      sql`octet_length(background_credential_hash) = 32 and background_credential_expires_at > created_at`,
    )
    .addCheckConstraint(
      "devices_push_token_pair_check",
      sql`(encrypted_push_token is null and push_token_hash is null) or (encrypted_push_token is not null and push_token_hash is not null and octet_length(encrypted_push_token) between 1 and 8192 and octet_length(push_token_hash) = 32)`,
    )
    .addCheckConstraint(
      "devices_app_version_check",
      sql`app_version ~ '^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?$'`,
    )
    .execute();

  await db.schema
    .createTable("trips")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("owner_user_id", "uuid", (column) => column.notNull())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("release_mode", "text", (column) => column.notNull())
    .addColumn("release_timezone", "text")
    .addColumn("release_local_time", "time")
    .addColumn("ends_at", "timestamptz", (column) => column.notNull())
    .addColumn("hard_delete_at", "timestamptz", (column) => column.notNull())
    .addColumn("member_count", "smallint", (column) =>
      column.notNull().defaultTo(1),
    )
    .addColumn("version", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("started_at", "timestamptz")
    .addColumn("ending_started_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("cancelled_at", "timestamptz")
    .addForeignKeyConstraint(
      "trips_owner_user_id_fk",
      ["owner_user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "trips_name_check",
      sql`name = btrim(name) and char_length(name) between 1 and 80`,
    )
    .addCheckConstraint(
      "trips_state_check",
      sql`state in ('LOBBY', 'ACTIVE', 'ENDING', 'COMPLETE', 'INCOMPLETE_EXPIRED', 'CANCELLED')`,
    )
    .addCheckConstraint(
      "trips_release_fields_check",
      sql`(release_mode = 'IMMEDIATE' and release_timezone is null and release_local_time is null) or (release_mode = 'NIGHTLY' and release_timezone is not null and release_timezone = btrim(release_timezone) and char_length(release_timezone) between 1 and 255 and release_local_time is not null and extract(second from release_local_time) = 0)`,
    )
    .addCheckConstraint(
      "trips_duration_check",
      sql`ends_at > created_at and ends_at <= created_at + interval '14 days'`,
    )
    .addCheckConstraint(
      "trips_hard_delete_at_check",
      sql`hard_delete_at = ends_at + interval '7 days'`,
    )
    .addCheckConstraint(
      "trips_member_count_check",
      sql`member_count between 1 and 10`,
    )
    .addCheckConstraint("trips_version_check", sql`version >= 0`)
    .addCheckConstraint(
      "trips_lifecycle_check",
      sql`
        (
          state = 'LOBBY'
          and started_at is null
          and ending_started_at is null
          and completed_at is null
          and cancelled_at is null
        ) or (
          state = 'ACTIVE'
          and started_at is not null
          and ending_started_at is null
          and completed_at is null
          and cancelled_at is null
        ) or (
          state = 'ENDING'
          and started_at is not null
          and ending_started_at is not null
          and completed_at is null
          and cancelled_at is null
        ) or (
          state in ('COMPLETE', 'INCOMPLETE_EXPIRED')
          and started_at is not null
          and ending_started_at is not null
          and completed_at is not null
          and cancelled_at is null
        ) or (
          state = 'CANCELLED'
          and started_at is null
          and ending_started_at is null
          and completed_at is null
          and cancelled_at is not null
        )
      `,
    )
    .addCheckConstraint(
      "trips_lifecycle_order_check",
      sql`
        (started_at is null or started_at >= created_at)
        and (ending_started_at is null or ending_started_at >= started_at)
        and (completed_at is null or completed_at >= ending_started_at)
        and (cancelled_at is null or cancelled_at >= created_at)
      `,
    )
    .execute();

  await db.schema
    .createTable("user_active_trips")
    .addColumn("user_id", "uuid", (column) => column.primaryKey())
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("acquired_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addForeignKeyConstraint(
      "user_active_trips_user_id_fk",
      ["user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "user_active_trips_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();

  await db.schema
    .createTable("trip_invites")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("invite_code_hmac", "bytea", (column) =>
      column.notNull().unique(),
    )
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("max_uses", "smallint", (column) => column.notNull())
    .addColumn("uses_count", "smallint", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("revoked_at", "timestamptz")
    .addForeignKeyConstraint(
      "trip_invites_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "trip_invites_hmac_check",
      sql`octet_length(invite_code_hmac) = 32`,
    )
    .addCheckConstraint(
      "trip_invites_expiry_check",
      sql`expires_at > created_at`,
    )
    .addCheckConstraint(
      "trip_invites_uses_check",
      sql`max_uses between 1 and 9 and uses_count between 0 and max_uses`,
    )
    .execute();

  await db.schema
    .createTable("trip_members")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("participating_device_id", "uuid", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("key_epoch", "smallint")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("approved_at", "timestamptz")
    .addColumn("rejected_at", "timestamptz")
    .addUniqueConstraint("trip_members_trip_user_unique", [
      "trip_id",
      "user_id",
    ])
    .addUniqueConstraint("trip_members_trip_device_unique", [
      "trip_id",
      "participating_device_id",
    ])
    .addUniqueConstraint("trip_members_trip_epoch_device_unique", [
      "trip_id",
      "key_epoch",
      "participating_device_id",
    ])
    .addForeignKeyConstraint(
      "trip_members_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "trip_members_user_id_fk",
      ["user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "trip_members_user_device_fk",
      ["user_id", "participating_device_id"],
      "devices",
      ["user_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "trip_members_role_check",
      sql`role in ('OWNER', 'MEMBER')`,
    )
    .addCheckConstraint(
      "trip_members_state_check",
      sql`state in ('PENDING_KEY', 'ACTIVE', 'REJECTED')`,
    )
    .addCheckConstraint(
      "trip_members_lifecycle_check",
      sql`
        (
          state = 'PENDING_KEY'
          and role = 'MEMBER'
          and key_epoch is null
          and approved_at is null
          and rejected_at is null
        ) or (
          state = 'ACTIVE'
          and key_epoch = 1
          and approved_at is not null
          and rejected_at is null
        ) or (
          state = 'REJECTED'
          and role = 'MEMBER'
          and key_epoch is null
          and approved_at is null
          and rejected_at is not null
        )
      `,
    )
    .addCheckConstraint(
      "trip_members_lifecycle_order_check",
      sql`
        (approved_at is null or approved_at >= created_at)
        and (rejected_at is null or rejected_at >= created_at)
      `,
    )
    .execute();

  await db.schema
    .createTable("trip_key_envelopes")
    .addColumn("trip_id", "uuid", (column) => column.notNull())
    .addColumn("key_epoch", "smallint", (column) => column.notNull())
    .addColumn("recipient_device_id", "uuid", (column) => column.notNull())
    .addColumn("sender_device_id", "uuid", (column) => column.notNull())
    .addColumn("algorithm_version", "smallint", (column) => column.notNull())
    .addColumn("wrapped_key", "bytea", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("trip_key_envelopes_pk", [
      "trip_id",
      "key_epoch",
      "recipient_device_id",
    ])
    .addForeignKeyConstraint(
      "trip_key_envelopes_trip_id_fk",
      ["trip_id"],
      "trips",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "trip_key_envelopes_recipient_member_fk",
      ["trip_id", "key_epoch", "recipient_device_id"],
      "trip_members",
      ["trip_id", "key_epoch", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "trip_key_envelopes_sender_member_fk",
      ["trip_id", "key_epoch", "sender_device_id"],
      "trip_members",
      ["trip_id", "key_epoch", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "trip_key_envelopes_version_check",
      sql`key_epoch = 1 and algorithm_version = 1`,
    )
    .addCheckConstraint(
      "trip_key_envelopes_wrapped_key_check",
      sql`octet_length(wrapped_key) between 1 and 4096`,
    )
    .execute();

  await db.schema
    .createIndex("trip_members_trip_state_idx")
    .on("trip_members")
    .columns(["trip_id", "state"])
    .execute();

  await db.schema
    .createIndex("trips_state_ends_idx")
    .on("trips")
    .columns(["state", "ends_at"])
    .execute();

  await db.schema
    .createIndex("devices_user_active_idx")
    .on("devices")
    .column<"user_id" | "revoked_at">("user_id")
    .where("revoked_at", "is", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("devices_user_active_idx").execute();
  await db.schema.dropIndex("trips_state_ends_idx").execute();
  await db.schema.dropIndex("trip_members_trip_state_idx").execute();
  await db.schema.dropTable("trip_key_envelopes").execute();
  await db.schema.dropTable("trip_members").execute();
  await db.schema.dropTable("trip_invites").execute();
  await db.schema.dropTable("user_active_trips").execute();
  await db.schema.dropTable("trips").execute();
  await db.schema.dropTable("devices").execute();
  await db.schema.dropTable("users").execute();
}
