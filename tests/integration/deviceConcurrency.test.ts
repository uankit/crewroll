import { createECDH, createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyDeviceAuthorizationSnapshotReader } from "../../services/control-plane/src/db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { createKyselyDeviceUnitOfWork } from "../../services/control-plane/src/db/devices/kyselyDeviceUnitOfWork.js";
import { createRegisterDevice } from "../../services/control-plane/src/modules/devices/registerDevice.js";
import type { DeviceAuthorizationSnapshotReader } from "../../services/control-plane/src/modules/devices/ports/deviceAuthorizationSnapshotReader.js";
import type { DeviceUnitOfWork } from "../../services/control-plane/src/modules/devices/ports/deviceUnitOfWork.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";
import { createPostgresBarrier } from "./support/postgresBarrier.js";

const now = new Date("2026-08-30T05:00:00.000Z");
const p256 = Buffer.from(
  "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
  "base64",
);
const alternateP256 = (() => {
  const key = createECDH("prime256v1");
  const privateKey = Buffer.alloc(32);
  privateKey[31] = 2;
  key.setPrivateKey(privateKey);
  return key.getPublicKey().toString("base64");
})();
const body = {
  appVersion: "0.2.0",
  authenticationKeyAlgorithm: "P-256" as const,
  authenticationKeyVersion: 1 as const,
  authenticationPublicKey: p256.toString("base64"),
  e2eeKeyAlgorithm: "X25519" as const,
  e2eeKeyVersion: 1 as const,
  e2eePublicKey: Buffer.alloc(32, 4).toString("base64"),
  installationId: "race_installation_0001",
  platform: "ios" as const,
};

function createRaceService(
  snapshots: DeviceAuthorizationSnapshotReader,
  unitOfWork: DeviceUnitOfWork,
  uuid: () => string,
) {
  return createRegisterDevice({
    backgroundCredentials: {
      issue({ deviceId, expiresAt, userId }) {
        const digest = createHash("sha256")
          .update(`${userId}:${deviceId}:${expiresAt.toISOString()}`)
          .digest();
        const bearer = `crb_${digest.toString("base64url")}`;
        return {
          bearer,
          bearerHash: createHash("sha256").update(bearer).digest(),
          expiresAt,
        };
      },
    },
    clock: { now: () => now },
    directory: {
      getUser: (clerkSubject) =>
        Promise.resolve({ clerkSubject, displayName: "Race member" }),
    },
    ids: { uuid },
    protector: {
      fingerprint: () => Buffer.alloc(32),
      protect: () => Promise.reject(new Error("unexpected KMS")),
    },
    snapshots,
    unitOfWork,
  });
}

function uuidSequence(prefix: string): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  };
}

