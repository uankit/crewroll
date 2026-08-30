import type { TripResponse } from "@crewroll/contracts";

import type {
  TripProjectionRead,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { projectTrip, tripProblem, tripSuccess } from "./projectTrip.js";
import type { ForegroundTripActor, TripPolicyResult } from "./types.js";

export interface GetTripDependencies {
  readonly unitOfWork: TripUnitOfWork;
}

export interface GetTripInput {
  readonly actor: ForegroundTripActor;
  readonly tripId: string;
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
    case "NOT_FOUND":
      return tripProblem("NOT_FOUND");
    case "INVARIANT_ERROR":
      return tripProblem("INTERNAL_ERROR");
  }
}

export function createGetTrip(dependencies: GetTripDependencies) {
  return {
    async execute(
      input: GetTripInput,
    ): Promise<TripPolicyResult<TripResponse>> {
      try {
        return projectionResult(
          await dependencies.unitOfWork.readProjection(
            input.actor,
            input.tripId,
          ),
        );
      } catch {
        return tripProblem("INTERNAL_ERROR");
      }
    },
  };
}
