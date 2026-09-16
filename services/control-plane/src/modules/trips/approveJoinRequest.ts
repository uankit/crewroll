import type {
  ApproveJoinRequestBody,
  MembershipResponse,
} from "@crewroll/contracts";

import type {
  TripDeviceRecord,
  TripEnvelopeRecord,
  TripIdempotencyRecord,
  TripMembershipRecord,
  TripRecord,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { tripProblem, tripSuccess } from "./projectTrip.js";
import { approveTripRequestFingerprint } from "./requestFingerprint.js";
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

const ROUTE_KEY = "trips.approve.v1" as const;

export interface ApproveJoinRequestDependencies {
  readonly classifyConstraint: (error: unknown) => string | null;
  readonly ids: IdGenerator;
  readonly unitOfWork: TripUnitOfWork;
}

export interface ApproveJoinRequestInput {
  readonly actor: ForegroundTripActor;
  readonly body: ApproveJoinRequestBody;
  readonly idempotencyKey: string;
  readonly membershipId: string;
  readonly tripId: string;
}

interface PreparedApproval {
  readonly requestSha256: Readonly<Uint8Array>;
  readonly wrappedKey: Readonly<Uint8Array>;
}

function prepare(
  input: ApproveJoinRequestInput,
): TripPolicyResult<PreparedApproval> {
  if (
    input.body.algorithmVersion !== 1 ||
    input.body.keyEpoch !== 1 ||
    typeof input.body.wrappedKey !== "string"
  ) {
    return tripProblem("KEY_ENVELOPE_INVALID");
  }
  const decoded = Buffer.from(input.body.wrappedKey, "base64");
  if (
    decoded.byteLength !== 148 ||
    decoded.toString("base64") !== input.body.wrappedKey
  ) {
    decoded.fill(0);
    return tripProblem("KEY_ENVELOPE_INVALID");
  }
  const wrappedKey = Uint8Array.from(decoded);
  decoded.fill(0);
  try {
    return tripSuccess({
      requestSha256: approveTripRequestFingerprint({
        algorithmVersion: 1,
        keyEpoch: 1,
        membershipId: input.membershipId,
        tripId: input.tripId,
        wrappedKey,
      }),
      wrappedKey,
    });
  } catch {
    wrappedKey.fill(0);
    return tripProblem("INVALID_REQUEST");
  }
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
    case "trip_key_envelopes_version_check":
    case "trip_key_envelopes_wrapped_key_check":
      return "KEY_ENVELOPE_INVALID";
    case "trip_key_envelopes_pk":
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

function validActiveTarget(membership: TripMembershipRecord): boolean {
  return (
    membership.role === "MEMBER" &&
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

function response(
  membership: TripMembershipRecord,
  envelope: TripEnvelopeRecord,
): MembershipResponse {
  return {
    deviceId: membership.participatingDeviceId,
    keyEpoch: 1,
    membershipId: membership.membershipId,
    status: "ACTIVE",
    tripId: membership.tripId,
    tripKeyEnvelope: {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: Buffer.from(envelope.wrappedKey).toString("base64"),
    },
  };
}

export function createApproveJoinRequest(
  dependencies: ApproveJoinRequestDependencies,
) {
  return {
    async execute(
      input: ApproveJoinRequestInput,
    ): Promise<TripPolicyResult<MembershipResponse>> {
      const prepared = prepare(input);
      if (!prepared.ok) return prepared;

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
              prior.kind !== "APPROVE" ||
              prior.tripId !== input.tripId ||
              prior.membershipId !== input.membershipId ||
              prior.actorDeviceId !== input.actor.deviceId ||
              !bytesEqual(prior.requestSha256, prepared.value.requestSha256)
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
            if (target === undefined || !validActiveTarget(target)) {
              return tripProblem("INTERNAL_ERROR");
            }
            const envelope = await transaction.findEnvelope(
              trip.tripId,
              target.participatingDeviceId,
            );
            if (envelope === null || !validEnvelope(envelope, target)) {
              return tripProblem("INTERNAL_ERROR");
            }
            return tripSuccess(response(target, envelope));
          }

          if (trip.endsAt <= now) return tripProblem("TRIP_STATE_CONFLICT");
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
          if (capacity.used !== trip.memberCount) {
            return tripProblem("INTERNAL_ERROR");
          }
          const devices = await transaction.lockDevices([
            caller.participatingDeviceId,
            target.participatingDeviceId,
          ]);
          const callerDevice = devices.find(
            (device) => device.deviceId === caller.participatingDeviceId,
          );
          const targetDevice = devices.find(
            (device) => device.deviceId === target.participatingDeviceId,
          );
          if (!validDevice(callerDevice, caller)) {
            return tripProblem("INTERNAL_ERROR");
          }
          if (!validDevice(targetDevice, target)) {
            return tripProblem("INTERNAL_ERROR");
          }
          if (targetDevice.revoked) return tripProblem("DEVICE_REVOKED");
          if (
            (await transaction.findEnvelope(
              trip.tripId,
              target.participatingDeviceId,
            )) !== null
          ) {
            return tripProblem("INTERNAL_ERROR");
          }
          const version = resultingTripVersion({
            currentVersion: trip.version,
            effect: "APPROVE_PENDING_MEMBER",
          });
          if (!version.ok) return tripProblem("INTERNAL_ERROR");
          if (prior !== null) await transaction.deleteIdempotency(prior);
          const eventId = dependencies.ids.uuid();
          const approvedMembership: TripMembershipRecord = {
            ...target,
            approvedAt: now,
            keyEpoch: 1,
            state: "ACTIVE",
            updatedAt: now,
          };
          const envelope: TripEnvelopeRecord = {
            algorithmVersion: 1,
            createdAt: now,
            keyEpoch: 1,
            recipientDeviceId: target.participatingDeviceId,
            senderDeviceId: caller.participatingDeviceId,
            tripId: trip.tripId,
            wrappedKey: prepared.value.wrappedKey,
          };
          await transaction.updateMembership(approvedMembership);
          await transaction.insertEnvelope(envelope);
          await transaction.updateTrip({
            ...trip,
            updatedAt: now,
            version: version.value,
          });
          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: trip.hardDeleteAt,
            idempotencyKey: input.idempotencyKey,
            kind: "APPROVE",
            membershipId: target.membershipId,
            requestSha256: prepared.value.requestSha256,
            responseStatus: 200,
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
            throw new Error("Trip approval outbox invariant failed");
          }
          return tripSuccess(response(approvedMembership, envelope));
        });
      } catch (error) {
        return tripProblem(
          mappedConstraintProblem(dependencies.classifyConstraint(error)),
        );
      }
    },
  };
}
