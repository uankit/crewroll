import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql, TableNode, type Kysely, type KyselyPlugin } from "kysely";
import type { TripContinuityBody } from "@crewroll/contracts";
import { createDatabase } from "../../services/control-plane/src/db/database.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import { createKyselyTripContinuity } from "../../services/control-plane/src/db/trips/kyselyTripContinuity.js";
import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
import type { ForegroundTripActor } from "../../services/control-plane/src/modules/trips/ports/tripContinuityService.js";
import { normalizeInviteCode } from "../../services/control-plane/src/modules/trips/tripPolicy.js";
import { createHmacInviteCodeHasher } from "../../services/control-plane/src/platform/crypto/hmacInviteCodeHasher.js";
import { createOwnerInviteVault } from "../../services/control-plane/src/platform/crypto/ownerInviteVault.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Scheduling barrier only: the selected row is already locked by PostgreSQL. */
function rowLockGate(tableName: "devices" | "trips") {
  const queryIds = new WeakSet<object>();
  const held = deferred();
  const released = deferred();
  let armed = true;
  let timer: ReturnType<typeof setTimeout>;
  const entered = Promise.race([
    held.promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Expected PostgreSQL row lock was not reached")),
        8_000,
      );
    }),
  ]);
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (
        armed &&
        node.kind === "SelectQueryNode" &&
        node.from?.froms.some(
          (table) =>
            TableNode.is(table) && table.table.identifier.name === tableName,
        ) &&
        node.endModifiers?.some(
          (modifier) =>
            modifier.modifier === "ForUpdate" ||
            modifier.modifier === "ForNoKeyUpdate",
        )
      ) {
        armed = false;
        queryIds.add(queryId);
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      if (queryIds.has(queryId)) {
        queryIds.delete(queryId);
        held.resolve();
        await released.promise;
      }
      return result;
    },
  };
  return {
    plugin,
    entered,
    release() {
      clearTimeout(timer);
      released.resolve();
    },
  };
}

