import type { TripResponse } from "@crewroll/contracts";

import type { TripProjection } from "./ports/tripUnitOfWork.js";
import { TRIP_PROBLEM_STATUS } from "./tripPolicy.js";
import type { TripPolicyProblemCode, TripPolicyResult } from "./types.js";

export function tripSuccess<Value>(value: Value): TripPolicyResult<Value> {
  return Object.freeze({ ok: true, value });
}

export function tripProblem(
  code: TripPolicyProblemCode,
): TripPolicyResult<never> {
  return Object.freeze({
    ok: false,
    problem: Object.freeze({ code, status: TRIP_PROBLEM_STATUS[code] }),
  });
}

export function projectTrip(projection: TripProjection): TripResponse {
  return {
    currentMembershipId: projection.currentMembershipId,
    endsAt: projection.endsAt.toISOString(),
    id: projection.tripId,
    keyEpoch: projection.keyEpoch,
    members: projection.members.map((member) => ({
      displayName: member.displayName,
      membershipId: member.membershipId,
      nominatedDevice:
        member.nominatedDevice === null
          ? null
          : {
              deviceId: member.nominatedDevice.deviceId,
              e2eeKeyAlgorithm: member.nominatedDevice.e2eeKeyAlgorithm,
              e2eeKeyVersion: member.nominatedDevice.e2eeKeyVersion,
              e2eePublicKey: Buffer.from(
                member.nominatedDevice.e2eePublicKey,
              ).toString("base64"),
            },
      readiness: {
        fullPhotoLibraryAccess: member.fullPhotoLibraryAccess,
      },
      role: member.role,
      status: member.status,
    })),
    name: projection.name,
    ownerDeviceId: projection.ownerDeviceId,
    release: projection.release,
    startsAt: projection.startsAt?.toISOString() ?? null,
    status: projection.state,
    tripKeyEnvelope:
      projection.tripKeyEnvelope === null
        ? null
        : {
            algorithmVersion: projection.tripKeyEnvelope.algorithmVersion,
            keyEpoch: projection.tripKeyEnvelope.keyEpoch,
            wrappedKey: Buffer.from(
              projection.tripKeyEnvelope.wrappedKey,
            ).toString("base64"),
          },
    version: projection.version,
  };
}
