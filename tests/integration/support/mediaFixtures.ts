import { sql, type Kysely } from "kysely";

import type { Database } from "../../../services/control-plane/src/db/schema/tables.js";
import {
  createIdentityTripFixtures,
  type IdentityTripFixtures,
} from "./fixtures.js";

export const FIXED_NOW = new Date("2026-08-29T08:00:00.000Z");
export const ONE_HOUR_MS = 60 * 60 * 1000;

export function fixedBytes(fill: number, length = 32): Uint8Array {
  return Uint8Array.from({ length }, () => fill);
}

interface UploadSessionRow {
  id: string;
  client_asset_id: string;
  trip_id: string;
  source_device_id: string;
  source_asset_key: string;
  media_type: string;
  key_epoch: number;
  encryption_version: number;
  encrypted_manifest: Uint8Array;
  state: string;
  expires_at: Date;
  created_at: Date;
}

interface UploadObjectRow {
  upload_session_id: string;
  variant: string;
  s3_key: string;
  expected_ciphertext_bytes: string;
  expected_ciphertext_sha256: Uint8Array;
  etag: string | null;
  verified_at: Date | null;
}

interface AssetRow {
  id: string;
  trip_id: string;
  source_device_id: string;
  source_asset_key: string;
  committed_at: Date;
  media_type: string;
  key_epoch: number;
  encryption_version: number;
  encrypted_manifest: Uint8Array;
  state: string;
  purge_pending_at: Date | null;
  purged_at: Date | null;
  expired_at: Date | null;
}

interface AssetObjectRow {
  asset_id: string;
  variant: string;
  s3_key: string;
  ciphertext_bytes: string;
  ciphertext_sha256: Uint8Array;
  etag: string;
  created_at: Date;
  deleted_at: Date | null;
}

interface DeliveryRow {
  id: string;
  asset_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  state: string;
  available_at: Date;
  saved_at: Date | null;
  created_at: Date;
}

interface ReceiptRow {
  id: string;
  delivery_id: string;
  receipt_type: string;
  client_event_id: string;
  client_observed_at: Date;
  accepted_at: Date;
}

interface InboxEventRow {
  recipient_device_id: string;
  trip_id: string;
  event_type: string;
  aggregate_id: string;
  available_at: Date;
  payload: Readonly<Record<string, unknown>> | readonly unknown[];
  created_at: Date;
}

interface OutboxEventRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  dedupe_key: string;
  payload: Readonly<Record<string, unknown>> | readonly unknown[];
  available_at: Date;
  published_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

interface ApiIdempotencyRow {
  user_id: string;
  route_key: string;
  idempotency_key: string;
  request_sha256: Uint8Array;
  response_status: number;
  response_body: Readonly<Record<string, unknown>> | readonly unknown[];
  expires_at: Date;
}

interface AuditEventRow {
  id: string;
  trip_id: string | null;
  actor_user_id: string | null;
  actor_device_id: string | null;
  event_type: string;
  metadata: Readonly<Record<string, unknown>> | readonly unknown[];
  occurred_at: Date;
}

interface ClerkWebhookEventRow {
  event_id: string;
  event_type: string;
  processed_at: Date;
}

type Overrides<T> = Partial<T>;

export interface MediaParents {
  tripId: string;
  sourceUserId: string;
  sourceDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  outsiderUserId: string;
  outsiderDeviceId: string;
}

