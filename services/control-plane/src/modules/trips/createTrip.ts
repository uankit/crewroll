import type { CreateTripBody, TripResponse } from "@crewroll/contracts";

import type { InviteCodeHasher } from "./ports/inviteCodeHasher.js";
import type {
  TripIdempotencyRecord,
  TripProjectionRead,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { projectTrip, tripProblem, tripSuccess } from "./projectTrip.js";
import { createTripRequestFingerprint } from "./requestFingerprint.js";
import {
  canonicalTripName,
  createTripVersion,
  normalizeInviteCode,
  validateTripRelease,
  validateTripWindow,
} from "./tripPolicy.js";
import type {
  CanonicalTripName,
  ForegroundActorSnapshot,
  ForegroundTripActor,
  NormalizedInviteCode,
  TripPolicyProblemCode,
  TripPolicyResult,
  ValidatedEndsAt,
  ValidatedTripRelease,
} from "./types.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";

const ROUTE_KEY = "trips.create.v1" as const;

export interface CreateTripDependencies {
  readonly classifyConstraint: (error: unknown) => string | null;
  readonly hasher: InviteCodeHasher;
  readonly ids: IdGenerator;
  readonly unitOfWork: TripUnitOfWork;
}

export interface CreateTripInput {
  readonly actor: ForegroundTripActor;
  readonly body: CreateTripBody;
  readonly idempotencyKey: string;
}

interface PreparedCreate {
  readonly canonicalName: CanonicalTripName;
  readonly decodedEnvelope: Readonly<Uint8Array>;
  readonly endsAt: Date;
  readonly inviteCode: NormalizedInviteCode;
  readonly release: ValidatedTripRelease;
}

function prepare(input: CreateTripInput): TripPolicyResult<PreparedCreate> {
  if (input.body.ownerDeviceId !== input.actor.deviceId) {
    return tripProblem("DEVICE_NOT_OWNED");
  }
  const canonicalName = canonicalTripName(input.body.name);
  if (!canonicalName.ok) return canonicalName;
  const inviteCode = normalizeInviteCode(input.body.inviteCode);
  if (!inviteCode.ok) return inviteCode;
  const release = validateTripRelease(input.body.release);
  if (!release.ok) return release;
  const endsAt = new Date(input.body.endsAt);
  if (!Number.isFinite(endsAt.getTime())) {
    return tripProblem("TRIP_DURATION_INVALID");
  }
  const wrappedKey = input.body.ownerKeyEnvelope.wrappedKey;
  const decodedEnvelope = Buffer.from(wrappedKey, "base64");
  if (
    decodedEnvelope.byteLength !== 148 ||
    decodedEnvelope.toString("base64") !== wrappedKey
  ) {
    decodedEnvelope.fill(0);
    return tripProblem("KEY_ENVELOPE_INVALID");
  }
  return tripSuccess({
    canonicalName: canonicalName.value,
    decodedEnvelope: Uint8Array.from(decodedEnvelope),
    endsAt,
    inviteCode: inviteCode.value,
    release: release.value,
  });
}

function bytesEqual(
  left: Readonly<Uint8Array>,
  right: Readonly<Uint8Array>,
): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function authorizationProblem(
  snapshot: Exclude<ForegroundActorSnapshot, { readonly kind: "ACTIVE" }>,
): TripPolicyResult<never> {
  return tripProblem(snapshot.kind);
}

function projectionResult(
  read: TripProjectionRead,
): TripPolicyResult<TripResponse> {
  switch (read.kind) {
    case "FOUND":
      return tripSuccess(projectTrip(read.projection));
    case "DEVICE_NOT_PARTICIPANT":
      return tripProblem("DEVICE_NOT_PARTICIPANT");
    case "DEVICE_REVOKED":
      return tripProblem("DEVICE_REVOKED");
    case "INVARIANT_ERROR":
    case "NOT_FOUND":
      return tripProblem("INTERNAL_ERROR");
  }
}

function mappedConstraintProblem(
  constraint: string | null,
): TripPolicyProblemCode {
  switch (constraint) {
    case "api_idempotency_pk":
      return "IDEMPOTENCY_CONFLICT";
    case "trip_invites_invite_code_hmac_key":
      return "INVITE_CODE_CONFLICT";
    case "trip_key_envelopes_version_check":
    case "trip_key_envelopes_wrapped_key_check":
      return "KEY_ENVELOPE_INVALID";
    case "trips_duration_check":
    case "trips_hard_delete_at_check":
      return "TRIP_DURATION_INVALID";
    case "trips_name_check":
      return "INVALID_REQUEST";
    case "trips_pkey":
      return "TRIP_ID_CONFLICT";
    case "user_active_trips_pkey":
      return "ACTIVE_TRIP_EXISTS";
    default:
      return "INTERNAL_ERROR";
  }
}

function live(record: TripIdempotencyRecord, now: Date): boolean {
  return record.expiresAt.getTime() > now.getTime();
}

function fingerprint(
  input: CreateTripInput,
  prepared: PreparedCreate,
  inviteCodeHmac: Readonly<Uint8Array>,
  endsAt: ValidatedEndsAt,
): TripPolicyResult<Readonly<Uint8Array>> {
  try {
    return tripSuccess(
      createTripRequestFingerprint({
        canonicalTripName: prepared.canonicalName,
        endsAt,
        inviteCodeHmac,
        ownerDeviceId: input.body.ownerDeviceId,
        ownerKeyEnvelope: prepared.decodedEnvelope,
        release: prepared.release,
        tripId: input.body.tripId,
      }),
    );
  } catch {
    return tripProblem("INVALID_REQUEST");
  }
}

export function createCreateTrip(dependencies: CreateTripDependencies) {
  return {
    async execute(
      input: CreateTripInput,
    ): Promise<TripPolicyResult<TripResponse>> {
      const prepared = prepare(input);
      if (!prepared.ok) return prepared;

      let inviteCodeHmac: Readonly<Uint8Array>;
      try {
        inviteCodeHmac = dependencies.hasher.hash(prepared.value.inviteCode);
      } catch {
        return tripProblem("INTERNAL_ERROR");
      }
      if (inviteCodeHmac.byteLength !== 32) {
        return tripProblem("INTERNAL_ERROR");
      }

      try {
        return await dependencies.unitOfWork.run(async (transaction) => {
          await transaction.acquireCreateCommandLock({
            idempotencyKey: input.idempotencyKey,
            userId: input.actor.userId,
          });
          const authorization = await transaction.reauthorizeForegroundActor(
            input.actor,
          );
          if (authorization.kind !== "ACTIVE") {
            return authorizationProblem(authorization);
          }
          const now = await transaction.authoritativeNow();

          const prior = await transaction.findIdempotency({
            idempotencyKey: input.idempotencyKey,
            routeKey: ROUTE_KEY,
            userId: input.actor.userId,
          });
          if (prior !== null && live(prior, now)) {
            if (
              prior.tripId !== input.body.tripId ||
              prior.actorDeviceId !== input.actor.deviceId
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            if (prior.kind === "TERMINAL_NOT_COMMITTED") {
              return tripProblem("CONFLICT");
            }
            if (prior.kind !== "CREATE_COMMITTED") {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            // The live committed digest proves this boundary was validated by
            // the original transaction; recomputation only authorizes replay.
            const replayFingerprint = fingerprint(
              input,
              prepared.value,
              inviteCodeHmac,
              new Date(prepared.value.endsAt.getTime()) as ValidatedEndsAt,
            );
            if (
              !replayFingerprint.ok ||
              !bytesEqual(prior.requestSha256, replayFingerprint.value)
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            return projectionResult(
              await transaction.readProjection(input.actor, prior.tripId),
            );
          }

          const window = validateTripWindow({
            authoritativeNow: now,
            endsAt: prepared.value.endsAt,
          });
          if (!window.ok) return window;
          if (prior !== null) {
            await transaction.deleteIdempotency(prior);
          }
          const requestFingerprint = fingerprint(
            input,
            prepared.value,
            inviteCodeHmac,
            window.value.endsAt,
          );
          if (!requestFingerprint.ok) return requestFingerprint;

          const activeTrip = await transaction.lockActiveTrip(
            input.actor.userId,
          );
          if (activeTrip !== null) return tripProblem("ACTIVE_TRIP_EXISTS");
          const existingTrip = await transaction.lockTrip(input.body.tripId);
          if (existingTrip !== null) return tripProblem("TRIP_ID_CONFLICT");

          const membershipId = dependencies.ids.uuid();
          const inviteId = dependencies.ids.uuid();
          const version = createTripVersion();
          await transaction.insertTrip({
            cancelledAt: null,
            completedAt: null,
            createdAt: now,
            endingStartedAt: null,
            endsAt: window.value.endsAt,
            hardDeleteAt: window.value.hardDeleteAt,
            memberCount: 1,
            name: prepared.value.canonicalName,
            ownerUserId: input.actor.userId,
            release: prepared.value.release,
            startedAt: null,
            state: "LOBBY",
            tripId: input.body.tripId,
            updatedAt: now,
            version,
          });
          await transaction.insertActiveTrip({
            acquiredAt: now,
            tripId: input.body.tripId,
            userId: input.actor.userId,
          });
          await transaction.insertMembership({
            approvedAt: now,
            createdAt: now,
            fullPhotoLibraryAccess: false,
            keyEpoch: 1,
            membershipId,
            participatingDeviceId: input.actor.deviceId,
            rejectedAt: null,
            role: "OWNER",
            state: "ACTIVE",
            tripId: input.body.tripId,
            updatedAt: now,
            userId: input.actor.userId,
          });
          await transaction.insertEnvelope({
            algorithmVersion: 1,
            createdAt: now,
            keyEpoch: 1,
            recipientDeviceId: input.actor.deviceId,
            senderDeviceId: input.actor.deviceId,
            tripId: input.body.tripId,
            wrappedKey: prepared.value.decodedEnvelope,
          });
          await transaction.insertInvite({
            createdAt: now,
            expiresAt: window.value.endsAt,
            inviteCodeHmac,
            inviteId,
            maxUses: 9,
            revokedAt: null,
            tripId: input.body.tripId,
            updatedAt: now,
            usesCount: 0,
          });
          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: window.value.hardDeleteAt,
            idempotencyKey: input.idempotencyKey,
            kind: "CREATE_COMMITTED",
            requestSha256: requestFingerprint.value,
            responseStatus: 201,
            routeKey: ROUTE_KEY,
            tripId: input.body.tripId,
            userId: input.actor.userId,
          });
          return projectionResult(
            await transaction.readProjection(input.actor, input.body.tripId),
          );
        });
      } catch (error) {
        return tripProblem(
          mappedConstraintProblem(dependencies.classifyConstraint(error)),
        );
      }
    },
  };
}
