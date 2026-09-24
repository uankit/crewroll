import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("account_terms")
    .addColumn("user_id", "uuid", (c) =>
      c.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("terms_version", "varchar(32)", (c) => c.notNull())
    .addColumn("accepted_at", "timestamptz", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("account_deleted_subjects")
    .addColumn("subject_hash", "varchar(64)", (c) => c.primaryKey())
    .addColumn("deleted_at", "timestamptz", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("account_deletions")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("user_id", "uuid", (c) => c.unique())
    .addColumn("clerk_subject", "varchar(255)", (c) => c.unique())
    .addColumn("requested_at", "timestamptz", (c) => c.notNull())
    .addColumn("available_at", "timestamptz", (c) => c.notNull())
    .addColumn("provider_deleted_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("lease_token", "uuid")
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(0))
    .addCheckConstraint(
      "account_deletions_attempt_count_check",
      sql`attempt_count >= 0`,
    )
    .execute();
  await db.schema
    .createIndex("account_deletions_pending")
    .on("account_deletions")
    .column<"available_at" | "completed_at">("available_at")
    .where("completed_at", "is", null)
    .execute();
  await db.schema
    .createTable("account_deletion_objects")
    .addColumn("request_id", "uuid", (c) =>
      c.notNull().references("account_deletions.id").onDelete("cascade"),
    )
    .addColumn("object_key", "text", (c) => c.notNull())
    .addColumn("deleted_at", "timestamptz")
    .addPrimaryKeyConstraint("account_deletion_objects_pkey", [
      "request_id",
      "object_key",
    ])
    .execute();
  await db.schema
    .createTable("user_blocks")
    .addColumn("user_id", "uuid", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("blocked_user_id", "uuid", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addPrimaryKeyConstraint("user_blocks_pkey", ["user_id", "blocked_user_id"])
    .addCheckConstraint("user_blocks_check", sql`user_id <> blocked_user_id`)
    .execute();
  await db.schema
    .createIndex("user_blocks_target")
    .on("user_blocks")
    .columns(["blocked_user_id", "user_id"])
    .execute();
  await db.schema
    .createTable("safety_reports")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("reporter_user_id", "uuid", (c) =>
      c.references("users.id").onDelete("set null"),
    )
    .addColumn("subject_user_id", "uuid", (c) =>
      c.references("users.id").onDelete("set null"),
    )
    .addColumn("trip_id", "uuid")
    .addColumn("asset_id", "uuid")
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("details", "varchar(1000)", (c) => c.notNull().defaultTo(""))
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("resolved_at", "timestamptz")
    .addColumn("resolution", "text")
    .addCheckConstraint(
      "safety_reports_reason_check",
      sql`reason in ('INAPPROPRIATE','HARASSMENT','PRIVACY','OTHER')`,
    )
    .addCheckConstraint(
      "safety_reports_resolution_check",
      sql`resolution in ('REMOVED','ACTION_TAKEN','DISMISSED')`,
    )
    .execute();
  await db.schema
    .createIndex("safety_reports_pending")
    .on("safety_reports")
    .column<"created_at" | "resolved_at">("created_at")
    .where("resolved_at", "is", null)
    .execute();
  await db.schema
    .createTable("request_limits")
    .addColumn("key", "varchar(128)", (c) => c.notNull())
    .addColumn("window_start", "timestamptz", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("request_limits_pkey", ["key", "window_start"])
    .addCheckConstraint("request_limits_count_check", sql`count > 0`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("request_limits").execute();
  await db.schema.dropTable("safety_reports").execute();
  await db.schema.dropTable("user_blocks").execute();
  await db.schema.dropTable("account_deletion_objects").execute();
  await db.schema.dropTable("account_deletions").execute();
  await db.schema.dropTable("account_deleted_subjects").execute();
  await db.schema.dropTable("account_terms").execute();
}
