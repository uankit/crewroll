import { captureAllowed } from "./capturePolicy.js";
import { cleanupMedia } from "./mediaCleanup.js";
import { eraseExpiredMediaMetadata } from "./mediaMetadataRetention.js";
import {
  CommitAssetBodySchema,
  CreateDownloadSessionBodySchema,
  CreateUploadSessionBodySchema,
  SavedReceiptBodySchema,
  PublishPreviewBodySchema,
  PendingDeliveriesQuerySchema,
  PendingDeliveryCursorSchema,
  DeliveryIdSchema,
  type PreviewDownloadResponse,
  type CommitAssetResponse,
  type CreateUploadSessionBody,
  type UploadSessionResponse,
} from "@crewroll/contracts";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { sql, type Kysely, type Transaction } from "kysely";

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

interface PendingCursor {
  v: 1;
  deviceId: string;
  tripId: string;
  availableAt: string;
  deliveryId: string;
}

function pendingCursor(
  encoded: string | undefined,
  actor: MediaActor,
  tripId: string | undefined,
): PendingCursor | null {
  if (encoded === undefined) return null;
  try {
    requireBody(PendingDeliveryCursorSchema, encoded);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error();
    const fields = value as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join(",") !==
        "availableAt,deliveryId,deviceId,tripId,v" ||
      fields.v !== 1 ||
      tripId === undefined ||
      fields.deviceId !== actor.deviceId ||
      fields.tripId !== tripId ||
      typeof fields.availableAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(
        fields.availableAt,
      ) ||
      fields.availableAt.startsWith("0000-") ||
      new Date(fields.availableAt).toISOString().slice(0, 23) !==
        fields.availableAt.slice(0, 23) ||
      typeof fields.deliveryId !== "string" ||
      !Value.Check(DeliveryIdSchema, fields.deliveryId)
    )
      throw new Error();
    return {
      v: 1,
      deviceId: actor.deviceId,
      tripId,
      availableAt: fields.availableAt,
      deliveryId: fields.deliveryId,
    };
  } catch {
    throw new DomainError("INVALID_REQUEST");
  }
}

