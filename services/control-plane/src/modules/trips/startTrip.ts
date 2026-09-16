import type { StartTripBody, TripResponse } from "@crewroll/contracts";

import type {
  TripDeviceRecord,
  TripEnvelopeRecord,
  TripIdempotencyRecord,
  TripInviteRecord,
  TripMembershipRecord,
  TripRecord,
  TripTransaction,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { projectTrip, tripProblem, tripSuccess } from "./projectTrip.js";
import { startTripRequestFingerprint } from "./requestFingerprint.js";
import { evaluateStartEligibility } from "./tripPolicy.js";
import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
  TripPolicyProblemCode,
  TripPolicyResult,
} from "./types.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";

const ROUTE_KEY = "trips.start.v1" as const;

export interface StartTripDependencies {
  readonly classifyConstraint: (error: unknown) => string | null;
  readonly ids: IdGenerator;
  readonly unitOfWork: TripUnitOfWork;
}

export interface StartTripInput {
  readonly actor: ForegroundTripActor;
  readonly body: StartTripBody;
  readonly idempotencyKey: string;
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
  return constraint === "api_idempotency_pk"
    ? "IDEMPOTENCY_CONFLICT"
    : "INTERNAL_ERROR";
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

function validVisibleMembership(membership: TripMembershipRecord): boolean {
  if (membership.state === "ACTIVE") {
    return (
      membership.keyEpoch === 1 &&
      membership.approvedAt !== null &&
      membership.rejectedAt === null
    );
  }
  return (
    membership.role === "MEMBER" &&
    membership.state === "PENDING_KEY" &&
    membership.keyEpoch === null &&
    membership.approvedAt === null &&
    membership.rejectedAt === null
  );
}

function validDevice(
  device: TripDeviceRecord | undefined,
  membership: TripMembershipRecord,
): device is TripDeviceRecord {
  return (
    device !== undefined &&
    device.deviceId === membership.participatingDeviceId &&
    device.userId === membership.userId
  );
}

function validEnvelope(
  envelope: TripEnvelopeRecord | null,
  membership: TripMembershipRecord,
  ownerDeviceId: string,
): envelope is TripEnvelopeRecord {
  return (
    envelope !== null &&
    envelope.algorithmVersion === 1 &&
    envelope.keyEpoch === 1 &&
    envelope.tripId === membership.tripId &&
    envelope.recipientDeviceId === membership.participatingDeviceId &&
    envelope.senderDeviceId === ownerDeviceId &&
    envelope.wrappedKey.byteLength === 148
  );
}

function validLockedInvite(
  invite: TripInviteRecord | null,
  candidate: Readonly<{ inviteId: string; tripId: string }>,
  inputTripId: string,
): invite is TripInviteRecord {
  return (
    invite !== null &&
    candidate.tripId === inputTripId &&
    invite.inviteId === candidate.inviteId &&
    invite.tripId === inputTripId
  );
}

async function currentProjection(
  transaction: TripTransaction,
  actor: ForegroundTripActor,
  tripId: string,
): Promise<TripPolicyResult<TripResponse>> {
  const result = await transaction.readProjection(actor, tripId);
  switch (result.kind) {
    case "FOUND":
      return tripSuccess(projectTrip(result.projection));
    case "DEVICE_NOT_PARTICIPANT":
      return tripProblem("DEVICE_NOT_PARTICIPANT");
    case "DEVICE_REVOKED":
      return tripProblem("DEVICE_REVOKED");
    case "INVARIANT_ERROR":
    case "NOT_FOUND":
      return tripProblem("INTERNAL_ERROR");
  }
}

export function createStartTrip(dependencies: StartTripDependencies) {
  return {
    async execute(
      input: StartTripInput,
    ): Promise<TripPolicyResult<TripResponse>> {
      let requestSha256: Readonly<Uint8Array>;
      try {
        requestSha256 = startTripRequestFingerprint({
          expectedVersion: input.body.expectedVersion,
          tripId: input.tripId,
        });
      } catch {
        return tripProblem("INVALID_REQUEST");
      }

      try {
        const candidateRead =
          await dependencies.unitOfWork.findInviteCandidateForTrip(
            input.tripId,
          );
        if (candidateRead.kind === "NOT_FOUND") return tripProblem("NOT_FOUND");
        if (candidateRead.kind === "INVARIANT_ERROR") {
          return tripProblem("INTERNAL_ERROR");
        }
        const candidate = candidateRead.candidate;

        return await dependencies.unitOfWork.run(async (transaction) => {
          const trip = await transaction.lockTrip(input.tripId);
          const invite = await transaction.lockInvite(candidate.inviteId);
          if (trip === null) return tripProblem("NOT_FOUND");
          if (!validLockedInvite(invite, candidate, input.tripId)) {
            return tripProblem("INTERNAL_ERROR");
          }
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
            caller === undefined ||
            caller.state !== "ACTIVE" ||
            caller.rejectedAt !== null
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
              prior.kind !== "START" ||
              prior.tripId !== input.tripId ||
              prior.actorDeviceId !== input.actor.deviceId ||
              !bytesEqual(prior.requestSha256, requestSha256)
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            if (trip.state === "LOBBY" || trip.startedAt === null) {
              return tripProblem("INTERNAL_ERROR");
            }
            return currentProjection(transaction, input.actor, input.tripId);
          }

          const visibleMemberships = memberships.filter(
            (membership) => membership.state !== "REJECTED",
          );
          if (
            visibleMemberships.length !== trip.memberCount ||
            visibleMemberships.some(
              (membership) =>
                membership.tripId !== trip.tripId ||
                !validVisibleMembership(membership),
            ) ||
            !Number.isSafeInteger(trip.version) ||
            trip.version < 1
          ) {
            return tripProblem("INTERNAL_ERROR");
          }

          const devices = await transaction.lockDevices(
            visibleMemberships.map(
              (membership) => membership.participatingDeviceId,
            ),
          );
          for (const membership of visibleMemberships) {
            const device = devices.find(
              (candidateDevice) =>
                candidateDevice.deviceId === membership.participatingDeviceId,
            );
            if (!validDevice(device, membership)) {
              return tripProblem("INTERNAL_ERROR");
            }
          }

          const activeMemberships = visibleMemberships.filter(
            (membership) => membership.state === "ACTIVE",
          );
          let hasCompleteKeyDirectory = true;
          for (const membership of activeMemberships) {
            const envelope = await transaction.findEnvelope(
              trip.tripId,
              membership.participatingDeviceId,
            );
            if (
              !validEnvelope(envelope, membership, caller.participatingDeviceId)
            ) {
              hasCompleteKeyDirectory = false;
            }
          }

          const eligibility = evaluateStartEligibility({
            actorIsOwner: caller.userId === trip.ownerUserId,
            actorUsesNominatedDevice:
              caller.participatingDeviceId === input.actor.deviceId,
            allMembersReady: visibleMemberships.every(
              (membership) => membership.fullPhotoLibraryAccess,
            ),
            allNominatedDevicesActive: visibleMemberships.every(
              (membership) =>
                devices.find(
                  (device) =>
                    device.deviceId === membership.participatingDeviceId,
                )?.revoked === false,
            ),
            currentVersion: trip.version,
            expectedVersion: input.body.expectedVersion,
            hasCompleteKeyDirectory,
            pendingMemberCount: visibleMemberships.filter(
              (membership) => membership.state === "PENDING_KEY",
            ).length,
            state: trip.state,
          });
          if (!eligibility.ok) return eligibility;
          if (invite.revokedAt !== null) return tripProblem("INTERNAL_ERROR");

          if (prior !== null) await transaction.deleteIdempotency(prior);
          const eventId = dependencies.ids.uuid();
          const startedTrip: TripRecord = {
            ...trip,
            startedAt: now,
            state: "ACTIVE",
            updatedAt: now,
            version: eligibility.value.resultingVersion,
          };
          await transaction.updateTrip(startedTrip);
          await transaction.updateInvite({
            ...invite,
            revokedAt: null,
            updatedAt: now,
          });
          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: trip.hardDeleteAt,
            idempotencyKey: input.idempotencyKey,
            kind: "START",
            requestSha256,
            responseStatus: 200,
            routeKey: ROUTE_KEY,
            tripId: trip.tripId,
            userId: input.actor.userId,
          });
          const activeDeviceIds = new Set(
            activeMemberships.map(
              (membership) => membership.participatingDeviceId,
            ),
          );
          const recipientSequences: string[] = [];
          for (const device of devices) {
            if (
              device.deviceId === caller.participatingDeviceId ||
              !activeDeviceIds.has(device.deviceId)
            ) {
              continue;
            }
            recipientSequences.push(
              await transaction.insertInbox({
                aggregateId: trip.tripId,
                availableAt: now,
                recipientDeviceId: device.deviceId,
                status: "ACTIVE",
                tripId: trip.tripId,
              }),
            );
          }
          const outbox = await transaction.insertOutbox({
            aggregateId: trip.tripId,
            availableAt: now,
            eventId,
            recipientSequences,
            status: "ACTIVE",
            tripId: trip.tripId,
            version: eligibility.value.resultingVersion,
          });
          if (outbox !== "inserted") {
            throw new Error("Trip Start outbox invariant failed");
          }
          return currentProjection(transaction, input.actor, input.tripId);
        });
      } catch (error) {
        return tripProblem(
          mappedConstraintProblem(dependencies.classifyConstraint(error)),
        );
      }
    },
  };
}
