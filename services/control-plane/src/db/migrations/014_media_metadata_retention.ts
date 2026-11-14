import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("trips")
    .addColumn("media_metadata_purged_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("trips")
    .addCheckConstraint(
      "trips_media_metadata_purged_check",
      sql`media_metadata_purged_at is null or media_metadata_purged_at >= hard_delete_at`,
    )
    .execute();
  await db.schema
    .createIndex("trips_media_metadata_due_idx")
    .on("trips")
    .column<"hard_delete_at" | "media_metadata_purged_at">("hard_delete_at")
    .where("media_metadata_purged_at", "is", null)
    .execute();
  await db.schema
    .alterTable("assets")
    .dropConstraint("assets_manifest_check")
    .execute();
  await db.schema
    .alterTable("assets")
    .alterColumn("encrypted_manifest", (c) => c.dropNotNull())
    .execute();
  await db.schema
    .alterTable("assets")
    .addCheckConstraint(
      "assets_manifest_check",
      sql`(encrypted_manifest is not null and octet_length(encrypted_manifest) >= 1 and octet_length(encrypted_manifest) <= 65536) or (encrypted_manifest is null and state in ('PURGED', 'EXPIRED'))`,
    )
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .dropConstraint("upload_sessions_manifest_check")
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .alterColumn("encrypted_manifest", (c) => c.dropNotNull())
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .addCheckConstraint(
      "upload_sessions_manifest_check",
      sql`(encrypted_manifest is not null and octet_length(encrypted_manifest) >= 1 and octet_length(encrypted_manifest) <= 65536) or (encrypted_manifest is null and state = 'EXPIRED')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SET NOT NULL deliberately refuses rollback after erasure. Never manufacture
  // replacement payloads or pretend erased encrypted manifests are recoverable.
  await db.schema
    .alterTable("upload_sessions")
    .alterColumn("encrypted_manifest", (c) => c.setNotNull())
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .dropConstraint("upload_sessions_manifest_check")
    .execute();
  await db.schema
    .alterTable("upload_sessions")
    .addCheckConstraint(
      "upload_sessions_manifest_check",
      sql`octet_length(encrypted_manifest) >= 1 and octet_length(encrypted_manifest) <= 65536`,
    )
    .execute();
  await db.schema
    .alterTable("assets")
    .alterColumn("encrypted_manifest", (c) => c.setNotNull())
    .execute();
  await db.schema
    .alterTable("assets")
    .dropConstraint("assets_manifest_check")
    .execute();
  await db.schema
    .alterTable("assets")
    .addCheckConstraint(
      "assets_manifest_check",
      sql`octet_length(encrypted_manifest) >= 1 and octet_length(encrypted_manifest) <= 65536`,
    )
    .execute();
  await db.schema.dropIndex("trips_media_metadata_due_idx").execute();
  await db.schema
    .alterTable("trips")
    .dropConstraint("trips_media_metadata_purged_check")
    .execute();
  await db.schema
    .alterTable("trips")
    .dropColumn("media_metadata_purged_at")
    .execute();
}
