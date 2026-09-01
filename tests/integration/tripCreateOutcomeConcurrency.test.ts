import type { CreateTripBody } from "@crewroll/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase } from "../../services/control-plane/src/db/database.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import { classifyTripConstraint } from "../../services/control-plane/src/db/trips/constraintClassifier.js";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import { createCreateTrip } from "../../services/control-plane/src/modules/trips/createTrip.js";
import { createResolveCreateTripOutcome } from "../../services/control-plane/src/modules/trips/resolveCreateTripOutcome.js";
import type { TripUnitOfWork } from "../../services/control-plane/src/modules/trips/ports/tripUnitOfWork.js";
import type {
  ForegroundTripActor,
  TripPolicyResult,
} from "../../services/control-plane/src/modules/trips/types.js";
import { createHmacInviteCodeHasher } from "../../services/control-plane/src/platform/crypto/hmacInviteCodeHasher.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";

const DAY_MS = 86_400_000;
const REPEATS = 25;
const OWNER_ENVELOPE = Buffer.alloc(148, 0x61).toString("base64");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function successful<Value>(result: TripPolicyResult<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`Expected success, got ${result.problem.code}`);
  return result.value;
}

function problemCode<Value>(result: TripPolicyResult<Value>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected Trip problem");
  return result.problem.code;
}

function tripId(sequence: number): string {
  return `018f0d98-76fa-7d1a-b4b4-${sequence.toString().padStart(12, "0")}`;
}

function idempotencyKey(sequence: number): string {
  return `850e8400-e29b-41d4-a716-${sequence.toString().padStart(12, "0")}`;
}

function createIds() {
  let sequence = 10_000;
  return {
    uuid() {
      sequence += 1;
      return `950e8400-e29b-41d4-a716-${sequence.toString().padStart(12, "0")}`;
    },
  };
}

function bodyFor(id: string, name = "Race trip"): CreateTripBody {
  return {
    endsAt: new Date(Date.now() + DAY_MS).toISOString(),
    inviteCode: "ABCD2345",
    name,
    ownerDeviceId: "00000000-0000-4000-8000-000000000002",
    ownerKeyEnvelope: {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: OWNER_ENVELOPE,
    },
    release: { mode: "IMMEDIATE" },
    tripId: id,
  };
}

function pauseAfterBlockingCreateLock(
  unitOfWork: TripUnitOfWork,
  acquired: () => void,
  release: Promise<void>,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          async acquireCreateCommandLock(identity) {
            await transaction.acquireCreateCommandLock(identity);
            acquired();
            await release;
          },
        }),
      );
    },
  };
}

function pauseAfterTryCreateLock(
  unitOfWork: TripUnitOfWork,
  acquired: () => void,
  release: Promise<void>,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          async tryAcquireCreateCommandLock(identity) {
            const available =
              await transaction.tryAcquireCreateCommandLock(identity);
            if (available) {
              acquired();
              await release;
            }
            return available;
          },
        }),
      );
    },
  };
}

function failAfterIdempotencyInsert(
  unitOfWork: TripUnitOfWork,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          async insertIdempotency(record) {
            await transaction.insertIdempotency(record);
            throw new Error("simulated response-connection cut rollback");
          },
        }),
      );
    },
  };
}

function withAuthoritativeNow(
  unitOfWork: TripUnitOfWork,
  now: Date,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          authoritativeNow: () => Promise.resolve(new Date(now.getTime())),
        }),
      );
    },
  };
}

