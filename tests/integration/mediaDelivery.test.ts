import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreateUploadSessionBody } from "@crewroll/contracts";
import { createKyselyMediaService } from "../../services/control-plane/src/db/media/kyselyMediaService.js";
import { createFileCiphertextStore } from "../../services/control-plane/src/platform/localMedia/fileCiphertextStore.js";
import { createBackgroundDeviceAuthenticator } from "../../services/control-plane/src/modules/devices/index.js";
import { createKyselyDeviceUnitOfWork } from "../../services/control-plane/src/db/devices/kyselyDeviceUnitOfWork.js";
import { buildApp } from "../../services/control-plane/src/app/buildApp.js";
import { createTestDependencies } from "../../services/control-plane/test/support/fakes.js";
import type {
  CiphertextStore,
  MediaActor,
  MediaService,
} from "../../services/control-plane/src/modules/media/index.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

describe.sequential("durable encrypted photo delivery", () => {
  let context: PostgresTestContext;
  let service: MediaService;
  let now: Date;
  let tripId: string;
  let members: MediaActor[];
  let outsider: MediaActor;
  let store: CiphertextStore;
  let objects: Map<string, { bytes: string; checksum: string; etag: string }>;
  let body: CreateUploadSessionBody;
  let fixtures: ReturnType<typeof createIdentityTripFixtures>;

  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  afterAll(async () => {
    await context?.stop();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
    now = new Date("2026-08-29T08:01:00.000Z");
    objects = new Map();
    store = {
      async upload(object) {
        return `https://media.example/${object.key}`;
      },
      async inspect(key) {
        return objects.get(key) ?? null;
      },
      async download(key) {
        return `https://media.example/${key}`;
      },
      async delete(key) {
        objects.delete(key);
      },
    };
    service = createKyselyMediaService(context.db, store, { now: () => now });
    fixtures = createIdentityTripFixtures(context.db);
    members = [];
    const owner = await fixtures.user();
    const trip = await fixtures.trip(owner.id, {
      id: "01990000-0000-7000-8000-000000000001",
      state: "ACTIVE",
      started_at: new Date("2026-08-29T08:00:00.000Z"),
    });
    tripId = trip.id;
    for (let i = 0; i < 4; i++) {
      const user = i === 0 ? owner : await fixtures.user();
      const device = await fixtures.device(user.id);
      await fixtures.member(tripId, user.id, device.id, {
        role: i === 0 ? "OWNER" : "MEMBER",
        key_epoch: 1,
      });
      members.push({ userId: user.id, deviceId: device.id });
    }
    const other = await fixtures.user();
    outsider = {
      userId: other.id,
      deviceId: (await fixtures.device(other.id)).id,
    };
    const checksum = createHash("sha256")
      .update("opaque encrypted bytes")
      .digest("base64");
    body = {
      tripId,
      assetId: randomUUID(),
      sourceAssetKey: `src_${"A".repeat(32)}`,
      capturedAt: now.toISOString(),
      formatVersion: 1,
      keyEpoch: 1,
      encryptedManifest: Buffer.from("encrypted manifest").toString("base64"),
      objects: [
        { variant: "PREVIEW", ciphertextBytes: "22", checksumSha256: checksum },
        {
          variant: "ORIGINAL",
          ciphertextBytes: "22",
          checksumSha256: checksum,
        },
      ],
    };
  });
  async function uploaded() {
    const session = await service.createUpload(members[0]!, body);
    for (const object of session.objects)
      objects.set(new URL(object.url).pathname.slice(1), {
        bytes: object.requiredHeaders["content-length"],
        checksum: object.requiredHeaders["x-amz-checksum-sha256"],
        etag: `"${object.variant}"`,
      });
    return {
      uploadSessionId: session.uploadSessionId,
      objects: [
        { variant: "PREVIEW" as const, etag: '"PREVIEW"' },
        { variant: "ORIGINAL" as const, etag: '"ORIGINAL"' },
      ] as [
        { variant: "PREVIEW"; etag: string },
        { variant: "ORIGINAL"; etag: string },
      ],
    };
  }
  const lifecycle = () =>
    createKyselyTripLifecycle(context.db, { now: () => now });
  async function command(
    index: number,
    action: "PAUSE" | "RESUME" | "LEAVE" | "LEAVE_NOW" | "END",
  ) {
    const state = await lifecycle().read(members[index]!, tripId);
    return lifecycle().change(members[index]!, tripId, {
      action,
      expectedVersion: state.version,
    });
  }
  it("pauses only the sender and never backfills paused captures after resume", async () => {
    await command(0, "PAUSE");
    await expect(service.createUpload(members[0]!, body)).rejects.toMatchObject(
      { kind: "TRIP_STATE_CONFLICT" },
    );
    await expect(
      service.createUpload(members[1]!, body),
    ).resolves.toMatchObject({ assetId: body.assetId });
    now = new Date(now.getTime() + 5000);
    await command(0, "RESUME");
    const pausedPhoto = {
      ...body,
      assetId: randomUUID(),
      sourceAssetKey: "src_" + "B".repeat(32),
    };
    await expect(
      service.createUpload(members[0]!, pausedPhoto),
    ).rejects.toMatchObject({ kind: "TRIP_STATE_CONFLICT" });
    await expect(
      service.createUpload(members[0]!, {
        ...pausedPhoto,
        capturedAt: now.toISOString(),
      }),
    ).resolves.toMatchObject({ assetId: pausedPhoto.assetId });
  });
  it("freezes a leaving member's queue, waits for originals and releases their active slot only after saving", async () => {
    await fixtures.activeTrip(members[1]!.userId, tripId);
    const upload = await uploaded();
    const leaving = await command(1, "LEAVE");
    expect(leaving).toMatchObject({
      participation: "LEAVING",
      pendingUploads: 1,
    });
    expect(
      (await lifecycle().drained(members[1]!, tripId, leaving.version))
        .participation,
    ).toBe("LEAVING");
    expect(
      await context.db
        .selectFrom("user_active_trips")
        .selectAll()
        .where("user_id", "=", members[1]!.userId)
        .execute(),
    ).toHaveLength(1);
    await service.commit(members[0]!, body.assetId, upload);
    now = new Date(now.getTime() + 5000);
    const later = {
      ...body,
      assetId: randomUUID(),
      sourceAssetKey: "src_" + "C".repeat(32),
      capturedAt: now.toISOString(),
    };
    const laterUpload = await service.createUpload(members[2]!, later);
    now = new Date(now.getTime() + 1000);
    await command(0, "END"); // A later host end must not expand an earlier personal departure.
    // Even a guessed asset ID must not grant a departed recipient future previews.
    for (const object of laterUpload.objects)
      objects.set(new URL(object.url).pathname.slice(1), {
        bytes: object.requiredHeaders["content-length"],
        checksum: object.requiredHeaders["x-amz-checksum-sha256"],
        etag: `"${object.variant}"`,
      });
    await service.publishPreview(members[2]!, later.assetId, {
      uploadSessionId: laterUpload.uploadSessionId,
      etag: '"PREVIEW"',
    });
    await expect(
      service.previewDownload(members[1]!, later.assetId),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await service.commit(members[2]!, later.assetId, {
      uploadSessionId: laterUpload.uploadSessionId,
      objects: [
        { variant: "PREVIEW", etag: '"PREVIEW"' },
        { variant: "ORIGINAL", etag: '"ORIGINAL"' },
      ],
    });
    const pending = await service.pending(members[1]!);
    expect(pending.items.map((item) => item.assetId)).toEqual([body.assetId]);
    await service.saved(
      members[1]!,
      pending.items[0]!.deliveryId,
      randomUUID(),
      { assetId: body.assetId, savedAt: now.toISOString(), engineRevision: 1 },
    );
    expect((await lifecycle().read(members[1]!, tripId)).participation).toBe(
      "LEFT",
    );
    expect(
      await context.db
        .selectFrom("user_active_trips")
        .selectAll()
        .where("user_id", "=", members[1]!.userId)
        .execute(),
    ).toHaveLength(0);
    expect((await lifecycle().list(members[1]!)).items[0]).toMatchObject({
      participation: "LEFT",
      savedPhotoCount: 1,
    });
    expect((await lifecycle().list(outsider)).items).toHaveLength(0);
  });
  it("leave now revokes media access without fabricating receipts or removing other people's queued photos", async () => {
    await service.commit(members[0]!, body.assetId, await uploaded());
    const pending = (await service.pending(members[1]!)).items[0]!;
    await command(1, "LEAVE_NOW");
    await expect(
      service.download(members[1]!, pending.deliveryId, {
        variants: ["ORIGINAL"],
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(
      await context.db
        .selectFrom("receipts")
        .selectAll()
        .where("delivery_id", "=", pending.deliveryId)
        .execute(),
    ).toHaveLength(0);
    expect((await service.pending(members[2]!)).items).toHaveLength(1);
    expect(objects.size).toBe(2);
  });
  it("only the host ends a trip and ending waits for offline phones' final capture pass", async () => {
    await expect(command(1, "END")).rejects.toMatchObject({
      kind: "TRIP_OWNER_REQUIRED",
    });
    const ended = await command(0, "END");
    expect(ended.status).toBe("ENDING");
    expect(
      (await lifecycle().drained(members[0]!, tripId, ended.version))
        .participation,
    ).toBe("LEAVING");
    now = new Date(now.getTime() + 1000);
    await expect(
      service.createUpload(members[1]!, {
        ...body,
        capturedAt: now.toISOString(),
      }),
    ).rejects.toMatchObject({ kind: "TRIP_STATE_CONFLICT" });
    for (const member of members.slice(1)) {
      const state = await lifecycle().read(member, tripId);
      await lifecycle().drained(member, tripId, state.version);
    }
    for (const member of members) await lifecycle().read(member, tripId);
    expect((await lifecycle().read(members[0]!, tripId)).status).toBe(
      "COMPLETE",
    );
  });
  it("ends automatically after the final participant leaves, and rejects outsiders", async () => {
    await expect(lifecycle().read(outsider, tripId)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    for (let index = 0; index < members.length - 1; index++)
      expect((await command(index, "LEAVE_NOW")).status).toBe("ACTIVE");
    expect((await command(members.length - 1, "LEAVE_NOW")).status).toBe(
      "INCOMPLETE_EXPIRED",
    );
  });
  it("does not let waiting trips starve the expiry batch", async () => {
    const endsAt = new Date(now.getTime() - 1000);
    const startedAt = new Date(now.getTime() - 60_000);
    const hardDeleteAt = new Date(endsAt.getTime() + 7 * 86_400_000);
    for (let i = 0; i < 100; i++) {
      await fixtures.trip(members[0]!.userId, {
        state: "ENDING",
        started_at: startedAt,
        ending_started_at: endsAt,
        ends_at: endsAt,
        hard_delete_at: hardDeleteAt,
      });
    }
    const expiring = await fixtures.trip(members[0]!.userId, {
      state: "ACTIVE",
      started_at: startedAt,
      ends_at: endsAt,
      hard_delete_at: hardDeleteAt,
    });
    await lifecycle().expire();
    expect(
      await context.db
        .selectFrom("trips")
        .select("state")
        .where("id", "=", expiring.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "ENDING" });
  });
  it("rejects stale simultaneous lifecycle choices", async () => {
    const state = await lifecycle().read(members[0]!, tripId);
    const outcomes = await Promise.allSettled(
      ["PAUSE", "LEAVE"].map((action) =>
        lifecycle().change(members[0]!, tripId, {
          action: action as "PAUSE" | "LEAVE",
          expectedVersion: state.version,
        }),
      ),
    );
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { kind: "VERSION_CONFLICT" } });
  });
  it("publishes a verified preview to five phones before any original upload, without receipts", async () => {
    const user = await fixtures.user();
    const device = await fixtures.device(user.id);
    await fixtures.member(tripId, user.id, device.id, {
      role: "MEMBER",
      key_epoch: 1,
    });
    members.push({ userId: user.id, deviceId: device.id });
    const session = await service.createUpload(members[0]!, body);
    const preview = session.objects[0];
    objects.set(new URL(preview.url).pathname.slice(1), {
      bytes: preview.requiredHeaders["content-length"],
      checksum: preview.requiredHeaders["x-amz-checksum-sha256"],
      etag: '"PREVIEW"',
    });
    const command = {
      uploadSessionId: session.uploadSessionId,
      etag: '"PREVIEW"',
    };
    const published = await service.publishPreview(
      members[0]!,
      body.assetId,
      command,
    );
    expect(
      await service.publishPreview(members[0]!, body.assetId, command),
    ).toEqual(published);
    for (const member of members) {
      const feed = await service.previewFeed(member, tripId, "0");
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0]?.download.object.variant).toBe("PREVIEW");
      const source = await context.db
        .selectFrom("trip_members")
        .select("id")
        .where("trip_id", "=", tripId)
        .where("participating_device_id", "=", members[0]!.deviceId)
        .executeTakeFirstOrThrow();
      expect(feed.items[0]?.download.sourceMembershipId).toBe(source.id);
      expect(feed.items[0]?.download.encryptedManifest).toBe(
        body.encryptedManifest,
      );
      expect(
        (await service.previewFeed(member, tripId, feed.nextCursor)).items,
      ).toEqual([]);
      expect(await service.previewDownload(member, body.assetId)).toEqual(
        feed.items[0]?.download,
      );
      expect((await service.pending(member)).items).toEqual([]);
    }
    expect(
      await context.db.selectFrom("assets").selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await context.db.selectFrom("receipts").selectAll().execute(),
    ).toHaveLength(0);
    expect(await service.cleanup()).toBe(0);
    expect(objects.size).toBe(1);
    await expect(
      service.previewFeed(outsider, tripId, "0"),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(
      service.previewDownload(outsider, body.assetId),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(
      service.publishPreview(members[1]!, body.assetId, command),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
  it("rejects unverified previews and stale authorization, and expires abandoned previews", async () => {
    const session = await service.createUpload(members[0]!, body);
    const command = {
      uploadSessionId: session.uploadSessionId,
      etag: '"PREVIEW"',
    };
    await expect(
      service.publishPreview(members[0]!, body.assetId, command),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    await expect(
      service.previewDownload(members[1]!, body.assetId),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    const uploadedObjects = await uploaded();
    await service.publishPreview(members[0]!, body.assetId, command);
    await expect(
      service.publishPreview(members[0]!, body.assetId, {
        ...command,
        etag: '"wrong"',
      }),
    ).rejects.toMatchObject({ kind: "IDEMPOTENCY_CONFLICT" });
    await context.db
      .updateTable("devices")
      .set({ revoked_at: now })
      .where("id", "=", members[1]!.deviceId)
      .execute();
    await expect(
      service.previewFeed(members[1]!, tripId, "0"),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    // Full original publication remains separate and backwards-compatible.
    await service.commit(members[0]!, body.assetId, uploadedObjects);
    expect((await service.pending(members[2]!)).items).toHaveLength(1);
    const deadline = await context.db
      .selectFrom("trips")
      .select("hard_delete_at")
      .where("id", "=", tripId)
      .executeTakeFirstOrThrow();
    now = deadline.hard_delete_at;
    await service.cleanup();
    await expect(
      service.previewDownload(members[2]!, body.assetId),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(objects.size).toBe(0);
  });
  it("fans out to four phones atomically, and purges only after every receipt", async () => {
    const commit = await uploaded();
    const result = await service.commit(members[0]!, body.assetId, commit);
    expect(await service.commit(members[0]!, body.assetId, commit)).toEqual(
      result,
    );
    expect((await service.pending(members[0]!)).items).toEqual([]);
    expect(await service.cleanup()).toBe(0);
    for (const member of members.slice(1)) {
      const delivery = (await service.pending(member)).items[0]!;
      const download = await service.download(member, delivery.deliveryId, {
        variants: ["PREVIEW", "ORIGINAL"],
      });
      expect(download.encryptedManifest).toBe(body.encryptedManifest);
      expect(download.objects).toHaveLength(2);
      const receipt = {
        assetId: body.assetId,
        savedAt: now.toISOString(),
        engineRevision: 1,
      };
      const accepted = await service.saved(
        member,
        delivery.deliveryId,
        randomUUID(),
        receipt,
      );
      expect(
        await service.saved(member, delivery.deliveryId, randomUUID(), receipt),
      ).toEqual(accepted);
      expect((await service.pending(member)).items).toEqual([]);
    }
    expect(await service.cleanup()).toBe(0); // outstanding PUT grants remain valid
    now = new Date(now.getTime() + 900_000);
    const replay = await service.createUpload(members[0]!, body);
    expect(new Date(replay.expiresAt).getTime()).toBeLessThanOrEqual(
      now.getTime(),
    );
    expect(await service.cleanup()).toBe(1);
    expect(objects.size).toBe(0);
    expect(await service.cleanup()).toBe(0);
    expect(
      await context.db.selectFrom("deliveries").selectAll().execute(),
    ).toHaveLength(4);
    expect(
      await context.db.selectFrom("receipts").selectAll().execute(),
    ).toHaveLength(4);
  });
  it("does not acknowledge on download and recovers after process restart", async () => {
    await service.commit(members[0]!, body.assetId, await uploaded());
    const delivery = (await service.pending(members[1]!)).items[0]!;
    await service.download(members[1]!, delivery.deliveryId, {
      variants: ["ORIGINAL"],
    });
    const restarted = createKyselyMediaService(context.db, store, {
      now: () => now,
    });
    expect((await restarted.pending(members[1]!)).items).toEqual([delivery]);
    expect(await restarted.cleanup()).toBe(0);
  });
  it("drains a 105-photo backlog across ten member phones without skipping pending deliveries", async () => {
    for (let index = 4; index < 10; index++) {
      const user = await fixtures.user();
      const device = await fixtures.device(user.id);
      await fixtures.member(tripId, user.id, device.id, {
        role: "MEMBER",
        key_epoch: 1,
      });
      members.push({ userId: user.id, deviceId: device.id });
    }
    for (let index = 0; index < 105; index++) {
      body = {
        ...body,
        assetId: randomUUID(),
        sourceAssetKey: `src_${String(index).padStart(32, "0")}`,
      };
      await service.commit(members[0]!, body.assetId, await uploaded());
    }
    expect(
      await context.db.selectFrom("deliveries").selectAll().execute(),
    ).toHaveLength(1050);
    const receiver = members[1]!;
    const first = (await service.pending(receiver)).items;
    expect(first).toHaveLength(100);
    expect((await service.pending(receiver)).items).toEqual(first);
    const seen = new Set<string>();
    for (const expected of [100, 5]) {
      const page = (await service.pending(receiver)).items;
      expect(page).toHaveLength(expected);
      for (const delivery of page) {
        expect(seen.has(delivery.deliveryId)).toBe(false);
        seen.add(delivery.deliveryId);
        await service.saved(receiver, delivery.deliveryId, randomUUID(), {
          assetId: delivery.assetId,
          savedAt: now.toISOString(),
          engineRevision: seen.size,
        });
      }
    }
    expect(seen.size).toBe(105);
    expect((await service.pending(receiver)).items).toEqual([]);
    expect((await service.pending(members[2]!)).items).toHaveLength(100);
    expect(await service.cleanup()).toBe(0);
  });
  it("rejects missing, corrupt, or wrong-size uploads without partial fan-out", async () => {
    const commit = await uploaded();
    const key = [...objects.keys()][0]!;
    const valid = objects.get(key)!;
    for (const invalid of [
      null,
      { ...valid, checksum: "wrong" },
      { ...valid, bytes: "21" },
      { ...valid, etag: '"different"' },
    ]) {
      if (invalid) objects.set(key, invalid);
      else objects.delete(key);
      await expect(
        service.commit(members[0]!, body.assetId, commit),
      ).rejects.toMatchObject({ kind: "CONFLICT" });
      expect(
        await context.db.selectFrom("assets").selectAll().execute(),
      ).toEqual([]);
      expect(
        await context.db.selectFrom("deliveries").selectAll().execute(),
      ).toEqual([]);
    }
  });
  it("rejects outsiders, cross-device receipts, and revoked receivers", async () => {
    await expect(service.createUpload(outsider, body)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await service.commit(members[0]!, body.assetId, await uploaded());
    const delivery = (await service.pending(members[1]!)).items[0]!;
    await expect(
      service.download(outsider, delivery.deliveryId, {
        variants: ["ORIGINAL"],
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(
      service.saved(members[2]!, delivery.deliveryId, randomUUID(), {
        assetId: body.assetId,
        savedAt: now.toISOString(),
        engineRevision: 1,
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await context.db
      .updateTable("devices")
      .set({ revoked_at: now })
      .where("id", "=", members[1]!.deviceId)
      .execute();
    await expect(
      service.download(members[1]!, delivery.deliveryId, {
        variants: ["ORIGINAL"],
      }),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
  });
  it("renews identical interrupted uploads but rejects conflicting source reuse", async () => {
    const first = await service.createUpload(members[0]!, body);
    now = new Date(now.getTime() + 16 * 60_000);
    const retry = await service.createUpload(members[0]!, body);
    expect(retry.uploadSessionId).toBe(first.uploadSessionId);
    expect(retry.objects).toEqual(first.objects);
    expect(retry.expiresAt).not.toBe(first.expiresAt);
    await expect(
      service.createUpload(members[0]!, { ...body, encryptedManifest: "YWJj" }),
    ).rejects.toMatchObject({ kind: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.createUpload(members[0]!, { ...body, assetId: randomUUID() }),
    ).rejects.toMatchObject({ kind: "IDEMPOTENCY_CONFLICT" });
  });
  it("serializes concurrent commits into one asset and one delivery per member", async () => {
    const commit = await uploaded();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.commit(members[0]!, body.assetId, commit),
      ),
    );
    expect(
      results.every((item) => item.sequence === results[0]!.sequence),
    ).toBe(true);
    expect(
      await context.db.selectFrom("assets").selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await context.db.selectFrom("deliveries").selectAll().execute(),
    ).toHaveLength(4);
  });
  it("expires inaccessible ciphertext at the hard deadline", async () => {
    await service.commit(members[0]!, body.assetId, await uploaded());
    const trip = await context.db
      .selectFrom("trips")
      .select("hard_delete_at")
      .where("id", "=", tripId)
      .executeTakeFirstOrThrow();
    now = trip.hard_delete_at;
    expect((await service.pending(members[1]!)).items).toEqual([]);
    expect(await service.cleanup()).toBe(1);
    expect(objects.size).toBe(0);
    expect(
      (
        await context.db
          .selectFrom("assets")
          .select("state")
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("EXPIRED");
  });
  it("rejects photos outside the active capture window", async () => {
    await expect(
      service.createUpload(members[0]!, {
        ...body,
        capturedAt: "2026-08-29T07:59:59.000Z",
      }),
    ).rejects.toMatchObject({ kind: "INVALID_REQUEST" });
    await expect(
      service.createUpload(members[0]!, {
        ...body,
        capturedAt: "2026-08-30T08:00:00.000Z",
      }),
    ).rejects.toMatchObject({ kind: "INVALID_REQUEST" });
  });
  it("purges abandoned uploads at the hard deadline without breaking live resumability", async () => {
    await uploaded();
    now = new Date(now.getTime() + 900_000);
    expect(await service.cleanup()).toBe(0);
    expect(objects.size).toBe(2);
    const renewed = await service.createUpload(members[0]!, body);
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(
      now.getTime(),
    );
    now = (
      await context.db
        .selectFrom("trips")
        .select("hard_delete_at")
        .where("id", "=", tripId)
        .executeTakeFirstOrThrow()
    ).hard_delete_at;
    expect(await service.cleanup()).toBe(1);
    expect(objects.size).toBe(0);
    expect(await service.cleanup()).toBe(0);
    expect(
      (
        await context.db
          .selectFrom("upload_sessions")
          .select("state")
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("EXPIRED");
  });
  it("runs the actual authenticated HTTP upload, download and receipt path with disk-backed ciphertext", async () => {
    const fifth = await fixtures.user();
    const fifthDevice = await fixtures.device(fifth.id);
    await fixtures.member(tripId, fifth.id, fifthDevice.id);
    members.push({ userId: fifth.id, deviceId: fifthDevice.id });
    const directory = await mkdtemp(
      path.join(tmpdir(), "crewroll-http-media-"),
    );
    const local = await createFileCiphertextStore({
      directory,
      origin: "http://127.0.0.1:8787",
      signingKey: randomBytes(32),
      nodeEnvironment: "test",
      now: () => now,
    });
    const clock = { now: () => now };
    const realService = createKyselyMediaService(
      context.db,
      local.store,
      clock,
    );
    const tokens = members.map(
      () => `crb_${randomBytes(32).toString("base64url")}`,
    );
    for (const [index, member] of members.entries())
      await context.db
        .updateTable("devices")
        .set({
          background_credential_hash: createHash("sha256")
            .update(tokens[index]!)
            .digest(),
        })
        .where("id", "=", member.deviceId)
        .execute();
    const app = buildApp({
      ...createTestDependencies().dependencies,
      clock,
      media: {
        service: realService,
        localObjects: local.gateway,
        authenticator: createBackgroundDeviceAuthenticator({
          clock,
          unitOfWork: createKyselyDeviceUnitOfWork(context.db),
        }),
      },
    });
    const headers = (index: number) => ({
      authorization: `Bearer ${tokens[index]!}`,
      "x-crewroll-device-id": members[index]!.deviceId,
      "idempotency-key": randomUUID(),
    });
    const ciphertext = randomBytes(131_071);
    body.objects = ["PREVIEW", "ORIGINAL"].map((variant) => ({
      variant,
      ciphertextBytes: String(ciphertext.length),
      checksumSha256: createHash("sha256").update(ciphertext).digest("base64"),
    })) as CreateUploadSessionBody["objects"];
    try {
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/v1/deliveries/pending",
      });
      expect(unauthenticated.statusCode).toBe(401);
      const upload = await app.inject({
        method: "POST",
        url: "/v1/assets/upload-sessions",
        headers: headers(0),
        payload: body,
      });
      expect(upload.statusCode, upload.body).toBe(201);
      const session = upload.json<{
        uploadSessionId: string;
        objects: {
          url: string;
          variant: "PREVIEW" | "ORIGINAL";
          requiredHeaders: Record<string, string>;
        }[];
      }>();
      const uploadedObjects: {
        variant: "PREVIEW" | "ORIGINAL";
        etag: string;
      }[] = [];
      for (const object of session.objects) {
        const put = await app.inject({
          method: "PUT",
          url: new URL(object.url).pathname + new URL(object.url).search,
          headers: object.requiredHeaders,
          payload: ciphertext,
        });
        expect(put.statusCode, put.body).toBe(200);
        uploadedObjects.push({
          variant: object.variant,
          etag: String(put.headers.etag),
        });
        if (object.variant === "PREVIEW") {
          const published = await app.inject({
            method: "POST",
            url: `/v1/assets/${body.assetId}/preview`,
            headers: headers(0),
            payload: {
              uploadSessionId: session.uploadSessionId,
              etag: String(put.headers.etag),
            },
          });
          expect(published.statusCode, published.body).toBe(200);
          await Promise.all(
            members.map(async (_member, index) => {
              const feed = await app.inject({
                method: "GET",
                url: `/v1/trips/${tripId}/previews`,
                headers: headers(index),
              });
              expect(feed.statusCode, feed.body).toBe(200);
              expect(feed.headers["cache-control"]).toBe("no-store");
              const page = feed.json<{
                items: { download: { object: { url: string } } }[];
                nextCursor: string;
              }>();
              expect(page.items).toHaveLength(1);
              const target = new URL(page.items[0]!.download.object.url);
              const bytes = await app.inject({
                method: "GET",
                url: target.pathname + target.search,
              });
              expect(bytes.statusCode).toBe(200);
              expect(bytes.rawPayload).toEqual(ciphertext);
              const replay = await app.inject({
                method: "GET",
                url: `/v1/trips/${tripId}/previews?after=${page.nextCursor}`,
                headers: headers(index),
              });
              expect(replay.json().items).toEqual([]);
            }),
          );
          expect(
            await context.db.selectFrom("assets").selectAll().execute(),
          ).toHaveLength(0);
          expect(
            await context.db.selectFrom("receipts").selectAll().execute(),
          ).toHaveLength(0);
          const invalid = await app.inject({
            method: "GET",
            url: `/v1/trips/${tripId}/previews?after=9223372036854775808`,
            headers: headers(0),
          });
          expect(invalid.statusCode).toBe(400);
        }
      }
      const committed = await app.inject({
        method: "POST",
        url: `/v1/assets/${body.assetId}/commit`,
        headers: headers(0),
        payload: {
          uploadSessionId: session.uploadSessionId,
          objects: uploadedObjects,
        },
      });
      expect(committed.statusCode, committed.body).toBe(200);
      for (let index = 1; index < members.length; index++) {
        const pending = await app.inject({
          method: "GET",
          url: "/v1/deliveries/pending",
          headers: headers(index),
        });
        expect(pending.statusCode, pending.body).toBe(200);
        const delivery = pending.json<{ items: { deliveryId: string }[] }>()
          .items[0]!;
        const download = await app.inject({
          method: "POST",
          url: `/v1/deliveries/${delivery.deliveryId}/download-session`,
          headers: headers(index),
          payload: { variants: ["ORIGINAL"] },
        });
        expect(download.statusCode, download.body).toBe(200);
        const signed = download.json<{ objects: { url: string }[] }>()
          .objects[0]!.url;
        const bytes = await app.inject({
          method: "GET",
          url: new URL(signed).pathname + new URL(signed).search,
        });
        expect(bytes.statusCode, bytes.body).toBe(200);
        expect(bytes.rawPayload).toEqual(ciphertext);
        const saved = await app.inject({
          method: "POST",
          url: `/v1/deliveries/${delivery.deliveryId}/saved-receipt`,
          headers: headers(index),
          payload: {
            assetId: body.assetId,
            savedAt: now.toISOString(),
            engineRevision: 1,
          },
        });
        expect(saved.statusCode, saved.body).toBe(200);
      }
      expect(await realService.cleanup()).toBe(0);
      now = new Date(now.getTime() + 900_000);
      expect(await realService.cleanup()).toBe(1);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
