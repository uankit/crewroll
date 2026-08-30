import { timingSafeEqual } from "node:crypto";

import type {
  CreateJoinRequestBody,
  MembershipResponse,
} from "@crewroll/contracts";

import type { InviteCodeHasher } from "./ports/inviteCodeHasher.js";
import type {
  TripEnvelopeRecord,
  TripIdempotencyRecord,
  TripInviteRecord,
  TripMembershipRecord,
  TripRecord,
  TripTransaction,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { tripProblem, tripSuccess } from "./projectTrip.js";
import { joinTripRequestFingerprint } from "./requestFingerprint.js";
import {
  normalizeInviteCode,
  resultingTripVersion,
  tripCapacity,
} from "./tripPolicy.js";
import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
  NormalizedInviteCode,
  TripPolicyProblemCode,
  TripPolicyResult,
} from "./types.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";

const ROUTE_KEY = "trips.join.v1" as const;

export interface RequestJoinDependencies {
  readonly classifyConstraint: (error: unknown) => string | null;
  readonly hasher: InviteCodeHasher;
  readonly ids: IdGenerator;
  readonly unitOfWork: TripUnitOfWork;
}

export interface RequestJoinInput {
  readonly actor: ForegroundTripActor;
  readonly body: CreateJoinRequestBody;
  readonly idempotencyKey: string;
}

interface PreparedJoin {
  readonly inviteCode: NormalizedInviteCode;
}

function prepare(input: RequestJoinInput): TripPolicyResult<PreparedJoin> {
  if (input.body.deviceId !== input.actor.deviceId) {
    return tripProblem("DEVICE_NOT_OWNED");
  }
  const inviteCode = normalizeInviteCode(input.body.inviteCode);
  return inviteCode.ok
    ? tripSuccess({ inviteCode: inviteCode.value })
    : inviteCode;
}

function bytesEqual(
  left: Readonly<Uint8Array>,
  right: Readonly<Uint8Array>,
): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function live(record: TripIdempotencyRecord, now: Date): boolean {
  return record.expiresAt.getTime() > now.getTime();
}

function authorizationProblem(
  snapshot: Exclude<ForegroundActorSnapshot, { readonly kind: "ACTIVE" }>,
): TripPolicyResult<never> {
  return tripProblem(snapshot.kind);
}

function mappedConstraintProblem(
  constraint: string | null,
): TripPolicyProblemCode {
  switch (constraint) {
    case "api_idempotency_pk":
      return "IDEMPOTENCY_CONFLICT";
    case "trip_invites_uses_check":
      return "INVITE_INVALID";
    case "trips_member_count_check":
      return "TRIP_FULL";
    case "trip_members_pkey":
    case "trip_members_trip_device_unique":
    case "trip_members_trip_user_unique":
      return "CONFLICT";
    case "user_active_trips_pkey":
      return "ACTIVE_TRIP_EXISTS";
    default:
      return "INTERNAL_ERROR";
  }
}

function validPendingMembership(membership: TripMembershipRecord): boolean {
  return (
    membership.state === "PENDING_KEY" &&
    membership.role === "MEMBER" &&
    membership.keyEpoch === null &&
    membership.approvedAt === null &&
    membership.rejectedAt === null
  );
}

function validActiveMembership(membership: TripMembershipRecord): boolean {
  return (
    membership.state === "ACTIVE" &&
    membership.keyEpoch === 1 &&
    membership.approvedAt !== null &&
    membership.rejectedAt === null
  );
}

function validRejectedMembership(membership: TripMembershipRecord): boolean {
  return (
    membership.state === "REJECTED" &&
    membership.role === "MEMBER" &&
    membership.keyEpoch === null &&
    membership.approvedAt === null &&
    membership.rejectedAt !== null
  );
}

