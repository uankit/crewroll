import { randomUUID } from "node:crypto";
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
import { createDatabase } from "../../services/control-plane/src/db/database.js";
import { createKyselyAccountService } from "../../services/control-plane/src/db/account/kyselyAccountService.js";
import { createKyselyMediaService } from "../../services/control-plane/src/db/media/kyselyMediaService.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import type {
  CiphertextStore,
  MediaActor,
} from "../../services/control-plane/src/modules/media/ports/mediaService.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import { createMediaCoordinationFixtures } from "./support/mediaFixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pause after a genuine SELECT; the default receipt lookup follows all row fences. */
function receiptGate(
  tableName: "receipts" | "deliveries" | "assets" = "receipts",
) {
  const ids = new WeakSet<object>();
  const held = deferred();
  const released = deferred();
  let armed = true;
  let timer: ReturnType<typeof setTimeout>;
  const entered = Promise.race([
    held.promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("Expected real PostgreSQL lookup was not reached")),
        5_000,
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
        )
      ) {
        armed = false;
        ids.add(queryId);
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      if (ids.has(queryId)) {
        ids.delete(queryId);
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

describe.sequential(
  "PostgreSQL asset-local saved receipt serialization",
  () => {
    let context: PostgresTestContext;
    let db: Kysely<Database>;
    let actors: MediaActor[];
    let tripId: string;
    let assets: string[];
    let deliveries: string[][];
    const now = new Date("2026-08-29T08:01:00.000Z");
    let clockNow = now;
    const clock = { now: () => clockNow };
    // Capability signing is outside this SQL scheduling proof; no object body is transferred.
    const store: CiphertextStore = {
      upload: async (object) => `https://objects.example.test/${object.key}`,
      inspect: async () => null,
      download: async (key) => `https://objects.example.test/${key}`,
      delete: async () => {},
    };
    beforeAll(async () => {
      context = await startMigratedPostgres();
    });
    afterAll(async () => {
      await context?.stop();
    });
    beforeEach(async () => {
      clockNow = now;
      await truncateIdentityTripTables(context.db);
      db = createDatabase(context.connectionString, {
        maxConnections: 22,
        lockTimeoutMillis: 300,
        statementTimeoutMillis: 3_000,
        queryTimeoutMillis: 4_000,
      });
      const identity = createIdentityTripFixtures(context.db);
      const media = createMediaCoordinationFixtures(context.db);
      const owner = await identity.user();
      const trip = await identity.trip(owner.id, {
        state: "ACTIVE",
        member_count: 10,
        started_at: new Date("2026-08-29T08:00:00.000Z"),
      });
      tripId = trip.id;
      actors = [];
      for (let i = 0; i < 10; i++) {
        const user = i === 0 ? owner : await identity.user();
        const device = await identity.device(user.id);
        await identity.member(tripId, user.id, device.id, {
          role: i === 0 ? "OWNER" : "MEMBER",
        });
        actors.push({ userId: user.id, deviceId: device.id });
      }
      const parents = {
        tripId,
        sourceUserId: actors[0]!.userId,
        sourceDeviceId: actors[0]!.deviceId,
        recipientUserId: actors[1]!.userId,
        recipientDeviceId: actors[1]!.deviceId,
        outsiderUserId: actors[9]!.userId,
        outsiderDeviceId: actors[9]!.deviceId,
      };
      assets = [];
      deliveries = [];
      for (let i = 0; i < 10; i++) {
        const asset = await media.asset(parents);
        assets.push(asset.id);
        await media.assetObject(asset.id, { variant: "PREVIEW" });
        await media.assetObject(asset.id, { variant: "ORIGINAL" });
        const assetDeliveries: string[] = [];
        for (let j = 0; j < 10; j++) {
          const delivery = await media.delivery(asset.id, parents, {
            recipient_user_id: actors[j]!.userId,
            recipient_device_id: actors[j]!.deviceId,
            ...(j === 0 ? { state: "SAVED_LOCALLY", saved_at: now } : {}),
          });
          assetDeliveries.push(delivery.id);
          if (j === 0)
            await media.receipt(delivery.id, {
              receipt_type: "SOURCE_PRESENT",
            });
        }
        deliveries.push(assetDeliveries);
      }
    });
    afterEach(async () => {
      await db?.destroy();
    });
    const service = (database: Kysely<Database>) =>
      createKyselyMediaService(database, store, clock);
    const body = (asset: number) => ({
      assetId: assets[asset]!,
      savedAt: now.toISOString(),
      engineRevision: 1,
    });

    it("allows ten independent asset receipt/grant operations past a held receipt", async () => {
      const gate = receiptGate();
      const held = Promise.allSettled([
        service(db.withPlugin(gate.plugin)).saved(
          actors[1]!,
          deliveries[0]![1]!,
          randomUUID(),
          body(0),
        ),
      ]);
      let peers: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await gate.entered;
        peers = Promise.allSettled([
          ...Array.from({ length: 9 }, (_, i) =>
            service(db).saved(
              actors[i + 1]!,
              deliveries[i + 1]![i + 1]!,
              randomUUID(),
              body(i + 1),
            ),
          ),
          ...Array.from({ length: 10 }, (_, i) =>
            service(db).download(
              actors[((i + 1) % 9) + 1]!,
              deliveries[i]![((i + 1) % 9) + 1]!,
              { variants: ["ORIGINAL"] },
            ),
          ),
        ]);
        const outcomes = await peers;
        const codes = outcomes.flatMap((outcome) =>
          outcome.status === "rejected"
            ? [String(outcome.reason?.code ?? "UNEXPECTED_ERROR")]
            : [],
        );
        process.stdout.write(
          JSON.stringify({
            event: "held_receipt_independent_assets",
            operations: outcomes.length,
            errorCodes: codes,
          }) + "\n",
        );
        expect(codes).toEqual([]);
        expect(outcomes).toHaveLength(19);
        expect(
          await context.db.selectFrom("receipts").select("id").execute(),
        ).toHaveLength(19);
      } finally {
        gate.release();
        await held;
        if (peers) await peers;
      }
      expect((await held)[0]?.status).toBe("fulfilled");
    });

    it("serializes the last nine receipts for one asset and purges exactly once", async () => {
      let purgeUpdates = 0;
      let statements = 0;
      const plugin: KyselyPlugin = {
        transformQuery({ node }) {
          statements++;
          if (
            node.kind === "UpdateQueryNode" &&
            node.table &&
            TableNode.is(node.table) &&
            node.table.table.identifier.name === "assets"
          )
            purgeUpdates++;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      };
      const concurrent = service(db.withPlugin(plugin));
      const commands = actors.slice(1).map((actor, i) => ({
        actor,
        delivery: deliveries[0]![i + 1]!,
        event: randomUUID(),
      }));
      const responses = await Promise.all(
        commands.map((c) =>
          concurrent.saved(c.actor, c.delivery, c.event, body(0)),
        ),
      );
      expect(responses).toHaveLength(9);
      expect(purgeUpdates).toBe(1);
      expect(
        await context.db
          .selectFrom("assets")
          .select(["state", "purge_pending_at"])
          .where("id", "=", assets[0]!)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "PURGE_PENDING", purge_pending_at: now });
      expect(
        await context.db
          .selectFrom("deliveries")
          .select("id")
          .where("asset_id", "=", assets[0]!)
          .where("state", "=", "SAVED_LOCALLY")
          .execute(),
      ).toHaveLength(10);
      const replay = await Promise.all(
        commands.map((c) =>
          concurrent.saved(c.actor, c.delivery, c.event, body(0)),
        ),
      );
      expect(replay).toEqual(responses);
      expect(purgeUpdates).toBe(1);
      expect(
        await context.db
          .selectFrom("receipts")
          .select("id")
          .where("delivery_id", "in", deliveries[0]!)
          .execute(),
      ).toHaveLength(10);
      process.stdout.write(
        JSON.stringify({
          event: "same_asset_receipts",
          accepted: 9,
          replays: 9,
          purgeUpdates,
          statements,
        }) + "\n",
      );
    });

    it.each(["user", "device", "end", "erase"] as const)(
      "retains the %s exclusion fence while accepting a receipt",
      async (operation) => {
        const gate = receiptGate();
        const held = Promise.allSettled([
          service(db.withPlugin(gate.plugin)).saved(
            actors[1]!,
            deliveries[0]![1]!,
            randomUUID(),
            body(0),
          ),
        ]);
        try {
          await gate.entered;
          const mutation =
            operation === "user"
              ? db
                  .updateTable("users")
                  .set({ suspended_at: now })
                  .where("id", "=", actors[1]!.userId)
                  .execute()
              : operation === "device"
                ? db
                    .updateTable("devices")
                    .set({ revoked_at: now })
                    .where("id", "=", actors[1]!.deviceId)
                    .execute()
                : operation === "end"
                  ? db
                      .updateTable("trips")
                      .set({ state: "ENDING", ending_started_at: now })
                      .where("id", "=", tripId)
                      .execute()
                  : db.transaction().execute(async (tx) => {
                      await tx
                        .selectFrom("trips")
                        .select("id")
                        .where("id", "=", tripId)
                        .forUpdate()
                        .executeTakeFirstOrThrow();
                      await tx
                        .deleteFrom("assets")
                        .where("id", "=", assets[0]!)
                        .execute();
                    });
          await expect(mutation).rejects.toMatchObject({ code: "55P03" });
          expect(
            await context.db.selectFrom("receipts").select("id").execute(),
          ).toHaveLength(10);
        } finally {
          gate.release();
          await held;
        }
        expect((await held)[0]?.status).toBe("fulfilled");
      },
    );

    it.each(["user", "device"] as const)(
      "rejects a receipt after prior %s revocation without writes",
      async (kind) => {
        if (kind === "user")
          await db
            .updateTable("users")
            .set({ suspended_at: now })
            .where("id", "=", actors[1]!.userId)
            .execute();
        else
          await db
            .updateTable("devices")
            .set({ revoked_at: now })
            .where("id", "=", actors[1]!.deviceId)
            .execute();
        await expect(
          service(db).saved(
            actors[1]!,
            deliveries[0]![1]!,
            randomUUID(),
            body(0),
          ),
        ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
        expect(
          await context.db.selectFrom("receipts").select("id").execute(),
        ).toHaveLength(10);
        expect(
          (
            await context.db
              .selectFrom("deliveries")
              .select("state")
              .where("id", "=", deliveries[0]![1]!)
              .executeTakeFirstOrThrow()
          ).state,
        ).toBe("READY");
      },
    );

    it("rolls back a real inserted receipt and delivery update on a later failure", async () => {
      const ids = new WeakSet<object>();
      const plugin: KyselyPlugin = {
        transformQuery({ node, queryId }) {
          if (
            node.kind === "UpdateQueryNode" &&
            node.table &&
            TableNode.is(node.table) &&
            node.table.table.identifier.name === "deliveries"
          )
            ids.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (ids.has(queryId))
            throw new Error("Injected failure after genuine delivery update");
          return result;
        },
      };
      await expect(
        service(db.withPlugin(plugin)).saved(
          actors[1]!,
          deliveries[0]![1]!,
          randomUUID(),
          body(0),
        ),
      ).rejects.toThrow("Injected failure");
      expect(
        await context.db.selectFrom("receipts").select("id").execute(),
      ).toHaveLength(10);
      expect(
        await context.db
          .selectFrom("deliveries")
          .select(["state", "saved_at"])
          .where("id", "=", deliveries[0]![1]!)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "READY", saved_at: null });
      expect(
        (
          await context.db
            .selectFrom("assets")
            .select("state")
            .where("id", "=", assets[0]!)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("COMMITTED");
    });
    it("returns a typed conflict for concurrent event reuse across independent assets", async () => {
      const gate = deferred();
      const ids = new WeakSet<object>();
      let arrivals = 0;
      const timer = setTimeout(gate.resolve, 3_000);
      const plugin: KyselyPlugin = {
        transformQuery({ node, queryId }) {
          if (
            node.kind === "SelectQueryNode" &&
            node.from?.froms.some(
              (table) =>
                TableNode.is(table) &&
                table.table.identifier.name === "receipts",
            ) &&
            node.selections?.some(
              (selection) => selection.selection.kind === "ReferenceNode",
            )
          )
            ids.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (ids.has(queryId)) {
            ids.delete(queryId);
            arrivals++;
            if (arrivals === 2) gate.resolve();
            await gate.promise;
          }
          return result;
        },
      };
      const eventId = randomUUID();
      const concurrent = service(db.withPlugin(plugin));
      try {
        const outcomes = await Promise.allSettled(
          [0, 1].map((asset) =>
            concurrent.saved(
              actors[1]!,
              deliveries[asset]![1]!,
              eventId,
              body(asset),
            ),
          ),
        );
        expect(arrivals).toBe(2);
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(
          1,
        );
        const rejected = outcomes.filter(
          (o): o is PromiseRejectedResult => o.status === "rejected",
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toMatchObject({
          kind: "IDEMPOTENCY_CONFLICT",
        });
        expect(
          await context.db
            .selectFrom("receipts")
            .select("id")
            .where("client_event_id", "=", eventId)
            .execute(),
        ).toHaveLength(1);
        expect(
          await context.db
            .selectFrom("deliveries")
            .select("id")
            .where("id", "in", [deliveries[0]![1]!, deliveries[1]![1]!])
            .where("state", "=", "SAVED_LOCALLY")
            .execute(),
        ).toHaveLength(1);
      } finally {
        clearTimeout(timer);
        gate.resolve();
      }
    });

    it("rejects a receipt whose asset wait crosses the hard deletion deadline", async () => {
      const gate = receiptGate();
      const held = Promise.allSettled([
        service(db.withPlugin(gate.plugin)).saved(
          actors[1]!,
          deliveries[0]![1]!,
          randomUUID(),
          body(0),
        ),
      ]);
      let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await gate.entered;
        waiting = Promise.allSettled([
          service(db).saved(
            actors[2]!,
            deliveries[0]![2]!,
            randomUUID(),
            body(0),
          ),
        ]);
        await expect
          .poll(
            async () =>
              Number(
                (
                  await sql<{
                    count: string;
                  }>`select count(*)::text as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
                    context.db,
                  )
                ).rows[0]!.count,
              ),
            { timeout: 1_000 },
          )
          .toBeGreaterThan(0);
        clockNow = (
          await context.db
            .selectFrom("trips")
            .select("hard_delete_at")
            .where("id", "=", tripId)
            .executeTakeFirstOrThrow()
        ).hard_delete_at;
      } finally {
        gate.release();
        await held;
        if (waiting) await waiting;
      }
      for (const outcome of [...(await held), ...(await waiting!)]) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({ kind: "TRIP_STATE_CONFLICT" });
      }
      expect(
        await context.db.selectFrom("receipts").select("id").execute(),
      ).toHaveLength(10);
      expect(
        await context.db
          .selectFrom("deliveries")
          .select("id")
          .where("asset_id", "=", assets[0]!)
          .where("state", "=", "READY")
          .execute(),
      ).toHaveLength(9);
    });

    async function requestNonOwnerDeletion(database = db) {
      const source = actors[2]!;
      await db
        .updateTable("assets")
        .set({ source_device_id: source.deviceId })
        .where("id", "=", assets[0]!)
        .execute();
      // Keep the seeded source receipt consistent with this non-owner source.
      await db
        .deleteFrom("receipts")
        .where("delivery_id", "=", deliveries[0]![0]!)
        .execute();
      await db
        .updateTable("deliveries")
        .set({ state: "READY", saved_at: null })
        .where("id", "=", deliveries[0]![0]!)
        .execute();
      await db
        .updateTable("deliveries")
        .set({ state: "SAVED_LOCALLY", saved_at: now })
        .where("id", "=", deliveries[0]![2]!)
        .execute();
      await db
        .insertInto("receipts")
        .values({
          id: randomUUID(),
          delivery_id: deliveries[0]![2]!,
          receipt_type: "SOURCE_PRESENT",
          client_event_id: randomUUID(),
          client_observed_at: now,
          accepted_at: now,
        })
        .execute();
      const subject = (
        await db
          .selectFrom("users")
          .select("clerk_subject")
          .where("id", "=", source.userId)
          .executeTakeFirstOrThrow()
      ).clerk_subject;
      return createKyselyAccountService(
        database,
        store,
        clock,
        async () => {},
      ).requestDeletion(subject);
    }

    it.each(["download", "receipt"] as const)(
      "returns typed NOT_FOUND when physical source erasure wins before %s trip authorization",
      async (operation) => {
        await requestNonOwnerDeletion();
        const gate = receiptGate("deliveries");
        const media = service(db.withPlugin(gate.plugin));
        const work = Promise.allSettled([
          operation === "download"
            ? media.download(actors[1]!, deliveries[0]![1]!, {
                variants: ["ORIGINAL"],
              })
            : media.saved(
                actors[1]!,
                deliveries[0]![1]!,
                randomUUID(),
                body(0),
              ),
        ]);
        try {
          await gate.entered;
          await createKyselyAccountService(
            db,
            store,
            clock,
            async () => {},
          ).cleanup();
          expect(
            await db
              .selectFrom("assets")
              .select("id")
              .where("id", "=", assets[0]!)
              .execute(),
          ).toEqual([]);
        } finally {
          gate.release();
          await work;
        }
        const outcome = (await work)[0]!;
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({ kind: "NOT_FOUND" });
        expect(
          await db
            .selectFrom("receipts")
            .select("id")
            .where("delivery_id", "=", deliveries[0]![1]!)
            .execute(),
        ).toEqual([]);
      },
    );

    it("fences final non-owner source erasure before delivery deletes while a recipient receipt is held", async () => {
      const eraseDb = createDatabase(context.connectionString, {
        maxConnections: 3,
        lockTimeoutMillis: 3_000,
        statementTimeoutMillis: 5_000,
        queryTimeoutMillis: 6_000,
      });
      let deletesAttempted = 0;
      const phase = deferred();
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
          )
            phase.resolve();
          if (
            node.kind === "DeleteQueryNode" &&
            node.from.froms.some(
              (table) =>
                TableNode.is(table) &&
                table.table.identifier.name === "deliveries",
            )
          ) {
            deletesAttempted++;
            phase.resolve();
          }
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      };
      const account = (database: Kysely<Database>) =>
        createKyselyAccountService(database, store, clock, async () => {});
      const request = await requestNonOwnerDeletion(eraseDb);
      const gate = receiptGate();
      const held = Promise.allSettled([
        service(db.withPlugin(gate.plugin)).saved(
          actors[1]!,
          deliveries[0]![1]!,
          randomUUID(),
          body(0),
        ),
      ]);
      let erase: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await gate.entered;
        erase = Promise.allSettled([
          account(eraseDb.withPlugin(plugin)).cleanup(),
        ]);
        await Promise.race([
          phase.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Final erasure phase was not reached")),
              2_000,
            );
          }),
        ]);
        await expect
          .poll(
            async () =>
              Number(
                (
                  await sql<{
                    count: string;
                  }>`select count(*)::text as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
                    context.db,
                  )
                ).rows[0]!.count,
              ),
            { timeout: 1_000 },
          )
          .toBeGreaterThan(0);
        expect(deletesAttempted).toBe(0);
        expect(
          await context.db
            .selectFrom("deliveries")
            .select("id")
            .where("asset_id", "=", assets[0]!)
            .execute(),
        ).toHaveLength(10);
      } finally {
        clearTimeout(timer);
        gate.release();
        await held;
        if (erase) await erase;
        await eraseDb.destroy();
      }
      expect((await held)[0]?.status).toBe("fulfilled");
      expect((await erase!)[0]?.status).toBe("fulfilled");
      expect(
        (
          await context.db
            .selectFrom("account_deletions")
            .select("completed_at")
            .where("id", "=", request.requestId)
            .executeTakeFirstOrThrow()
        ).completed_at,
      ).not.toBeNull();
      expect(
        await context.db
          .selectFrom("assets")
          .select("id")
          .where("id", "=", assets[0]!)
          .execute(),
      ).toEqual([]);
      expect(
        (
          await context.db
            .selectFrom("trips")
            .select("state")
            .where("id", "=", tripId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("ACTIVE");
      expect(
        await context.db.selectFrom("users").select("id").execute(),
      ).toHaveLength(9);
    });
  },
);
