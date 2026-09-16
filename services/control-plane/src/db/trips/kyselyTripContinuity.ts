import { sql, type Kysely, type Transaction } from "kysely";
import type {
  DeviceApprovalRequest,
  TripContinuity,
  TripContinuityBody,
} from "@crewroll/contracts";
import type { Database } from "../schema/tables.js";
import type { Clock } from "../../shared/time/clock.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { InviteCodeCryptography } from "../../modules/trips/ports/inviteCodeHasher.js";
import type {
  ForegroundTripActor,
  NormalizeContinuityInvite,
  OwnerInviteVault,
  TripContinuityService,
} from "../../modules/trips/ports/tripContinuityService.js";

type Tx = Transaction<Database>;
export function createKyselyTripContinuity(
  db: Kysely<Database>,
  clock: Clock,
  hasher: InviteCodeCryptography,
  vault: OwnerInviteVault,
  normalizeInviteCode: NormalizeContinuityInvite,
): TripContinuityService {
  const randomUUID = () => crypto.randomUUID();
  async function lock(tx: Tx, actor: ForegroundTripActor, tripId: string) {
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
      user.clerk_subject !== actor.clerkSubject ||
      !device ||
      device.user_id !== user.id ||
      device.revoked_at
    )
      throw new DomainError("AUTH_INVALID");
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
      .where("user_id", "=", user.id)
      .where("left_at", "is", null)
      .where("state", "!=", "REJECTED")
      .executeTakeFirst();
    if (!trip || !member) throw new DomainError("NOT_FOUND");
    return { trip, member };
  }
  async function projection(
    tx: Tx,
    actor: ForegroundTripActor,
    tripId: string,
  ): Promise<TripContinuity> {
    const { trip, member } = await lock(tx, actor, tripId);
    const host = await tx
      .selectFrom("users")
      .select("display_name")
      .where("id", "=", trip.owner_user_id)
      .executeTakeFirstOrThrow();
    const onThisDevice = member.participating_device_id === actor.deviceId;
    const requests = await tx
      .selectFrom("trip_device_requests as r")
      .innerJoin("trip_members as m", "m.id", "r.membership_id")
      .innerJoin("users as u", "u.id", "m.user_id")
      .innerJoin("devices as d", "d.id", "r.device_id")
      .select([
        "r.id",
        "r.membership_id",
        "r.device_id",
        "r.state",
        "r.requested_at",
        "u.display_name",
        "d.platform",
        "d.e2ee_public_key",
        "m.role",
        "m.user_id",
      ])
      .where("r.trip_id", "=", tripId)
      .where("d.revoked_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("r.device_id", "=", actor.deviceId),
          ...(onThisDevice && member.state === "ACTIVE" && !member.leaving_at
            ? [
                member.role === "OWNER"
                  ? eb("r.state", "=", "PENDING")
                  : eb.and([
                      eb("r.state", "=", "PENDING"),
                      eb.or([
                        eb("m.user_id", "=", actor.userId),
                        eb("m.role", "=", "OWNER"),
                      ]),
                    ]),
              ]
            : []),
        ]),
      )
      .orderBy("r.requested_at")
      .execute();
    const project = (r: (typeof requests)[number]): DeviceApprovalRequest => ({
      requestId: r.id,
      membershipId: r.membership_id,
      displayName: r.display_name,
      deviceId: r.device_id,
      platform: r.platform,
      e2eePublicKey: Buffer.from(r.e2ee_public_key).toString("base64"),
      status: r.state,
      requestedAt: r.requested_at.toISOString(),
    });
    let ownerInviteCode: string | null = null;
    if (
      onThisDevice &&
      member.role === "OWNER" &&
      !member.leaving_at &&
      ["LOBBY", "ACTIVE"].includes(trip.state) &&
      trip.ends_at > clock.now()
    ) {
      const saved = await tx
        .selectFrom("trip_owner_invites")
        .selectAll()
        .where("trip_id", "=", tripId)
        .executeTakeFirst();
      if (saved) {
        const code = vault.open(tripId, saved.encrypted_code);
        const normalized = normalizeInviteCode(code);
        if (!normalized.ok) throw new DomainError("INTERNAL_ERROR");
        const digest = hasher.hash(normalized.value);
        const valid = await tx
          .selectFrom("trip_invites")
          .select("invite_code_hmac")
          .where("trip_id", "=", tripId)
          .where("revoked_at", "is", null)
          .where("expires_at", ">", clock.now())
          .whereRef("uses_count", "<", "max_uses")
          .execute();
        if (
          valid.some((invite) =>
            hasher.matches(invite.invite_code_hmac, digest),
          )
        )
          ownerInviteCode = code;
      }
    }
    return {
      tripId,
      version: trip.version,
      tripName: trip.name,
      status: trip.state,
      hostDisplayName: host.display_name,
      onThisDevice,
      syncFrom: member.approved_at
        ? new Date(
            Math.max(
              member.approved_at.getTime(),
              trip.started_at?.getTime() ?? 0,
            ),
          ).toISOString()
        : null,
      ownerInviteCode,
      deviceRequest:
        requests
          .filter((r) => r.device_id === actor.deviceId)
          .map(project)[0] ?? null,
      approvalRequests: requests
        .filter((r) => r.state === "PENDING" && r.device_id !== actor.deviceId)
        .map(project),
    };
  }
  async function change(
    tx: Tx,
    actor: ForegroundTripActor,
    tripId: string,
    body: TripContinuityBody,
  ) {
    const { trip, member } = await lock(tx, actor, tripId);
    const now = clock.now();
    if (
      !["LOBBY", "ACTIVE"].includes(trip.state) ||
      trip.ends_at <= now ||
      member.leaving_at ||
      (member.state !== "ACTIVE" &&
        !(member.state === "PENDING_KEY" && body.action === "REQUEST_DEVICE"))
    )
      throw new DomainError("TRIP_STATE_CONFLICT");
    const currentPhone = member.participating_device_id === actor.deviceId;
    // Resolve exact state replays before version checks; mutations remain CAS.
    if (body.action === "REQUEST_DEVICE") {
      if (currentPhone) return;
      const existing = await tx
        .selectFrom("trip_device_requests")
        .selectAll()
        .where("trip_id", "=", tripId)
        .where("device_id", "=", actor.deviceId)
        .executeTakeFirst();
      if (existing?.state === "PENDING" || existing?.state === "APPROVED")
        return;
    }
    if (body.action === "APPROVE_DEVICE" || body.action === "REJECT_DEVICE") {
      const prior = await tx
        .selectFrom("trip_device_requests")
        .selectAll()
        .where("trip_id", "=", tripId)
        .where("id", "=", body.requestId)
        .executeTakeFirst();
      if (
        prior?.approved_by_device_id === actor.deviceId &&
        prior.state ===
          (body.action === "APPROVE_DEVICE" ? "APPROVED" : "REJECTED")
      )
        return;
    }
    if (body.expectedVersion !== trip.version)
      throw new DomainError("VERSION_CONFLICT");
    if (body.action === "SAVE_INVITE") {
      if (!currentPhone || member.role !== "OWNER")
        throw new DomainError("TRIP_OWNER_REQUIRED");
      const code = normalizeInviteCode(body.inviteCode);
      if (!code.ok) throw new DomainError("INVALID_REQUEST");
      const digest = hasher.hash(code.value);
      const existing = await tx
        .selectFrom("trip_invites")
        .selectAll()
        .where("trip_id", "=", tripId)
        .execute();
      if (
        !existing.some(
          (invite) =>
            invite.revoked_at === null &&
            hasher.matches(invite.invite_code_hmac, digest) &&
            invite.expires_at > now &&
            invite.uses_count < invite.max_uses,
        )
      ) {
        await tx
          .updateTable("trip_invites")
          .set({ revoked_at: now, updated_at: now })
          .where("trip_id", "=", tripId)
          .where("revoked_at", "is", null)
          .execute();
        const reusable = existing.find((invite) =>
          hasher.matches(invite.invite_code_hmac, digest),
        );
        if (reusable)
          await tx
            .updateTable("trip_invites")
            .set({
              expires_at: trip.ends_at,
              revoked_at: null,
              uses_count: 0,
              updated_at: now,
            })
            .where("id", "=", reusable.id)
            .execute();
        else
          await tx
            .insertInto("trip_invites")
            .values({
              id: randomUUID(),
              trip_id: tripId,
              invite_code_hmac: Buffer.from(digest),
              expires_at: trip.ends_at,
              max_uses: 9,
              uses_count: 0,
              revoked_at: null,
              created_at: now,
              updated_at: now,
            })
            .execute();
      }
      await tx
        .insertInto("trip_owner_invites")
        .values({
          trip_id: tripId,
          encrypted_code: vault.seal(tripId, code.value),
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("trip_id").doUpdateSet({
            encrypted_code: vault.seal(tripId, code.value),
            updated_at: now,
          }),
        )
        .execute();
    } else if (body.action === "REQUEST_DEVICE") {
      // A pending join has never received a trip key. Its authenticated account
      // can replace the nominated phone, but still needs ordinary host approval
      // before either device can access photos. Do not strand a reinstalled app
      // behind an approval for a public key it no longer holds.
      if (member.state === "PENDING_KEY") {
        await tx
          .updateTable("trip_members")
          .set({
            participating_device_id: actor.deviceId,
            full_photo_library_access: false,
            updated_at: now,
          })
          .where("id", "=", member.id)
          .execute();
        await tx
          .updateTable("devices")
          .set({ revoked_at: now, updated_at: now })
          .where("id", "=", member.participating_device_id)
          .execute();
        await tx
          .updateTable("trips")
          .set({ version: sql`version + 1`, updated_at: now })
          .where("id", "=", tripId)
          .execute();
        return;
      }
      // One pending replacement per membership, even across fresh installations.
      await tx
        .updateTable("trip_device_requests")
        .set({ state: "CANCELLED", resolved_at: now })
        .where("membership_id", "=", member.id)
        .where("state", "=", "PENDING")
        .execute();
      const request = {
        id: randomUUID(),
        trip_id: tripId,
        membership_id: member.id,
        previous_device_id: member.participating_device_id,
        device_id: actor.deviceId,
        state: "PENDING" as const,
        requested_at: now,
        resolved_at: null,
        approved_by_device_id: null,
      };
      await tx
        .insertInto("trip_device_requests")
        .values(request)
        .onConflict((oc) =>
          oc.columns(["trip_id", "device_id"]).doUpdateSet(request),
        )
        .execute();
    } else {
      if (!currentPhone) throw new DomainError("DEVICE_NOT_PARTICIPANT");
      const request = await tx
        .selectFrom("trip_device_requests")
        .selectAll()
        .where("id", "=", body.requestId)
        .where("trip_id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!request || request.state !== "PENDING")
        throw new DomainError("CONFLICT");
      const target = await tx
        .selectFrom("trip_members")
        .selectAll()
        .where("id", "=", request.membership_id)
        .executeTakeFirstOrThrow();
      if (
        member.role !== "OWNER" &&
        target.user_id !== actor.userId &&
        target.role !== "OWNER"
      )
        throw new DomainError("TRIP_OWNER_REQUIRED");
      if (
        target.left_at ||
        target.leaving_at ||
        target.state !== "ACTIVE" ||
        target.participating_device_id !== request.previous_device_id
      )
        throw new DomainError("CONFLICT");
      const newDevice = await tx
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", request.device_id)
        .executeTakeFirstOrThrow();
      if (newDevice.revoked_at || newDevice.user_id !== target.user_id)
        throw new DomainError("DEVICE_REVOKED");
      if (body.action === "APPROVE_DEVICE") {
        const key = Buffer.from(body.wrappedKey, "base64");
        if (key.length !== 148 || key.toString("base64") !== body.wrappedKey)
          throw new DomainError("KEY_ENVELOPE_INVALID");
        await tx
          .insertInto("trip_key_envelopes")
          .values({
            trip_id: tripId,
            key_epoch: 1,
            recipient_device_id: newDevice.id,
            sender_device_id: actor.deviceId,
            algorithm_version: 1,
            wrapped_key: key,
          })
          .execute();
        await tx
          .updateTable("trip_members")
          .set({
            participating_device_id: newDevice.id,
            full_photo_library_access: false,
            drained_at: null,
            updated_at: now,
          })
          .where("id", "=", target.id)
          .execute();
        await tx
          .updateTable("devices")
          .set({ revoked_at: now, updated_at: now })
          .where("id", "=", request.previous_device_id)
          .execute();
        await tx
          .updateTable("deliveries")
          .set({ state: "EXPIRED" })
          .where("recipient_device_id", "=", request.previous_device_id)
          .where("state", "in", ["READY", "HELD"])
          .where(
            "asset_id",
            "in",
            tx.selectFrom("assets").select("id").where("trip_id", "=", tripId),
          )
          .execute();
        // SAVED on the old phone is not proof of a save on this phone. Reissue
        // only retained, eligible ciphertext; cleanup and this command lock trip.
        const assets = await tx
          .selectFrom("assets")
          .selectAll()
          .where("trip_id", "=", tripId)
          .where("state", "=", "COMMITTED")
          .where((eb) =>
            eb.or([
              eb("captured_at", ">=", target.approved_at!),
              ...(target.approved_at! <= (trip.started_at ?? now)
                ? [eb("captured_at", "is", null)]
                : []),
            ]),
          )
          .execute();
        for (const asset of assets) {
          const deliveryId = randomUUID();
          await tx
            .insertInto("deliveries")
            .values({
              id: deliveryId,
              asset_id: asset.id,
              recipient_user_id: target.user_id,
              recipient_device_id: newDevice.id,
              state: "READY",
              available_at: now,
              saved_at: null,
            })
            .execute();
          await tx
            .insertInto("inbox_events")
            .values({
              recipient_device_id: newDevice.id,
              trip_id: tripId,
              event_type: "ASSET_COMMITTED",
              aggregate_id: asset.id,
              available_at: now,
              payload: { assetId: asset.id, deliveryId },
            })
            .execute();
        }
      }
      await tx
        .updateTable("trip_device_requests")
        .set({
          state: body.action === "APPROVE_DEVICE" ? "APPROVED" : "REJECTED",
          resolved_at: now,
          approved_by_device_id: actor.deviceId,
        })
        .where("id", "=", request.id)
        .execute();
      if (body.action === "APPROVE_DEVICE")
        await tx
          .updateTable("trip_device_requests")
          .set({ state: "CANCELLED", resolved_at: now })
          .where("membership_id", "=", target.id)
          .where("state", "=", "PENDING")
          .execute();
    }
    await tx
      .updateTable("trips")
      .set({ version: sql`version + 1`, updated_at: now })
      .where("id", "=", tripId)
      .execute();
  }
  return {
    read: (actor, tripId) =>
      db.transaction().execute((tx) => projection(tx, actor, tripId)),
    change: (actor, tripId, body) =>
      db.transaction().execute(async (tx) => {
        const before = await projection(tx, actor, tripId);
        await change(tx, actor, tripId, body);
        const device = await tx
          .selectFrom("devices")
          .select("revoked_at")
          .where("id", "=", actor.deviceId)
          .executeTakeFirstOrThrow();
        if (device.revoked_at)
          return {
            ...before,
            version: before.version + 1,
            onThisDevice: false,
            ownerInviteCode: null,
            approvalRequests: [],
          };
        return projection(tx, actor, tripId);
      }),
  };
}
