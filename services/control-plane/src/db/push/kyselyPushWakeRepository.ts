import { sql, type Kysely } from "kysely";
import type { Database } from "../schema/tables.js";
import type { Clock } from "../../shared/time/clock.js";
import type {
  ClaimedPushWake,
  PushWakeRepository,
} from "../../modules/push/ports/pushDispatch.js";

const LEASE_MS = 120_000;
const COALESCE_MS = 60_000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1_000;
const supportedEvents = ["trip.changed", "trip.lifecycle", "media.committed"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createKyselyPushWakeRepository(
  db: Kysely<Database>,
  clock: Clock,
): PushWakeRepository {
  function owned(job: ClaimedPushWake) {
    return db
      .updateTable("push_wakeups")
      .where("id", "=", job.id)
      .where("lease_token", "=", job.leaseToken)
      .where("completed_at", "is", null);
  }
  return {
    async materialize(limit) {
      await db.transaction().execute(async (tx) => {
        const now = clock.now();
        const events = await tx
          .selectFrom("outbox_events")
          .selectAll()
          .where("published_at", "is", null)
          .where("available_at", "<=", now)
          .orderBy("available_at")
          .orderBy("id")
          .forUpdate()
          .skipLocked()
          .limit(Math.max(1, Math.min(100, limit)))
          .execute();
        for (const event of events) {
          const { tripId, recipientSequences } = event.payload;
          let error: string | null = null;
          if (
            !supportedEvents.includes(event.event_type) ||
            typeof tripId !== "string" ||
            !uuid.test(tripId) ||
            !Array.isArray(recipientSequences) ||
            recipientSequences.length > 10 ||
            !recipientSequences.every(
              (s) => typeof s === "string" && /^[1-9][0-9]{0,18}$/.test(s),
            )
          ) {
            error = "OUTBOX_INVALID_PAYLOAD";
          } else {
            const trip = await tx
              .selectFrom("trips")
              .select("hard_delete_at")
              .where("id", "=", tripId)
              .executeTakeFirst();
            const expiresAt = new Date(
              Math.min(
                event.created_at.getTime() + 3_600_000,
                trip?.hard_delete_at.getTime() ?? 0,
              ),
            );
            if (expiresAt <= now || expiresAt <= event.created_at)
              error = "OUTBOX_EXPIRED";
            else if (recipientSequences.length) {
              const recipients = await tx
                .selectFrom("inbox_events as i")
                .innerJoin("devices as d", "d.id", "i.recipient_device_id")
                .select(["i.recipient_device_id", "d.user_id"])
                .where("i.trip_id", "=", tripId)
                .where("i.sequence", "in", recipientSequences as string[])
                .distinct()
                .execute();
              if (recipients.length)
                await tx
                  .insertInto("push_wakeups")
                  .values(
                    recipients.map((recipient) => ({
                      id: crypto.randomUUID(),
                      event_id: event.id,
                      trip_id: tripId,
                      recipient_device_id: recipient.recipient_device_id,
                      recipient_user_id: recipient.user_id,
                      available_at: now,
                      created_at: event.created_at,
                      expires_at: expiresAt,
                      lease_token: null,
                      completed_at: null,
                      outcome: null,
                      last_error: null,
                    })),
                  )
                  .onConflict((c) =>
                    c.columns(["event_id", "recipient_device_id"]).doNothing(),
                  )
                  .execute();
            }
          }
          // Published means atomically fanned out, never device delivery/save.
          await tx
            .updateTable("outbox_events")
            .set({
              published_at: new Date(
                Math.max(now.getTime(), event.created_at.getTime()),
              ),
              last_error: error,
            })
            .where("id", "=", event.id)
            .execute();
        }
      });
    },
    async claim() {
      return db.transaction().execute(async (tx) => {
        const now = clock.now();
        const row = await tx
          .selectFrom("push_wakeups")
          .selectAll()
          .where("completed_at", "is", null)
          .where("available_at", "<=", now)
          .orderBy("available_at")
          .orderBy("created_at")
          .orderBy("id")
          .forUpdate()
          .skipLocked()
          .limit(1)
          .executeTakeFirst();
        if (!row) return null;
        // Serializes per-trip/device lease decisions without blocking account,
        // device or trip mutations while a provider request is in flight.
        const lock = await sql<{
          locked: boolean;
        }>`select pg_try_advisory_xact_lock(hashtextextended(${`${row.recipient_device_id}:${row.trip_id}`}, 0)) as locked`.execute(
          tx,
        );
        if (!lock.rows[0]?.locked) return null;
        if (row.expires_at <= now || row.attempt_count >= 8) {
          await tx
            .updateTable("push_wakeups")
            .set({
              completed_at: now,
              lease_token: null,
              outcome: row.expires_at <= now ? "EXPIRED" : "DEAD_LETTERED",
            })
            .where("id", "=", row.id)
            .execute();
          return null;
        }
        const inflight = await tx
          .selectFrom("push_wakeups")
          .select("id")
          .where("recipient_device_id", "=", row.recipient_device_id)
          .where("trip_id", "=", row.trip_id)
          .where("completed_at", "is", null)
          .where("lease_token", "is not", null)
          .where("available_at", ">", now)
          .executeTakeFirst();
        if (inflight) {
          await tx
            .updateTable("push_wakeups")
            .set({ available_at: new Date(now.getTime() + COALESCE_MS) })
            .where("id", "=", row.id)
            .execute();
          return null;
        }
        const last = await tx
          .selectFrom("push_wakeups")
          .select("completed_at")
          .where("recipient_device_id", "=", row.recipient_device_id)
          .where("trip_id", "=", row.trip_id)
          .where("outcome", "=", "SENT")
          .where("completed_at", ">", new Date(now.getTime() - COALESCE_MS))
          .orderBy("completed_at", "desc")
          .executeTakeFirst();
        if (last?.completed_at) {
          await tx
            .updateTable("push_wakeups")
            .set({
              available_at: new Date(last.completed_at.getTime() + COALESCE_MS),
            })
            .where("id", "=", row.id)
            .execute();
          return null;
        }
        const leaseToken = crypto.randomUUID();
        await tx
          .updateTable("push_wakeups")
          .set({
            lease_token: leaseToken,
            available_at: new Date(now.getTime() + LEASE_MS),
            attempt_count: row.attempt_count + 1,
          })
          .where("id", "=", row.id)
          .execute();
        return {
          id: row.id,
          leaseToken,
          attempt: row.attempt_count + 1,
          userId: row.recipient_user_id,
          expiresAt: row.expires_at,
          hint: {
            type: "crewroll.sync.v1",
            deviceId: row.recipient_device_id,
            tripId: row.trip_id,
            eventId: row.event_id,
          },
        };
      });
    },
    async target(job) {
      const now = clock.now();
      const row = await db
        .selectFrom("push_wakeups as w")
        .innerJoin("devices as d", "d.id", "w.recipient_device_id")
        .innerJoin("users as u", "u.id", "d.user_id")
        .innerJoin("trips as t", "t.id", "w.trip_id")
        .innerJoin("trip_members as m", (j) =>
          j
            .onRef("m.trip_id", "=", "w.trip_id")
            .onRef("m.participating_device_id", "=", "d.id")
            .onRef("m.user_id", "=", "u.id"),
        )
        .select([
          "d.platform",
          "d.encrypted_push_token",
          "d.push_token_hash",
          "d.updated_at",
          "d.push_token_committed_revision",
        ])
        .where("w.id", "=", job.id)
        .where("w.lease_token", "=", job.leaseToken)
        .where("w.completed_at", "is", null)
        .where("w.available_at", ">", now)
        .where("w.expires_at", ">", now)
        .where("t.hard_delete_at", ">", now)
        .where("d.user_id", "=", job.userId)
        .where("w.recipient_user_id", "=", job.userId)
        .where("d.revoked_at", "is", null)
        .where("u.deleted_at", "is", null)
        .where("u.suspended_at", "is", null)
        .where("d.background_credential_expires_at", ">", now)
        .where((eb) =>
          eb.or([
            eb("m.left_at", "is", null),
            eb("m.left_at", ">=", eb.ref("w.created_at")),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb("m.rejected_at", "is", null),
            eb("m.rejected_at", ">=", eb.ref("w.created_at")),
          ]),
        )
        .executeTakeFirst();
      return row?.encrypted_push_token && row.push_token_hash
        ? {
            platform: row.platform,
            encryptedToken: row.encrypted_push_token,
            tokenHash: row.push_token_hash,
            revision: {
              registeredAt: row.updated_at,
              committed: row.push_token_committed_revision,
            },
          }
        : null;
    },
    async complete(job, outcome, errorCode) {
      await db.transaction().execute(async (tx) => {
        const sent = await tx
          .updateTable("push_wakeups")
          .set({
            completed_at: clock.now(),
            outcome,
            lease_token: null,
            last_error: errorCode ?? null,
          })
          .where("id", "=", job.id)
          .where("lease_token", "=", job.leaseToken)
          .where("completed_at", "is", null)
          .returning(["created_at", "expires_at"])
          .executeTakeFirst();
        if (outcome !== "SENT" || !sent) return;
        // Coalesce only after provider acceptance. Never let a failed, exhausted
        // or nearly expired old job consume a newer commit's retry/TTL budget.
        const older = await tx
          .selectFrom("push_wakeups")
          .select("id")
          .where("recipient_device_id", "=", job.hint.deviceId)
          .where("trip_id", "=", job.hint.tripId)
          .where("completed_at", "is", null)
          .where("lease_token", "is", null)
          .where("created_at", "<=", sent.created_at)
          .where("expires_at", "<=", sent.expires_at)
          .orderBy("created_at")
          .limit(100)
          .forUpdate()
          .skipLocked()
          .execute();
        if (older.length)
          await tx
            .updateTable("push_wakeups")
            .set({ completed_at: clock.now(), outcome: "COALESCED" })
            .where(
              "id",
              "in",
              older.map((row) => row.id),
            )
            .execute();
      });
    },
    async retry(job, at, code) {
      await owned(job)
        .set({ available_at: at, lease_token: null, last_error: code })
        .execute();
    },
    async invalidateToken(job, hash, revision, invalidatedAt) {
      await db
        .updateTable("devices")
        .set({ encrypted_push_token: null, push_token_hash: null })
        .where("id", "=", job.hint.deviceId)
        .where("user_id", "=", job.userId)
        .where("push_token_hash", "=", Buffer.from(hash))
        .where("updated_at", "=", revision.registeredAt)
        .where("push_token_committed_revision", "=", revision.committed)
        .$if(invalidatedAt !== undefined, (query) =>
          query.where("updated_at", "<=", invalidatedAt!),
        )
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("push_wakeups")
              .select("id")
              .where("id", "=", job.id)
              .where("lease_token", "=", job.leaseToken)
              .where("completed_at", "is", null)
              .where("available_at", ">", clock.now())
              .where("expires_at", ">", clock.now()),
          ),
        )
        .execute();
    },
    async compact(limit) {
      const now = clock.now();
      const bounded = Math.max(1, Math.min(200, limit));
      await db.transaction().execute(async (tx) => {
        const expired = await tx
          .selectFrom("push_wakeups")
          .select("id")
          .where("completed_at", "is", null)
          .where("expires_at", "<=", now)
          .orderBy("expires_at")
          .limit(bounded)
          .forUpdate()
          .skipLocked()
          .execute();
        if (expired.length)
          await tx
            .updateTable("push_wakeups")
            .set({ completed_at: now, outcome: "EXPIRED", lease_token: null })
            .where(
              "id",
              "in",
              expired.map((r) => r.id),
            )
            .execute();
        const old = await tx
          .selectFrom("outbox_events as e")
          .select("e.id")
          .where("e.published_at", "<", new Date(now.getTime() - RETAIN_MS))
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("push_wakeups as w")
                  .select("w.id")
                  .whereRef("w.event_id", "=", "e.id")
                  .where("w.completed_at", "is", null),
              ),
            ),
          )
          .orderBy("e.published_at")
          .limit(bounded)
          .forUpdate()
          .skipLocked()
          .execute();
        if (old.length)
          await tx
            .deleteFrom("outbox_events")
            .where(
              "id",
              "in",
              old.map((r) => r.id),
            )
            .execute();
      });
    },
  };
}
