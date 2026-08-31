import type {
  TripIdempotencyRecord,
  TripMembershipRecord,
  TripRecord,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { tripProblem, tripSuccess } from "./projectTrip.js";
import { rejectTripRequestFingerprint } from "./requestFingerprint.js";
import {
  evaluateMutationFreeze,
  resultingTripVersion,
  tripCapacity,
} from "./tripPolicy.js";
import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
  TripPolicyProblemCode,
  TripPolicyResult,
} from "./types.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";

const ROUTE_KEY = "trips.reject.v1" as const;

export interface RejectJoinRequestDependencies {
  readonly classifyConstraint: (error: unknown) => string | null;
  readonly ids: IdGenerator;
  readonly unitOfWork: TripUnitOfWork;
}

export interface RejectJoinRequestInput {
  readonly actor: ForegroundTripActor;
  readonly idempotencyKey: string;
  readonly membershipId: string;
  readonly tripId: string;
}

function bytesEqual(
  left: Readonly<Uint8Array>,
  right: Readonly<Uint8Array>,
): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
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
    case "trip_members_lifecycle_check":
      return "CONFLICT";
    default:
      return "INTERNAL_ERROR";
  }
}

function validOwner(
  trip: TripRecord,
  membership: TripMembershipRecord,
): boolean {
  return (
    membership.tripId === trip.tripId &&
    membership.userId === trip.ownerUserId &&
    membership.role === "OWNER" &&
    membership.state === "ACTIVE" &&
    membership.keyEpoch === 1 &&
    membership.approvedAt !== null &&
    membership.rejectedAt === null
  );
}

function validPendingTarget(membership: TripMembershipRecord): boolean {
  return (
    membership.role === "MEMBER" &&
    membership.state === "PENDING_KEY" &&
    membership.keyEpoch === null &&
    membership.approvedAt === null &&
    membership.rejectedAt === null
  );
}

function validRejectedTarget(membership: TripMembershipRecord): boolean {
  return (
    membership.role === "MEMBER" &&
    membership.state === "REJECTED" &&
    membership.keyEpoch === null &&
    membership.approvedAt === null &&
    membership.rejectedAt !== null
  );
}

export function createRejectJoinRequest(
  dependencies: RejectJoinRequestDependencies,
) {
  return {
    async execute(
      input: RejectJoinRequestInput,
    ): Promise<TripPolicyResult<void>> {
      let requestSha256: Readonly<Uint8Array>;
      try {
        requestSha256 = rejectTripRequestFingerprint({
          membershipId: input.membershipId,
          tripId: input.tripId,
        });
      } catch {
        return tripProblem("INVALID_REQUEST");
      }

      try {
        return await dependencies.unitOfWork.run(async (transaction) => {
          const trip = await transaction.lockTrip(input.tripId);
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
          const memberships = await transaction.lockMemberships(input.tripId);
          const caller = memberships.find(
            (membership) => membership.userId === input.actor.userId,
          );
          if (
            trip === null ||
            caller === undefined ||
            caller.state !== "ACTIVE"
          ) {
            return tripProblem("NOT_FOUND");
          }
          if (caller.participatingDeviceId !== input.actor.deviceId) {
            return tripProblem("DEVICE_NOT_PARTICIPANT");
          }
          if (caller.role !== "OWNER") {
            return tripProblem("TRIP_OWNER_REQUIRED");
          }
          if (!validOwner(trip, caller)) return tripProblem("INTERNAL_ERROR");

          if (prior !== null && live(prior, now)) {
            if (
              prior.kind !== "REJECT" ||
              prior.tripId !== input.tripId ||
              prior.membershipId !== input.membershipId ||
              prior.actorDeviceId !== input.actor.deviceId ||
              !bytesEqual(prior.requestSha256, requestSha256)
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            const freeze = evaluateMutationFreeze({
              exactReplay: true,
              state: trip.state,
            });
            if (!freeze.ok) return freeze;
            const target = memberships.find(
              (membership) => membership.membershipId === prior.membershipId,
            );
            return target === undefined || !validRejectedTarget(target)
              ? tripProblem("INTERNAL_ERROR")
              : tripSuccess(undefined);
          }

          const freeze = evaluateMutationFreeze({
            exactReplay: false,
            state: trip.state,
          });
          if (!freeze.ok) return freeze;
          const target = memberships.find(
            (membership) => membership.membershipId === input.membershipId,
          );
          if (target === undefined) return tripProblem("NOT_FOUND");
          if (!validPendingTarget(target)) return tripProblem("CONFLICT");
          const capacity = tripCapacity(
            memberships.map((membership) => membership.state),
          );
          if (capacity.used !== trip.memberCount || trip.memberCount <= 1) {
            return tripProblem("INTERNAL_ERROR");
          }
          const activeTrip = await transaction.lockActiveTrip(target.userId);
          if (
            activeTrip === null ||
            activeTrip.userId !== target.userId ||
            activeTrip.tripId !== trip.tripId
          ) {
            return tripProblem("INTERNAL_ERROR");
          }
          const version = resultingTripVersion({
            currentVersion: trip.version,
            effect: "REJECT_PENDING_MEMBER",
          });
          if (!version.ok) return tripProblem("INTERNAL_ERROR");
          if (prior !== null) await transaction.deleteIdempotency(prior);
          const eventId = dependencies.ids.uuid();
          await transaction.updateMembership({
            ...target,
            rejectedAt: now,
            state: "REJECTED",
            updatedAt: now,
          });
          await transaction.deleteActiveTrip(target.userId, trip.tripId);
          await transaction.updateTrip({
            ...trip,
            memberCount: trip.memberCount - 1,
            updatedAt: now,
            version: version.value,
          });
          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: trip.hardDeleteAt,
            idempotencyKey: input.idempotencyKey,
            kind: "REJECT",
            membershipId: target.membershipId,
            requestSha256,
            responseStatus: 204,
            routeKey: ROUTE_KEY,
            tripId: trip.tripId,
            userId: input.actor.userId,
          });
          const sequence = await transaction.insertInbox({
            aggregateId: trip.tripId,
            availableAt: now,
            recipientDeviceId: target.participatingDeviceId,
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
            throw new Error("Trip rejection outbox invariant failed");
          }
          return tripSuccess(undefined);
        });
      } catch (error) {
        return tripProblem(
          mappedConstraintProblem(dependencies.classifyConstraint(error)),
        );
      }
    },
  };
}