async function countRows(
  database: Kysely<Database>,
  table: "api_idempotency" | "trips",
): Promise<number> {
  const row = await database
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("create/outcome PostgreSQL overtaking", () => {
  let context: PostgresTestContext;
  let databaseA: Kysely<Database>;
  let databaseB: Kysely<Database>;

  beforeAll(async () => {
    context = await startMigratedPostgres();
    databaseA = createDatabase(context.connectionString);
    databaseB = createDatabase(context.connectionString);
  });

  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
  });

  afterAll(async () => {
    await databaseA.destroy();
    await databaseB.destroy();
    await context.stop();
  });

  async function actorAndBody(sequence: number) {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({
      clerk_subject: `user_create_race_${sequence}`,
    });
    const device = await fixtures.device(user.id);
    const actor: ForegroundTripActor = {
      clerkSubject: user.clerk_subject,
      deviceId: device.id,
      userId: user.id,
    };
    const createBody = {
      ...bodyFor(tripId(sequence)),
      ownerDeviceId: device.id,
    };
    return { actor, createBody };
  }

  function services(unitOfWork: TripUnitOfWork, ids = createIds()) {
    return {
      create: createCreateTrip({
        classifyConstraint: classifyTripConstraint,
        hasher: createHmacInviteCodeHasher("task5-test-hmac-key"),
        ids,
        unitOfWork,
      }),
      outcome: createResolveCreateTripOutcome({ unitOfWork }),
    };
  }

  it("returns unknown while create owns the lock, then committed", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody } = await actorAndBody(1000 + repetition);
      const idempotency = idempotencyKey(1000 + repetition);
      const held = deferred();
      const release = deferred();
      const createService = services(
        pauseAfterBlockingCreateLock(
          createKyselyTripUnitOfWork(databaseA),
          held.resolve,
          release.promise,
        ),
      ).create;
      const outcomeService = services(
        createKyselyTripUnitOfWork(databaseB),
      ).outcome;

      const pendingCreate = createService.execute({
        actor,
        body: createBody,
        idempotencyKey: idempotency,
      });
      await held.promise;
      expect(
        successful(
          await outcomeService.execute({
            actor,
            idempotencyKey: idempotency,
            tripId: createBody.tripId,
          }),
        ),
      ).toEqual({ outcome: "STILL_UNKNOWN" });
      release.resolve();
      const created = successful(await pendingCreate);
      expect(
        successful(
          await outcomeService.execute({
            actor,
            idempotencyKey: idempotency,
            tripId: createBody.tripId,
          }),
        ),
      ).toEqual({ outcome: "COMMITTED", trip: created });
    }
  });

  it("lets outcome seal first so delayed create can never commit", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody } = await actorAndBody(2000 + repetition);
      const idempotency = idempotencyKey(2000 + repetition);
      const held = deferred();
      const release = deferred();
      const outcomeService = services(
        pauseAfterTryCreateLock(
          createKyselyTripUnitOfWork(databaseA),
          held.resolve,
          release.promise,
        ),
      ).outcome;
      const createService = services(
        createKyselyTripUnitOfWork(databaseB),
      ).create;

      const pendingOutcome = outcomeService.execute({
        actor,
        idempotencyKey: idempotency,
        tripId: createBody.tripId,
      });
      await held.promise;
      let createSettled = false;
      const pendingCreate = createService
        .execute({ actor, body: createBody, idempotencyKey: idempotency })
        .finally(() => {
          createSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(createSettled).toBe(false);
      release.resolve();
      expect(successful(await pendingOutcome)).toEqual({
        outcome: "TERMINAL_NOT_COMMITTED",
      });
      expect(problemCode(await pendingCreate)).toBe("CONFLICT");
      expect(await countRows(context.db, "trips")).toBe(0);
    }
  });

  it("recovers committed state after the create response is cut and services restart", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody } = await actorAndBody(3000 + repetition);
      const idempotency = idempotencyKey(3000 + repetition);
      successful(
        await services(createKyselyTripUnitOfWork(databaseA)).create.execute({
          actor,
          body: createBody,
          idempotencyKey: idempotency,
        }),
      );
      const restarted = services(createKyselyTripUnitOfWork(databaseB)).outcome;
      const recovered = successful(
        await restarted.execute({
          actor,
          idempotencyKey: idempotency,
          tripId: createBody.tripId,
        }),
      );
      expect(recovered.outcome).toBe("COMMITTED");
      expect(await countRows(context.db, "trips")).toBe(1);
    }
  });

  it("seals terminal after a create rollback and response cut", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody } = await actorAndBody(4000 + repetition);
      const idempotency = idempotencyKey(4000 + repetition);
      const failed = services(
        failAfterIdempotencyInsert(createKyselyTripUnitOfWork(databaseA)),
      ).create;
      expect(
        problemCode(
          await failed.execute({
            actor,
            body: createBody,
            idempotencyKey: idempotency,
          }),
        ),
      ).toBe("INTERNAL_ERROR");
      expect(await countRows(context.db, "trips")).toBe(0);
      const outcome = services(createKyselyTripUnitOfWork(databaseB)).outcome;
      expect(
        successful(
          await outcome.execute({
            actor,
            idempotencyKey: idempotency,
            tripId: createBody.tripId,
          }),
        ),
      ).toEqual({ outcome: "TERMINAL_NOT_COMMITTED" });
    }
  });

  it("serializes two identical creates to one trip and two projections", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody } = await actorAndBody(5000 + repetition);
      const idempotency = idempotencyKey(5000 + repetition);
      const ids = createIds();
      const createA = services(
        createKyselyTripUnitOfWork(databaseA),
        ids,
      ).create;
      const createB = services(
        createKyselyTripUnitOfWork(databaseB),
        ids,
      ).create;
      const [left, right] = await Promise.all([
        createA.execute({
          actor,
          body: createBody,
          idempotencyKey: idempotency,
        }),
        createB.execute({
          actor,
          body: createBody,
          idempotencyKey: idempotency,
        }),
      ]);
      expect(successful(left)).toEqual(successful(right));
      expect(await countRows(context.db, "trips")).toBe(1);
      expect(await countRows(context.db, "api_idempotency")).toBe(1);
    }
  });

  it("serializes different bodies to one commit and one idempotency conflict", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody } = await actorAndBody(6000 + repetition);
      const idempotency = idempotencyKey(6000 + repetition);
      const ids = createIds();
      const createA = services(
        createKyselyTripUnitOfWork(databaseA),
        ids,
      ).create;
      const createB = services(
        createKyselyTripUnitOfWork(databaseB),
        ids,
      ).create;
      const results = await Promise.all([
        createA.execute({
          actor,
          body: createBody,
          idempotencyKey: idempotency,
        }),
        createB.execute({
          actor,
          body: { ...createBody, name: "Different race trip" },
          idempotencyKey: idempotency,
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok).map(problemCode)).toEqual([
        "IDEMPOTENCY_CONFLICT",
      ]);
      expect(await countRows(context.db, "trips")).toBe(1);
    }
  });

  it("proves terminal expiry outlives the original maximum create window", async () => {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      await truncateIdentityTripTables(context.db);
      const { actor, createBody: baseBody } = await actorAndBody(
        7000 + repetition,
      );
      const initialNow = new Date("2026-09-01T00:00:00.000Z");
      const createBody = {
        ...baseBody,
        endsAt: new Date(initialNow.getTime() + 14 * DAY_MS).toISOString(),
      };
      const idempotency = idempotencyKey(7000 + repetition);
      const initialUnitOfWork = withAuthoritativeNow(
        createKyselyTripUnitOfWork(databaseA),
        initialNow,
      );
      const terminal = services(initialUnitOfWork).outcome;
      expect(
        successful(
          await terminal.execute({
            actor,
            idempotencyKey: idempotency,
            tripId: createBody.tripId,
          }),
        ),
      ).toEqual({ outcome: "TERMINAL_NOT_COMMITTED" });
      const stored = await context.db
        .selectFrom("api_idempotency")
        .select("expires_at")
        .executeTakeFirstOrThrow();
      expect(stored.expires_at).toEqual(
        new Date(initialNow.getTime() + 21 * DAY_MS),
      );

      const delayed = services(
        withAuthoritativeNow(
          createKyselyTripUnitOfWork(databaseB),
          new Date(initialNow.getTime() + 21 * DAY_MS),
        ),
      ).create;
      expect(
        problemCode(
          await delayed.execute({
            actor,
            body: createBody,
            idempotencyKey: idempotency,
          }),
        ),
      ).toBe("TRIP_DURATION_INVALID");
      expect(await countRows(context.db, "trips")).toBe(0);
      expect(await countRows(context.db, "api_idempotency")).toBe(1);
    }
  });
});