export interface MediaCoordinationFixtures {
  readonly identity: IdentityTripFixtures;
  uuid(): string;
  sourceAssetKey(): string;
  parents(): Promise<MediaParents>;
  uploadSession(
    parents: MediaParents,
    overrides?: Overrides<UploadSessionRow>,
  ): Promise<UploadSessionRow>;
  uploadObject(
    uploadSessionId: string,
    overrides?: Overrides<UploadObjectRow>,
  ): Promise<UploadObjectRow>;
  asset(
    parents: MediaParents,
    overrides?: Overrides<AssetRow>,
  ): Promise<AssetRow>;
  assetObject(
    assetId: string,
    overrides?: Overrides<AssetObjectRow>,
  ): Promise<AssetObjectRow>;
  delivery(
    assetId: string,
    parents: MediaParents,
    overrides?: Overrides<DeliveryRow>,
  ): Promise<DeliveryRow>;
  receipt(
    deliveryId: string,
    overrides?: Overrides<ReceiptRow>,
  ): Promise<ReceiptRow>;
  inboxEvent(
    parents: MediaParents,
    overrides?: Overrides<InboxEventRow>,
  ): Promise<string>;
  outboxEvent(overrides?: Overrides<OutboxEventRow>): Promise<OutboxEventRow>;
  apiIdempotency(
    userId: string,
    overrides?: Overrides<ApiIdempotencyRow>,
  ): Promise<ApiIdempotencyRow>;
  auditEvent(
    parents: MediaParents,
    overrides?: Overrides<AuditEventRow>,
  ): Promise<AuditEventRow>;
  clerkWebhookEvent(
    overrides?: Overrides<ClerkWebhookEventRow>,
  ): Promise<ClerkWebhookEventRow>;
}

