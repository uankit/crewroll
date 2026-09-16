import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
  TripDatabaseState,
} from "../types.js";

export type TripRouteKey =
  | "trips.approve.v1"
  | "trips.create.v1"
  | "trips.join.v1"
  | "trips.readiness.v1"
  | "trips.reject.v1"
  | "trips.start.v1";

export interface CreateCommandLockIdentity {
  readonly idempotencyKey: string;
  readonly userId: string;
}

export type TripReleaseRecord =
  | Readonly<{ mode: "IMMEDIATE" }>
  | Readonly<{
      localTime: string;
      mode: "NIGHTLY";
      timeZone: string;
    }>;

export interface TripRecord {
  readonly cancelledAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly endingStartedAt: Date | null;
  readonly endsAt: Date;
  readonly hardDeleteAt: Date;
  readonly memberCount: number;
  readonly name: string;
  readonly ownerUserId: string;
  readonly release: TripReleaseRecord;
  readonly startedAt: Date | null;
  readonly state: TripDatabaseState;
  readonly tripId: string;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface ActiveTripRecord {
  readonly acquiredAt: Date;
  readonly tripId: string;
  readonly userId: string;
}

export interface TripInviteRecord {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly inviteCodeHmac: Readonly<Uint8Array>;
  readonly inviteId: string;
  readonly maxUses: number;
  readonly revokedAt: Date | null;
  readonly tripId: string;
  readonly updatedAt: Date;
  readonly usesCount: number;
}

export type TripInviteCandidateForTripRead =
  | Readonly<{
      candidate: Readonly<{ inviteId: string; tripId: string }>;
      kind: "FOUND";
    }>
  | Readonly<{ kind: "INVARIANT_ERROR" }>
  | Readonly<{ kind: "NOT_FOUND" }>;

export type TripMembershipState = "ACTIVE" | "PENDING_KEY" | "REJECTED";
export type TripMembershipRole = "MEMBER" | "OWNER";

export interface TripMembershipRecord {
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
  readonly fullPhotoLibraryAccess: boolean;
  readonly keyEpoch: 1 | null;
  readonly membershipId: string;
  readonly participatingDeviceId: string;
  readonly rejectedAt: Date | null;
  readonly role: TripMembershipRole;
  readonly state: TripMembershipState;
  readonly tripId: string;
  readonly updatedAt: Date;
  readonly userId: string;
}

export interface TripDeviceRecord {
  readonly deviceId: string;
  readonly e2eeKeyAlgorithm: "X25519";
  readonly e2eeKeyVersion: 1;
  readonly e2eePublicKey: Readonly<Uint8Array>;
  readonly revoked: boolean;
  readonly userId: string;
}

export interface TripEnvelopeRecord {
  readonly algorithmVersion: 1;
  readonly createdAt: Date;
  readonly keyEpoch: 1;
  readonly recipientDeviceId: string;
  readonly senderDeviceId: string;
  readonly tripId: string;
  readonly wrappedKey: Readonly<Uint8Array>;
}

interface TripIdempotencyBase {
  readonly actorDeviceId: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  readonly requestSha256: Readonly<Uint8Array>;
  readonly responseStatus: number;
  readonly routeKey: TripRouteKey;
  readonly tripId: string;
  readonly userId: string;
}

export type TripIdempotencyRecord =
  | (TripIdempotencyBase & Readonly<{ kind: "APPROVE"; membershipId: string }>)
  | (TripIdempotencyBase & Readonly<{ kind: "CREATE_COMMITTED" }>)
  | (TripIdempotencyBase & Readonly<{ kind: "JOIN"; membershipId: string }>)
  | (TripIdempotencyBase & Readonly<{ kind: "READINESS" }>)
  | (TripIdempotencyBase & Readonly<{ kind: "REJECT"; membershipId: string }>)
  | (TripIdempotencyBase & Readonly<{ kind: "START" }>)
  | (TripIdempotencyBase & Readonly<{ kind: "TERMINAL_NOT_COMMITTED" }>);

export interface TripProjectionMember {
  readonly displayName: string;
  readonly fullPhotoLibraryAccess: boolean;
  readonly membershipId: string;
  readonly nominatedDevice: Readonly<{
    deviceId: string;
    e2eeKeyAlgorithm: "X25519";
    e2eeKeyVersion: 1;
    e2eePublicKey: Readonly<Uint8Array>;
  }> | null;
  readonly role: TripMembershipRole;
  readonly status: Exclude<TripMembershipState, "REJECTED">;
}

export interface TripProjection {
  readonly currentMembershipId: string;
  readonly endsAt: Date;
  readonly keyEpoch: 1;
  readonly members: readonly TripProjectionMember[];
  readonly name: string;
  readonly ownerDeviceId: string;
  readonly release: TripReleaseRecord;
  readonly startsAt: Date | null;
  readonly state: TripDatabaseState;
  readonly tripId: string;
  readonly tripKeyEnvelope: Readonly<{
    senderDeviceId?: string;
    algorithmVersion: 1;
    keyEpoch: 1;
    wrappedKey: Readonly<Uint8Array>;
  }> | null;
  readonly version: number;
}

export type TripProjectionRead =
  | Readonly<{ kind: "DEVICE_NOT_PARTICIPANT" }>
  | Readonly<{ kind: "DEVICE_REVOKED" }>
  | Readonly<{ kind: "FOUND"; projection: TripProjection }>
  | Readonly<{ kind: "INVARIANT_ERROR" }>
  | Readonly<{ kind: "NOT_FOUND" }>;

export interface InboxInsert {
  readonly aggregateId: string;
  readonly availableAt: Date;
  readonly recipientDeviceId: string;
  readonly status: TripDatabaseState;
  readonly tripId: string;
}

export interface OutboxInsert {
  readonly aggregateId: string;
  readonly availableAt: Date;
  readonly eventId: string;
  readonly recipientSequences: readonly string[];
  readonly status: TripDatabaseState;
  readonly tripId: string;
  readonly version: number;
}

export interface TripTransaction {
  acquireCreateCommandLock(identity: CreateCommandLockIdentity): Promise<void>;
  authoritativeNow(): Promise<Date>;
  deleteActiveTrip(userId: string, tripId: string): Promise<void>;
  deleteIdempotency(record: TripIdempotencyRecord): Promise<void>;
  findEnvelope(
    tripId: string,
    recipientDeviceId: string,
  ): Promise<TripEnvelopeRecord | null>;
  findIdempotency(
    input: Readonly<{
      idempotencyKey: string;
      routeKey: TripRouteKey;
      userId: string;
    }>,
  ): Promise<TripIdempotencyRecord | null>;
  insertActiveTrip(record: ActiveTripRecord): Promise<void>;
  insertEnvelope(record: TripEnvelopeRecord): Promise<void>;
  insertIdempotency(record: TripIdempotencyRecord): Promise<void>;
  insertInbox(record: InboxInsert): Promise<string>;
  insertInvite(record: TripInviteRecord): Promise<void>;
  insertMembership(record: TripMembershipRecord): Promise<void>;
  insertOutbox(record: OutboxInsert): Promise<"duplicate" | "inserted">;
  insertTrip(record: TripRecord): Promise<void>;
  lockActiveTrip(userId: string): Promise<ActiveTripRecord | null>;
  lockDevice(deviceId: string): Promise<TripDeviceRecord | null>;
  lockDevices(
    deviceIds: readonly string[],
  ): Promise<readonly TripDeviceRecord[]>;
  lockInvite(inviteId: string): Promise<TripInviteRecord | null>;
  lockMembership(
    tripId: string,
    membershipId: string,
  ): Promise<TripMembershipRecord | null>;
  lockMembershipForUser(
    tripId: string,
    userId: string,
  ): Promise<TripMembershipRecord | null>;
  lockMemberships(tripId: string): Promise<readonly TripMembershipRecord[]>;
  lockTrip(tripId: string): Promise<TripRecord | null>;
  readProjection(
    actor: ForegroundTripActor,
    tripId: string,
  ): Promise<TripProjectionRead>;
  reauthorizeForegroundActor(
    actor: ForegroundTripActor,
  ): Promise<ForegroundActorSnapshot>;
  tryAcquireCreateCommandLock(
    identity: CreateCommandLockIdentity,
  ): Promise<boolean>;
  updateInvite(record: TripInviteRecord): Promise<void>;
  updateMembership(record: TripMembershipRecord): Promise<void>;
  updateTrip(record: TripRecord): Promise<void>;
}

type CallbackContainsTransaction<Result> = [Result] extends [TripTransaction]
  ? true
  : Result extends (...arguments_: never[]) => unknown
    ? false
    : Result extends PromiseLike<infer AwaitedResult>
      ? CallbackContainsTransaction<AwaitedResult>
      : Result extends readonly (infer Item)[]
        ? true extends CallbackContainsTransaction<Item>
          ? true
          : false
        : Result extends object
          ? true extends {
              [Key in keyof Result]-?: CallbackContainsTransaction<Result[Key]>;
            }[keyof Result]
            ? true
            : false
          : false;

type CallbackResult<Result> =
  true extends CallbackContainsTransaction<Result> ? never : Result;

export interface InvitePreviewRecord {
  readonly tripId: string;
  readonly name: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date;
  readonly members: readonly Readonly<{
    displayName: string;
    role: TripMembershipRole;
  }>[];
}

export interface TripUnitOfWork {
  readInvitePreview(
    actor: ForegroundTripActor,
    inviteCodeHmac: Readonly<Uint8Array>,
  ): Promise<InvitePreviewRecord | null>;
  findIdempotencyTripCandidate(
    input: Readonly<{
      idempotencyKey: string;
      routeKey: TripRouteKey;
      userId: string;
    }>,
  ): Promise<Readonly<{ tripId: string }> | null>;
  findInviteCandidate(
    inviteCodeHmac: Readonly<Uint8Array>,
  ): Promise<Readonly<{ inviteId: string; tripId: string }> | null>;
  findInviteCandidateForTrip(
    tripId: string,
  ): Promise<TripInviteCandidateForTripRead>;
  readProjection(
    actor: ForegroundTripActor,
    tripId: string,
  ): Promise<TripProjectionRead>;
  run<Result>(
    operation: (
      transaction: TripTransaction,
    ) => Promise<CallbackResult<Result>>,
  ): Promise<Result>;
}
