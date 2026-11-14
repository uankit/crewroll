import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import type {
  CommitAssetBody,
  CreateUploadSessionBody,
} from "@crewroll/contracts";
import { createDatabase } from "../../services/control-plane/src/db/database.js";
import { createKyselyMediaService } from "../../services/control-plane/src/db/media/kyselyMediaService.js";
import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
import { createKyselyTripContinuity } from "../../services/control-plane/src/db/trips/kyselyTripContinuity.js";
import { createHmacInviteCodeHasher } from "../../services/control-plane/src/platform/crypto/hmacInviteCodeHasher.js";
import { createOwnerInviteVault } from "../../services/control-plane/src/platform/crypto/ownerInviteVault.js";
import { normalizeInviteCode } from "../../services/control-plane/src/modules/trips/tripPolicy.js";
import { createFileCiphertextStore } from "../../services/control-plane/src/platform/localMedia/fileCiphertextStore.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import type { MediaActor } from "../../services/control-plane/src/modules/media/ports/mediaService.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
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

/** Instrument only scheduling AFTER genuine PostgreSQL authorization locks exist. */
function identityBarrier(participants: number) {
  const queryIds = new WeakSet<object>();
  const gate = deferred();
  let count = 0;
  const timer = setTimeout(() => gate.resolve(), 10_000);
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (
        node.kind === "SelectQueryNode" &&
        node.from?.froms.some(
          (table) =>
            TableNode.is(table) && table.table.identifier.name === "devices",
        ) &&
        node.endModifiers?.some(
          (modifier) =>
            modifier.modifier === "ForUpdate" ||
            modifier.modifier === "ForNoKeyUpdate",
        )
      )
        queryIds.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (queryIds.has(queryId)) {
        queryIds.delete(queryId);
        count++;
        if (count === participants) {
          gate.resolve();
        }
        await gate.promise;
      }
      return result;
    },
  };
  return {
    plugin,
    count: () => count,
    release() {
      clearTimeout(timer);
      gate.resolve();
    },
  };
}

/** Pause one operation only after PostgreSQL has granted its first matching row lock. */
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
        () => reject(new Error("Expected real row lock was not reached")),
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
            modifier.modifier === "ForNoKeyUpdate" ||
            modifier.modifier === "ForShare",
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