export function createMediaCoordinationFixtures(
  db: Kysely<Database>,
): MediaCoordinationFixtures {
  const identity = createIdentityTripFixtures(db);
  let sequence = 1_000;

  function uuid(): string {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  }

  function sourceAssetKey(): string {
    return `src_${uuid().replaceAll("-", "_")}`;
  }

  return {
    identity,
    uuid,
    sourceAssetKey,

    async parents() {
      const source = await identity.user();
      const recipient = await identity.user();
      const outsider = await identity.user();
      const trip = await identity.trip(source.id);
      const sourceDevice = await identity.device(source.id);
      const recipientDevice = await identity.device(recipient.id);
      const outsiderDevice = await identity.device(outsider.id);
      await identity.member(trip.id, source.id, sourceDevice.id, {
        role: "OWNER",
      });
      await identity.member(trip.id, recipient.id, recipientDevice.id);

      return {
        outsiderDeviceId: outsiderDevice.id,
        outsiderUserId: outsider.id,
        recipientDeviceId: recipientDevice.id,
        recipientUserId: recipient.id,
        sourceDeviceId: sourceDevice.id,
        sourceUserId: source.id,
        tripId: trip.id,
      };
    },

    async uploadSession(parents, overrides = {}) {
      const row: UploadSessionRow = {
        client_asset_id: uuid(),
        created_at: FIXED_NOW,
        encrypted_manifest: fixedBytes(sequence, 64),
        encryption_version: 1,
        expires_at: new Date(FIXED_NOW.getTime() + ONE_HOUR_MS),
        id: uuid(),
        key_epoch: 1,
        media_type: "PHOTO",
        source_asset_key: sourceAssetKey(),
        source_device_id: parents.sourceDeviceId,
        state: "CREATED",
        trip_id: parents.tripId,
        ...overrides,
      };
      await sql`
        insert into upload_sessions (
          id, client_asset_id, trip_id, source_device_id, source_asset_key,
          media_type, key_epoch, encryption_version, encrypted_manifest, state,
          expires_at, created_at
        ) values (
          ${row.id}, ${row.client_asset_id}, ${row.trip_id},
          ${row.source_device_id}, ${row.source_asset_key}, ${row.media_type},
          ${row.key_epoch}, ${row.encryption_version},
          ${row.encrypted_manifest}, ${row.state}, ${row.expires_at},
          ${row.created_at}
        )
      `.execute(db);
      return row;
    },

    async uploadObject(uploadSessionId, overrides = {}) {
      const row: UploadObjectRow = {
        etag: null,
        expected_ciphertext_bytes: "524288",
        expected_ciphertext_sha256: fixedBytes(sequence),
        s3_key: `task4/${uuid()}/preview.bin`,
        upload_session_id: uploadSessionId,
        variant: "PREVIEW",
        verified_at: null,
        ...overrides,
      };
      await sql`
        insert into upload_objects (
          upload_session_id, variant, s3_key, expected_ciphertext_bytes,
          expected_ciphertext_sha256, etag, verified_at
        ) values (
          ${row.upload_session_id}, ${row.variant}, ${row.s3_key},
          ${row.expected_ciphertext_bytes},
          ${row.expected_ciphertext_sha256}, ${row.etag}, ${row.verified_at}
        )
      `.execute(db);
      return row;
    },

    async asset(parents, overrides = {}) {
      const row: AssetRow = {
        committed_at: FIXED_NOW,
        encrypted_manifest: fixedBytes(sequence, 64),
        encryption_version: 1,
        expired_at: null,
        id: uuid(),
        key_epoch: 1,
        media_type: "PHOTO",
        purge_pending_at: null,
        purged_at: null,
        source_asset_key: sourceAssetKey(),
        source_device_id: parents.sourceDeviceId,
        state: "COMMITTED",
        trip_id: parents.tripId,
        ...overrides,
      };
      await sql`
        insert into assets (
          id, trip_id, source_device_id, source_asset_key, committed_at,
          media_type, key_epoch, encryption_version, encrypted_manifest, state,
          purge_pending_at, purged_at, expired_at
        ) values (
          ${row.id}, ${row.trip_id}, ${row.source_device_id},
          ${row.source_asset_key}, ${row.committed_at}, ${row.media_type},
          ${row.key_epoch}, ${row.encryption_version},
          ${row.encrypted_manifest}, ${row.state}, ${row.purge_pending_at},
          ${row.purged_at}, ${row.expired_at}
        )
      `.execute(db);
      return row;
    },

    async assetObject(assetId, overrides = {}) {
      const row: AssetObjectRow = {
        asset_id: assetId,
        ciphertext_bytes: "524288",
        ciphertext_sha256: fixedBytes(sequence),
        created_at: FIXED_NOW,
        deleted_at: null,
        etag: `etag-${sequence}`,
        s3_key: `task4/${uuid()}/committed-preview.bin`,
        variant: "PREVIEW",
        ...overrides,
      };
      await sql`
        insert into asset_objects (
          asset_id, variant, s3_key, ciphertext_bytes, ciphertext_sha256,
          etag, created_at, deleted_at
        ) values (
          ${row.asset_id}, ${row.variant}, ${row.s3_key},
          ${row.ciphertext_bytes}, ${row.ciphertext_sha256}, ${row.etag},
          ${row.created_at}, ${row.deleted_at}
        )
      `.execute(db);
      return row;
    },

    async delivery(assetId, parents, overrides = {}) {
      const row: DeliveryRow = {
        asset_id: assetId,
        available_at: FIXED_NOW,
        created_at: FIXED_NOW,
        id: uuid(),
        recipient_device_id: parents.recipientDeviceId,
        recipient_user_id: parents.recipientUserId,
        saved_at: null,
        state: "READY",
        ...overrides,
      };
      await sql`
        insert into deliveries (
          id, asset_id, recipient_user_id, recipient_device_id, state,
          available_at, saved_at, created_at
        ) values (
          ${row.id}, ${row.asset_id}, ${row.recipient_user_id},
          ${row.recipient_device_id}, ${row.state}, ${row.available_at},
          ${row.saved_at}, ${row.created_at}
        )
      `.execute(db);
      return row;
    },

    async receipt(deliveryId, overrides = {}) {
      const row: ReceiptRow = {
        accepted_at: FIXED_NOW,
        client_event_id: uuid(),
        client_observed_at: FIXED_NOW,
        delivery_id: deliveryId,
        id: uuid(),
        receipt_type: "SAVED_LOCALLY",
        ...overrides,
      };
      await sql`
        insert into receipts (
          id, delivery_id, receipt_type, client_event_id, client_observed_at,
          accepted_at
        ) values (
          ${row.id}, ${row.delivery_id}, ${row.receipt_type},
          ${row.client_event_id}, ${row.client_observed_at}, ${row.accepted_at}
        )
      `.execute(db);
      return row;
    },

    async inboxEvent(parents, overrides = {}) {
      const row: InboxEventRow = {
        aggregate_id: uuid(),
        available_at: FIXED_NOW,
        created_at: FIXED_NOW,
        event_type: "DELIVERY_READY",
        payload: { schemaVersion: 1 },
        recipient_device_id: parents.recipientDeviceId,
        trip_id: parents.tripId,
        ...overrides,
      };
      const result = await sql<{ sequence: string }>`
        insert into inbox_events (
          recipient_device_id, trip_id, event_type, aggregate_id, available_at,
          payload, created_at
        ) values (
          ${row.recipient_device_id}, ${row.trip_id}, ${row.event_type},
          ${row.aggregate_id}, ${row.available_at},
          ${JSON.stringify(row.payload)}::jsonb, ${row.created_at}
        )
        returning sequence::text
      `.execute(db);
      return result.rows[0]!.sequence;
    },

    async outboxEvent(overrides = {}) {
      const row: OutboxEventRow = {
        aggregate_id: uuid(),
        attempt_count: 0,
        available_at: FIXED_NOW,
        created_at: FIXED_NOW,
        dedupe_key: `asset-committed:${uuid()}`,
        event_type: "asset.committed",
        id: uuid(),
        last_error: null,
        payload: { schemaVersion: 1 },
        published_at: null,
        ...overrides,
      };
      await sql`
        insert into outbox_events (
          id, event_type, aggregate_id, dedupe_key, payload, available_at,
          published_at, attempt_count, last_error, created_at
        ) values (
          ${row.id}, ${row.event_type}, ${row.aggregate_id}, ${row.dedupe_key},
          ${JSON.stringify(row.payload)}::jsonb, ${row.available_at},
          ${row.published_at}, ${row.attempt_count}, ${row.last_error},
          ${row.created_at}
        )
      `.execute(db);
      return row;
    },

    async apiIdempotency(userId, overrides = {}) {
      const row: ApiIdempotencyRow = {
        expires_at: new Date(FIXED_NOW.getTime() + ONE_HOUR_MS),
        idempotency_key: uuid(),
        request_sha256: fixedBytes(sequence),
        response_body: { assetId: uuid() },
        response_status: 201,
        route_key: "POST /v1/assets/:assetId/commit",
        user_id: userId,
        ...overrides,
      };
      await sql`
        insert into api_idempotency (
          user_id, route_key, idempotency_key, request_sha256, response_status,
          response_body, expires_at
        ) values (
          ${row.user_id}, ${row.route_key}, ${row.idempotency_key},
          ${row.request_sha256}, ${row.response_status},
          ${JSON.stringify(row.response_body)}::jsonb, ${row.expires_at}
        )
      `.execute(db);
      return row;
    },

    async auditEvent(parents, overrides = {}) {
      const row: AuditEventRow = {
        actor_device_id: parents.sourceDeviceId,
        actor_user_id: parents.sourceUserId,
        event_type: "asset.purged",
        id: uuid(),
        metadata: { objectCount: 2 },
        occurred_at: FIXED_NOW,
        trip_id: parents.tripId,
        ...overrides,
      };
      await sql`
        insert into audit_events (
          id, trip_id, actor_user_id, actor_device_id, event_type, metadata,
          occurred_at
        ) values (
          ${row.id}, ${row.trip_id}, ${row.actor_user_id},
          ${row.actor_device_id}, ${row.event_type},
          ${JSON.stringify(row.metadata)}::jsonb, ${row.occurred_at}
        )
      `.execute(db);
      return row;
    },

    async clerkWebhookEvent(overrides = {}) {
      const row: ClerkWebhookEventRow = {
        event_id: `evt_${uuid()}`,
        event_type: "user.updated",
        processed_at: FIXED_NOW,
        ...overrides,
      };
      await sql`
        insert into clerk_webhook_events (event_id, event_type, processed_at)
        values (${row.event_id}, ${row.event_type}, ${row.processed_at})
      `.execute(db);
      return row;
    },
  };
}
