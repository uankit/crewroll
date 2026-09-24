import { sql, type Transaction } from "kysely";
import type { Database } from "../schema/tables.js";

type Tx = Transaction<Database>;
export const subjectHash = async (subject: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject)),
  ).toString("hex");

// Call after locking the user, before locking trips (the normal command order).
export async function stopParticipation(
  tx: Tx,
  userId: string,
  now: Date,
  onlyTripId?: string,
) {
  const trips = await tx
    .selectFrom("trips")
    .selectAll()
    .where(
      "id",
      "in",
      tx
        .selectFrom("trip_members")
        .select("trip_id")
        .where("user_id", "=", userId),
    )
    .$if(onlyTripId !== undefined, (q) => q.where("id", "=", onlyTripId!))
    .orderBy("id")
    .forUpdate()
    .execute();
  for (const trip of trips) {
    const owner = trip.owner_user_id === userId;
    await tx
      .updateTable("trip_members")
      .set({
        leaving_at: sql`coalesce(leaving_at, ${now})`,
        left_at: now,
        left_incomplete: trip.started_at !== null,
        updated_at: now,
      })
      .where("trip_id", "=", trip.id)
      .where("left_at", "is", null)
      .$if(!owner, (q) => q.where("user_id", "=", userId))
      .execute();
    await tx
      .deleteFrom("user_active_trips")
      .where("trip_id", "=", trip.id)
      .$if(!owner, (q) => q.where("user_id", "=", userId))
      .execute();
    await tx
      .updateTable("deliveries")
      .set({ state: "EXPIRED" })
      .where(
        "asset_id",
        "in",
        tx.selectFrom("assets").select("id").where("trip_id", "=", trip.id),
      )
      .where("state", "in", ["HELD", "READY"])
      .$if(!owner, (q) => q.where("recipient_user_id", "=", userId))
      .execute();
    if (owner) {
      await tx
        .updateTable("trip_invites")
        .set({ revoked_at: now, updated_at: now })
        .where("trip_id", "=", trip.id)
        .execute();
      await tx
        .updateTable("trips")
        .set({
          ...(trip.started_at
            ? {
                state: "INCOMPLETE_EXPIRED" as const,
                ending_started_at: trip.ending_started_at ?? now,
                completed_at: trip.completed_at ?? now,
              }
            : {
                state: "CANCELLED" as const,
                cancelled_at: trip.cancelled_at ?? now,
              }),
          version: sql`version + 1`,
          updated_at: now,
        })
        .where("id", "=", trip.id)
        .execute();
    } else {
      await sql`update trips set member_count = greatest(1, (select count(*) from trip_members where trip_id = ${trip.id}::uuid and left_at is null and state <> 'REJECTED')), version = version + 1, updated_at = ${now} where id = ${trip.id}::uuid`.execute(
        tx,
      );
    }
  }
}

export async function enqueueAccountDeletion(
  tx: Tx,
  userId: string,
  subject: string,
  now: Date,
  providerDeleted = false,
) {
  const existing = await tx
    .selectFrom("account_deletions")
    .selectAll()
    .where("clerk_subject", "=", subject)
    .executeTakeFirst();
  if (existing) {
    if (providerDeleted)
      await tx
        .updateTable("account_deletions")
        .set({ provider_deleted_at: now })
        .where("id", "=", existing.id)
        .execute();
    return existing.id;
  }
  const requestId = crypto.randomUUID();
  await tx
    .insertInto("account_deleted_subjects")
    .values({ subject_hash: await subjectHash(subject), deleted_at: now })
    .onConflict((c) => c.column("subject_hash").doNothing())
    .execute();
  await tx
    .insertInto("account_deletions")
    .values({
      id: requestId,
      user_id: userId,
      clerk_subject: subject,
      requested_at: now,
      available_at: now,
      provider_deleted_at: providerDeleted ? now : null,
      completed_at: null,
      lease_token: null,
    })
    .execute();
  await tx
    .updateTable("users")
    .set({
      display_name: "Deleted account",
      deleted_at: sql`coalesce(deleted_at, ${now})`,
      updated_at: now,
    })
    .where("id", "=", userId)
    .execute();
  await tx
    .updateTable("devices")
    .set({
      revoked_at: sql`coalesce(revoked_at, ${now})`,
      encrypted_push_token: null,
      push_token_hash: null,
      updated_at: now,
    })
    .where("user_id", "=", userId)
    .execute();
  await stopParticipation(tx, userId, now);
  // Retain only opaque object keys until storage confirms erasure. The user lock
  // prevents new uploads; trip locks fence other members of a deleted host's trip.
  await sql`insert into account_deletion_objects (request_id, object_key)
    select ${requestId}::uuid, o.s3_key from upload_objects o join upload_sessions u on u.id = o.upload_session_id
    where u.source_device_id in (select id from devices where user_id = ${userId}::uuid)
       or u.trip_id in (select id from trips where owner_user_id = ${userId}::uuid)
    union
    select ${requestId}::uuid, o.s3_key from asset_objects o join assets a on a.id = o.asset_id
    where a.source_device_id in (select id from devices where user_id = ${userId}::uuid)
       or a.trip_id in (select id from trips where owner_user_id = ${userId}::uuid)
    on conflict do nothing`.execute(tx);
  return requestId;
}

