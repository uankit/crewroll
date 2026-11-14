import type { Transaction } from "kysely";
import type { Database } from "../schema/tables.js";

/** Called under the existing trip lock, after a version-changing mutation. */
export async function insertTripLifecycleWake(
  tx: Transaction<Database>,
  tripId: string,
  now: Date,
): Promise<void> {
  const trip = await tx
    .selectFrom("trips")
    .select(["version", "state"])
    .where("id", "=", tripId)
    .executeTakeFirstOrThrow();
  const members = await tx
    .selectFrom("trip_members")
    .select("participating_device_id")
    .where("trip_id", "=", tripId)
    .where("state", "!=", "REJECTED")
    .where((eb) => eb.or([eb("left_at", "is", null), eb("left_at", ">=", now)]))
    .orderBy("left_at", "desc")
    .limit(10)
    .execute();
  const sequences: string[] = [];
  for (const member of members) {
    const row = await tx
      .insertInto("inbox_events")
      .values({
        recipient_device_id: member.participating_device_id,
        trip_id: tripId,
        event_type: "TRIP_CHANGED",
        aggregate_id: tripId,
        available_at: now,
        created_at: now,
        payload: { status: trip.state, version: trip.version },
      })
      .returning("sequence")
      .executeTakeFirstOrThrow();
    sequences.push(row.sequence);
  }
  await tx
    .insertInto("outbox_events")
    .values({
      id: crypto.randomUUID(),
      aggregate_id: tripId,
      event_type: "trip.lifecycle",
      dedupe_key: `trip.lifecycle:${tripId}:v${trip.version}`,
      available_at: now,
      created_at: now,
      published_at: null,
      last_error: null,
      payload: { tripId, recipientSequences: sequences },
    })
    .execute();
}
