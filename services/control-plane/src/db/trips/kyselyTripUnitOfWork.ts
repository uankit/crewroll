import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../schema/tables.js";
import type {
  CreateCommandLockIdentity,
  TripDeviceRecord,
  TripEnvelopeRecord,
  TripIdempotencyRecord,
  TripInviteRecord,
  TripMembershipRecord,
  TripProjection,
  TripProjectionMember,
  TripProjectionRead,
  TripRecord,
  TripRouteKey,
  TripTransaction,
  TripUnitOfWork,
} from "../../modules/trips/ports/tripUnitOfWork.js";
import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
} from "../../modules/trips/ports/foregroundActorSnapshotReader.js";

type Queryable = Kysely<Database> | Transaction<Database>;

function mapTrip(row: {
  cancelled_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  ending_started_at: Date | null;
  ends_at: Date;
  hard_delete_at: Date;
  id: string;
  member_count: number;
  name: string;
  owner_user_id: string;
  release_local_time: string | null;
  release_mode: "IMMEDIATE" | "NIGHTLY";
  release_timezone: string | null;
  started_at: Date | null;
  state: TripRecord["state"];
  updated_at: Date;
  version: number;
}): TripRecord {
  const release =
    row.release_mode === "IMMEDIATE"
      ? ({ mode: "IMMEDIATE" } as const)
      : {
          localTime: row.release_local_time?.slice(0, 5) ?? "",
          mode: "NIGHTLY" as const,
          timeZone: row.release_timezone ?? "",
        };
  return {
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    endingStartedAt: row.ending_started_at,
    endsAt: row.ends_at,
    hardDeleteAt: row.hard_delete_at,
    memberCount: row.member_count,
    name: row.name,
    ownerUserId: row.owner_user_id,
    release,
    startedAt: row.started_at,
    state: row.state,
    tripId: row.id,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapInvite(row: {
  created_at: Date;
  expires_at: Date;
  id: string;
  invite_code_hmac: Uint8Array;
  max_uses: number;
  revoked_at: Date | null;
  trip_id: string;
  updated_at: Date;
  uses_count: number;
}): TripInviteRecord {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    inviteCodeHmac: row.invite_code_hmac,
    inviteId: row.id,
    maxUses: row.max_uses,
    revokedAt: row.revoked_at,
    tripId: row.trip_id,
    updatedAt: row.updated_at,
    usesCount: row.uses_count,
  };
}

function mapMembership(row: {
  approved_at: Date | null;
  created_at: Date;
  full_photo_library_access: boolean;
  id: string;
  key_epoch: number | null;
  participating_device_id: string;
  rejected_at: Date | null;
  role: TripMembershipRecord["role"];
  state: TripMembershipRecord["state"];
  trip_id: string;
  updated_at: Date;
  user_id: string;
}): TripMembershipRecord {
  return {
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    fullPhotoLibraryAccess: row.full_photo_library_access,
    keyEpoch: row.key_epoch === 1 ? 1 : null,
    membershipId: row.id,
    participatingDeviceId: row.participating_device_id,
    rejectedAt: row.rejected_at,
    role: row.role,
    state: row.state,
    tripId: row.trip_id,
    updatedAt: row.updated_at,
    userId: row.user_id,
  };
}

function mapDevice(row: {
  e2ee_key_algorithm: "X25519";
  e2ee_key_version: 1;
  e2ee_public_key: Uint8Array;
  id: string;
  revoked_at: Date | null;
  user_id: string;
}): TripDeviceRecord {
  return {
    deviceId: row.id,
    e2eeKeyAlgorithm: row.e2ee_key_algorithm,
    e2eeKeyVersion: row.e2ee_key_version,
    e2eePublicKey: row.e2ee_public_key,
    revoked: row.revoked_at !== null,
    userId: row.user_id,
  };
}

function mapEnvelope(row: {
  algorithm_version: 1;
  created_at: Date;
  key_epoch: 1;
  recipient_device_id: string;
  sender_device_id: string;
  trip_id: string;
  wrapped_key: Uint8Array;
}): TripEnvelopeRecord {
  return {
    algorithmVersion: row.algorithm_version,
    createdAt: row.created_at,
    keyEpoch: row.key_epoch,
    recipientDeviceId: row.recipient_device_id,
    senderDeviceId: row.sender_device_id,
    tripId: row.trip_id,
    wrappedKey: row.wrapped_key,
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapIdempotency(row: {
  expires_at: Date;
  idempotency_key: string;
  request_sha256: Uint8Array;
  response_body: Readonly<Record<string, unknown>>;
  response_status: number;
  route_key: string;
  user_id: string;
}): TripIdempotencyRecord {
  const reference = row.response_body;
  if (
    !plainObject(reference) ||
    typeof reference.kind !== "string" ||
    typeof reference.tripId !== "string" ||
    typeof reference.actorDeviceId !== "string"
  ) {
    throw new Error("Invalid Trip idempotency reference");
  }
  const base = {
    actorDeviceId: reference.actorDeviceId,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    responseStatus: row.response_status,
    routeKey: row.route_key as TripRouteKey,
    tripId: reference.tripId,
    userId: row.user_id,
  };
  if (
    reference.kind === "APPROVE" ||
    reference.kind === "JOIN" ||
    reference.kind === "REJECT"
  ) {
    if (typeof reference.membershipId !== "string") {
      throw new Error("Invalid Trip idempotency reference");
    }
    return {
      ...base,
      kind: reference.kind,
      membershipId: reference.membershipId,
    };
  }
  if (
    reference.kind === "CREATE_COMMITTED" ||
    reference.kind === "READINESS" ||
    reference.kind === "START" ||
    reference.kind === "TERMINAL_NOT_COMMITTED"
  ) {
    return { ...base, kind: reference.kind };
  }
  throw new Error("Invalid Trip idempotency reference");
}

function idempotencyReference(record: TripIdempotencyRecord) {
  const base = {
    actorDeviceId: record.actorDeviceId,
    kind: record.kind,
    tripId: record.tripId,
  };
  return "membershipId" in record
    ? { ...base, membershipId: record.membershipId }
    : base;
}

function tripSelect() {
  return [
    "id",
    "owner_user_id",
    "name",
    "state",
    "release_mode",
    "release_timezone",
    "release_local_time",
    "ends_at",
    "hard_delete_at",
    "member_count",
    "version",
    "created_at",
    "updated_at",
    "started_at",
    "ending_started_at",
    "completed_at",
    "cancelled_at",
  ] as const;
}

function inviteSelect() {
  return [
    "id",
    "trip_id",
    "invite_code_hmac",
    "expires_at",
    "max_uses",
    "uses_count",
    "created_at",
    "updated_at",
    "revoked_at",
  ] as const;
}

function membershipSelect() {
  return [
    "id",
    "trip_id",
    "user_id",
    "participating_device_id",
    "role",
    "state",
    "key_epoch",
    "full_photo_library_access",
    "created_at",
    "updated_at",
    "approved_at",
    "rejected_at",
  ] as const;
}

function deviceSelect() {
  return [
    "id",
    "user_id",
    "e2ee_key_algorithm",
    "e2ee_public_key",
    "e2ee_key_version",
    "revoked_at",
  ] as const;
}

function advisoryIdentity(identity: CreateCommandLockIdentity) {
  return sql<string>`${identity.userId}::text || ':trips.create.v1:' || ${identity.idempotencyKey}::text`;
}

interface ProjectionSqlMember {
  readonly displayName: unknown;
  readonly fullPhotoLibraryAccess: unknown;
  readonly membershipId: unknown;
  readonly nominatedDevice: unknown;
  readonly role: unknown;
  readonly status: unknown;
}

interface ProjectionSqlRow {
  readonly access_kind: unknown;
  readonly current_membership_id: string | null;
  readonly ends_at: Date;
  readonly members: unknown;
  readonly name: string;
  readonly owner_device_id: string | null;
  readonly release_local_time: string | null;
  readonly release_mode: "IMMEDIATE" | "NIGHTLY";
  readonly release_timezone: string | null;
  readonly self_envelope_algorithm_version: number | null;
  readonly self_envelope_key_epoch: number | null;
  readonly self_envelope_wrapped_key: string | null;
  readonly started_at: Date | null;
  readonly state: TripRecord["state"];
  readonly trip_id: string;
  readonly version: number;
}

function projectionMember(value: unknown): TripProjectionMember {
  if (!plainObject(value)) throw new Error("Invalid Trip projection member");
  const nominated = value.nominatedDevice;
  let nominatedDevice: TripProjectionMember["nominatedDevice"] = null;
  if (nominated !== null) {
    if (
      !plainObject(nominated) ||
      typeof nominated.deviceId !== "string" ||
      nominated.e2eeKeyAlgorithm !== "X25519" ||
      nominated.e2eeKeyVersion !== 1 ||
      typeof nominated.e2eePublicKey !== "string"
    ) {
      throw new Error("Invalid Trip projection device");
    }
    nominatedDevice = {
      deviceId: nominated.deviceId,
      e2eeKeyAlgorithm: "X25519",
      e2eeKeyVersion: 1,
      e2eePublicKey: Buffer.from(nominated.e2eePublicKey, "base64"),
    };
  }
  if (
    typeof value.displayName !== "string" ||
    typeof value.fullPhotoLibraryAccess !== "boolean" ||
    typeof value.membershipId !== "string" ||
    (value.role !== "OWNER" && value.role !== "MEMBER") ||
    (value.status !== "ACTIVE" && value.status !== "PENDING_KEY")
  ) {
    throw new Error("Invalid Trip projection member");
  }
  return {
    displayName: value.displayName,
    fullPhotoLibraryAccess: value.fullPhotoLibraryAccess,
    membershipId: value.membershipId,
    nominatedDevice,
    role: value.role,
    status: value.status,
  };
}

async function readProjection(
  database: Queryable,
  actor: ForegroundTripActor,
  tripId: string,
): Promise<TripProjectionRead> {
  const result = await sql<ProjectionSqlRow>`
    with caller_membership as (
      select
        member.id,
        member.role,
        member.state,
        member.participating_device_id,
        device.id as device_id,
        device.revoked_at as device_revoked_at
      from trip_members as member
      left join devices as device
        on device.id = member.participating_device_id
       and device.user_id = member.user_id
      where member.trip_id = ${tripId}::uuid
        and member.user_id = ${actor.userId}::uuid
        and member.state <> 'REJECTED'
    ), owner_membership as (
      select
        member.id,
        member.participating_device_id,
        device.id as device_id,
        device.revoked_at as device_revoked_at
      from trip_members as member
      left join devices as device
        on device.id = member.participating_device_id
       and device.user_id = member.user_id
      where member.trip_id = ${tripId}::uuid
        and member.role = 'OWNER'
        and member.state = 'ACTIVE'
    ), projection_base as (
      select
        trip.id as trip_id,
        trip.name,
        trip.state,
        trip.release_mode,
        trip.release_timezone,
        trip.release_local_time::text,
        trip.started_at,
        trip.ends_at,
        trip.version,
        caller.id as current_membership_id,
        caller.role as caller_role,
        caller.state as caller_state,
        caller.participating_device_id as caller_participating_device_id,
        caller.device_id as caller_device_id,
        caller.device_revoked_at,
        owner.id as owner_membership_id,
        owner.participating_device_id as owner_device_id,
        owner.device_id as valid_owner_device_id,
        owner.device_revoked_at as owner_device_revoked_at,
        envelope.key_epoch as self_envelope_key_epoch,
        envelope.algorithm_version as self_envelope_algorithm_version,
        encode(envelope.wrapped_key, 'base64') as self_envelope_wrapped_key
      from trips as trip
      left join caller_membership as caller on true
      left join owner_membership as owner on true
      left join trip_key_envelopes as envelope
        on envelope.trip_id = trip.id
       and envelope.key_epoch = 1
       and envelope.recipient_device_id = caller.participating_device_id
      where trip.id = ${tripId}::uuid
    )
    select
      case
        when base.current_membership_id is null or base.caller_state <> 'ACTIVE'
          then 'NOT_FOUND'
        when base.caller_participating_device_id <> ${actor.deviceId}::uuid
          then 'DEVICE_NOT_PARTICIPANT'
        when base.caller_device_id is null
          then 'DEVICE_NOT_PARTICIPANT'
        when base.device_revoked_at is not null
          then 'DEVICE_REVOKED'
        when base.owner_membership_id is null
          or base.valid_owner_device_id is null
          or base.owner_device_revoked_at is not null
          or base.self_envelope_wrapped_key is null
          then 'INVARIANT_ERROR'
        when base.caller_role = 'OWNER'
          and count(*) filter (
            where member.id is not null
              and (device.id is null or device.revoked_at is not null)
          ) > 0
          then 'INVARIANT_ERROR'
        else 'FOUND'
      end as access_kind,
      base.trip_id,
      base.name,
      base.state,
      base.release_mode,
      base.release_timezone,
      base.release_local_time,
      base.started_at,
      base.ends_at,
      base.version,
      base.current_membership_id,
      base.owner_device_id,
      base.self_envelope_key_epoch,
      base.self_envelope_algorithm_version,
      base.self_envelope_wrapped_key,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'membershipId', member.id,
            'role', member.role,
            'displayName', member_user.display_name,
            'status', member.state,
            'fullPhotoLibraryAccess', member.full_photo_library_access,
            'nominatedDevice', case
              when base.caller_role = 'OWNER'
                or member.id = base.current_membership_id
              then jsonb_build_object(
                'deviceId', device.id,
                'e2eeKeyAlgorithm', device.e2ee_key_algorithm,
                'e2eePublicKey', encode(device.e2ee_public_key, 'base64'),
                'e2eeKeyVersion', device.e2ee_key_version
              )
              else null
            end
          ) order by member.created_at, member.id
        ) filter (where member.id is not null),
        '[]'::jsonb
      ) as members
    from projection_base as base
    left join trip_members as member
      on member.trip_id = base.trip_id
     and member.state <> 'REJECTED'
     and (base.caller_role = 'OWNER' or member.state = 'ACTIVE')
    left join users as member_user on member_user.id = member.user_id
    left join devices as device
      on device.id = member.participating_device_id
     and device.user_id = member.user_id
    group by
      base.trip_id,
      base.name,
      base.state,
      base.release_mode,
      base.release_timezone,
      base.release_local_time,
      base.started_at,
      base.ends_at,
      base.version,
      base.current_membership_id,
      base.caller_role,
      base.caller_state,
      base.caller_participating_device_id,
      base.caller_device_id,
      base.device_revoked_at,
      base.owner_membership_id,
      base.owner_device_id,
      base.valid_owner_device_id,
      base.owner_device_revoked_at,
      base.self_envelope_key_epoch,
      base.self_envelope_algorithm_version,
      base.self_envelope_wrapped_key
  `.execute(database);
  const row = result.rows[0];
  if (row === undefined || row.access_kind === "NOT_FOUND") {
    return { kind: "NOT_FOUND" };
  }
  if (row.access_kind === "DEVICE_NOT_PARTICIPANT") {
    return { kind: "DEVICE_NOT_PARTICIPANT" };
  }
  if (row.access_kind === "DEVICE_REVOKED") {
    return { kind: "DEVICE_REVOKED" };
  }
  if (row.access_kind !== "FOUND") return { kind: "INVARIANT_ERROR" };
  if (
    row.current_membership_id === null ||
    row.owner_device_id === null ||
    row.self_envelope_key_epoch !== 1 ||
    row.self_envelope_algorithm_version !== 1 ||
    row.self_envelope_wrapped_key === null ||
    !Array.isArray(row.members)
  ) {
    return { kind: "INVARIANT_ERROR" };
  }
  const release =
    row.release_mode === "IMMEDIATE"
      ? ({ mode: "IMMEDIATE" } as const)
      : {
          localTime: row.release_local_time?.slice(0, 5) ?? "",
          mode: "NIGHTLY" as const,
          timeZone: row.release_timezone ?? "",
        };
  const projection: TripProjection = {
    currentMembershipId: row.current_membership_id,
    endsAt: row.ends_at,
    keyEpoch: 1,
    members: (row.members as ProjectionSqlMember[]).map(projectionMember),
    name: row.name,
    ownerDeviceId: row.owner_device_id,
    release,
    startsAt: row.started_at,
    state: row.state,
    tripId: row.trip_id,
    tripKeyEnvelope: {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: Buffer.from(row.self_envelope_wrapped_key, "base64"),
    },
    version: row.version,
  };
  return { kind: "FOUND", projection };
}

async function reauthorizeForegroundActor(
  transaction: Transaction<Database>,
  actor: ForegroundTripActor,
): Promise<ForegroundActorSnapshot> {
  const user = await transaction
    .selectFrom("users")
    .select(["id", "clerk_subject", "deleted_at"])
    .where("id", "=", actor.userId)
    .where("clerk_subject", "=", actor.clerkSubject)
    .forUpdate()
    .executeTakeFirst();
  if (user === undefined || user.deleted_at !== null) {
    return { kind: "AUTH_INVALID" };
  }
  const device = await transaction
    .selectFrom("devices")
    .select(["id", "user_id", "revoked_at"])
    .where("id", "=", actor.deviceId)
    .forUpdate()
    .executeTakeFirst();
  if (device === undefined || device.user_id !== actor.userId) {
    return { kind: "DEVICE_NOT_OWNED" };
  }
  if (device.revoked_at !== null) return { kind: "DEVICE_REVOKED" };
  return { actor, kind: "ACTIVE" };
}

function transactionAdapter(
  transaction: Transaction<Database>,
): TripTransaction {
  return {
    async acquireCreateCommandLock(identity) {
      const key = advisoryIdentity(identity);
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
        transaction,
      );
    },
    async authoritativeNow() {
      const result = await sql<{ now: Date }>`
        select transaction_timestamp() as now
      `.execute(transaction);
      const now = result.rows[0]?.now;
      if (!(now instanceof Date)) throw new Error("Invalid transaction time");
      return now;
    },
    async deleteActiveTrip(userId, tripId) {
      await transaction
        .deleteFrom("user_active_trips")
        .where("user_id", "=", userId)
        .where("trip_id", "=", tripId)
        .executeTakeFirst();
    },
    async deleteIdempotency(record) {
      await transaction
        .deleteFrom("api_idempotency")
        .where("user_id", "=", record.userId)
        .where("route_key", "=", record.routeKey)
        .where("idempotency_key", "=", record.idempotencyKey)
        .executeTakeFirst();
    },
    async findEnvelope(tripId, recipientDeviceId) {
      const row = await transaction
        .selectFrom("trip_key_envelopes")
        .select([
          "trip_id",
          "key_epoch",
          "recipient_device_id",
          "sender_device_id",
          "algorithm_version",
          "wrapped_key",
          "created_at",
        ])
        .where("trip_id", "=", tripId)
        .where("key_epoch", "=", 1)
        .where("recipient_device_id", "=", recipientDeviceId)
        .executeTakeFirst();
      return row === undefined ? null : mapEnvelope(row);
    },
    async findIdempotency(input) {
      const row = await transaction
        .selectFrom("api_idempotency")
        .select([
          "user_id",
          "route_key",
          "idempotency_key",
          "request_sha256",
          "response_status",
          "response_body",
          "expires_at",
        ])
        .where("user_id", "=", input.userId)
        .where("route_key", "=", input.routeKey)
        .where("idempotency_key", "=", input.idempotencyKey)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapIdempotency(row);
    },
    async insertActiveTrip(record) {
      await transaction
        .insertInto("user_active_trips")
        .values({
          acquired_at: record.acquiredAt,
          trip_id: record.tripId,
          user_id: record.userId,
        })
        .executeTakeFirst();
    },
    async insertEnvelope(record) {
      await transaction
        .insertInto("trip_key_envelopes")
        .values({
          algorithm_version: record.algorithmVersion,
          created_at: record.createdAt,
          key_epoch: record.keyEpoch,
          recipient_device_id: record.recipientDeviceId,
          sender_device_id: record.senderDeviceId,
          trip_id: record.tripId,
          wrapped_key: Buffer.from(record.wrappedKey),
        })
        .executeTakeFirst();
    },
    async insertIdempotency(record) {
      await transaction
        .insertInto("api_idempotency")
        .values({
          expires_at: record.expiresAt,
          idempotency_key: record.idempotencyKey,
          request_sha256: Buffer.from(record.requestSha256),
          response_body: idempotencyReference(record),
          response_status: record.responseStatus,
          route_key: record.routeKey,
          user_id: record.userId,
        })
        .executeTakeFirst();
    },
    async insertInbox(record) {
      const row = await transaction
        .insertInto("inbox_events")
        .values({
          aggregate_id: record.aggregateId,
          available_at: record.availableAt,
          event_type: "TRIP_CHANGED",
          payload: { status: record.status },
          recipient_device_id: record.recipientDeviceId,
          trip_id: record.tripId,
        })
        .returning("sequence")
        .executeTakeFirstOrThrow();
      return row.sequence;
    },
    async insertInvite(record) {
      await transaction
        .insertInto("trip_invites")
        .values({
          created_at: record.createdAt,
          expires_at: record.expiresAt,
          id: record.inviteId,
          invite_code_hmac: Buffer.from(record.inviteCodeHmac),
          max_uses: record.maxUses,
          revoked_at: record.revokedAt,
          trip_id: record.tripId,
          updated_at: record.updatedAt,
          uses_count: record.usesCount,
        })
        .executeTakeFirst();
    },
    async insertMembership(record) {
      await transaction
        .insertInto("trip_members")
        .values({
          approved_at: record.approvedAt,
          created_at: record.createdAt,
          full_photo_library_access: record.fullPhotoLibraryAccess,
          id: record.membershipId,
          key_epoch: record.keyEpoch,
          participating_device_id: record.participatingDeviceId,
          rejected_at: record.rejectedAt,
          role: record.role,
          state: record.state,
          trip_id: record.tripId,
          updated_at: record.updatedAt,
          user_id: record.userId,
        })
        .executeTakeFirst();
    },
    async insertOutbox(record) {
      const row = await transaction
        .insertInto("outbox_events")
        .values({
          aggregate_id: record.aggregateId,
          available_at: record.availableAt,
          dedupe_key: `trip.changed:${record.tripId}:v${record.version}`,
          event_type: "trip.changed",
          id: record.eventId,
          last_error: null,
          payload: {
            recipientSequences: [...record.recipientSequences],
            status: record.status,
            tripId: record.tripId,
            version: record.version,
          },
          published_at: null,
        })
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .returning("id")
        .executeTakeFirst();
      return row === undefined ? "duplicate" : "inserted";
    },
    async insertTrip(record) {
      await transaction
        .insertInto("trips")
        .values({
          cancelled_at: record.cancelledAt,
          completed_at: record.completedAt,
          created_at: record.createdAt,
          ending_started_at: record.endingStartedAt,
          ends_at: record.endsAt,
          hard_delete_at: record.hardDeleteAt,
          id: record.tripId,
          member_count: record.memberCount,
          name: record.name,
          owner_user_id: record.ownerUserId,
          release_local_time:
            record.release.mode === "NIGHTLY" ? record.release.localTime : null,
          release_mode: record.release.mode,
          release_timezone:
            record.release.mode === "NIGHTLY" ? record.release.timeZone : null,
          started_at: record.startedAt,
          state: record.state,
          updated_at: record.updatedAt,
          version: record.version,
        })
        .executeTakeFirst();
    },
    async lockActiveTrip(userId) {
      const row = await transaction
        .selectFrom("user_active_trips")
        .select(["user_id", "trip_id", "acquired_at"])
        .where("user_id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            acquiredAt: row.acquired_at,
            tripId: row.trip_id,
            userId: row.user_id,
          };
    },
    async lockDevice(deviceId) {
      const row = await transaction
        .selectFrom("devices")
        .select(deviceSelect())
        .where("id", "=", deviceId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapDevice(row);
    },
    async lockDevices(deviceIds) {
      const uniqueIds = [...new Set(deviceIds)].sort();
      if (uniqueIds.length === 0) return [];
      const rows = await transaction
        .selectFrom("devices")
        .select(deviceSelect())
        .where("id", "in", uniqueIds)
        .orderBy("id")
        .forUpdate()
        .execute();
      return rows.map(mapDevice);
    },
    async lockInvite(inviteId) {
      const row = await transaction
        .selectFrom("trip_invites")
        .select(inviteSelect())
        .where("id", "=", inviteId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapInvite(row);
    },
    async lockMembership(tripId, membershipId) {
      const row = await transaction
        .selectFrom("trip_members")
        .select(membershipSelect())
        .where("trip_id", "=", tripId)
        .where("id", "=", membershipId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapMembership(row);
    },
    async lockMembershipForUser(tripId, userId) {
      const row = await transaction
        .selectFrom("trip_members")
        .select(membershipSelect())
        .where("trip_id", "=", tripId)
        .where("user_id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapMembership(row);
    },
    async lockMemberships(tripId) {
      const rows = await transaction
        .selectFrom("trip_members")
        .select(membershipSelect())
        .where("trip_id", "=", tripId)
        .orderBy("id")
        .forUpdate()
        .execute();
      return rows.map(mapMembership);
    },
    async lockTrip(tripId) {
      const row = await transaction
        .selectFrom("trips")
        .select(tripSelect())
        .where("id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapTrip(row);
    },
    readProjection(actor, tripId) {
      return readProjection(transaction, actor, tripId);
    },
    reauthorizeForegroundActor(actor) {
      return reauthorizeForegroundActor(transaction, actor);
    },
    async tryAcquireCreateCommandLock(identity) {
      const key = advisoryIdentity(identity);
      const result = await sql<{ acquired: boolean }>`
        select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired
      `.execute(transaction);
      return result.rows[0]?.acquired === true;
    },
    async updateInvite(record) {
      await transaction
        .updateTable("trip_invites")
        .set({
          expires_at: record.expiresAt,
          invite_code_hmac: Buffer.from(record.inviteCodeHmac),
          max_uses: record.maxUses,
          revoked_at: record.revokedAt,
          updated_at: record.updatedAt,
          uses_count: record.usesCount,
        })
        .where("id", "=", record.inviteId)
        .where("trip_id", "=", record.tripId)
        .executeTakeFirstOrThrow();
    },
    async updateMembership(record) {
      await transaction
        .updateTable("trip_members")
        .set({
          approved_at: record.approvedAt,
          full_photo_library_access: record.fullPhotoLibraryAccess,
          key_epoch: record.keyEpoch,
          participating_device_id: record.participatingDeviceId,
          rejected_at: record.rejectedAt,
          role: record.role,
          state: record.state,
          updated_at: record.updatedAt,
        })
        .where("id", "=", record.membershipId)
        .where("trip_id", "=", record.tripId)
        .executeTakeFirstOrThrow();
    },
    async updateTrip(record) {
      await transaction
        .updateTable("trips")
        .set({
          cancelled_at: record.cancelledAt,
          completed_at: record.completedAt,
          ending_started_at: record.endingStartedAt,
          ends_at: record.endsAt,
          hard_delete_at: record.hardDeleteAt,
          member_count: record.memberCount,
          name: record.name,
          release_local_time:
            record.release.mode === "NIGHTLY" ? record.release.localTime : null,
          release_mode: record.release.mode,
          release_timezone:
            record.release.mode === "NIGHTLY" ? record.release.timeZone : null,
          started_at: record.startedAt,
          state: record.state,
          updated_at: record.updatedAt,
          version: record.version,
        })
        .where("id", "=", record.tripId)
        .executeTakeFirstOrThrow();
    },
  };
}

const CLOSED_TRANSACTION_MESSAGE = "Trip transaction scope is closed";
const UNSETTLED_TRANSACTION_MESSAGE =
  "Trip transaction callback left unsettled work";

interface CallbackTransactionScope {
  readonly transaction: TripTransaction;
  hasPending(): boolean;
  invalidate(): void;
  settlePending(): Promise<void>;
}

function callbackTransactionScope(
  raw: TripTransaction,
): CallbackTransactionScope {
  let active = true;
  const pending = new Set<Promise<unknown>>();

  function invoke<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!active) {
      return Promise.reject(new Error(CLOSED_TRANSACTION_MESSAGE));
    }
    let result: Promise<Result>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(
        error instanceof Error
          ? error
          : new Error("Trip transaction operation failed"),
      );
    }
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  }

  const transaction = Object.freeze<TripTransaction>({
    acquireCreateCommandLock: (identity) =>
      invoke(() => raw.acquireCreateCommandLock(identity)),
    authoritativeNow: () => invoke(() => raw.authoritativeNow()),
    deleteActiveTrip: (userId, tripId) =>
      invoke(() => raw.deleteActiveTrip(userId, tripId)),
    deleteIdempotency: (record) => invoke(() => raw.deleteIdempotency(record)),
    findEnvelope: (tripId, recipientDeviceId) =>
      invoke(() => raw.findEnvelope(tripId, recipientDeviceId)),
    findIdempotency: (input) => invoke(() => raw.findIdempotency(input)),
    insertActiveTrip: (record) => invoke(() => raw.insertActiveTrip(record)),
    insertEnvelope: (record) => invoke(() => raw.insertEnvelope(record)),
    insertIdempotency: (record) => invoke(() => raw.insertIdempotency(record)),
    insertInbox: (record) => invoke(() => raw.insertInbox(record)),
    insertInvite: (record) => invoke(() => raw.insertInvite(record)),
    insertMembership: (record) => invoke(() => raw.insertMembership(record)),
    insertOutbox: (record) => invoke(() => raw.insertOutbox(record)),
    insertTrip: (record) => invoke(() => raw.insertTrip(record)),
    lockActiveTrip: (userId) => invoke(() => raw.lockActiveTrip(userId)),
    lockDevice: (deviceId) => invoke(() => raw.lockDevice(deviceId)),
    lockDevices: (deviceIds) => invoke(() => raw.lockDevices(deviceIds)),
    lockInvite: (inviteId) => invoke(() => raw.lockInvite(inviteId)),
    lockMembership: (tripId, membershipId) =>
      invoke(() => raw.lockMembership(tripId, membershipId)),
    lockMembershipForUser: (tripId, userId) =>
      invoke(() => raw.lockMembershipForUser(tripId, userId)),
    lockMemberships: (tripId) => invoke(() => raw.lockMemberships(tripId)),
    lockTrip: (tripId) => invoke(() => raw.lockTrip(tripId)),
    readProjection: (actor, tripId) =>
      invoke(() => raw.readProjection(actor, tripId)),
    reauthorizeForegroundActor: (actor) =>
      invoke(() => raw.reauthorizeForegroundActor(actor)),
    tryAcquireCreateCommandLock: (identity) =>
      invoke(() => raw.tryAcquireCreateCommandLock(identity)),
    updateInvite: (record) => invoke(() => raw.updateInvite(record)),
    updateMembership: (record) => invoke(() => raw.updateMembership(record)),
    updateTrip: (record) => invoke(() => raw.updateTrip(record)),
  });

  return {
    transaction,
    hasPending() {
      return pending.size > 0;
    },
    invalidate() {
      active = false;
    },
    async settlePending() {
      await Promise.allSettled([...pending]);
    },
  };
}

export function createKyselyTripUnitOfWork(
  database: Kysely<Database>,
): TripUnitOfWork {
  return {
    async findInviteCandidate(inviteCodeHmac) {
      const row = await database
        .selectFrom("trip_invites")
        .select(["id", "trip_id"])
        .where("invite_code_hmac", "=", Buffer.from(inviteCodeHmac))
        .executeTakeFirst();
      return row === undefined
        ? null
        : { inviteId: row.id, tripId: row.trip_id };
    },
    readProjection(actor, tripId) {
      return readProjection(database, actor, tripId);
    },
    async run(operation) {
      return database.transaction().execute(async (transaction) => {
        const scope = callbackTransactionScope(transactionAdapter(transaction));
        let result;
        try {
          result = await operation(scope.transaction);
        } catch (error) {
          scope.invalidate();
          await scope.settlePending();
          throw error;
        }
        scope.invalidate();
        if (scope.hasPending()) {
          await scope.settlePending();
          throw new Error(UNSETTLED_TRANSACTION_MESSAGE);
        }
        return result;
      });
    },
  };
}