export function createKyselyMediaService(
  db: Kysely<Database>,
  store: CiphertextStore,
  clock: Clock,
): MediaService {
  const randomUUID = () => crypto.randomUUID();
  // Match device/trip command lock order. Recheck authorization inside every
  // mutation, so revocation cannot race a previously authenticated request.
  // NO KEY UPDATE also permits the KEY SHARE locks required by recipient FKs.
  async function authorize(tx: Tx, actor: MediaActor, readOnly = false) {
    const user = await tx
      .selectFrom("users")
      .selectAll()
      .where("id", "=", actor.userId)
      .$if(readOnly, (query) => query.forShare())
      .$if(!readOnly, (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    const device = await tx
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", actor.deviceId)
      .$if(readOnly, (query) => query.forShare())
      .$if(!readOnly, (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    if (
      !user ||
      user.deleted_at ||
      user.suspended_at ||
      !device ||
      device.user_id !== actor.userId ||
      device.revoked_at ||
      device.background_credential_expires_at <= clock.now()
    ) {
      throw new DomainError("AUTH_INVALID");
    }
  }
  async function tripFor(
    tx: Tx,
    actor: MediaActor,
    tripId: string,
    readOnly = false,
  ) {
    const trip = await tx
      .selectFrom("trips")
      .selectAll()
      .where("id", "=", tripId)
      // Serialize trip state/recipient snapshots without excluding immutable FK references.
      .$if(readOnly, (query) => query.forShare())
      .$if(!readOnly, (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    const member = await tx
      .selectFrom("trip_members")
      .selectAll()
      .where("trip_id", "=", tripId)
      .where("participating_device_id", "=", actor.deviceId)
      .where("user_id", "=", actor.userId)
      .where("state", "=", "ACTIVE")
      .where("left_at", "is", null)
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
  async function ownedDelivery(
    tx: Tx,
    actor: MediaActor,
    deliveryId: string,
    mode: "download" | "receipt",
  ) {
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
      .executeTakeFirst();
    if (!reference) throw new DomainError("NOT_FOUND");
    const trip = await tripFor(tx, actor, reference.trip_id, true);
    const asset = await tx
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", delivery.asset_id)
      // Receipts serialize only the asset's all-recipients-saved transition.
      // Take this fence before locking a delivery; lifecycle/erasure fence trips first.
      .$if(mode === "receipt", (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    if (!asset) throw new DomainError("NOT_FOUND");
    if (mode === "receipt") {
      // Another receipt may have completed while this transaction waited for
      // the asset. Read its delivery again only after acquiring that asset lock.
      const current = await tx
        .selectFrom("deliveries")
        .selectAll()
        .where("id", "=", deliveryId)
        .where("asset_id", "=", asset.id)
        .where("recipient_device_id", "=", actor.deviceId)
        .where("recipient_user_id", "=", actor.userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current) throw new DomainError("NOT_FOUND");
      return { delivery: current, asset, trip };
    }
    return { delivery, asset, trip };
  }
  async function inspectUpload(
    actor: MediaActor,
    assetId: string,
    sessionId: string,
    previewOnly = false,
  ) {
    const objects = await db.transaction().execute(async (tx) => {
      await authorize(tx, actor, true);
      const session = await tx
        .selectFrom("upload_sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("client_asset_id", "=", assetId)
        .where("source_device_id", "=", actor.deviceId)
        .executeTakeFirst();
      if (!session) throw new DomainError("NOT_FOUND");
      // Exact replays must still work after ciphertext has been purged.
      if (!previewOnly && session.state === "COMMITTED") return [];
      if (previewOnly) {
        const prior = await tx
          .selectFrom("inbox_events")
          .select("sequence")
          .where("aggregate_id", "=", assetId)
          .where("recipient_device_id", "=", actor.deviceId)
          .where("event_type", "=", "ASSET_PREVIEW_READY")
          .executeTakeFirst();
        if (prior) return [];
      }
      return tx
        .selectFrom("upload_objects")
        .selectAll()
        .where("upload_session_id", "=", sessionId)
        .$if(previewOnly, (query) => query.where("variant", "=", "PREVIEW"))
        .execute();
    });
    return new Map(
      await Promise.all(
        objects.map(
          async (object) =>
            [object.s3_key, await store.inspect(object.s3_key)] as const,
        ),
      ),
    );
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
    tx: Kysely<Database>,
    sessionId: string,
    recoverUploaded = false,
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
        const uploaded = recoverUploaded
          ? await store.inspect(object.s3_key)
          : null;
        if (
          uploaded &&
          (uploaded.bytes !== object.expected_ciphertext_bytes ||
            uploaded.checksum !== checksum)
        )
          throw new DomainError("CONFLICT");
        return {
          variant,
          ...(uploaded ? { uploadedEtag: uploaded.etag } : {}),
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
      body.capturedAt,
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
    encryptedManifest: Uint8Array | null;
    key: string;
    bytes: string;
    checksum: Uint8Array;
    hardDeleteAt: Date;
  }): Promise<PreviewDownloadResponse> {
    if (row.encryptedManifest === null) throw new DomainError("NOT_FOUND");
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
      const inspected = await inspectUpload(
        actor,
        assetId,
        body.uploadSessionId,
        true,
      );
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
        const actual = inspected.get(object.s3_key);
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
          .where("left_at", "is", null)
          .where("approved_at", "<=", session.captured_at ?? trip.started_at!)
          .where((eb) =>
            eb.or([
              eb("leaving_at", "is", null),
              eb("leaving_at", ">=", session.created_at),
              ...(trip.state === "ENDING" && trip.ending_started_at
                ? [eb("leaving_at", ">=", trip.ending_started_at)]
                : []),
            ]),
          )
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
        await authorize(tx, actor, true);
        await tripFor(tx, actor, tripId, true);
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
          .innerJoin(
            "devices as source_device",
            "source_device.id",
            "u.source_device_id",
          )
          .innerJoin("trip_members as source_member", (join) =>
            join
              .onRef("source_member.trip_id", "=", "u.trip_id")
              .onRef("source_member.user_id", "=", "source_device.user_id"),
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
        await authorize(tx, actor, true);
        const session = await tx
          .selectFrom("upload_sessions")
          .select([
            "trip_id",
            "state",
            "created_at",
            "source_device_id",
            "captured_at",
          ])
          .where("client_asset_id", "=", assetId)
          .executeTakeFirst();
        if (!session) throw new DomainError("NOT_FOUND");
        const trip = await tripFor(tx, actor, session.trip_id, true);
        const viewer = await tx
          .selectFrom("trip_members")
          .select(["leaving_at", "approved_at"])
          .where("trip_id", "=", trip.id)
          .where("participating_device_id", "=", actor.deviceId)
          .executeTakeFirstOrThrow();
        if (viewer.approved_at! > (session.captured_at ?? trip.started_at!))
          throw new DomainError("NOT_FOUND");
        if (
          viewer.leaving_at &&
          !(
            trip.state === "ENDING" &&
            trip.ending_started_at &&
            viewer.leaving_at >= trip.ending_started_at
          ) &&
          session.created_at > viewer.leaving_at &&
          session.source_device_id !== actor.deviceId
        )
          throw new DomainError("NOT_FOUND");
        const row = await tx
          .selectFrom("upload_sessions as u")
          .innerJoin("upload_objects as o", "o.upload_session_id", "u.id")
          .innerJoin("trips as t", "t.id", "u.trip_id")
          .leftJoin("assets as a", "a.id", "u.client_asset_id")
          .innerJoin(
            "devices as source_device",
            "source_device.id",
            "u.source_device_id",
          )
          .innerJoin("trip_members as source_member", (join) =>
            join
              .onRef("source_member.trip_id", "=", "u.trip_id")
              .onRef("source_member.user_id", "=", "source_device.user_id"),
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
      const prepared = await db.transaction().execute(async (tx) => {
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
          if (
            existing.state === "EXPIRED" ||
            existing.encrypted_manifest === null
          )
            throw new DomainError("CONFLICT");
          const original: CreateUploadSessionBody = {
            tripId: existing.trip_id,
            assetId: existing.client_asset_id,
            sourceAssetKey: existing.source_asset_key,
            capturedAt: existing.captured_at?.toISOString() ?? body.capturedAt,
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
          return { sessionId: existing.id, recover: true };
        }
        const member = await tx
          .selectFrom("trip_members")
          .selectAll()
          .where("trip_id", "=", trip.id)
          .where("participating_device_id", "=", actor.deviceId)
          .executeTakeFirstOrThrow();
        const replacement = await tx
          .selectFrom("trip_device_requests")
          .select("resolved_at")
          .where("trip_id", "=", trip.id)
          .where("device_id", "=", actor.deviceId)
          .where("state", "=", "APPROVED")
          .executeTakeFirst();
        if (
          !captureAllowed(capturedAt, {
            startsAt: new Date(
              Math.max(
                trip.started_at!.getTime(),
                member.approved_at!.getTime(),
                replacement?.resolved_at?.getTime() ?? 0,
              ),
            ),
            endsAt: trip.ends_at,
            endingAt: trip.ending_started_at,
            leavingAt: member.leaving_at,
            pausedAt: member.sharing_paused_at,
            pauses: member.sharing_pauses,
          })
        )
          throw new DomainError("TRIP_STATE_CONFLICT");
        if (member.drained_at)
          await tx
            .updateTable("trip_members")
            .set({ drained_at: null })
            .where("id", "=", member.id)
            .execute();
        const sessionId = randomUUID();
        // Reservations count too; concurrent uploads cannot oversubscribe a
        // trip. Existing sessions above remain retryable at the limit.
        const quota = await sql<{ photos: string; bytes: string }>`select
          count(distinct u.id)::text as photos,
          coalesce(sum(o.expected_ciphertext_bytes), 0)::text as bytes
          from upload_sessions u left join upload_objects o on o.upload_session_id = u.id
          where u.trip_id = ${trip.id}::uuid`.execute(tx);
        const requestedBytes = body.objects.reduce(
          (sum, object) => sum + BigInt(object.ciphertextBytes),
          0n,
        );
        if (
          Number(quota.rows[0]?.photos ?? 0) >= 5000 ||
          BigInt(quota.rows[0]?.bytes ?? "0") + requestedBytes >
            20n * 1024n ** 3n
        )
          throw new DomainError("TRIP_STORAGE_LIMIT");
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
            captured_at: capturedAt,
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
        return { sessionId, recover: false };
      });
      return uploadResponse(db, prepared.sessionId, prepared.recover);
    },
    async commit(actor, assetId, body) {
      requireBody(CommitAssetBodySchema, body);
      const inspected = await inspectUpload(
        actor,
        assetId,
        body.uploadSessionId,
      );
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
        const verified = objects.map((object) => {
          const actual = inspected.get(object.s3_key);
          if (
            !actual ||
            actual.bytes !== object.expected_ciphertext_bytes ||
            actual.checksum !== b64(object.expected_ciphertext_sha256) ||
            actual.etag !==
              body.objects.find((item) => item.variant === object.variant)?.etag
          )
            throw new DomainError("CONFLICT");
          return { ...object, etag: actual.etag };
        });
        if (verified.length !== 2) throw new DomainError("CONFLICT");
        await tx
          .insertInto("assets")
          .values({
            id: assetId,
            trip_id: session.trip_id,
            source_device_id: actor.deviceId,
            source_asset_key: session.source_asset_key,
            captured_at: session.captured_at,
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
          .where("left_at", "is", null)
          .where("approved_at", "<=", session.captured_at ?? trip.started_at!)
          .where((eb) =>
            eb.or([
              eb("leaving_at", "is", null),
              eb("leaving_at", ">=", session.created_at),
              ...(trip.state === "ENDING" && trip.ending_started_at
                ? [eb("leaving_at", ">=", trip.ending_started_at)]
                : []),
            ]),
          )
          .execute();
        // Departing recipients have a fixed queue. Fan-out is atomic with the
        // commit, including the source receipt; a lost response is safe to retry.
        const deliveries = members.map((member) => {
          const source = member.participating_device_id === actor.deviceId;
          return {
            id: randomUUID(),
            asset_id: assetId,
            recipient_user_id: member.user_id,
            recipient_device_id: member.participating_device_id,
            state: source ? ("SAVED_LOCALLY" as const) : ("READY" as const),
            available_at: now,
            saved_at: source ? now : null,
            created_at: now,
          };
        });
        const wakeSequences: string[] = [];
        if (deliveries.length) {
          // One bounded batch (at most ten members) shortens the trip lock
          // without weakening its recipient snapshot or transaction boundary.
          await tx.insertInto("deliveries").values(deliveries).execute();
          const source = deliveries.find(
            (delivery) => delivery.recipient_device_id === actor.deviceId,
          );
          if (source)
            await tx
              .insertInto("receipts")
              .values({
                id: randomUUID(),
                delivery_id: source.id,
                receipt_type: "SOURCE_PRESENT",
                client_event_id: randomUUID(),
                client_observed_at: now,
                accepted_at: now,
              })
              .execute();
          const inbox = await tx
            .insertInto("inbox_events")
            .values(
              deliveries.map((delivery) => ({
                recipient_device_id: delivery.recipient_device_id,
                trip_id: trip.id,
                event_type: "ASSET_COMMITTED",
                aggregate_id: assetId,
                available_at: now,
                payload: { assetId, deliveryId: delivery.id },
                created_at: now,
              })),
            )
            .returning(["sequence", "recipient_device_id"])
            .execute();
          // RETURNING row order is not a contract. Associate wakeups with the
          // returned recipient, never an index into the input batch.
          for (const event of inbox)
            if (event.recipient_device_id !== actor.deviceId)
              wakeSequences.push(event.sequence);
        }
        if (wakeSequences.length)
          await tx
            .insertInto("outbox_events")
            .values({
              id: randomUUID(),
              event_type: "media.committed",
              aggregate_id: assetId,
              dedupe_key: `media.committed:${assetId}`,
              payload: { tripId: trip.id, recipientSequences: wakeSequences },
              available_at: now,
              created_at: now,
              published_at: null,
              last_error: null,
            })
            .execute();
        await tx
          .updateTable("upload_sessions")
          .set({ state: "COMMITTED" })
          .where("id", "=", session.id)
          .execute();
        return commitResult(tx, assetId, actor.deviceId);
      });
    },
    async pending(actor, query = {}) {
      requireBody(PendingDeliveriesQuerySchema, query);
      const tripId = "tripId" in query ? query.tripId : undefined;
      const cursor = pendingCursor(
        "after" in query ? query.after : undefined,
        actor,
        tripId,
      );
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor, true);
        const now = clock.now();
        const rows = await tx
          .selectFrom("deliveries as d")
          .innerJoin("assets as a", "a.id", "d.asset_id")
          .innerJoin("trips as t", "t.id", "a.trip_id")
          .innerJoin("trip_members as m", (join) =>
            join
              .onRef("m.trip_id", "=", "a.trip_id")
              .onRef("m.participating_device_id", "=", "d.recipient_device_id")
              .onRef("m.user_id", "=", "d.recipient_user_id"),
          )
          .select([
            "d.id as deliveryId",
            "a.id as assetId",
            "a.trip_id as tripId",
            "a.source_device_id as sourceDeviceId",
            "a.committed_at as committedAt",
            sql<string>`to_char(d.available_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
              "cursorAvailableAt",
            ),
          ])
          .where("d.recipient_device_id", "=", actor.deviceId)
          .where("d.recipient_user_id", "=", actor.userId)
          .where("d.state", "=", "READY")
          .where("a.state", "=", "COMMITTED")
          .where("m.state", "=", "ACTIVE")
          .where("m.left_at", "is", null)
          .where("t.hard_delete_at", ">", now)
          .where("d.available_at", "<=", now)
          .$if(tripId !== undefined, (q) => q.where("a.trip_id", "=", tripId!))
          .$if(cursor !== null, (q) =>
            q.where(
              sql<boolean>`(d.available_at, d.id) > (${cursor!.availableAt}::timestamptz, ${cursor!.deliveryId}::uuid)`,
            ),
          )
          .orderBy("d.available_at")
          .orderBy("d.id")
          .limit(tripId === undefined ? 100 : 101)
          .execute();
        const page = rows.slice(0, 100);
        const items = page.map((row) => ({
          deliveryId: row.deliveryId,
          assetId: row.assetId,
          tripId: row.tripId,
          sourceDeviceId: row.sourceDeviceId,
          committedAt: row.committedAt.toISOString(),
        }));
        // Legacy consumers retain head polling. Scoped consumers durably admit
        // a page before its cursor, and wrap to the head when a pass ends.
        if (tripId === undefined) return { items };
        const last = page.at(-1);
        const hasMore = rows.length > 100;
        return {
          items,
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    deviceId: actor.deviceId,
                    tripId,
                    availableAt: last.cursorAvailableAt,
                    deliveryId: last.deliveryId,
                  } satisfies PendingCursor),
                ).toString("base64url")
              : null,
        };
      });
    },
    async download(actor, deliveryId, body) {
      requireBody(CreateDownloadSessionBodySchema, body);
      return db.transaction().execute(async (tx) => {
        await authorize(tx, actor, true);
        const { delivery, asset, trip } = await ownedDelivery(
          tx,
          actor,
          deliveryId,
          "download",
        );
        const now = clock.now();
        if (
          delivery.state !== "READY" ||
          delivery.available_at > now ||
          asset.state !== "COMMITTED" ||
          asset.encrypted_manifest === null
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
        // Shared identity/trip fences still exclude revocation, END and erase,
        // while unrelated assets and read-only download grants can proceed.
        await authorize(tx, actor, true);
        const { delivery, asset, trip } = await ownedDelivery(
          tx,
          actor,
          deliveryId,
          "receipt",
        );
        if (body.assetId !== asset.id) throw new DomainError("INVALID_REQUEST");
        const prior = await tx
          .selectFrom("receipts")
          .selectAll()
          .where("delivery_id", "=", deliveryId)
          .executeTakeFirst();
        // Asset serialization may have waited past this immutable deadline.
        // Check after the wait for both new receipts and exact replays.
        const now = clock.now();
        if (trip.hard_delete_at <= now)
          throw new DomainError("TRIP_STATE_CONFLICT");
        if (prior)
          return {
            deliveryId,
            status: "SAVED_LOCALLY" as const,
            acceptedAt: prior.accepted_at.toISOString(),
          };
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
        const inserted = await tx
          .insertInto("receipts")
          .values({
            id: randomUUID(),
            delivery_id: deliveryId,
            receipt_type: "SAVED_LOCALLY",
            client_event_id: eventId,
            client_observed_at: new Date(body.savedAt),
            accepted_at: now,
          })
          // Independent assets may reuse a client event concurrently after the
          // absence check. Preserve the public typed conflict without leaking
          // a PostgreSQL unique violation or mutating the losing delivery.
          .onConflict((conflict) =>
            conflict.column("client_event_id").doNothing(),
          )
          .returning("id")
          .executeTakeFirst();
        if (!inserted) throw new DomainError("IDEMPOTENCY_CONFLICT");
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
      const retired = await cleanupMedia(db, store, clock);
      await eraseExpiredMediaMetadata(db, clock);
      return retired;
    },
  };
}
