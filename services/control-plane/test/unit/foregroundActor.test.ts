import { describe, expect, it } from "vitest";

import { createResolveForegroundActor } from "../../src/modules/trips/resolveForegroundActor.js";
import type {
  ForegroundActorSnapshotReader,
  ForegroundActorSnapshot,
} from "../../src/modules/trips/ports/foregroundActorSnapshotReader.js";
import type { TripUnitOfWork } from "../../src/modules/trips/ports/tripUnitOfWork.js";
import type { TripRecord } from "../../src/modules/trips/ports/tripUnitOfWork.js";
import type { ForegroundTripActor } from "../../src/modules/trips/types.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import { createTripTestHarness } from "../support/tripFakes.js";

const actor: ForegroundTripActor = {
  clerkSubject: "user_clerk_subject",
  deviceId: "550e8400-e29b-41d4-a716-446655440000",
  userId: "650e8400-e29b-41d4-a716-446655440000",
};

function readerReturning(
  snapshot: ForegroundActorSnapshot,
  reads: Array<Readonly<{ clerkSubject: string; deviceId: string }>>,
): ForegroundActorSnapshotReader {
  return {
    read(input) {
      reads.push(input);
      return Promise.resolve(snapshot);
    },
  };
}

describe("foreground Trip actor resolution", () => {
  it("returns only the active local actor from the exact snapshot input", async () => {
    const reads: Array<Readonly<{ clerkSubject: string; deviceId: string }>> =
      [];
    const resolve = createResolveForegroundActor(
      readerReturning({ actor, kind: "ACTIVE" }, reads),
    );

    await expect(
      resolve({
        clerkSubject: actor.clerkSubject,
        deviceId: actor.deviceId,
      }),
    ).resolves.toEqual(actor);
    expect(reads).toEqual([
      { clerkSubject: actor.clerkSubject, deviceId: actor.deviceId },
    ]);
  });

  it.each([
    ["AUTH_INVALID", "AUTH_INVALID"],
    ["DEVICE_NOT_OWNED", "DEVICE_NOT_OWNED"],
    ["DEVICE_REVOKED", "DEVICE_REVOKED"],
  ] as const)("maps %s without leaking identifiers", async (kind, expected) => {
    const secretSubject = "secret_subject_canary";
    const secretDevice = "750e8400-e29b-41d4-a716-446655440000";
    const resolve = createResolveForegroundActor(readerReturning({ kind }, []));

    const error = await resolve({
      clerkSubject: secretSubject,
      deviceId: secretDevice,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ kind: expected });
    expect(JSON.stringify(error)).not.toContain(secretSubject);
    expect(JSON.stringify(error)).not.toContain(secretDevice);
  });

  it("the callback-scoped fake records lock order and rolls back a numbered write fault", async () => {
    const test = createTripTestHarness();
    const trip: TripRecord = {
      cancelledAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-30T12:00:00.000Z"),
      endingStartedAt: null,
      endsAt: new Date("2026-08-31T12:00:00.000Z"),
      hardDeleteAt: new Date("2026-09-07T12:00:00.000Z"),
      memberCount: 1,
      name: "Fault trip",
      ownerUserId: actor.userId,
      release: { mode: "IMMEDIATE" },
      startedAt: null,
      state: "LOBBY",
      tripId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
      updatedAt: new Date("2026-08-30T12:00:00.000Z"),
      version: 1,
    };
    test.setReauthorization({ actor, kind: "ACTIVE" });
    test.failAfterWrite(2);

    await expect(
      test.unitOfWork.run(async (transaction) => {
        await transaction.acquireCreateCommandLock({
          idempotencyKey: "850e8400-e29b-41d4-a716-446655440000",
          userId: actor.userId,
        });
        await transaction.reauthorizeForegroundActor(actor);
        await transaction.insertTrip(trip);
        await transaction.insertActiveTrip({
          acquiredAt: trip.createdAt,
          tripId: trip.tripId,
          userId: actor.userId,
        });
      }),
    ).rejects.toThrow("Forced Trip write boundary 2");

    expect(test.trace).toEqual([
      "transaction.begin",
      "lock.create.blocking",
      "lock.actor.user",
      "lock.actor.device",
      "write.trip",
      "write.active-trip",
      "transaction.rollback",
    ]);
    expect(test.state.trips.size).toBe(0);
    expect(test.state.activeTrips.size).toBe(0);
  });
});

function callbackResultCannotBeTransaction(unitOfWork: TripUnitOfWork): void {
  // @ts-expect-error A transaction object cannot be returned from its callback.
  void unitOfWork.run((transaction) => Promise.resolve(transaction));
}

void callbackResultCannotBeTransaction;
