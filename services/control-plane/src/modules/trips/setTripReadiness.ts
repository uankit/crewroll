import type { SetTripReadinessBody, TripResponse } from "@crewroll/contracts";

import type {
  TripDeviceRecord,
  TripIdempotencyRecord,
  TripMembershipRecord,
  TripTransaction,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { projectTrip, tripProblem, tripSuccess } from "./projectTrip.js";
import { readinessTripRequestFingerprint } from "./requestFingerprint.js";
import { evaluateMutationFreeze, resultingTripVersion } from "./tripPolicy.js";
import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
  TripPolicyProblemCode,
  TripPolicyResult,
} from "./types.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";

const ROUTE_KEY = "trips.readiness.v1" as const;

export interface SetTripReadinessDependencies {
  readonly classifyConstraint: (error: unknown) => string | null;
  readonly ids: IdGenerator;
  readonly unitOfWork: TripUnitOfWork;
}

export interface SetTripReadinessInput {
  readonly actor: ForegroundTripActor;
  readonly body: SetTripReadinessBody;
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
  switch (constraint) {
    case "api_idempotency_pk":
      return "IDEMPOTENCY_CONFLICT";
    case "trip_members_lifecycle_check":
      return "CONFLICT";
    default:
      return "INTERNAL_ERROR";
  }
}

function validActiveMembership(membership: TripMembershipRecord): boolean {
  return (
    membership.state === "ACTIVE" &&
    membership.keyEpoch === 1 &&
    membership.approvedAt !== null &&
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

export function createSetTripReadiness(
  dependencies: SetTripReadinessDependencies,
) {
  return {
    async execute(
      input: SetTripReadinessInput,
    ): Promise<TripPolicyResult<TripResponse>> {
      let requestSha256: Readonly<Uint8Array>;
      try {
        requestSha256 = readinessTripRequestFingerprint({
          fullPhotoLibraryAccess: input.body.fullPhotoLibraryAccess,
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
            !validActiveMembership(caller)
          ) {
            return tripProblem("NOT_FOUND");
          }
          if (caller.participatingDeviceId !== input.actor.deviceId) {
            return tripProblem("DEVICE_NOT_PARTICIPANT");
          }

          if (prior !== null && live(prior, now)) {
            if (
              prior.kind !== "READINESS" ||
              prior.tripId !== input.tripId ||
              prior.actorDeviceId !== input.actor.deviceId ||
              !bytesEqual(prior.requestSha256, requestSha256)
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            const freeze = evaluateMutationFreeze({
              exactReplay: true,
              state: trip.state,
            });
            return freeze.ok
              ? currentProjection(transaction, input.actor, input.tripId)
              : freeze;
          }

          const freeze = evaluateMutationFreeze({
            exactReplay: false,
            state: trip.state,
          });
          if (!freeze.ok) return freeze;
          if (prior !== null) await transaction.deleteIdempotency(prior);

          if (
            caller.fullPhotoLibraryAccess === input.body.fullPhotoLibraryAccess
          ) {
            await transaction.insertIdempotency({
              actorDeviceId: input.actor.deviceId,
              expiresAt: trip.hardDeleteAt,
              idempotencyKey: input.idempotencyKey,
              kind: "READINESS",
              requestSha256,
              responseStatus: 200,
              routeKey: ROUTE_KEY,
              tripId: trip.tripId,
              userId: input.actor.userId,
            });
            return currentProjection(transaction, input.actor, input.tripId);
          }

          const activeMemberships = memberships.filter(validActiveMembership);
          const devices = await transaction.lockDevices(
            activeMemberships.map(
              (membership) => membership.participatingDeviceId,
            ),
          );
          for (const membership of activeMemberships) {
            const device = devices.find(
              (candidate) =>
                candidate.deviceId === membership.participatingDeviceId,
            );
            if (!validDevice(device, membership)) {
              return tripProblem("INTERNAL_ERROR");
            }
          }
          const callerDevice = devices.find(
            (device) => device.deviceId === caller.participatingDeviceId,
          );
          if (callerDevice?.revoked) return tripProblem("DEVICE_REVOKED");
          const version = resultingTripVersion({
            currentVersion: trip.version,
            effect: "READINESS_CHANGE",
          });
          if (!version.ok) return tripProblem("INTERNAL_ERROR");
          const eventId = dependencies.ids.uuid();
          await transaction.updateMembership({
            ...caller,
            fullPhotoLibraryAccess: input.body.fullPhotoLibraryAccess,
            updatedAt: now,
          });
          await transaction.updateTrip({
            ...trip,
            updatedAt: now,
            version: version.value,
          });
          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: trip.hardDeleteAt,
            idempotencyKey: input.idempotencyKey,
            kind: "READINESS",
            requestSha256,
            responseStatus: 200,
            routeKey: ROUTE_KEY,
            tripId: trip.tripId,
            userId: input.actor.userId,
          });
          const recipientSequences: string[] = [];
          for (const device of devices) {
            if (
              device.deviceId === caller.participatingDeviceId ||
              device.revoked
            ) {
              continue;
            }
            recipientSequences.push(
              await transaction.insertInbox({
                aggregateId: trip.tripId,
                availableAt: now,
                recipientDeviceId: device.deviceId,
                status: trip.state,
                tripId: trip.tripId,
              }),
            );
          }
          const outbox = await transaction.insertOutbox({
            aggregateId: trip.tripId,
            availableAt: now,
            eventId,
            recipientSequences,
            status: trip.state,
            tripId: trip.tripId,
            version: version.value,
          });
          if (outbox !== "inserted") {
            throw new Error("Trip readiness outbox invariant failed");
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
