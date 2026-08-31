import { describe, expect, it } from "vitest";

import { createResolveForegroundActor } from "../../src/modules/trips/resolveForegroundActor.js";
import type {
  ForegroundActorSnapshotReader,
  ForegroundActorSnapshot,
} from "../../src/modules/trips/ports/foregroundActorSnapshotReader.js";
import type {
  TripRecord,
  TripTransaction,
  TripUnitOfWork,
} from "../../src/modules/trips/ports/tripUnitOfWork.js";
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

  it("freezes and revokes every captured transaction method after commit", async () => {
    const test = createTripTestHarness();
    let captured: TripTransaction | undefined;
    await test.unitOfWork.run((transaction) => {
      captured = transaction;
      return Promise.resolve();
    });

    expect(captured).toBeDefined();
    expect(Object.isFrozen(captured)).toBe(true);
    await expectEveryTransactionMethodClosed(captured!);
  });

  it("revokes returned wrapped handles, closures, and method references", async () => {
    const test = createTripTestHarness();
    const wrapped = (await test.unitOfWork.run((transaction) =>
      Promise.resolve({ transaction } as unknown),
    )) as { readonly transaction: TripTransaction };
    const closure = (await test.unitOfWork.run((transaction) =>
      Promise.resolve((() => transaction.authoritativeNow()) as unknown),
    )) as () => Promise<Date>;
    const method = (await test.unitOfWork.run((transaction) =>
      Promise.resolve(Reflect.get(transaction, "authoritativeNow") as unknown),
    )) as () => Promise<Date>;

    await expect(wrapped.transaction.authoritativeNow()).rejects.toThrow(
      "Trip transaction scope is closed",
    );
    await expect(closure()).rejects.toThrow("Trip transaction scope is closed");
    await expect(method()).rejects.toThrow("Trip transaction scope is closed");
  });

  it("revokes outer captures, closures, and method references after rollback", async () => {
    const test = createTripTestHarness();
    let captured: TripTransaction | undefined;
    let closure: (() => Promise<Date>) | undefined;
    let method: (() => Promise<Date>) | undefined;

    await expect(
      test.unitOfWork.run((transaction) => {
        captured = transaction;
        closure = () => transaction.authoritativeNow();
        method = Reflect.get(transaction, "authoritativeNow");
        return Promise.reject(new Error("rollback canary"));
      }),
    ).rejects.toThrow("rollback canary");

    await expect(captured!.authoritativeNow()).rejects.toThrow(
      "Trip transaction scope is closed",
    );
    await expect(closure!()).rejects.toThrow(
      "Trip transaction scope is closed",
    );
    await expect(method!()).rejects.toThrow("Trip transaction scope is closed");
  });

  it("settles an unawaited operation and forces rollback with a static error", async () => {
    const test = createTripTestHarness();
    const held = test.deferAuthoritativeNow();
    let settled = false;
    const run = test.unitOfWork
      .run((transaction) => {
        void transaction.authoritativeNow();
        return Promise.resolve("callback-result");
      })
      .finally(() => {
        settled = true;
      });

    await held.started;
    expect(settled).toBe(false);
    held.release();
    await expect(run).rejects.toThrow(
      "Trip transaction callback left unsettled work",
    );
    expect(test.trace.at(-1)).toBe("transaction.rollback");
  });
});

const transactionMethodNames = [
  "acquireCreateCommandLock",
  "authoritativeNow",
  "deleteActiveTrip",
  "deleteIdempotency",
  "findEnvelope",
  "findIdempotency",
  "insertActiveTrip",
  "insertEnvelope",
  "insertIdempotency",
  "insertInbox",
  "insertInvite",
  "insertMembership",
  "insertOutbox",
  "insertTrip",
  "lockActiveTrip",
  "lockDevice",
  "lockDevices",
  "lockInvite",
  "lockMembership",
  "lockMembershipForUser",
  "lockMemberships",
  "lockTrip",
  "readProjection",
  "reauthorizeForegroundActor",
  "tryAcquireCreateCommandLock",
  "updateInvite",
  "updateMembership",
  "updateTrip",
] as const satisfies readonly (keyof TripTransaction)[];

async function expectEveryTransactionMethodClosed(
  transaction: TripTransaction,
): Promise<void> {
  expect(Object.keys(transaction).sort()).toEqual(
    [...transactionMethodNames].sort(),
  );
  const outcomes = await Promise.allSettled(
    transactionMethodNames.map((method) =>
      Promise.resolve().then(() => {
        const operation: unknown = Reflect.get(transaction, method);
        if (typeof operation !== "function") {
          throw new Error(`Missing transaction method: ${method}`);
        }
        return (operation as () => Promise<unknown>)();
      }),
    ),
  );
  expect(outcomes).toHaveLength(transactionMethodNames.length);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toBe(
        "Trip transaction scope is closed",
      );
    }
  }
}

function callbackResultCannotContainTransaction(
  unitOfWork: TripUnitOfWork,
): void {
  // @ts-expect-error A transaction object cannot be returned from its callback.
  void unitOfWork.run((transaction) => Promise.resolve(transaction));
  // @ts-expect-error A transaction cannot escape in a direct object property.
  void unitOfWork.run((transaction) => Promise.resolve({ transaction }));
  void unitOfWork.run((transaction) =>
    // @ts-expect-error A transaction cannot escape in a nested object property.
    Promise.resolve({ nested: { transaction } }),
  );
  // @ts-expect-error A transaction cannot escape in an array.
  void unitOfWork.run((transaction) => Promise.resolve([transaction]));

  // TypeScript cannot decide whether an arbitrary closure captures a value.
  // Runtime revocation is therefore the authoritative lifetime boundary.
}

void callbackResultCannotContainTransaction;
