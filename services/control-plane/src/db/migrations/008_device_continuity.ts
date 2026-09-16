import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Keep immutable source-device history when the account nominates a new phone. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("trip_owner_invites")
    .addColumn("trip_id", "uuid", (c) =>
      c.primaryKey().references("trips.id").onDelete("restrict"),
    )
    .addColumn("encrypted_code", "bytea", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("trip_device_requests")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("trip_id", "uuid", (c) =>
      c.notNull().references("trips.id").onDelete("restrict"),
    )
    .addColumn("membership_id", "uuid", (c) =>
      c.notNull().references("trip_members.id").onDelete("restrict"),
    )
    .addColumn("previous_device_id", "uuid", (c) =>
      c.notNull().references("devices.id").onDelete("restrict"),
    )
    .addColumn("device_id", "uuid", (c) =>
      c.notNull().references("devices.id").onDelete("restrict"),
    )
    .addColumn("state", "text", (c) => c.notNull())
    .addColumn("requested_at", "timestamptz", (c) => c.notNull())
    .addColumn("resolved_at", "timestamptz")
    .addColumn("approved_by_device_id", "uuid", (c) =>
      c.references("devices.id").onDelete("restrict"),
    )
    .addUniqueConstraint("trip_device_requests_device_unique", [
      "trip_id",
      "device_id",
    ])
    .addCheckConstraint(
      "trip_device_requests_state_check",
      sql`state in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')`,
    )
    .execute();
  // These rows describe the device at capture/wrapping time, not the account's
  // currently nominated device. Device rows are immutable and never deleted.
  await db.schema
    .alterTable("upload_sessions")
    .dropConstraint("upload_sessions_source_member_fk")
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .addForeignKeyConstraint(
      "upload_sessions_source_device_fk",
      ["source_device_id"],
      "devices",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .alterTable("assets")
    .dropConstraint("assets_source_member_fk")
    .execute();
  await db.schema
    .alterTable("assets")
    .addForeignKeyConstraint(
      "assets_source_device_fk",
      ["source_device_id"],
      "devices",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .dropConstraint("trip_key_envelopes_recipient_member_fk")
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .addForeignKeyConstraint(
      "trip_key_envelopes_recipient_device_fk",
      ["recipient_device_id"],
      "devices",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .dropConstraint("trip_key_envelopes_sender_member_fk")
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .addForeignKeyConstraint(
      "trip_key_envelopes_sender_device_fk",
      ["sender_device_id"],
      "devices",
      ["id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
}

/** PostgreSQL rejects rollback once historical devices need the expanded
 * schema. The migration transaction retains all data in that case. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("upload_sessions")
    .dropConstraint("upload_sessions_source_device_fk")
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .addForeignKeyConstraint(
      "upload_sessions_source_member_fk",
      ["trip_id", "source_device_id"],
      "trip_members",
      ["trip_id", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .alterTable("assets")
    .dropConstraint("assets_source_device_fk")
    .execute();
  await db.schema
    .alterTable("assets")
    .addForeignKeyConstraint(
      "assets_source_member_fk",
      ["trip_id", "source_device_id"],
      "trip_members",
      ["trip_id", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .dropConstraint("trip_key_envelopes_recipient_device_fk")
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .addForeignKeyConstraint(
      "trip_key_envelopes_recipient_member_fk",
      ["trip_id", "key_epoch", "recipient_device_id"],
      "trip_members",
      ["trip_id", "key_epoch", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .dropConstraint("trip_key_envelopes_sender_device_fk")
    .execute();
  await db.schema
    .alterTable("trip_key_envelopes")
    .addForeignKeyConstraint(
      "trip_key_envelopes_sender_member_fk",
      ["trip_id", "key_epoch", "sender_device_id"],
      "trip_members",
      ["trip_id", "key_epoch", "participating_device_id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema.dropTable("trip_device_requests").execute();
  await db.schema.dropTable("trip_owner_invites").execute();
}