describe.sequential(
  "PostgreSQL identity locks during ten-member fan-out",
  () => {
    let context: PostgresTestContext;
    let db: Kysely<Database>;
    let directory: string;
    let local: Awaited<ReturnType<typeof createFileCiphertextStore>>;
    let actors: (MediaActor & { clerkSubject: string })[];
    let tripId: string;
    const now = new Date("2026-08-29T08:01:00.000Z");
    const clock = { now: () => now };
    const bytes = Buffer.from("opaque encrypted bytes");
    beforeAll(async () => {
      context = await startMigratedPostgres();
    });
    afterAll(async () => {
      await context?.stop();
    });
    beforeEach(async () => {
      await truncateIdentityTripTables(context.db);
      db = createDatabase(context.connectionString, {
        maxConnections: 12,
        statementTimeoutMillis: 15_000,
        queryTimeoutMillis: 16_000,
        idleTransactionTimeoutMillis: 20_000,
      });
      directory = await mkdtemp(path.join(tmpdir(), "crewroll-fanout-locks-"));
      local = await createFileCiphertextStore({
        directory,
        origin: "http://127.0.0.1:8787",
        signingKey: randomBytes(32),
        nodeEnvironment: "test",
        now: clock.now,
      });
      const fixtures = createIdentityTripFixtures(context.db);
      const owner = await fixtures.user();
      const trip = await fixtures.trip(owner.id, {
        id: "01990000-0000-7000-8000-000000000001",
        state: "ACTIVE",
        member_count: 10,
        started_at: new Date("2026-08-29T08:00:00.000Z"),
      });
      tripId = trip.id;
      actors = [];
      for (let i = 0; i < 10; i++) {
        const user = i === 0 ? owner : await fixtures.user();
        const device = await fixtures.device(user.id);
        await fixtures.member(tripId, user.id, device.id, {
          role: i === 0 ? "OWNER" : "MEMBER",
          full_photo_library_access: true,
        });
        actors.push({
          userId: user.id,
          deviceId: device.id,
          clerkSubject: user.clerk_subject,
        });
      }
    });
    afterEach(async () => {
      await db?.destroy();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    function service(database = db) {
      return createKyselyMediaService(database, local.store, clock);
    }
    async function uploaded(index: number) {
      const assetId = randomUUID();
      const checksum = createHash("sha256").update(bytes).digest("base64");
      const body: CreateUploadSessionBody = {
        tripId,
        assetId,
        sourceAssetKey: `src_${assetId.replaceAll("-", "")}`,
        capturedAt: now.toISOString(),
        formatVersion: 1,
        keyEpoch: 1,
        encryptedManifest: Buffer.from("encrypted manifest").toString("base64"),
        objects: [
          {
            variant: "PREVIEW",
            ciphertextBytes: String(bytes.length),
            checksumSha256: checksum,
          },
          {
            variant: "ORIGINAL",
            ciphertextBytes: String(bytes.length),
            checksumSha256: checksum,
          },
        ],
      };
      const reserved = await service().createUpload(actors[index]!, body);
      const objects = new Map<string, string>();
      for (const object of reserved.objects) {
        const grant = new URL(object.url).searchParams.get("grant")!;
        const result = await local.gateway.put(
          grant,
          (async function* () {
            yield bytes;
          })(),
        );
        objects.set(object.variant, result.etag);
      }
      const commit: CommitAssetBody = {
        uploadSessionId: reserved.uploadSessionId,
        objects: [
          { variant: "PREVIEW", etag: objects.get("PREVIEW")! },
          { variant: "ORIGINAL", etag: objects.get("ORIGINAL")! },
        ],
      };
      return { body, reserved, commit };
    }
    function assertAllSucceeded(
      outcomes: PromiseSettledResult<unknown>[],
      operation: string,
    ) {
      const codes = outcomes
        .filter((o): o is PromiseRejectedResult => o.status === "rejected")
        .map((o) =>
          typeof o.reason?.code === "string"
            ? o.reason.code
            : "UNEXPECTED_ERROR",
        );
      process.stdout.write(
        JSON.stringify({
          event: "real_postgres_fanout_result",
          operation,
          phase: process.env.CREWROLL_FANOUT_LOCK_PHASE ?? "verification",
          participants: outcomes.length,
          fulfilled: outcomes.length - codes.length,
          errorCodes: codes,
        }) + "\n",
      );
      expect(codes).toEqual([]);
      expect(outcomes).toHaveLength(10);
    }
    it.each(["preview", "commit"] as const)(
      "completes ten concurrent %s fan-outs without PostgreSQL deadlocks",
      async (operation) => {
        const uploads = [];
        for (let i = 0; i < 10; i++) uploads.push(await uploaded(i));
        const barrier = identityBarrier(10);
        const concurrent = service(db.withPlugin(barrier.plugin));
        let work: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          work = Promise.allSettled(
            uploads.map((upload, i) =>
              operation === "preview"
                ? concurrent.publishPreview(actors[i]!, upload.body.assetId, {
                    uploadSessionId: upload.reserved.uploadSessionId,
                    etag: upload.commit.objects.find(
                      (o) => o.variant === "PREVIEW",
                    )!.etag,
                  })
                : concurrent.commit(
                    actors[i]!,
                    upload.body.assetId,
                    upload.commit,
                  ),
            ),
          );
          const outcomes = await work;
          expect(barrier.count()).toBe(10);
          assertAllSucceeded(outcomes, operation);
          const events = await context.db
            .selectFrom("inbox_events")
            .selectAll()
            .where("trip_id", "=", tripId)
            .execute();
          expect(events).toHaveLength(100);
          expect(
            new Set(
              events.map((e) => `${e.aggregate_id}:${e.recipient_device_id}`),
            ).size,
          ).toBe(100);
          expect(
            events.every(
              (e) =>
                e.event_type ===
                (operation === "preview"
                  ? "ASSET_PREVIEW_READY"
                  : "ASSET_COMMITTED"),
            ),
          ).toBe(true);
          const deliveries = await context.db
            .selectFrom("deliveries")
            .selectAll()
            .execute();
          const receipts = await context.db
            .selectFrom("receipts")
            .selectAll()
            .execute();
          expect(deliveries).toHaveLength(operation === "commit" ? 100 : 0);
          expect(receipts).toHaveLength(operation === "commit" ? 10 : 0);
          if (operation === "commit") {
            expect(
              receipts.every((r) => r.receipt_type === "SOURCE_PRESENT"),
            ).toBe(true);
            expect(deliveries.filter((d) => d.state === "READY")).toHaveLength(
              90,
            );
            expect(
              deliveries.filter((d) => d.state === "SAVED_LOCALLY"),
            ).toHaveLength(10);
            expect(
              await context.db.selectFrom("assets").select("id").execute(),
            ).toHaveLength(10);
          }
        } finally {
          barrier.release();
          if (work) await work;
        }
      },
    );

    it.each(["lifecycle", "continuity"] as const)(
      "allows media fan-out while another actor holds real %s authorization",
      async (operation) => {
        const upload = await uploaded(0);
        const tripHeld = rowLockGate("trips");
        const identityHeld = rowLockGate("devices");
        const mediaWork = Promise.allSettled([
          service(db.withPlugin(tripHeld.plugin)).commit(
            actors[0]!,
            upload.body.assetId,
            upload.commit,
          ),
        ]);
        let peerWork: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await tripHeld.entered;
          const instrumented = db.withPlugin(identityHeld.plugin);
          const peer =
            operation === "lifecycle"
              ? createKyselyTripLifecycle(instrumented, clock).read(
                  actors[1]!,
                  tripId,
                )
              : createKyselyTripContinuity(
                  instrumented,
                  clock,
                  createHmacInviteCodeHasher(randomBytes(32).toString("hex")),
                  createOwnerInviteVault(randomBytes(32).toString("hex")),
                  normalizeInviteCode,
                ).read(actors[1]!, tripId);
          peerWork = Promise.allSettled([peer]);
          await identityHeld.entered;
          // The media transaction owns the trip, and the peer owns its identity row.
          // Thus the old FOR UPDATE authorization modes necessarily form the FK cycle.
          identityHeld.release();
          tripHeld.release();
          const outcomes = (await Promise.all([mediaWork, peerWork])).flat();
          const errors = outcomes
            .filter((o): o is PromiseRejectedResult => o.status === "rejected")
            .map((o) => o.reason?.code ?? "UNEXPECTED_ERROR");
          expect(errors).toEqual([]);
          expect(outcomes).toHaveLength(2);
          expect(
            await context.db.selectFrom("deliveries").select("id").execute(),
          ).toHaveLength(10);
        } finally {
          identityHeld.release();
          tripHeld.release();
          await Promise.all([mediaWork, ...(peerWork ? [peerWork] : [])]);
        }
      },
    );

    it.each(["device", "user"] as const)(
      "keeps a concurrent %s revocation update behind the media authorization fence",
      async (target) => {
        const actor = actors[0]!;
        const locked = deferred();
        const release = deferred();
        const ids = new WeakSet<object>();
        const gated = db.withPlugin({
          transformQuery({ node, queryId }) {
            if (
              node.kind === "SelectQueryNode" &&
              node.from?.froms.some(
                (t) => TableNode.is(t) && t.table.identifier.name === "devices",
              ) &&
              node.endModifiers?.some(
                (m) =>
                  m.modifier === "ForUpdate" || m.modifier === "ForNoKeyUpdate",
              )
            )
              ids.add(queryId);
            return node;
          },
          async transformResult({ result, queryId }) {
            if (ids.has(queryId)) {
              ids.delete(queryId);
              locked.resolve();
              await release.promise;
            }
            return result;
          },
        });
        const payload: CreateUploadSessionBody = {
          tripId,
          assetId: randomUUID(),
          sourceAssetKey: `src_${"Z".repeat(32)}`,
          capturedAt: now.toISOString(),
          formatVersion: 1,
          keyEpoch: 1,
          encryptedManifest:
            Buffer.from("encrypted manifest").toString("base64"),
          objects: [
            {
              variant: "PREVIEW",
              ciphertextBytes: "22",
              checksumSha256: createHash("sha256")
                .update(bytes)
                .digest("base64"),
            },
            {
              variant: "ORIGINAL",
              ciphertextBytes: "22",
              checksumSha256: createHash("sha256")
                .update(bytes)
                .digest("base64"),
            },
          ],
        };
        const media = service(gated).createUpload(actor, payload);
        let mutation: Promise<void> | undefined;
        const attempted = deferred();
        let mutationPid = 0;
        try {
          await locked.promise;
          mutation = context.db.transaction().execute(async (tx) => {
            mutationPid = (
              await sql<{
                pid: number;
              }>`select pg_backend_pid() as pid`.execute(tx)
            ).rows[0]!.pid;
            attempted.resolve();
            if (target === "device")
              await tx
                .updateTable("devices")
                .set({ revoked_at: now })
                .where("id", "=", actor.deviceId)
                .execute();
            else
              await tx
                .updateTable("users")
                .set({ suspended_at: now })
                .where("id", "=", actor.userId)
                .execute();
          });
          await attempted.promise;
          let blocked = false;
          for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
            blocked = (
              await sql<{
                blocked: boolean;
              }>`select cardinality(pg_blocking_pids(${mutationPid})) > 0 as blocked`.execute(
                context.db,
              )
            ).rows[0]!.blocked;
            if (!blocked)
              await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(blocked).toBe(true);
          release.resolve();
          await media;
          await mutation;
          await expect(
            service().createUpload(actor, {
              ...payload,
              assetId: randomUUID(),
              sourceAssetKey: `src_${"Y".repeat(32)}`,
            }),
          ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
          expect(
            await context.db
              .selectFrom("upload_sessions")
              .select("id")
              .execute(),
          ).toHaveLength(1);
        } finally {
          release.resolve();
          await Promise.allSettled([media, ...(mutation ? [mutation] : [])]);
        }
      },
    );
  },
);
