import type { CreateTripOutcomeResponse } from "@crewroll/contracts";

import type {
  TripIdempotencyRecord,
  TripUnitOfWork,
} from "./ports/tripUnitOfWork.js";
import { projectTrip, tripProblem, tripSuccess } from "./projectTrip.js";
import type { ForegroundTripActor, TripPolicyResult } from "./types.js";

const ROUTE_KEY = "trips.create.v1" as const;
const TERMINAL_LIFETIME_MS = 21 * 24 * 60 * 60 * 1_000;

export interface ResolveCreateTripOutcomeInput {
  readonly actor: ForegroundTripActor;
  readonly idempotencyKey: string;
  readonly tripId: string;
}

export interface ResolveCreateTripOutcomeDependencies {
  readonly unitOfWork: TripUnitOfWork;
}

function live(record: TripIdempotencyRecord, now: Date): boolean {
  return record.expiresAt.getTime() > now.getTime();
}

export function createResolveCreateTripOutcome(
  dependencies: ResolveCreateTripOutcomeDependencies,
) {
  return {
    async execute(
      input: ResolveCreateTripOutcomeInput,
    ): Promise<TripPolicyResult<CreateTripOutcomeResponse>> {
      try {
        return await dependencies.unitOfWork.run(async (transaction) => {
          const acquired = await transaction.tryAcquireCreateCommandLock({
            idempotencyKey: input.idempotencyKey,
            userId: input.actor.userId,
          });
          if (!acquired) return tripSuccess({ outcome: "STILL_UNKNOWN" });

          const authorization = await transaction.reauthorizeForegroundActor(
            input.actor,
          );
          if (authorization.kind !== "ACTIVE") {
            return tripProblem(authorization.kind);
          }
          const now = await transaction.authoritativeNow();
          let prior = await transaction.findIdempotency({
            idempotencyKey: input.idempotencyKey,
            routeKey: ROUTE_KEY,
            userId: input.actor.userId,
          });
          if (prior !== null && !live(prior, now)) {
            await transaction.deleteIdempotency(prior);
            prior = null;
          }
          if (prior !== null) {
            if (
              prior.tripId !== input.tripId ||
              prior.actorDeviceId !== input.actor.deviceId
            ) {
              return tripProblem("IDEMPOTENCY_CONFLICT");
            }
            if (prior.kind === "TERMINAL_NOT_COMMITTED") {
              return tripSuccess({ outcome: "TERMINAL_NOT_COMMITTED" });
            }
            if (prior.kind !== "CREATE_COMMITTED") {
              return tripProblem("INTERNAL_ERROR");
            }
            const projection = await transaction.readProjection(
              input.actor,
              prior.tripId,
            );
            if (projection.kind !== "FOUND") {
              return tripProblem(
                projection.kind === "DEVICE_REVOKED"
                  ? "DEVICE_REVOKED"
                  : projection.kind === "DEVICE_NOT_PARTICIPANT"
                    ? "DEVICE_NOT_PARTICIPANT"
                    : "INTERNAL_ERROR",
              );
            }
            return tripSuccess({
              outcome: "COMMITTED",
              trip: projectTrip(projection.projection),
            });
          }

          await transaction.insertIdempotency({
            actorDeviceId: input.actor.deviceId,
            expiresAt: new Date(now.getTime() + TERMINAL_LIFETIME_MS),
            idempotencyKey: input.idempotencyKey,
            kind: "TERMINAL_NOT_COMMITTED",
            requestSha256: new Uint8Array(32),
            responseStatus: 200,
            routeKey: ROUTE_KEY,
            tripId: input.tripId,
            userId: input.actor.userId,
          });
          return tripSuccess({ outcome: "TERMINAL_NOT_COMMITTED" });
        });
      } catch {
        return tripProblem("INTERNAL_ERROR");
      }
    },
  };
}
