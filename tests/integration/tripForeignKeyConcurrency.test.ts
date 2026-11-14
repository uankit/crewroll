import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { TableNode, type Kysely, type KyselyPlugin } from "kysely";
import type { CreateUploadSessionBody } from "@crewroll/contracts";
import { createDatabase } from "../../services/control-plane/src/db/database.js";
import { createKyselyMediaService } from "../../services/control-plane/src/db/media/kyselyMediaService.js";
import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
import { createKyselyTripContinuity } from "../../services/control-plane/src/db/trips/kyselyTripContinuity.js";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import { createHmacInviteCodeHasher } from "../../services/control-plane/src/platform/crypto/hmacInviteCodeHasher.js";
import { createOwnerInviteVault } from "../../services/control-plane/src/platform/crypto/ownerInviteVault.js";
import { normalizeInviteCode } from "../../services/control-plane/src/modules/trips/tripPolicy.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import type { CiphertextStore } from "../../services/control-plane/src/modules/media/ports/mediaService.js";
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

/** Pause after a genuine row lock, without replacing PostgreSQL lock behavior. */
function rowGate(table: "devices" | "trips") {
  const ids = new WeakSet<object>();
  const entered = deferred();
  const release = deferred();
  let timer: ReturnType<typeof setTimeout>;
  const boundedEntered = Promise.race([
    entered.promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Expected PostgreSQL row lock was not reached")),
        8_000,
      );
    }),
  ]);
  let armed = true;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (
        armed &&
        node.kind === "SelectQueryNode" &&
        node.from?.froms.some(
          (item) => TableNode.is(item) && item.table.identifier.name === table,
        ) &&
        node.endModifiers?.some(
          (modifier) =>
            modifier.modifier !== undefined &&
            ["ForUpdate", "ForNoKeyUpdate", "ForShare"].includes(
              modifier.modifier,
            ),
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
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  };
  return {
    plugin,
    entered: boundedEntered,
    release() {
      clearTimeout(timer);
      release.resolve();
    },
  };
}