describe.sequential("PostgreSQL replacement-phone lock contention", () => {
  let context: PostgresTestContext;
  let db: Kysely<Database>;
  let host: ForegroundTripActor;
  let oldPhone: ForegroundTripActor;
  let newPhone: ForegroundTripActor;
  let tripId: string;
  let memberId: string;
  const clock = { now: () => new Date("2026-08-29T08:01:00.000Z") };

  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  afterAll(async () => {
    await context?.stop();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
    db = createDatabase(context.connectionString, {
      maxConnections: 4,
      statementTimeoutMillis: 10_000,
      queryTimeoutMillis: 11_000,
      idleTransactionTimeoutMillis: 15_000,
    });
    const fixtures = createIdentityTripFixtures(context.db);
    const owner = await fixtures.user();
    const hostDevice = await fixtures.device(owner.id);
    const guest = await fixtures.user();
    const oldDevice = await fixtures.device(guest.id);
    const newDevice = await fixtures.device(guest.id);
    const trip = await fixtures.trip(owner.id, {
      id: "01990000-0000-7000-8000-000000000001",
      state: "ACTIVE",
      member_count: 2,
      started_at: new Date("2026-08-29T08:00:00.000Z"),
    });
    tripId = trip.id;
    await fixtures.member(tripId, owner.id, hostDevice.id, {
      role: "OWNER",
      full_photo_library_access: true,
    });
    const member = await fixtures.member(tripId, guest.id, oldDevice.id, {
      full_photo_library_access: true,
    });
    memberId = member.id;
    await fixtures.envelope(tripId, oldDevice.id, hostDevice.id);
    host = {
      userId: owner.id,
      deviceId: hostDevice.id,
      clerkSubject: owner.clerk_subject,
    };
    oldPhone = {
      userId: guest.id,
      deviceId: oldDevice.id,
      clerkSubject: guest.clerk_subject,
    };
    newPhone = { ...oldPhone, deviceId: newDevice.id };
  });
  afterEach(async () => {
    await db?.destroy();
  });

  function continuity(database = db) {
    return createKyselyTripContinuity(
      database,
      clock,
      createHmacInviteCodeHasher("test-only-invite-secret"),
      createOwnerInviteVault("test-only-invite-secret"),
      normalizeInviteCode,
    );
  }

  async function approval(): Promise<TripContinuityBody> {
    const requested = await continuity().change(newPhone, tripId, {
      action: "REQUEST_DEVICE",
      expectedVersion: 1,
    });
    return {
      action: "APPROVE_DEVICE",
      requestId: requested.deviceRequest!.requestId,
      expectedVersion: requested.version,
      wrappedKey: Buffer.alloc(148, 7).toString("base64"),
    };
  }

  async function snapshot() {
    return {
      trip: await context.db
        .selectFrom("trips")
        .selectAll()
        .executeTakeFirstOrThrow(),
      members: await context.db
        .selectFrom("trip_members")
        .selectAll()
        .orderBy("id")
        .execute(),
      devices: await context.db
        .selectFrom("devices")
        .selectAll()
        .orderBy("id")
        .execute(),
      requests: await context.db
        .selectFrom("trip_device_requests")
        .selectAll()
        .orderBy("id")
        .execute(),
      envelopes: await context.db
        .selectFrom("trip_key_envelopes")
        .selectAll()
        .orderBy("recipient_device_id")
        .execute(),
      inbox: await context.db
        .selectFrom("inbox_events")
        .selectAll()
        .orderBy("sequence")
        .execute(),
      outbox: await context.db
        .selectFrom("outbox_events")
        .selectAll()
        .orderBy("id")
        .execute(),
    };
  }

  it("lets an authorized old-phone poll finish and commits host approval exactly once", async () => {
    const body = await approval();
    const before = await snapshot();
    const oldDeviceHeld = rowLockGate("devices");
    const approvalTripHeld = rowLockGate("trips");
    const oldDatabase = createDatabase(
      context.connectionString + "?application_name=crewroll-old-phone-cycle",
      { maxConnections: 1, statementTimeoutMillis: 10_000 },
    );
    const oldResult = Promise.allSettled([
      createKyselyTripLifecycle(
        oldDatabase.withPlugin(oldDeviceHeld.plugin),
        clock,
      ).read(oldPhone, tripId),
    ]);
    let approved: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await oldDeviceHeld.entered;
      const peer = await sql<{ pid: number }>`
        select pid from pg_stat_activity
        where application_name = 'crewroll-old-phone-cycle'
      `.execute(context.db);
      expect(peer.rows).toHaveLength(1);
      const peerPid = peer.rows[0]!.pid;
      approved = Promise.allSettled([
        continuity(db.withPlugin(approvalTripHeld.plugin)).change(
          host,
          tripId,
          body,
        ),
      ]);
      await approvalTripHeld.entered;
      oldDeviceHeld.release();
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await sql<{ blocked: boolean }>`
          select cardinality(pg_blocking_pids(${peerPid})) > 0 as blocked
        `.execute(context.db);
        if (result.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      approvalTripHeld.release();
      const [old, replacement] = await Promise.all([oldResult, approved]);
      const outcomes = [...old, ...replacement];
      process.stdout.write(
        JSON.stringify({
          event: "real_postgres_continuity_cycle",
          fulfilled: outcomes.filter((item) => item.status === "fulfilled")
            .length,
          errorCodes: outcomes.flatMap((item) =>
            item.status === "rejected"
              ? [
                  typeof item.reason?.code === "string"
                    ? item.reason.code
                    : "UNEXPECTED_ERROR",
                ]
              : [],
          ),
        }) + "\n",
      );
      expect(outcomes.map((item) => item.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const after = await snapshot();
      expect(after.trip.version).toBe(before.trip.version + 1);
      expect(
        after.members.find((member) => member.id === memberId),
      ).toMatchObject({
        participating_device_id: newPhone.deviceId,
        full_photo_library_access: false,
        approved_at: before.members.find((member) => member.id === memberId)!
          .approved_at,
      });
      expect(
        after.devices.find((device) => device.id === oldPhone.deviceId)!
          .revoked_at,
      ).toEqual(clock.now());
      expect(after.envelopes).toHaveLength(before.envelopes.length + 1);
      expect(after.requests).toHaveLength(1);
      expect(after.requests[0]!.state).toBe("APPROVED");
      expect(after.inbox).toHaveLength(before.inbox.length + 2);
      expect(after.outbox).toHaveLength(before.outbox.length + 1);
      // A client retry after a lost response must not duplicate any mutation.
      await continuity().change(host, tripId, body);
      expect(await snapshot()).toEqual(after);
      await expect(
        createKyselyTripLifecycle(db, clock).read(oldPhone, tripId),
      ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    } finally {
      oldDeviceHeld.release();
      approvalTripHeld.release();
      await oldResult;
      if (approved) await approved;
      await oldDatabase.destroy();
    }
  });

  it.each(["approval", "pending join"] as const)(
    "bounds busy-device retries for %s and rolls back every attempted mutation",
    async (operation) => {
      let actor = host;
      let body: TripContinuityBody;
      if (operation === "approval") body = await approval();
      else {
        await context.db
          .updateTable("trip_members")
          .set({ state: "PENDING_KEY", approved_at: null, key_epoch: null })
          .where("id", "=", memberId)
          .execute();
        actor = newPhone;
        body = { action: "REQUEST_DEVICE", expectedVersion: 1 };
      }
      const before = await snapshot();
      const held = deferred();
      const released = deferred();
      const blocker = context.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("devices")
          .select("id")
          .where("id", "=", oldPhone.deviceId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        held.resolve();
        await released.promise;
      });
      let targetLockAttempts = 0;
      const counting: KyselyPlugin = {
        transformQuery({ node }) {
          if (
            node.kind === "SelectQueryNode" &&
            node.from?.froms.some(
              (table) =>
                TableNode.is(table) &&
                table.table.identifier.name === "devices",
            ) &&
            node.endModifiers?.some(
              (modifier) => modifier.modifier === "NoWait",
            )
          )
            targetLockAttempts++;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      };
      // A short origin timeout also keeps the pre-fix negative control finite.
      const boundedDb = createDatabase(context.connectionString, {
        maxConnections: 1,
        lockTimeoutMillis: 150,
        statementTimeoutMillis: 3_000,
      });
      try {
        await held.promise;
        await expect(
          continuity(boundedDb.withPlugin(counting)).change(
            actor,
            tripId,
            body,
          ),
        ).rejects.toMatchObject({ kind: "DEPENDENCY_NOT_READY" });
        expect(targetLockAttempts).toBe(5);
        expect(await snapshot()).toEqual(before);
      } finally {
        released.resolve();
        await blocker;
        await boundedDb.destroy();
      }
      await expect(
        continuity().change(actor, tripId, body),
      ).resolves.toMatchObject({
        version: before.trip.version + 1,
      });
    },
  );

  it.each(["40P01", "40001", "08006"])(
    "does not retry an unrelated %s failure or commit partial changes",
    async (code) => {
      const body = await approval();
      const before = await snapshot();
      const failure = Object.assign(new Error("Injected transaction failure"), {
        code,
      });
      let attempts = 0;
      const plugin: KyselyPlugin = {
        transformQuery({ node }) {
          if (
            node.kind === "SelectQueryNode" &&
            node.from?.froms.some(
              (table) =>
                TableNode.is(table) && table.table.identifier.name === "trips",
            ) &&
            node.endModifiers?.some(
              (modifier) => modifier.modifier === "ForUpdate",
            )
          ) {
            attempts++;
            throw failure;
          }
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      };
      await expect(
        continuity(db.withPlugin(plugin)).change(host, tripId, body),
      ).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    ["trip version changes", "VERSION_CONFLICT"],
    ["approver is revoked", "AUTH_INVALID"],
  ] as const)(
    "rechecks current state after rollback when %s",
    async (change, expectedKind) => {
      const body = await approval();
      const held = deferred();
      const released = deferred();
      const targetAttempted = deferred();
      const stateChanged = deferred();
      const blocker = context.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("devices")
          .select("id")
          .where("id", "=", oldPhone.deviceId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        held.resolve();
        await released.promise;
      });
      let attempted = false;
      const retryQueryIds = new WeakSet<object>();
      const plugin: KyselyPlugin = {
        transformQuery({ node, queryId }) {
          if (node.kind !== "SelectQueryNode") return node;
          if (
            node.from?.froms.some(
              (table) =>
                TableNode.is(table) && table.table.identifier.name === "users",
            ) &&
            attempted
          )
            retryQueryIds.add(queryId);
          if (
            node.from?.froms.some(
              (table) =>
                TableNode.is(table) &&
                table.table.identifier.name === "devices",
            ) &&
            node.endModifiers?.some(
              (modifier) => modifier.modifier === "NoWait",
            )
          ) {
            attempted = true;
            targetAttempted.resolve();
          }
          return node;
        },
        async transformResult({ result, queryId }) {
          // The first attempt has rolled back before a fresh transaction can
          // reach this read. Hold it before device authorization, so the test
          // deterministically commits the intervening change first.
          if (retryQueryIds.has(queryId)) await stateChanged.promise;
          return result;
        },
      };
      let work: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await held.promise;
        work = Promise.allSettled([
          continuity(db.withPlugin(plugin)).change(host, tripId, body),
        ]);
        await targetAttempted.promise;
        if (change === "trip version changes")
          await context.db
            .updateTable("trips")
            .set({ version: sql`version + 1` })
            .where("id", "=", tripId)
            .execute();
        else
          await context.db
            .updateTable("devices")
            .set({ revoked_at: clock.now() })
            .where("id", "=", host.deviceId)
            .execute();
        const externallyChanged = await snapshot();
        stateChanged.resolve();
        released.resolve();
        const outcome = (await work)[0]!;
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { kind: expectedKind },
        });
        expect(await snapshot()).toEqual(externallyChanged);
      } finally {
        stateChanged.resolve();
        released.resolve();
        await blocker;
        if (work) await work;
      }
    },
  );
});
