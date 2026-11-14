import { sql, type Kysely } from "kysely";
import type { Database } from "../schema/tables.js";
import type { Clock } from "../../shared/time/clock.js";

const BATCH = 100;

/** Erase photo payloads after access/recovery expires, preserving history and
 * storage keys until byte retirement is confirmed. Never erase R2 tombstones. */
export async function eraseExpiredMediaMetadata(
  db: Kysely<Database>,
  clock: Clock,
) {
  const now = clock.now();
  // A blocked earlier upload must not consume every pass. Discover only trips
  // with work that can progress, or an empty graph ready for its final receipt.
  const candidates = await sql<{ id: string }>`select t.id from trips t
    where t.hard_delete_at <= ${now} and t.media_metadata_purged_at is null
      and (
        exists(select 1 from trip_key_envelopes k where k.trip_id = t.id)
        or exists(select 1 from assets a where a.trip_id = t.id
          and a.encrypted_manifest is not null and a.state in ('PURGED', 'EXPIRED')
          and not exists(select 1 from asset_objects o where o.asset_id = a.id and o.deleted_at is null))
        or exists(select 1 from upload_sessions u where u.trip_id = t.id and u.encrypted_manifest is not null
          and (u.state = 'EXPIRED' or (u.state = 'COMMITTED' and exists(
            select 1 from assets a where a.id = u.client_asset_id and a.trip_id = t.id
              and a.state in ('PURGED', 'EXPIRED')
              and not exists(select 1 from asset_objects o where o.asset_id = a.id and o.deleted_at is null)))))
        or (not exists(select 1 from assets a where a.trip_id = t.id and a.encrypted_manifest is not null)
          and not exists(select 1 from upload_sessions u where u.trip_id = t.id and u.encrypted_manifest is not null))
      )
    order by t.hard_delete_at, t.id limit 4`.execute(db);
  const counts = { assets: 0, uploads: 0, envelopes: 0, trips: 0 };
  for (const candidate of candidates.rows) {
    const result = await db.transaction().execute(async (tx) => {
      const trip = await tx
        .selectFrom("trips")
        .select(["hard_delete_at", "media_metadata_purged_at"])
        .where("id", "=", candidate.id)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (
        !trip ||
        trip.hard_delete_at > now ||
        trip.media_metadata_purged_at !== null
      )
        return null;
      const assets = await tx
        .selectFrom("assets as a")
        .select("a.id")
        .where("a.trip_id", "=", candidate.id)
        .where("a.encrypted_manifest", "is not", null)
        .where("a.state", "in", ["PURGED", "EXPIRED"])
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("asset_objects as o")
                .select("o.asset_id")
                .whereRef("o.asset_id", "=", "a.id")
                .where("o.deleted_at", "is", null),
            ),
          ),
        )
        .orderBy("a.id")
        .limit(BATCH - counts.assets)
        .execute();
      if (assets.length)
        await tx
          .updateTable("assets")
          .set({ encrypted_manifest: null })
          .where(
            "id",
            "in",
            assets.map((a) => a.id),
          )
          .execute();
      const uploads = await sql<{
        id: string;
      }>`select u.id from upload_sessions u
        where u.trip_id = ${candidate.id}::uuid and u.encrypted_manifest is not null
          and (u.state = 'EXPIRED' or (u.state = 'COMMITTED' and exists(
            select 1 from assets a where a.id = u.client_asset_id and a.trip_id = u.trip_id
              and a.state in ('PURGED', 'EXPIRED')
              and not exists(select 1 from asset_objects o where o.asset_id = a.id and o.deleted_at is null))))
        order by u.id limit ${BATCH - counts.uploads}`.execute(tx);
      if (uploads.rows.length)
        await tx
          .updateTable("upload_sessions")
          .set({ encrypted_manifest: null, state: "EXPIRED" })
          .where(
            "id",
            "in",
            uploads.rows.map((u) => u.id),
          )
          .execute();
      const envelopes = await tx
        .selectFrom("trip_key_envelopes")
        .select("recipient_device_id")
        .where("trip_id", "=", candidate.id)
        .orderBy("recipient_device_id")
        .limit(BATCH - counts.envelopes)
        .execute();
      if (envelopes.length)
        await tx
          .deleteFrom("trip_key_envelopes")
          .where("trip_id", "=", candidate.id)
          .where(
            "recipient_device_id",
            "in",
            envelopes.map((e) => e.recipient_device_id),
          )
          .execute();
      const remaining = await sql<{ remaining: boolean }>`select
        exists(select 1 from assets where trip_id = ${candidate.id}::uuid and encrypted_manifest is not null)
        or exists(select 1 from upload_sessions where trip_id = ${candidate.id}::uuid and encrypted_manifest is not null)
        or exists(select 1 from trip_key_envelopes where trip_id = ${candidate.id}::uuid) as remaining`.execute(
        tx,
      );
      const complete = remaining.rows[0]?.remaining === false;
      if (complete)
        await tx
          .updateTable("trips")
          .set({ media_metadata_purged_at: now })
          .where("id", "=", candidate.id)
          .execute();
      return {
        assets: assets.length,
        uploads: uploads.rows.length,
        envelopes: envelopes.length,
        trips: complete ? 1 : 0,
      };
    });
    if (result)
      for (const key of ["assets", "uploads", "envelopes", "trips"] as const)
        counts[key] += result[key];
  }
  if (Object.values(counts).some((count) => count > 0))
    console.log(JSON.stringify({ event: "media_metadata_retired", ...counts }));
  return counts;
}