function validEnvelope(
  envelope: TripEnvelopeRecord,
  membership: TripMembershipRecord,
): boolean {
  return (
    envelope.algorithmVersion === 1 &&
    envelope.keyEpoch === 1 &&
    envelope.tripId === membership.tripId &&
    envelope.recipientDeviceId === membership.participatingDeviceId &&
    envelope.wrappedKey.byteLength === 148
  );
}

async function membershipResponse(
  transaction: TripTransaction,
  actor: ForegroundTripActor,
  membership: TripMembershipRecord,
): Promise<TripPolicyResult<MembershipResponse>> {
  if (
    membership.userId !== actor.userId ||
    membership.participatingDeviceId !== actor.deviceId
  ) {
    return tripProblem("INTERNAL_ERROR");
  }
  let tripKeyEnvelope: MembershipResponse["tripKeyEnvelope"] = null;
  if (membership.state === "ACTIVE") {
    if (!validActiveMembership(membership)) {
      return tripProblem("INTERNAL_ERROR");
    }
    const envelope = await transaction.findEnvelope(
      membership.tripId,
      actor.deviceId,
    );
    if (envelope === null || !validEnvelope(envelope, membership)) {
      return tripProblem("INTERNAL_ERROR");
    }
    tripKeyEnvelope = {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: Buffer.from(envelope.wrappedKey).toString("base64"),
    };
  } else if (
    !validPendingMembership(membership) &&
    !validRejectedMembership(membership)
  ) {
    return tripProblem("INTERNAL_ERROR");
  }
  return tripSuccess({
    deviceId: membership.participatingDeviceId,
    keyEpoch: 1,
    membershipId: membership.membershipId,
    status: membership.state,
    tripId: membership.tripId,
    tripKeyEnvelope,
  });
}

function currentInviteIsValid(
  trip: TripRecord | null,
  invite: TripInviteRecord | null,
  inviteCodeHmac: Readonly<Uint8Array>,
  candidate: Readonly<{ inviteId: string; tripId: string }>,
  now: Date,
): trip is TripRecord {
  return (
    trip !== null &&
    invite !== null &&
    invite.inviteId === candidate.inviteId &&
    invite.tripId === candidate.tripId &&
    trip.tripId === candidate.tripId &&
    bytesEqual(invite.inviteCodeHmac, inviteCodeHmac) &&
    trip.state === "LOBBY" &&
    invite.revokedAt === null &&
    invite.expiresAt.getTime() > now.getTime() &&
    invite.usesCount < invite.maxUses
  );
}