export async function eraseAccountRecords(tx: Tx, userId: string) {
  const devices = tx
    .selectFrom("devices")
    .select("id")
    .where("user_id", "=", userId);
  const trips = tx
    .selectFrom("trips")
    .select("id")
    .where("owner_user_id", "=", userId);
  const assets = tx
    .selectFrom("assets")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("source_device_id", "in", devices),
        eb("trip_id", "in", trips),
      ]),
    );
  const uploads = tx
    .selectFrom("upload_sessions")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("source_device_id", "in", devices),
        eb("trip_id", "in", trips),
      ]),
    );
  const deliveries = tx
    .selectFrom("deliveries")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("recipient_user_id", "=", userId),
        eb("asset_id", "in", assets),
      ]),
    );
  // Coordination JSON includes names and identifiers; remove every affected
  // trip's transient events and cached responses, not just indexed actor rows.
  const affected = await tx
    .selectFrom("trip_members")
    .select("trip_id")
    .where("user_id", "=", userId)
    .execute();
  const affectedIds = affected.map((row) => row.trip_id);
  if (affectedIds.length) {
    await tx
      .deleteFrom("inbox_events")
      .where("trip_id", "in", affectedIds)
      .execute();
    await sql`delete from outbox_events where aggregate_id in (${sql.join(affectedIds.map((id) => sql`${id}::uuid`))}) or payload->>'tripId' in (${sql.join(affectedIds)})`.execute(
      tx,
    );
    await sql`delete from api_idempotency where user_id = ${userId}::uuid or response_body::text like ${`%${userId}%`} or response_body->>'tripId' in (${sql.join(affectedIds)})`.execute(
      tx,
    );
    await tx
      .deleteFrom("audit_events")
      .where("trip_id", "in", affectedIds)
      .execute();
  }
  await tx
    .deleteFrom("audit_events")
    .where("actor_user_id", "=", userId)
    .execute();
  await tx
    .deleteFrom("api_idempotency")
    .where("user_id", "=", userId)
    .execute();
  await tx
    .deleteFrom("inbox_events")
    .where("recipient_device_id", "in", devices)
    .execute();
  await tx
    .deleteFrom("receipts")
    .where("delivery_id", "in", deliveries)
    .execute();
  await tx.deleteFrom("deliveries").where("id", "in", deliveries).execute();
  await tx
    .deleteFrom("asset_objects")
    .where("asset_id", "in", assets)
    .execute();
  await tx.deleteFrom("assets").where("id", "in", assets).execute();
  await tx
    .deleteFrom("upload_objects")
    .where("upload_session_id", "in", uploads)
    .execute();
  await tx.deleteFrom("upload_sessions").where("id", "in", uploads).execute();
  await tx
    .deleteFrom("trip_device_requests")
    .where((eb) =>
      eb.or([
        eb("trip_id", "in", trips),
        eb("previous_device_id", "in", devices),
        eb("device_id", "in", devices),
        eb("approved_by_device_id", "in", devices),
      ]),
    )
    .execute();
  await tx
    .deleteFrom("trip_key_envelopes")
    .where((eb) =>
      eb.or([
        eb("trip_id", "in", trips),
        eb("sender_device_id", "in", devices),
        eb("recipient_device_id", "in", devices),
      ]),
    )
    .execute();
  await tx
    .deleteFrom("trip_members")
    .where((eb) =>
      eb.or([eb("trip_id", "in", trips), eb("user_id", "=", userId)]),
    )
    .execute();
  await tx
    .deleteFrom("user_active_trips")
    .where((eb) =>
      eb.or([eb("trip_id", "in", trips), eb("user_id", "=", userId)]),
    )
    .execute();
  await tx
    .deleteFrom("trip_owner_invites")
    .where("trip_id", "in", trips)
    .execute();
  await tx.deleteFrom("trip_invites").where("trip_id", "in", trips).execute();
  await tx.deleteFrom("trips").where("owner_user_id", "=", userId).execute();
  await tx.deleteFrom("devices").where("user_id", "=", userId).execute();
  await tx
    .updateTable("safety_reports")
    .set({ details: "", trip_id: null, asset_id: null })
    .where("reporter_user_id", "=", userId)
    .execute();
  await tx.deleteFrom("users").where("id", "=", userId).execute();
}
