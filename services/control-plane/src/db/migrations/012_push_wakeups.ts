import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Per-recipient, recoverable push hints. Payloads never contain media or credentials. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("push_wakeups")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("event_id", "uuid", (c) =>
      c.notNull().references("outbox_events.id").onDelete("cascade"),
    )
    .addColumn("trip_id", "uuid", (c) =>
      c.notNull().references("trips.id").onDelete("cascade"),
    )
    .addColumn("recipient_device_id", "uuid", (c) =>
      c.notNull().references("devices.id").onDelete("cascade"),
    )
    .addColumn("recipient_user_id", "uuid", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("available_at", "timestamptz", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("lease_token", "uuid")
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("completed_at", "timestamptz")
    .addColumn("outcome", "varchar(32)")
    .addColumn("last_error", "varchar(64)")
    .addUniqueConstraint("push_wakeups_event_device_unique", [
      "event_id",
      "recipient_device_id",
    ])
    .addCheckConstraint(
      "push_wakeups_attempt_check",
      sql`attempt_count >= 0 and attempt_count <= 8`,
    )
    .addCheckConstraint(
      "push_wakeups_expiry_check",
      sql`expires_at > created_at and expires_at <= created_at + interval '1 hour'`,
    )
    .addCheckConstraint(
      "push_wakeups_completion_check",
      sql`(completed_at is null and outcome is null) or (completed_at is not null and outcome in ('SENT', 'INELIGIBLE', 'EXPIRED', 'INVALID_TOKEN', 'DEAD_LETTERED', 'COALESCED'))`,
    )
    .addCheckConstraint(
      "push_wakeups_error_check",
      sql`last_error is null or last_error ~ '^[A-Z_]{1,64}$'`,
    )
    .execute();
  await db.schema
    .createIndex("push_wakeups_due_idx")
    .on("push_wakeups")
    .columns<"available_at" | "id" | "completed_at">(["available_at", "id"])
    .where("completed_at", "is", null)
    .execute();
  await db.schema
    .createIndex("push_wakeups_device_trip_idx")
    .on("push_wakeups")
    .columns<"recipient_device_id" | "trip_id" | "created_at" | "completed_at">(
      ["recipient_device_id", "trip_id", "created_at"],
    )
    .where("completed_at", "is", null)
    .execute();
  await db.schema
    .createIndex("push_wakeups_expiry_idx")
    .on("push_wakeups")
    .column<"expires_at" | "completed_at">("expires_at")
    .where("completed_at", "is", null)
    .execute();
  await db.schema
    .createIndex("push_wakeups_last_sent_idx")
    .on("push_wakeups")
    .columns<"recipient_device_id" | "trip_id" | "completed_at" | "outcome">([
      "recipient_device_id",
      "trip_id",
      "completed_at",
    ])
    .where("outcome", "=", "SENT")
    .execute();
  await db.schema
    .createIndex("outbox_events_published_retention_idx")
    .on("outbox_events")
    .column("published_at")
    .where("published_at", "is not", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("push_wakeups").execute();
  await db.schema.dropIndex("outbox_events_published_retention_idx").execute();
}