export function createRequestJoin(dependencies: RequestJoinDependencies) {
  return {
    async execute(
      input: RequestJoinInput,
    ): Promise<TripPolicyResult<MembershipResponse>> {
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
      let requestSha256: Readonly<Uint8Array>;
      try {
        requestSha256 = joinTripRequestFingerprint({
          deviceId: input.body.deviceId,
          inviteCodeHmac,
        });
      } catch {
        return tripProblem("INVALID_REQUEST");
      }

      let candidate: Readonly<{ inviteId: string; tripId: string }> | null;
      try {
        candidate =
          await dependencies.unitOfWork.findInviteCandidate(inviteCodeHmac);
      } catch {
        return tripProblem("INTERNAL_ERROR");
      }
      if (candidate === null) return tripProblem("INVITE_INVALID");

      try {
        return await dependencies.unitOfWork.run(async (transaction) => {
          const trip = await transaction.lockTrip(candidate.tripId);
          const invite = await transaction.lockInvite(candidate.inviteId);
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
              prior.kind !== "JOIN" ||
              prior.tripId !== candidate.tripId ||
              prior.actorDeviceId !== input.actor.deviceId ||
              !bytesEqual(prior.requestSha256, requestSha256)
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            const membership = await transaction.lockMembership(
              prior.tripId,
              prior.membershipId,
            );
            return membership === null
              ? tripProblem("INTERNAL_ERROR")
              : membershipResponse(transaction, input.actor, membership);
          }

          if (
            !currentInviteIsValid(trip, invite, inviteCodeHmac, candidate, now)
          ) {
            return tripProblem("INVITE_INVALID");
          }
          if (trip === null || invite === null) {
            return tripProblem("INTERNAL_ERROR");
          }
          const memberships = await transaction.lockMemberships(trip.tripId);
          if (
            memberships.some(
              (membership) => membership.userId === input.actor.userId,
            )
          ) {
            return tripProblem("CONFLICT");
          }
          const capacity = tripCapacity(
            memberships.map((membership) => membership.state),
          );
          if (capacity.used !== trip.memberCount) {
            return tripProblem("INTERNAL_ERROR");
          }
          if (!capacity.hasCapacity) return tripProblem("TRIP_FULL");

          const owner = memberships.find(
            (membership) =>
              membership.role === "OWNER" && membership.state === "ACTIVE",
          );
          if (owner === undefined || owner.keyEpoch !== 1) {
            return tripProblem("INTERNAL_ERROR");
          }
          const ownerDevices = await transaction.lockDevices([
            owner.participatingDeviceId,
          ]);
          const ownerDevice = ownerDevices[0];
          if (
            ownerDevices.length !== 1 ||
            ownerDevice === undefined ||
            ownerDevice.deviceId !== owner.participatingDeviceId ||
            ownerDevice.userId !== owner.userId ||
            ownerDevice.revoked
          ) {
            return tripProblem("INTERNAL_ERROR");
          }
          const activeTrip = await transaction.lockActiveTrip(
            input.actor.userId,
          );
          if (activeTrip !== null) return tripProblem("ACTIVE_TRIP_EXISTS");

          if (prior !== null) await transaction.deleteIdempotency(prior);
          const version = resultingTripVersion({
            currentVersion: trip.version,
            effect: "ADD_PENDING_MEMBER",
          });
          if (!version.ok) return tripProblem("INTERNAL_ERROR");
          const membershipId = dependencies.ids.uuid();
          const eventId = dependencies.ids.uuid();
          const membership: TripMembershipRecord = {
            approvedAt: null,
            createdAt: now,
            fullPhotoLibraryAccess: false,
            keyEpoch: null,
            membershipId,
            participatingDeviceId: input.actor.deviceId,
            rejectedAt: null,
            role: "MEMBER",
            state: "PENDING_KEY",
            tripId: trip.tripId,
            updatedAt: now,
            userId: input.actor.userId,
          };
          await transaction.insertMembership(membership);
          await transaction.insertActiveTrip({
            acquiredAt: now,
            tripId: trip.tripId,
            userId: input.actor.userId,
          });
          await transaction.updateInvite({
            ...invite,
            updatedAt: now,
            usesCount: invite.usesCount + 1,
          });
          await transaction.updateTrip({
            ...trip,
            memberCount: trip.memberCount + 1,
            updatedAt: now,
            version: version.value,
          });
          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: trip.hardDeleteAt,
            idempotencyKey: input.idempotencyKey,
            kind: "JOIN",
            membershipId,
            requestSha256,
            responseStatus: 201,
            routeKey: ROUTE_KEY,
            tripId: trip.tripId,
            userId: input.actor.userId,
          });
          const sequence = await transaction.insertInbox({
            aggregateId: trip.tripId,
            availableAt: now,
            recipientDeviceId: owner.participatingDeviceId,
            status: trip.state,
            tripId: trip.tripId,
          });
          const outbox = await transaction.insertOutbox({
            aggregateId: trip.tripId,
            availableAt: now,
            eventId,
            recipientSequences: [sequence],
            status: trip.state,
            tripId: trip.tripId,
            version: version.value,
          });
          if (outbox !== "inserted") {
            throw new Error("Trip join outbox invariant failed");
          }
          return membershipResponse(transaction, input.actor, membership);
        });
      } catch (error) {
        return tripProblem(
          mappedConstraintProblem(dependencies.classifyConstraint(error)),
        );
      }
    },
  };
}
