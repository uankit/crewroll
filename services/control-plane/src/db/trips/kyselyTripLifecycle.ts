import { sql, type Kysely, type Transaction, type Selectable } from "kysely";
import type { TripTransferState } from "@crewroll/contracts";
import type { Database, TripMemberTable, TripTable } from "../schema/tables.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Clock } from "../../shared/time/clock.js";

import type {
  LifecycleActor,
  TripLifecycleService,
} from "../../modules/trips/ports/tripLifecycleService.js";
type Tx = Transaction<Database>;
type Member = Selectable<TripMemberTable>;
type Trip = Selectable<TripTable>;
const terminal = (state: string) =>
  ["COMPLETE", "INCOMPLETE_EXPIRED", "CANCELLED"].includes(state);
const participation = (m: Member): TripTransferState["participation"] =>
  m.left_at
    ? "LEFT"
    : m.leaving_at
      ? "LEAVING"
      : m.state === "PENDING_KEY"
        ? "JOINING"
        : "JOINED";

/** Membership and media mutations share the user -> device -> trip lock order. */
export function createKyselyTripLifecycle(
  db: Kysely<Database>,
  clock: Clock,
): TripLifecycleService {
  async function authorize(tx: Tx, actor: LifecycleActor) {
    const user = await tx
      .selectFrom("users")
      .selectAll()
      .where("id", "=", actor.userId)
      .forUpdate()
      .executeTakeFirst();
    const device = await tx
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", actor.deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !user ||
      user.deleted_at ||
      (actor.clerkSubject && user.clerk_subject !== actor.clerkSubject) ||
      !device ||
      device.user_id !== actor.userId ||
      device.revoked_at ||
      (!actor.clerkSubject &&
        device.background_credential_expires_at <= clock.now())
    )
      throw new DomainError("AUTH_INVALID");
  }
  async function lock(tx: Tx, actor: LifecycleActor, tripId: string) {
    await authorize(tx, actor);
    const trip = await tx
      .selectFrom("trips")
      .selectAll()
      .where("id", "=", tripId)
      .forUpdate()
      .executeTakeFirst();
    const member = await tx
      .selectFrom("trip_members")
      .selectAll()
      .where("trip_id", "=", tripId)
      .where("user_id", "=", actor.userId)
      .where("participating_device_id", "=", actor.deviceId)
      .where("state", "!=", "REJECTED")
      .executeTakeFirst();
    if (!trip || !member) throw new DomainError("NOT_FOUND");
    return { trip, member };
  }
  async function bump(tx: Tx, tripId: string) {
    await tx
      .updateTable("trips")
      .set({ version: sql`version + 1`, updated_at: clock.now() })
      .where("id", "=", tripId)
      .execute();
  }
  async function counts(tx: Tx, trip: Trip, member: Member) {
    const cutoff = member.leaving_at ?? trip.ending_started_at ?? trip.ends_at;
    const uploads = await tx
      .selectFrom("upload_sessions")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("trip_id", "=", trip.id)
      .where("state", "in", ["CREATED", "VERIFIED"])
      .where("created_at", "<=", cutoff)
      .executeTakeFirstOrThrow();
    const downloads = await tx
      .selectFrom("deliveries as d")
      .innerJoin("assets as a", "a.id", "d.asset_id")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("a.trip_id", "=", trip.id)
      .where("d.recipient_device_id", "=", member.participating_device_id)
      .where("d.state", "in", ["READY", "HELD"])
      .executeTakeFirstOrThrow();
    return {
      pendingUploads: Number(uploads.count),
      pendingDownloads: Number(downloads.count),
    };
  }
  async function depart(tx: Tx, trip: Trip, member: Member, forced = false) {
    const now = clock.now();
    await tx
      .updateTable("trip_members")
      .set({
        leaving_at: member.leaving_at ?? now,
        left_at: now,
        left_incomplete: forced && trip.started_at !== null,
        updated_at: now,
      })
      .where("id", "=", member.id)
      .where("left_at", "is", null)
      .execute();
    await tx
      .deleteFrom("user_active_trips")
      .where("user_id", "=", member.user_id)
      .where("trip_id", "=", trip.id)
      .execute();
    // A waived delivery is EXPIRED, never a fabricated save receipt. Already
    // staged originals remain available to the other participating recipients.
    await tx
      .updateTable("deliveries")
      .set({ state: "EXPIRED" })
      .where("recipient_device_id", "=", member.participating_device_id)
      .where(
        "asset_id",
        "in",
        tx.selectFrom("assets").select("id").where("trip_id", "=", trip.id),
      )
      .where("state", "in", ["READY", "HELD"])
      .execute();
    const remaining = await tx
      .selectFrom("trip_members")
      .select("id")
      .where("trip_id", "=", trip.id)
      .where("left_at", "is", null)
      .where("state", "!=", "REJECTED")
      .execute();
    await tx
      .updateTable("trips")
      .set({ member_count: Math.max(1, remaining.length) })
      .where("id", "=", trip.id)
      .execute();
    if (!remaining.length && !terminal(trip.state)) {
      const missed = await tx
        .selectFrom("trip_members")
        .select("id")
        .where("trip_id", "=", trip.id)
        .where("left_incomplete", "=", true)
        .executeTakeFirst();
      await tx
        .updateTable("trips")
        .set(
          trip.started_at
            ? {
                state: missed ? "INCOMPLETE_EXPIRED" : "COMPLETE",
                ending_started_at: trip.ending_started_at ?? now,
                completed_at: now,
              }
            : { state: "CANCELLED", cancelled_at: now },
        )
        .where("id", "=", trip.id)
        .execute();
    }
    await bump(tx, trip.id);
  }
  async function end(tx: Tx, trip: Trip) {
    if (terminal(trip.state) || trip.state === "ENDING") return;
    const now = clock.now();
    if (!trip.started_at) {
      const members = await tx
        .selectFrom("trip_members")
        .selectAll()
        .where("trip_id", "=", trip.id)
        .where("left_at", "is", null)
        .where("state", "!=", "REJECTED")
        .execute();
      for (const m of members) await depart(tx, trip, m);
    } else {
      await tx
        .updateTable("trips")
        .set({ state: "ENDING", ending_started_at: now })
        .where("id", "=", trip.id)
        .execute();
      await tx
        .updateTable("trip_members")
        .set({ leaving_at: now, drained_at: null, updated_at: now })
        .where("trip_id", "=", trip.id)
        .where("left_at", "is", null)
        .where("leaving_at", "is", null)
        .execute();
      await bump(tx, trip.id);
    }
    await tx
      .updateTable("trip_invites")
      .set({ revoked_at: now })
      .where("trip_id", "=", trip.id)
      .where("revoked_at", "is", null)
      .execute();
  }
  async function settle(tx: Tx, trip: Trip, member: Member) {
    if (!member.leaving_at || member.left_at || !member.drained_at) return;
    // Ending waits for each phone's final discovery pass, including phones that
    // were offline when the host ended. The hard deadline bounds that wait.
    if (
      trip.state === "ENDING" &&
      trip.ending_started_at &&
      member.leaving_at >= trip.ending_started_at
    ) {
      const undrained = await tx
        .selectFrom("trip_members")
        .select("id")
        .where("trip_id", "=", trip.id)
        .where("left_at", "is", null)
        .where("drained_at", "is", null)
        .where("state", "=", "ACTIVE")
        .executeTakeFirst();
      if (undrained) return;
    }
    const pending = await counts(tx, trip, member);
    if (!pending.pendingUploads && !pending.pendingDownloads)
      await depart(tx, trip, member);
  }
  async function state(
    tx: Tx,
    actor: LifecycleActor,
    tripId: string,
  ): Promise<TripTransferState> {
    let { trip, member } = await lock(tx, actor, tripId);
    if (trip.state === "ACTIVE" && trip.ends_at <= clock.now()) {
      await end(tx, trip);
      ({ trip, member } = await lock(tx, actor, tripId));
    }
    await settle(tx, trip, member);
    ({ trip, member } = await lock(tx, actor, tripId));
    const cutoff = new Date(
      Math.min(
        trip.ends_at.getTime(),
        trip.ending_started_at?.getTime() ?? Infinity,
        member.leaving_at?.getTime() ?? Infinity,
      ),
    );
    const replacement = await tx
      .selectFrom("trip_device_requests")
      .select("resolved_at")
      .where("trip_id", "=", tripId)
      .where("device_id", "=", actor.deviceId)
      .where("state", "=", "APPROVED")
      .executeTakeFirst();
    return {
      tripId,
      version: trip.version,
      status: trip.state,
      participation: participation(member),
      sharingPaused: member.sharing_paused_at !== null,
      captureFrom: new Date(
        Math.max(
          trip.started_at?.getTime() ?? 0,
          member.approved_at?.getTime() ?? clock.now().getTime(),
          replacement?.resolved_at?.getTime() ?? 0,
        ),
      ).toISOString(),
      captureUntil: cutoff.toISOString(),
      excludedCaptureWindows: [
        ...member.sharing_pauses,
        ...(member.sharing_paused_at
          ? [{ from: member.sharing_paused_at.toISOString(), until: null }]
          : []),
      ],
      ...(member.left_at
        ? { pendingUploads: 0, pendingDownloads: 0 }
        : await counts(tx, trip, member)),
      deliveryDeadline: trip.hard_delete_at.toISOString(),
    };
  }
  return {
    read: (actor, tripId) =>
      db.transaction().execute((tx) => state(tx, actor, tripId)),
    async list(actor) {
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const rows = await tx
          .selectFrom("trip_members as m")
          .innerJoin("trips as t", "t.id", "m.trip_id")
          .select([
            "t.id",
            "t.name",
            "t.state as status",
            "t.started_at",
            "t.ends_at",
            "m.role",
            "m.state",
            "m.left_at",
            "m.leaving_at",
            "m.sharing_paused_at",
            "m.participating_device_id",
          ])
          .select((eb) => [
            eb
              .selectFrom("trip_members as crew")
              .select(eb.fn.countAll<string>().as("count"))
              .whereRef("crew.trip_id", "=", "t.id")
              .where("crew.left_at", "is", null)
              .where("crew.state", "=", "ACTIVE")
              .as("memberCount"),
            eb
              .selectFrom("deliveries as d")
              .innerJoin("assets as a", "a.id", "d.asset_id")
              .select(eb.fn.countAll<string>().as("count"))
              .whereRef("a.trip_id", "=", "t.id")
              .whereRef(
                "d.recipient_device_id",
                "=",
                "m.participating_device_id",
              )
              .where("d.state", "=", "SAVED_LOCALLY")
              .as("savedPhotoCount"),
          ])
          .where("m.user_id", "=", actor.userId)
          .where("m.state", "!=", "REJECTED")
          .orderBy("t.created_at", "desc")
          .execute();
        return {
          items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            role: r.role,
            participation:
              r.left_at || terminal(r.status)
                ? ("LEFT" as const)
                : r.leaving_at
                  ? ("LEAVING" as const)
                  : r.state === "PENDING_KEY"
                    ? ("JOINING" as const)
                    : ("JOINED" as const),
            startsAt: r.started_at?.toISOString() ?? null,
            endsAt: r.ends_at.toISOString(),
            leftAt: r.left_at?.toISOString() ?? null,
            sharingPaused: r.sharing_paused_at !== null,
            onThisDevice: r.participating_device_id === actor.deviceId,
            memberCount: Number(r.memberCount),
            savedPhotoCount: Number(r.savedPhotoCount),
          })),
        };
      });
    },
    async change(actor, tripId, body) {
      return db.transaction().execute(async (tx) => {
        const { trip, member } = await lock(tx, actor, tripId);
        if (body.action === "END" && member.role !== "OWNER")
          throw new DomainError("TRIP_OWNER_REQUIRED");
        if (body.expectedVersion !== trip.version)
          throw new DomainError("VERSION_CONFLICT");
        if (body.action === "END") await end(tx, trip);
        else if (!member.left_at && !terminal(trip.state)) {
          if (body.action === "LEAVE_NOW") await depart(tx, trip, member, true);
          else if (body.action === "LEAVE") {
            if (trip.state === "LOBBY" || member.state === "PENDING_KEY")
              await depart(tx, trip, member);
            else if (!member.leaving_at) {
              await tx
                .updateTable("trip_members")
                .set({ leaving_at: clock.now(), drained_at: null })
                .where("id", "=", member.id)
                .execute();
              await bump(tx, tripId);
            }
          } else {
            if (trip.state !== "ACTIVE" || member.leaving_at)
              throw new DomainError("TRIP_STATE_CONFLICT");
            if (body.action === "PAUSE" && !member.sharing_paused_at) {
              await tx
                .updateTable("trip_members")
                .set({ sharing_paused_at: clock.now() })
                .where("id", "=", member.id)
                .execute();
              await bump(tx, tripId);
            } else if (body.action === "RESUME" && member.sharing_paused_at) {
              await tx
                .updateTable("trip_members")
                .set({
                  sharing_paused_at: null,
                  sharing_pauses: sql`${JSON.stringify([...member.sharing_pauses, { from: member.sharing_paused_at.toISOString(), until: clock.now().toISOString() }])}::jsonb`,
                })
                .where("id", "=", member.id)
                .execute();
              await bump(tx, tripId);
            }
          }
        }
        return state(tx, actor, tripId);
      });
    },
    async drained(actor, tripId, observedVersion) {
      return db.transaction().execute(async (tx) => {
        const { trip, member } = await lock(tx, actor, tripId);
        if (
          !member.left_at &&
          member.leaving_at &&
          trip.version === observedVersion
        )
          await tx
            .updateTable("trip_members")
            .set({ drained_at: clock.now() })
            .where("id", "=", member.id)
            .execute();
        return state(tx, actor, tripId);
      });
    },
    async expire() {
      const candidates = await db
        .selectFrom("trips")
        .select("id")
        .where((eb) =>
          eb.or([
            eb.and([
              eb("state", "in", ["LOBBY", "ACTIVE"]),
              eb("ends_at", "<=", clock.now()),
            ]),
            eb.and([
              eb("state", "=", "ENDING"),
              eb("hard_delete_at", "<=", clock.now()),
            ]),
          ]),
        )
        // Waiting rooms need no mutation yet. Including them would repeatedly
        // consume the whole batch and starve other trips' end/expiry deadlines.
        .orderBy("hard_delete_at", "asc")
        .limit(100)
        .execute();
      for (const { id } of candidates)
        await db.transaction().execute(async (tx) => {
          const trip = await tx
            .selectFrom("trips")
            .selectAll()
            .where("id", "=", id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (terminal(trip.state)) return;
          if (trip.state !== "ENDING") await end(tx, trip);
          if (trip.hard_delete_at <= clock.now() && trip.started_at) {
            const now = clock.now();
            await tx
              .updateTable("trip_members")
              .set({
                leaving_at: sql`coalesce(leaving_at, ${now})`,
                left_at: now,
              })
              .where("trip_id", "=", id)
              .where("left_at", "is", null)
              .execute();
            await tx
              .deleteFrom("user_active_trips")
              .where("trip_id", "=", id)
              .execute();
            await tx
              .updateTable("trips")
              .set({
                state: "INCOMPLETE_EXPIRED",
                completed_at: now,
                version: sql`version + 1`,
              })
              .where("id", "=", id)
              .execute();
          }
        });
    },
  };
}