describe("device repository concurrency", () => {
  let context: PostgresTestContext;

  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
  });
  afterAll(async () => {
    await context.stop();
  });

  it("converges 20 same-subject/same-installation registrations", async () => {
    const baseSnapshots = createKyselyDeviceAuthorizationSnapshotReader(
      context.db,
    );
    const barrier = createPostgresBarrier(20);
    let preauthorizationReads = 0;
    const snapshots: DeviceAuthorizationSnapshotReader = {
      readForegroundDevice: (...arguments_) =>
        baseSnapshots.readForegroundDevice(...arguments_),
      async readRegistration(...arguments_) {
        const result = await baseSnapshots.readRegistration(...arguments_);
        if (preauthorizationReads < 20) {
          preauthorizationReads += 1;
          await barrier.arrive();
        }
        return result;
      },
    };
    const unitOfWork = createKyselyDeviceUnitOfWork(context.db);
    const service = createRaceService(
      snapshots,
      unitOfWork,
      uuidSequence("40000000"),
    );

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.execute({
          body,
          clerkSubject: "race_subject",
          idempotencyKey: "50000000-0000-4000-8000-000000000001",
        }),
      ),
    );
    expect(new Set(responses.map((response) => response.deviceId)).size).toBe(
      1,
    );
    expect(
      new Set(responses.map((response) => response.backgroundBearer)).size,
    ).toBe(1);
    const { count: userCount } = await context.db
      .selectFrom("users")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const { count: deviceCount } = await context.db
      .selectFrom("devices")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const { count: keyCount } = await context.db
      .selectFrom("api_idempotency")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect({ userCount, deviceCount, keyCount }).toEqual({
      deviceCount: "1",
      keyCount: "1",
      userCount: "1",
    });
  });

  it("converges same-owner identical registrations with different idempotency keys", async () => {
    await context.db
      .insertInto("users")
      .values({
        clerk_subject: "same_owner_subject",
        display_name: "Same owner",
        id: "60000000-0000-4000-8000-000000000001",
      })
      .execute();
    const baseSnapshots = createKyselyDeviceAuthorizationSnapshotReader(
      context.db,
    );
    const barrier = createPostgresBarrier(2);
    const snapshots: DeviceAuthorizationSnapshotReader = {
      readForegroundDevice: (...arguments_) =>
        baseSnapshots.readForegroundDevice(...arguments_),
      async readRegistration(...arguments_) {
        const result = await baseSnapshots.readRegistration(...arguments_);
        await barrier.arrive();
        return result;
      },
    };
    const service = createRaceService(
      snapshots,
      createKyselyDeviceUnitOfWork(context.db),
      uuidSequence("61000000"),
    );

    const results = await Promise.allSettled([
      service.execute({
        body,
        clerkSubject: "same_owner_subject",
        idempotencyKey: "62000000-0000-4000-8000-000000000001",
      }),
      service.execute({
        body,
        clerkSubject: "same_owner_subject",
        idempotencyKey: "62000000-0000-4000-8000-000000000002",
      }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      new Set(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.deviceId] : [],
        ),
      ).size,
    ).toBe(1);
    const devices = await context.db
      .selectFrom("devices")
      .selectAll()
      .execute();
    const keys = await context.db
      .selectFrom("api_idempotency")
      .selectAll()
      .execute();
    expect(devices).toHaveLength(1);
    expect(keys).toHaveLength(2);
  });

  it("allows one same-owner different-key winner and rejects the loser", async () => {
    await context.db
      .insertInto("users")
      .values({
        clerk_subject: "different_key_subject",
        display_name: "Different key owner",
        id: "63000000-0000-4000-8000-000000000001",
      })
      .execute();
    const baseSnapshots = createKyselyDeviceAuthorizationSnapshotReader(
      context.db,
    );
    const barrier = createPostgresBarrier(2);
    const snapshots: DeviceAuthorizationSnapshotReader = {
      readForegroundDevice: (...arguments_) =>
        baseSnapshots.readForegroundDevice(...arguments_),
      async readRegistration(...arguments_) {
        const result = await baseSnapshots.readRegistration(...arguments_);
        await barrier.arrive();
        return result;
      },
    };
    const service = createRaceService(
      snapshots,
      createKyselyDeviceUnitOfWork(context.db),
      uuidSequence("64000000"),
    );

    const results = await Promise.allSettled([
      service.execute({
        body,
        clerkSubject: "different_key_subject",
        idempotencyKey: "65000000-0000-4000-8000-000000000001",
      }),
      service.execute({
        body: { ...body, authenticationPublicKey: alternateP256 },
        clerkSubject: "different_key_subject",
        idempotencyKey: "65000000-0000-4000-8000-000000000002",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null,
    ).toMatchObject({ kind: "CONFLICT" });
    expect(
      await context.db.selectFrom("devices").selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await context.db.selectFrom("api_idempotency").selectAll().execute(),
    ).toHaveLength(1);
  });

  it("rolls back the losing user when two subjects race one installation", async () => {
    await context.db
      .insertInto("users")
      .values([
        {
          clerk_subject: "owner_a",
          display_name: "Owner A",
          id: "70000000-0000-4000-8000-000000000001",
        },
        {
          clerk_subject: "owner_b",
          display_name: "Owner B",
          id: "70000000-0000-4000-8000-000000000002",
        },
      ])
      .execute();
    const baseSnapshots = createKyselyDeviceAuthorizationSnapshotReader(
      context.db,
    );
    const barrier = createPostgresBarrier(2);
    const snapshots: DeviceAuthorizationSnapshotReader = {
      readForegroundDevice: (...arguments_) =>
        baseSnapshots.readForegroundDevice(...arguments_),
      async readRegistration(...arguments_) {
        const result = await baseSnapshots.readRegistration(...arguments_);
        await barrier.arrive();
        return result;
      },
    };
    const service = createRaceService(
      snapshots,
      createKyselyDeviceUnitOfWork(context.db),
      uuidSequence("71000000"),
    );

    const results = await Promise.allSettled([
      service.execute({
        body,
        clerkSubject: "owner_a",
        idempotencyKey: "72000000-0000-4000-8000-000000000001",
      }),
      service.execute({
        body,
        clerkSubject: "owner_b",
        idempotencyKey: "72000000-0000-4000-8000-000000000002",
      }),
    ]);
    const rejectionDiagnostics = results.flatMap((result) => {
      if (result.status !== "rejected") return [];
      const reason = result.reason as {
        readonly code?: unknown;
        readonly constraint?: unknown;
        readonly kind?: unknown;
        readonly name?: unknown;
      };
      return [
        {
          code: typeof reason.code === "string" ? reason.code : null,
          constraint:
            typeof reason.constraint === "string" ? reason.constraint : null,
          kind: typeof reason.kind === "string" ? reason.kind : null,
          name: typeof reason.name === "string" ? reason.name : null,
        },
      ];
    });
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(rejectionDiagnostics).toEqual([
      {
        code: null,
        constraint: null,
        kind: "INSTALLATION_OWNED_BY_ANOTHER_USER",
        name: "DomainError",
      },
    ]);
    expect(
      await context.db.selectFrom("devices").selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await context.db.selectFrom("api_idempotency").selectAll().execute(),
    ).toHaveLength(1);
  });
});
