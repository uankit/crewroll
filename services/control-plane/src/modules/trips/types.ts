declare const canonicalTripNameBrand: unique symbol;
declare const normalizedInviteCodeBrand: unique symbol;
declare const validatedEndsAtBrand: unique symbol;
declare const validatedReleaseBrand: unique symbol;

export interface ForegroundTripActor {
  readonly clerkSubject: string;
  readonly deviceId: string;
  readonly userId: string;
}

export type ForegroundActorSnapshot =
  | Readonly<{ actor: ForegroundTripActor; kind: "ACTIVE" }>
  | Readonly<{ kind: "AUTH_INVALID" }>
  | Readonly<{ kind: "DEVICE_NOT_OWNED" }>
  | Readonly<{ kind: "DEVICE_REVOKED" }>;

export type CanonicalTripName = string & {
  readonly [canonicalTripNameBrand]: true;
};
export type NormalizedInviteCode = string & {
  readonly [normalizedInviteCodeBrand]: true;
};
export type ValidatedEndsAt = Date & {
  readonly [validatedEndsAtBrand]: true;
};

export type ValidatedTripRelease =
  | Readonly<{
      mode: "IMMEDIATE";
      [validatedReleaseBrand]: true;
    }>
  | Readonly<{
      localTime: string;
      mode: "NIGHTLY";
      timeZone: string;
      [validatedReleaseBrand]: true;
    }>;

export type TripPolicyProblemCode =
  | "ACTIVE_TRIP_EXISTS"
  | "AUTH_INVALID"
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "DEVICE_NOT_OWNED"
  | "DEVICE_NOT_PARTICIPANT"
  | "DEVICE_REVOKED"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "INVITE_CODE_CONFLICT"
  | "INVITE_INVALID"
  | "KEY_ENVELOPE_INVALID"
  | "KEY_ENVELOPE_MISSING"
  | "MEMBERSHIP_FROZEN"
  | "NOT_FOUND"
  | "PENDING_JOIN_REQUESTS"
  | "PHOTO_LIBRARY_ACCESS_REQUIRED"
  | "RATE_LIMITED"
  | "TRIP_DURATION_INVALID"
  | "TRIP_FULL"
  | "TRIP_ID_CONFLICT"
  | "TRIP_OWNER_REQUIRED"
  | "TRIP_STATE_CONFLICT"
  | "VERSION_CONFLICT";

export type TripPolicyStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

export interface TripPolicyProblem {
  readonly code: TripPolicyProblemCode;
  readonly status: TripPolicyStatus;
}

export type TripPolicyResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; problem: TripPolicyProblem }>;

export interface ValidatedTripWindow {
  readonly endsAt: ValidatedEndsAt;
  readonly hardDeleteAt: Date;
}

export type TripVersionEffect =
  | "ADD_PENDING_MEMBER"
  | "APPROVE_PENDING_MEMBER"
  | "REJECT_PENDING_MEMBER"
  | "READINESS_CHANGE"
  | "READINESS_NOOP"
  | "START"
  | "EXACT_REPLAY";

export type TripMemberCapacityState = "PENDING_KEY" | "ACTIVE" | "REJECTED";
export type TripDatabaseState =
  | "LOBBY"
  | "ACTIVE"
  | "ENDING"
  | "COMPLETE"
  | "INCOMPLETE_EXPIRED"
  | "CANCELLED";

export interface StartEligibilityInput {
  readonly actorIsOwner: boolean;
  readonly actorUsesNominatedDevice: boolean;
  readonly allMembersReady: boolean;
  readonly allNominatedDevicesActive: boolean;
  readonly currentVersion: number;
  readonly expectedVersion: number;
  readonly hasCompleteKeyDirectory: boolean;
  readonly pendingMemberCount: number;
  readonly state: TripDatabaseState;
}

export interface CreateTripFingerprintInput {
  readonly canonicalTripName: CanonicalTripName;
  readonly endsAt: ValidatedEndsAt;
  readonly inviteCodeHmac: Readonly<Uint8Array>;
  readonly ownerDeviceId: string;
  readonly ownerKeyEnvelope: Readonly<Uint8Array>;
  readonly release: ValidatedTripRelease;
  readonly tripId: string;
}

export interface JoinTripFingerprintInput {
  readonly deviceId: string;
  readonly inviteCodeHmac: Readonly<Uint8Array>;
}

export interface ApproveTripFingerprintInput {
  readonly algorithmVersion: 1;
  readonly keyEpoch: 1;
  readonly membershipId: string;
  readonly tripId: string;
  readonly wrappedKey: Readonly<Uint8Array>;
}

export interface RejectTripFingerprintInput {
  readonly membershipId: string;
  readonly tripId: string;
}

export interface ReadinessTripFingerprintInput {
  readonly fullPhotoLibraryAccess: boolean;
  readonly tripId: string;
}

export interface StartTripFingerprintInput {
  readonly expectedVersion: number;
  readonly tripId: string;
}