describe.sequential(
  "PostgreSQL ordinary trip serialization and foreign keys",
  () => {
    let context: PostgresTestContext;
    let db: Kysely<Database>;
    let tripId: string;
    let actors: { userId: string; deviceId: string; clerkSubject: string }[];
    const now = new Date("2026-08-29T08:01:00.000Z");
    const clock = { now: () => now };
    // Storage is deliberately outside this lock regression's scope. No body is sent.
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
      await truncateIdentityTripTables(context.db);
      db = createDatabase(context.connectionString, {
        maxConnections: 12,
        lockTimeoutMillis: 250,
        statementTimeoutMillis: 2_000,
        queryTimeoutMillis: 3_000,
      });
      const fixtures = createIdentityTripFixtures(context.db);
      const owner = await fixtures.user();
      const trip = await fixtures.trip(owner.id, {
        state: "ACTIVE",
        member_count: 2,
        started_at: new Date("2026-08-29T08:00:00.000Z"),
      });
      tripId = trip.id;
      actors = [];
      for (let index = 0; index < 2; index++) {
        const user = index === 0 ? owner : await fixtures.user();
        const device = await fixtures.device(user.id);
        await fixtures.member(tripId, user.id, device.id, {
          role: index === 0 ? "OWNER" : "MEMBER",
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
    });

    function body(): CreateUploadSessionBody {
      const assetId = randomUUID();
      return {
        tripId,
        assetId,
        sourceAssetKey: `src_${assetId.replaceAll("-", "")}`,
        capturedAt: now.toISOString(),
        formatVersion: 1,
        keyEpoch: 1,
        encryptedManifest: Buffer.from("opaque encrypted manifest").toString(
          "base64",
        ),
        objects: ["PREVIEW", "ORIGINAL"].map((variant) => ({
          variant,
          ciphertextBytes: "32",
          checksumSha256: createHash("sha256")
            .update(Buffer.alloc(32))
            .digest("base64"),
        })) as CreateUploadSessionBody["objects"],
      };
    }
    function media(database = db) {
      return createKyselyMediaService(database, store, clock);
    }
    function continuity(database = db) {
      return createKyselyTripContinuity(
        database,
        clock,
        createHmacInviteCodeHasher(randomBytes(32).toString("hex")),
        createOwnerInviteVault(randomBytes(32).toString("hex")),
        normalizeInviteCode,
      );
    }
    async function retainedAsset() {
      const request = body();
      const source = createKyselyMediaService(
        db,
        {
          ...store,
          inspect: async () => ({
            bytes: "32",
            checksum: request.objects[0].checksumSha256,
            etag: "verified",
          }),
        },
        clock,
      );
      const upload = await source.createUpload(actors[0]!, request);
      await source.publishPreview(actors[0]!, request.assetId, {
        uploadSessionId: upload.uploadSessionId,
        etag: "verified",
      });
      await source.commit(actors[0]!, request.assetId, {
        uploadSessionId: upload.uploadSessionId,
        objects: [
          { variant: "PREVIEW", etag: "verified" },
          { variant: "ORIGINAL", etag: "verified" },
        ],
      });
      const delivery = await db
        .selectFrom("deliveries")
        .select("id")
        .where("asset_id", "=", request.assetId)
        .where("recipient_device_id", "=", actors[1]!.deviceId)
        .executeTakeFirstOrThrow();
      return { assetId: request.assetId, deliveryId: delivery.id };
    }
    type PureRead =
      | "preview feed"
      | "preview grant"
      | "original grant"
      | "trip list"
      | "continuity";
    function read(
      operation: PureRead,
      database: Kysely<Database>,
      asset: Awaited<ReturnType<typeof retainedAsset>>,
    ) {
      const actor = actors[1]!;
      if (operation === "preview feed")
        return media(database).previewFeed(actor, tripId, "0");
      if (operation === "preview grant")
        return media(database).previewDownload(actor, asset.assetId);
      if (operation === "original grant")
        return media(database).download(actor, asset.deliveryId, {
          variants: ["ORIGINAL"],
        });
      if (operation === "trip list")
        return createKyselyTripLifecycle(database, clock).list(actor);
      return continuity(database).read(actor, tripId);
    }
    async function ordinaryWriter(operation: string) {
      const actor = actors[0]!;
      if (operation === "media") return media().createUpload(actor, body());
      if (operation === "lifecycle")
        return createKyselyTripLifecycle(db, clock).change(actor, tripId, {
          action: "PAUSE",
          expectedVersion: 1,
        });
      if (operation === "continuity")
        return continuity().change(actor, tripId, {
          action: "SAVE_INVITE",
          expectedVersion: 1,
          inviteCode: "ABCDEFGH",
        });
      return createKyselyTripUnitOfWork(db).run(async (tx) => {
        const trip = await tx.lockTrip(tripId);
        expect(trip).not.toBeNull();
        expect(await tx.reauthorizeForegroundActor(actor)).toMatchObject({
          kind: "ACTIVE",
        });
        await tx.updateTrip({
          ...trip!,
          version: trip!.version + 1,
          updatedAt: now,
        });
      });
    }

    it.each(
      ["media", "lifecycle", "continuity", "trip command"].flatMap(
        (operation) =>
          [0, 1].map((recipientIndex) => ({ operation, recipientIndex })),
      ),
    )(
      "allows $operation work while an actual push insert retains recipient $recipientIndex FK KEY SHARE",
      async ({ operation, recipientIndex }) => {
        const held = deferred();
        const release = deferred();
        const eventId = randomUUID();
        const holder = context.db.transaction().execute(async (tx) => {
          await tx
            .insertInto("outbox_events")
            .values({
              id: eventId,
              event_type: "trip.changed",
              aggregate_id: tripId,
              dedupe_key: `trip.changed:${tripId}:v1`,
              payload: { tripId, recipientSequences: [] },
              available_at: now,
              created_at: now,
              published_at: null,
              last_error: null,
            })
            .execute();
          await tx
            .insertInto("push_wakeups")
            .values({
              id: randomUUID(),
              event_id: eventId,
              trip_id: tripId,
              recipient_device_id: actors[recipientIndex]!.deviceId,
              recipient_user_id: actors[recipientIndex]!.userId,
              available_at: now,
              created_at: now,
              expires_at: new Date(now.getTime() + 60_000),
              lease_token: null,
              completed_at: null,
              outcome: null,
              last_error: null,
            })
            .execute();
          held.resolve();
          await release.promise;
        });
        try {
          await held.promise;
          await ordinaryWriter(operation);
          expect(
            await context.db.selectFrom("push_wakeups").select("id").execute(),
          ).toHaveLength(0);
        } finally {
          release.resolve();
          await holder;
        }
        expect(
          await context.db.selectFrom("push_wakeups").select("id").execute(),
        ).toHaveLength(1);
      },
    );

    it.each(["reserve", "commit"] as const)(
      "still excludes END while another actor performs %s, then applies END after commit",
      async (operation) => {
        const gate = rowGate("trips");
        const request = body();
        const prepared =
          operation === "commit"
            ? await media().createUpload(actors[1]!, request)
            : null;
        const writer =
          operation === "reserve"
            ? media(db.withPlugin(gate.plugin)).createUpload(
                actors[1]!,
                request,
              )
            : createKyselyMediaService(
                db.withPlugin(gate.plugin),
                {
                  ...store,
                  // Verified ciphertext metadata is fixed here; only DB ordering is under test.
                  inspect: async () => ({
                    bytes: "32",
                    checksum: request.objects[0].checksumSha256,
                    etag: "verified",
                  }),
                },
                clock,
              ).commit(actors[1]!, request.assetId, {
                uploadSessionId: prepared!.uploadSessionId,
                objects: [
                  { variant: "PREVIEW", etag: "verified" },
                  { variant: "ORIGINAL", etag: "verified" },
                ],
              });
        try {
          await gate.entered;
          await expect(
            createKyselyTripLifecycle(db, clock).change(actors[0]!, tripId, {
              action: "END",
              expectedVersion: 1,
            }),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          gate.release();
          await writer;
        }
        const ended = await createKyselyTripLifecycle(db, clock).change(
          actors[0]!,
          tripId,
          { action: "END", expectedVersion: 1 },
        );
        expect(ended.status).toBe("ENDING");
        expect(
          await context.db.selectFrom("upload_sessions").select("id").execute(),
        ).toHaveLength(1);
        expect(
          await context.db.selectFrom("assets").select("id").execute(),
        ).toHaveLength(operation === "commit" ? 1 : 0);
        await expect(
          media().createUpload(actors[1]!, {
            ...body(),
            capturedAt: new Date(now.getTime() + 1_000).toISOString(),
          }),
        ).rejects.toMatchObject({ kind: "TRIP_STATE_CONFLICT" });
      },
    );

    it.each(["user", "device"] as const)(
      "preserves the %s revocation fence while issuing a reservation",
      async (target) => {
        const gate = rowGate("devices");
        const actor = actors[0]!;
        const reservation = media(db.withPlugin(gate.plugin)).createUpload(
          actor,
          body(),
        );
        async function revoke() {
          await db.transaction().execute(async (tx) => {
            if (target === "user")
              await tx
                .updateTable("users")
                .set({ suspended_at: now })
                .where("id", "=", actor.userId)
                .execute();
            else
              await tx
                .updateTable("devices")
                .set({ revoked_at: now })
                .where("id", "=", actor.deviceId)
                .execute();
          });
        }
        try {
          await gate.entered;
          await expect(revoke()).rejects.toMatchObject({ code: "55P03" });
        } finally {
          gate.release();
          await reservation;
        }
        await revoke();
        await expect(media().createUpload(actor, body())).rejects.toMatchObject(
          { kind: "AUTH_INVALID" },
        );
        expect(
          await context.db.selectFrom("upload_sessions").select("id").execute(),
        ).toHaveLength(1);
      },
    );

    it("serializes ten duplicate reservations into one durable session and two immutable objects", async () => {
      const request = body();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          media().createUpload(actors[0]!, request),
        ),
      );
      expect(
        new Set(results.map((result) => result.uploadSessionId)).size,
      ).toBe(1);
      expect(
        await context.db.selectFrom("upload_sessions").select("id").execute(),
      ).toHaveLength(1);
      expect(
        await context.db.selectFrom("upload_objects").selectAll().execute(),
      ).toHaveLength(2);
    });

    it.each<PureRead>([
      "preview feed",
      "preview grant",
      "original grant",
      "trip list",
      "continuity",
    ])(
      "allows parallel %s readers while preserving caller revocation exclusion",
      async (operation) => {
        const asset = await retainedAsset();
        const gate = rowGate(operation === "trip list" ? "devices" : "trips");
        const first = read(operation, db.withPlugin(gate.plugin), asset);
        try {
          await gate.entered;
          expect(await read(operation, db, asset)).toBeDefined();
          await expect(
            db
              .updateTable("devices")
              .set({ revoked_at: now })
              .where("id", "=", actors[1]!.deviceId)
              .execute(),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          gate.release();
          await first;
        }
        await db
          .updateTable("devices")
          .set({ revoked_at: now })
          .where("id", "=", actors[1]!.deviceId)
          .execute();
        await expect(read(operation, db, asset)).rejects.toMatchObject({
          kind: "AUTH_INVALID",
        });
      },
    );
    it.each<PureRead>([
      "preview feed",
      "preview grant",
      "original grant",
      "continuity",
    ])(
      "keeps END excluded while %s issues its authorized snapshot",
      async (operation) => {
        const asset = await retainedAsset();
        const gate = rowGate("trips");
        const first = read(operation, db.withPlugin(gate.plugin), asset);
        try {
          await gate.entered;
          await expect(
            createKyselyTripLifecycle(db, clock).change(actors[0]!, tripId, {
              action: "END",
              expectedVersion: 1,
            }),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          gate.release();
          await first;
        }
        expect(
          await createKyselyTripLifecycle(db, clock).change(
            actors[0]!,
            tripId,
            { action: "END", expectedVersion: 1 },
          ),
        ).toMatchObject({ status: "ENDING", version: 2 });
      },
    );
  },
);
