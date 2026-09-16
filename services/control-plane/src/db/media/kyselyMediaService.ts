import {
  CommitAssetBodySchema,
  CreateDownloadSessionBodySchema,
  CreateUploadSessionBodySchema,
  SavedReceiptBodySchema,
  PublishPreviewBodySchema,
  type PreviewDownloadResponse,
  type CommitAssetResponse,
  type CreateUploadSessionBody,
  type UploadSessionResponse,
} from "@crewroll/contracts";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { Kysely, Transaction } from "kysely";

import type {
  CiphertextStore,
  MediaActor,
  MediaService,
} from "../../modules/media/ports/mediaService.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Clock } from "../../shared/time/clock.js";
import type { Database, ObjectVariant } from "../schema/tables.js";

type Tx = Transaction<Database>;
const variants = ["PREVIEW", "ORIGINAL"] as const;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function requireBody(schema: TSchema, value: unknown): void {
  if (!Value.Check(schema, value)) throw new DomainError("INVALID_REQUEST");
}

export function createKyselyMediaService(
  db: Kysely<Database>,
  store: CiphertextStore,
  clock: Clock,
): MediaService {
  const randomUUID = () => crypto.randomUUID();
  // Match device/trip command lock order. Recheck authorization inside every
  // mutation, so revocation cannot race a previously authenticated request.
  async function authorize(tx: Tx, actor: MediaActor) {
    const user = await tx
      .selectFrom("users")
      .selectAll()
      .where("id", "=", actor.userId)
      .forUpdate()
      .executeTakeFirst();
    const device = await tx
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", actor.deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !user ||
      user.deleted_at ||
      !device ||
      device.user_id !== actor.userId ||
      device.revoked_at ||
      device.background_credential_expires_at <= clock.now()
    ) {
      throw new DomainError("AUTH_INVALID");
    }
  }
  async function tripFor(tx: Tx, actor: MediaActor, tripId: string) {
    const trip = await tx
      .selectFrom("trips")
      .selectAll()
      .where("id", "=", tripId)
      .forUpdate()
      .executeTakeFirst();
    const member = await tx
      .selectFrom("trip_members")
      .selectAll()
      .where("trip_id", "=", tripId)
      .where("participating_device_id", "=", actor.deviceId)
      .where("user_id", "=", actor.userId)
      .where("state", "=", "ACTIVE")
      .executeTakeFirst();
    if (!trip || !member || member.key_epoch !== 1)
      throw new DomainError("NOT_FOUND");
    if (
      !trip.started_at ||
      !["ACTIVE", "ENDING"].includes(trip.state) ||
      trip.hard_delete_at <= clock.now()
    )
      throw new DomainError("TRIP_STATE_CONFLICT");
    return trip;
  }
  async function ownedDelivery(tx: Tx, actor: MediaActor, deliveryId: string) {
    const delivery = await tx
      .selectFrom("deliveries")
      .selectAll()
      .where("id", "=", deliveryId)
      .where("recipient_device_id", "=", actor.deviceId)
      .where("recipient_user_id", "=", actor.userId)
      .executeTakeFirst();
    if (!delivery) throw new DomainError("NOT_FOUND");
    const reference = await tx
      .selectFrom("assets")
      .select("trip_id")
      .where("id", "=", delivery.asset_id)
      .executeTakeFirstOrThrow();
    const trip = await tripFor(tx, actor, reference.trip_id);
    const asset = await tx
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", delivery.asset_id)
      .executeTakeFirstOrThrow();
    return { delivery, asset, trip };
  }
  async function commitResult(
    tx: Tx,
    assetId: string,
    deviceId: string,
  ): Promise<CommitAssetResponse> {
    const asset = await tx
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", assetId)
      .executeTakeFirstOrThrow();
    const event = await tx
      .selectFrom("inbox_events")
      .select("sequence")
      .where("aggregate_id", "=", assetId)
      .where("recipient_device_id", "=", deviceId)
      .where("event_type", "=", "ASSET_COMMITTED")
      .executeTakeFirstOrThrow();
    return {
      assetId,
      committedAt: asset.committed_at.toISOString(),
      sequence: event.sequence,
    };
  }
  async function uploadResponse(
    tx: Tx,
    sessionId: string,
  ): Promise<UploadSessionResponse> {
    const session = await tx
      .selectFrom("upload_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const objects = await tx
      .selectFrom("upload_objects")
      .selectAll()
      .where("upload_session_id", "=", sessionId)
      .execute();
    const signed = await Promise.all(
      variants.map(async (variant) => {
        const object = objects.find((item) => item.variant === variant)!;
        const checksum = b64(object.expected_ciphertext_sha256);
        return {
          variant,
          url: await store.upload(
            {
              key: object.s3_key,
              bytes: object.expected_ciphertext_bytes,
              checksum,
            },
            session.expires_at,
          ),
          requiredHeaders: {
            "content-length": object.expected_ciphertext_bytes,
            "content-type": "application/octet-stream" as const,
            "x-amz-checksum-sha256": checksum,
            "if-none-match": "*" as const,
          },
        };
      }),
    );
    return {
      uploadSessionId: session.id,
      assetId: session.client_asset_id,
      expiresAt: session.expires_at.toISOString(),
      objects: [
        { ...signed[0]!, variant: "PREVIEW" },
        { ...signed[1]!, variant: "ORIGINAL" },
      ],
    };
  }
  function fingerprint(body: CreateUploadSessionBody): string {
    return JSON.stringify([
      body.tripId,
      body.assetId,
      body.sourceAssetKey,
      body.formatVersion,
      body.keyEpoch,
      body.encryptedManifest,
      body.objects.map((object) => [
        object.variant,
        object.ciphertextBytes,
        object.checksumSha256,
      ]),
    ]);
  }

  async function previewGrant(row: {
    assetId: string;
    sourceMembershipId: string;
    encryptedManifest: Uint8Array;
    key: string;
    bytes: string;
    checksum: Uint8Array;
    hardDeleteAt: Date;
  }): Promise<PreviewDownloadResponse> {
    const expiresAt = new Date(
      Math.min(clock.now().getTime() + 300_000, row.hardDeleteAt.getTime()),
    );
    return {
      assetId: row.assetId,
      sourceMembershipId: row.sourceMembershipId,
      expiresAt: expiresAt.toISOString(),
      encryptedManifest: b64(row.encryptedManifest),
      object: {
        variant: "PREVIEW",
        ciphertextBytes: row.bytes,
        checksumSha256: b64(row.checksum),
        url: await store.download(row.key, expiresAt),
      },
    };
  }

  const previewColumns = [
    "u.client_asset_id as assetId",
    "source_member.id as sourceMembershipId",
    "u.source_device_id as sourceDeviceId",
    "u.encrypted_manifest as encryptedManifest",
    "o.s3_key as key",
    "o.expected_ciphertext_bytes as bytes",
    "o.expected_ciphertext_sha256 as checksum",
    "t.hard_delete_at as hardDeleteAt",
  ] as const;

  return {
    async publishPreview(actor, assetId, body) {
      requireBody(PublishPreviewBodySchema, body);
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const session = await tx
          .selectFrom("upload_sessions")
          .selectAll()
          .where("id", "=", body.uploadSessionId)
          .where("client_asset_id", "=", assetId)
          .where("source_device_id", "=", actor.deviceId)
          .executeTakeFirst();
        if (!session) throw new DomainError("NOT_FOUND");
        const trip = await tripFor(tx, actor, session.trip_id);
        if (trip.release_mode !== "IMMEDIATE" || session.state === "EXPIRED")
          throw new DomainError("CONFLICT");
        const object = await tx
          .selectFrom("upload_objects")
          .selectAll()
          .where("upload_session_id", "=", session.id)
          .where("variant", "=", "PREVIEW")
          .executeTakeFirstOrThrow();
        const prior = await tx
          .selectFrom("inbox_events")
          .select("created_at")
          .where("aggregate_id", "=", assetId)
          .where("recipient_device_id", "=", actor.deviceId)
          .where("event_type", "=", "ASSET_PREVIEW_READY")
          .executeTakeFirst();
        if (prior) {
          if (body.etag !== object.etag)
            throw new DomainError("IDEMPOTENCY_CONFLICT");
          return { assetId, publishedAt: prior.created_at.toISOString() };
        }
        if (session.expires_at <= clock.now())
          throw new DomainError("CONFLICT");
        const actual = await store.inspect(object.s3_key);
        if (
          !actual ||
          actual.etag !== body.etag ||
          actual.bytes !== object.expected_ciphertext_bytes ||
          actual.checksum !== b64(object.expected_ciphertext_sha256)
        )
          throw new DomainError("CONFLICT");
        const now = clock.now();
        await tx
          .updateTable("upload_objects")
          .set({ etag: actual.etag, verified_at: now })
          .where("upload_session_id", "=", session.id)
          .where("variant", "=", "PREVIEW")
          .execute();
        const members = await tx
          .selectFrom("trip_members")
          .select("participating_device_id")
          .where("trip_id", "=", trip.id)
          .where("state", "=", "ACTIVE")
          .execute();
        // Trip serialization makes these per-trip sequence cursors commit ordered.
        // Preview availability is NOT an asset commit, receipt, or cleanup signal.
        await tx
          .insertInto("inbox_events")
          .values(
            members.map((member) => ({
              recipient_device_id: member.participating_device_id,
              trip_id: trip.id,
              event_type: "ASSET_PREVIEW_READY",
              aggregate_id: assetId,
              available_at: now,
              payload: { assetId },
              created_at: now,
            })),
          )
          .execute();
        return { assetId, publishedAt: now.toISOString() };
      });
    },
    async previewFeed(actor, tripId, after) {
      if (
        !/^(?:0|[1-9]\d{0,18})$/.test(after) ||
        BigInt(after) > 9223372036854775807n
      )
        throw new DomainError("INVALID_REQUEST");
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        await tripFor(tx, actor, tripId);
        const rows = await tx
          .selectFrom("inbox_events as e")
          .innerJoin(
            "upload_sessions as u",
            "u.client_asset_id",
            "e.aggregate_id",
          )
          .innerJoin("upload_objects as o", "o.upload_session_id", "u.id")
          .innerJoin("trips as t", "t.id", "u.trip_id")
          .leftJoin("assets as a", "a.id", "u.client_asset_id")
          .innerJoin("trip_members as source_member", (join) =>
            join
              .onRef("source_member.trip_id", "=", "u.trip_id")
              .onRef(
                "source_member.participating_device_id",
                "=",
                "u.source_device_id",
              ),
          )
          .select([
            ...previewColumns,
            "e.sequence",
            "e.created_at as publishedAt",
          ])
          .where("e.recipient_device_id", "=", actor.deviceId)
          .where("e.trip_id", "=", tripId)
          .where("e.event_type", "=", "ASSET_PREVIEW_READY")
          .where("e.sequence", ">", after)
          .where("o.variant", "=", "PREVIEW")
          .where("o.verified_at", "is not", null)
          .where("u.state", "in", ["CREATED", "COMMITTED"])
          .where((eb) =>
            eb.or([eb("a.state", "is", null), eb("a.state", "=", "COMMITTED")]),
          )
          .orderBy("e.sequence")
          .limit(21)
          .execute();
        const page = rows.slice(0, 20);
        return {
          items: await Promise.all(
            page.map(async (row) => ({
              sequence: row.sequence,
              assetId: row.assetId,
              sourceDeviceId: row.sourceDeviceId,
              publishedAt: row.publishedAt.toISOString(),
              download: await previewGrant(row),
            })),
          ),
          nextCursor: page.at(-1)?.sequence ?? after,
          hasMore: rows.length > 20,
        };
      });
    },
    async previewDownload(actor, assetId) {
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const session = await tx
          .selectFrom("upload_sessions")
          .select(["trip_id", "state"])
          .where("client_asset_id", "=", assetId)
          .executeTakeFirst();
        if (!session) throw new DomainError("NOT_FOUND");
        await tripFor(tx, actor, session.trip_id);
        const row = await tx
          .selectFrom("upload_sessions as u")
          .innerJoin("upload_objects as o", "o.upload_session_id", "u.id")
          .innerJoin("trips as t", "t.id", "u.trip_id")
          .leftJoin("assets as a", "a.id", "u.client_asset_id")
          .innerJoin("trip_members as source_member", (join) =>
            join
              .onRef("source_member.trip_id", "=", "u.trip_id")
              .onRef(
                "source_member.participating_device_id",
                "=",
                "u.source_device_id",
              ),
          )
          .select(previewColumns)
          .where("u.client_asset_id", "=", assetId)
          .where("o.variant", "=", "PREVIEW")
          .where("o.verified_at", "is not", null)
          .where("u.state", "in", ["CREATED", "COMMITTED"])
          .where((eb) =>
            eb.or([eb("a.state", "is", null), eb("a.state", "=", "COMMITTED")]),
          )
          .executeTakeFirst();
        if (!row) throw new DomainError("NOT_FOUND");
        return previewGrant(row);
      });
    },
    async createUpload(actor, rawBody) {
      requireBody(CreateUploadSessionBodySchema, rawBody);
      const body = {
        ...rawBody,
        assetId: rawBody.assetId.toLowerCase(),
        tripId: rawBody.tripId.toLowerCase(),
      };
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const trip = await tripFor(tx, actor, body.tripId);
        if (trip.release_mode !== "IMMEDIATE")
          throw new DomainError("TRIP_STATE_CONFLICT");
        const now = clock.now();
        const capturedAt = new Date(body.capturedAt);
        if (
          capturedAt < trip.started_at! ||
          capturedAt > trip.ends_at ||
          capturedAt.getTime() > now.getTime() + 60_000
        )
          throw new DomainError("INVALID_REQUEST");
        const existing = await tx
          .selectFrom("upload_sessions")
          .selectAll()
          .where((eb) =>
            eb.or([
              eb("client_asset_id", "=", body.assetId),
              eb.and([
                eb("trip_id", "=", body.tripId),
                eb("source_device_id", "=", actor.deviceId),
                eb("source_asset_key", "=", body.sourceAssetKey),
              ]),
            ]),
          )
          .executeTakeFirst();
        if (existing) {
          const objects = await tx
            .selectFrom("upload_objects")
            .selectAll()
            .where("upload_session_id", "=", existing.id)
            .execute();
          const original: CreateUploadSessionBody = {
            tripId: existing.trip_id,
            assetId: existing.client_asset_id,
            sourceAssetKey: existing.source_asset_key,
            capturedAt: body.capturedAt,
            formatVersion: 1,
            keyEpoch: 1,
            encryptedManifest: b64(existing.encrypted_manifest),
            objects: variants.map((variant) => {
              const object = objects.find((item) => item.variant === variant)!;
              return {
                variant,
                ciphertextBytes: object.expected_ciphertext_bytes,
                checksumSha256: b64(object.expected_ciphertext_sha256),
              };
            }) as CreateUploadSessionBody["objects"],
          };
          if (
            existing.source_device_id !== actor.deviceId ||
            fingerprint(original) !==
              fingerprint({ ...body, capturedAt: capturedAt.toISOString() })
          )
            throw new DomainError("IDEMPOTENCY_CONFLICT");
          if (existing.state === "EXPIRED") throw new DomainError("CONFLICT");
          // Renew the same immutable object keys after an interrupted upload.
          if (existing.state !== "COMMITTED" && existing.expires_at <= now)
            await tx
              .updateTable("upload_sessions")
              .set({
                expires_at: new Date(
                  Math.min(
                    now.getTime() + 900_000,
                    trip.hard_delete_at.getTime(),
                  ),
                ),
              })
              .where("id", "=", existing.id)
              .execute();
          return uploadResponse(tx, existing.id);
        }
        const sessionId = randomUUID();
        const expiresAt = new Date(
          Math.min(now.getTime() + 900_000, trip.hard_delete_at.getTime()),
        );
        await tx
          .insertInto("upload_sessions")
          .values({
            id: sessionId,
            client_asset_id: body.assetId,
            trip_id: body.tripId,
            source_device_id: actor.deviceId,
            source_asset_key: body.sourceAssetKey,
            media_type: "PHOTO",
            key_epoch: 1,
            encryption_version: 1,
            encrypted_manifest: Buffer.from(body.encryptedManifest, "base64"),
            state: "CREATED",
            expires_at: expiresAt,
            created_at: now,
          })
          .execute();
        await tx
          .insertInto("upload_objects")
          .values(
            body.objects.map((object) => ({
              upload_session_id: sessionId,
              variant: object.variant,
              s3_key: `media/${body.tripId}/${sessionId}/${object.variant.toLowerCase()}`,
              expected_ciphertext_bytes: object.ciphertextBytes,
              expected_ciphertext_sha256: Buffer.from(
                object.checksumSha256,
                "base64",
              ),
              etag: null,
              verified_at: null,
            })),
          )
          .execute();
        return uploadResponse(tx, sessionId);
      });
    },
    async commit(actor, assetId, body) {
      requireBody(CommitAssetBodySchema, body);
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const session = await tx
          .selectFrom("upload_sessions")
          .selectAll()
          .where("id", "=", body.uploadSessionId)
          .where("client_asset_id", "=", assetId)
          .where("source_device_id", "=", actor.deviceId)
          .executeTakeFirst();
        if (!session) throw new DomainError("NOT_FOUND");
        const trip = await tripFor(tx, actor, session.trip_id);
        const objects = await tx
          .selectFrom("upload_objects")
          .selectAll()
          .where("upload_session_id", "=", session.id)
          .execute();
        if (session.state === "COMMITTED") {
          if (
            objects.some(
              (object) =>
                body.objects.find((item) => item.variant === object.variant)
                  ?.etag !== object.etag,
            )
          )
            throw new DomainError("IDEMPOTENCY_CONFLICT");
          return commitResult(tx, assetId, actor.deviceId);
        }
        const now = clock.now();
        if (session.state === "EXPIRED" || session.expires_at <= now)
          throw new DomainError("CONFLICT");
        const verified = await Promise.all(
          objects.map(async (object) => {
            const actual = await store.inspect(object.s3_key);
            if (
              !actual ||
              actual.bytes !== object.expected_ciphertext_bytes ||
              actual.checksum !== b64(object.expected_ciphertext_sha256) ||
              actual.etag !==
                body.objects.find((item) => item.variant === object.variant)
                  ?.etag
            )
              throw new DomainError("CONFLICT");
            return { ...object, etag: actual.etag };
          }),
        );
        if (verified.length !== 2) throw new DomainError("CONFLICT");
        await tx
          .insertInto("assets")
          .values({
            id: assetId,
            trip_id: session.trip_id,
            source_device_id: actor.deviceId,
            source_asset_key: session.source_asset_key,
            committed_at: now,
            media_type: "PHOTO",
            key_epoch: 1,
            encryption_version: 1,
            encrypted_manifest: session.encrypted_manifest,
            state: "COMMITTED",
            purge_pending_at: null,
            purged_at: null,
            expired_at: null,
          })
          .execute();
        for (const object of verified) {
          await tx
            .insertInto("asset_objects")
            .values({
              asset_id: assetId,
              variant: object.variant,
              s3_key: object.s3_key,
              ciphertext_bytes: object.expected_ciphertext_bytes,
              ciphertext_sha256: object.expected_ciphertext_sha256,
              etag: object.etag,
              created_at: now,
              deleted_at: null,
            })
            .execute();
          await tx
            .updateTable("upload_objects")
            .set({ etag: object.etag, verified_at: now })
            .where("upload_session_id", "=", session.id)
            .where("variant", "=", object.variant)
            .execute();
        }
        const members = await tx
          .selectFrom("trip_members")
          .selectAll()
          .where("trip_id", "=", trip.id)
          .where("state", "=", "ACTIVE")
          .execute();
        // Membership is frozen when the trip starts. Fan-out is atomic with the
        // commit, including the source receipt; a lost response is safe to retry.
        for (const member of members) {
          const source = member.participating_device_id === actor.deviceId;
          const deliveryId = randomUUID();
          await tx
            .insertInto("deliveries")
            .values({
              id: deliveryId,
              asset_id: assetId,
              recipient_user_id: member.user_id,
              recipient_device_id: member.participating_device_id,
              state: source ? "SAVED_LOCALLY" : "READY",
              available_at: now,
              saved_at: source ? now : null,
              created_at: now,
            })
            .execute();
          if (source)
            await tx
              .insertInto("receipts")
              .values({
                id: randomUUID(),
                delivery_id: deliveryId,
                receipt_type: "SOURCE_PRESENT",
                client_event_id: randomUUID(),
                client_observed_at: now,
                accepted_at: now,
              })
              .execute();
          await tx
            .insertInto("inbox_events")
            .values({
              recipient_device_id: member.participating_device_id,
              trip_id: trip.id,
              event_type: "ASSET_COMMITTED",
              aggregate_id: assetId,
              available_at: now,
              payload: { assetId, deliveryId },
              created_at: now,
            })
            .execute();
        }
        await tx
          .updateTable("upload_sessions")
          .set({ state: "COMMITTED" })
          .where("id", "=", session.id)
          .execute();
        return commitResult(tx, assetId, actor.deviceId);
      });
    },
    async pending(actor) {
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const rows = await tx
          .selectFrom("deliveries as d")
          .innerJoin("assets as a", "a.id", "d.asset_id")
          .innerJoin("trips as t", "t.id", "a.trip_id")
          .innerJoin("trip_members as m", (join) =>
            join
              .onRef("m.trip_id", "=", "a.trip_id")
              .onRef("m.participating_device_id", "=", "d.recipient_device_id"),
          )
          .select([
            "d.id as deliveryId",
            "a.id as assetId",
            "a.trip_id as tripId",
            "a.source_device_id as sourceDeviceId",
            "a.committed_at as committedAt",
          ])
          .where("d.recipient_device_id", "=", actor.deviceId)
          .where("d.recipient_user_id", "=", actor.userId)
          .where("d.state", "=", "READY")
          .where("a.state", "=", "COMMITTED")
          .where("m.state", "=", "ACTIVE")
          .where("t.hard_delete_at", ">", clock.now())
          .where("d.available_at", "<=", clock.now())
          .orderBy("d.available_at")
          .orderBy("d.id")
          .limit(100)
          .execute();
        // Pending-state polling deliberately has no advancing cursor: an
        // interrupted receiver can never skip an unacknowledged delivery.
        return {
          items: rows.map((row) => ({
            ...row,
            committedAt: row.committedAt.toISOString(),
          })),
        };
      });
    },
    async download(actor, deliveryId, body) {
      requireBody(CreateDownloadSessionBodySchema, body);
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const { delivery, asset, trip } = await ownedDelivery(
          tx,
          actor,
          deliveryId,
        );
        const now = clock.now();
        if (
          delivery.state !== "READY" ||
          delivery.available_at > now ||
          asset.state !== "COMMITTED"
        )
          throw new DomainError("CONFLICT");
        const expiresAt = new Date(
          Math.min(now.getTime() + 300_000, trip.hard_delete_at.getTime()),
        );
        const objects = await tx
          .selectFrom("asset_objects")
          .selectAll()
          .where("asset_id", "=", asset.id)
          .where("variant", "in", body.variants as ObjectVariant[])
          .where("deleted_at", "is", null)
          .execute();
        if (objects.length !== body.variants.length)
          throw new DomainError("CONFLICT");
        return {
          deliveryId,
          assetId: asset.id,
          expiresAt: expiresAt.toISOString(),
          encryptedManifest: b64(asset.encrypted_manifest),
          objects: await Promise.all(
            objects.map(async (object) => ({
              variant: object.variant,
              ciphertextBytes: object.ciphertext_bytes,
              checksumSha256: b64(object.ciphertext_sha256),
              url: await store.download(object.s3_key, expiresAt),
            })),
          ),
        };
      });
    },
    async saved(actor, deliveryId, eventId, body) {
      requireBody(SavedReceiptBodySchema, body);
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor);
        const { delivery, asset } = await ownedDelivery(tx, actor, deliveryId);
        if (body.assetId !== asset.id) throw new DomainError("INVALID_REQUEST");
        const prior = await tx
          .selectFrom("receipts")
          .selectAll()
          .where("delivery_id", "=", deliveryId)
          .executeTakeFirst();
        if (prior)
          return {
            deliveryId,
            status: "SAVED_LOCALLY" as const,
            acceptedAt: prior.accepted_at.toISOString(),
          };
        const now = clock.now();
        if (
          delivery.state !== "READY" ||
          delivery.available_at > now ||
          asset.state !== "COMMITTED" ||
          new Date(body.savedAt).getTime() > now.getTime() + 60_000
        )
          throw new DomainError("CONFLICT");
        const reused = await tx
          .selectFrom("receipts")
          .select("id")
          .where("client_event_id", "=", eventId)
          .executeTakeFirst();
        if (reused) throw new DomainError("IDEMPOTENCY_CONFLICT");
        await tx
          .insertInto("receipts")
          .values({
            id: randomUUID(),
            delivery_id: deliveryId,
            receipt_type: "SAVED_LOCALLY",
            client_event_id: eventId,
            client_observed_at: new Date(body.savedAt),
            accepted_at: now,
          })
          .execute();
        await tx
          .updateTable("deliveries")
          .set({ state: "SAVED_LOCALLY", saved_at: now })
          .where("id", "=", deliveryId)
          .execute();
        const outstanding = await tx
          .selectFrom("deliveries")
          .select("id")
          .where("asset_id", "=", asset.id)
          .where("state", "!=", "SAVED_LOCALLY")
          .limit(1)
          .executeTakeFirst();
        if (!outstanding)
          await tx
            .updateTable("assets")
            .set({ state: "PURGE_PENDING", purge_pending_at: now })
            .where("id", "=", asset.id)
            .execute();
        return {
          deliveryId,
          status: "SAVED_LOCALLY" as const,
          acceptedAt: now.toISOString(),
        };
      });
    },
    async cleanup() {
      // Delete only committed ciphertext whose recipients all acknowledged, or
      // whose trip's explicit hard retention deadline has passed. Retry safely.
      const candidates = await db
        .selectFrom("assets as a")
        .innerJoin("trips as t", "t.id", "a.trip_id")
        .innerJoin("upload_sessions as u", "u.client_asset_id", "a.id")
        .select(["a.id", "a.trip_id"])
        // An issued PUT capability must expire before physical deletion, or a
        // delayed/replayed upload could recreate already-purged ciphertext.
        .where("u.expires_at", "<=", clock.now())
        .where((eb) =>
          eb.or([
            eb("a.state", "=", "PURGE_PENDING"),
            eb.and([
              eb("a.state", "=", "COMMITTED"),
              eb("t.hard_delete_at", "<=", clock.now()),
            ]),
          ]),
        )
        .limit(100)
        .execute();
      let count = 0;
      for (const candidate of candidates)
        await db.transaction().execute(async (tx) => {
          const trip = await tx
            .selectFrom("trips")
            .selectAll()
            .where("id", "=", candidate.trip_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const asset = await tx
            .selectFrom("assets")
            .selectAll()
            .where("id", "=", candidate.id)
            .executeTakeFirstOrThrow();
          const now = clock.now();
          const upload = await tx
            .selectFrom("upload_sessions")
            .select("expires_at")
            .where("client_asset_id", "=", asset.id)
            .executeTakeFirstOrThrow();
          if (upload.expires_at > now) return;
          if (
            asset.state !== "PURGE_PENDING" &&
            !(asset.state === "COMMITTED" && trip.hard_delete_at <= now)
          )
            return;
          const objects = await tx
            .selectFrom("asset_objects")
            .selectAll()
            .where("asset_id", "=", asset.id)
            .where("deleted_at", "is", null)
            .execute();
          for (const object of objects) {
            await store.delete(object.s3_key);
            await tx
              .updateTable("asset_objects")
              .set({ deleted_at: now })
              .where("asset_id", "=", asset.id)
              .where("variant", "=", object.variant)
              .execute();
          }
          if (asset.state === "PURGE_PENDING")
            await tx
              .updateTable("assets")
              .set({ state: "PURGED", purged_at: now })
              .where("id", "=", asset.id)
              .execute();
          else {
            await tx
              .updateTable("assets")
              .set({ state: "EXPIRED", expired_at: now })
              .where("id", "=", asset.id)
              .execute();
            await tx
              .updateTable("deliveries")
              .set({ state: "EXPIRED" })
              .where("asset_id", "=", asset.id)
              .where("state", "in", ["READY", "HELD"])
              .execute();
          }
          count += 1;
        });
      // Uncommitted uploads also contain ciphertext. Preserve resumable leases
      // during a live trip, but never retain abandoned bytes past its deadline.
      const abandoned = await db
        .selectFrom("upload_sessions as u")
        .innerJoin("trips as t", "t.id", "u.trip_id")
        .select(["u.id", "u.trip_id"])
        .where("u.state", "=", "CREATED")
        .where("t.hard_delete_at", "<=", clock.now())
        .limit(100)
        .execute();
      for (const candidate of abandoned)
        await db.transaction().execute(async (tx) => {
          const trip = await tx
            .selectFrom("trips")
            .select("hard_delete_at")
            .where("id", "=", candidate.trip_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const session = await tx
            .selectFrom("upload_sessions")
            .selectAll()
            .where("id", "=", candidate.id)
            .executeTakeFirstOrThrow();
          if (
            session.state !== "CREATED" ||
            trip.hard_delete_at > clock.now() ||
            session.expires_at > clock.now()
          )
            return;
          const objects = await tx
            .selectFrom("upload_objects")
            .select("s3_key")
            .where("upload_session_id", "=", session.id)
            .execute();
          for (const object of objects) await store.delete(object.s3_key);
          await tx
            .updateTable("upload_sessions")
            .set({ state: "EXPIRED" })
            .where("id", "=", session.id)
            .execute();
          count += 1;
        });
      return count;
    },
  };
}
