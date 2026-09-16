import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null,
  Date | string | null
>;
type BigIntValue = ColumnType<
  string,
  bigint | number | string,
  bigint | number | string
>;
type JsonObject = Readonly<Record<string, unknown>>;
type JsonObjectColumn = ColumnType<JsonObject, JsonObject, JsonObject>;

export type DevicePlatform = "ios" | "android";
export type TripState =
  | "LOBBY"
  | "ACTIVE"
  | "ENDING"
  | "COMPLETE"
  | "INCOMPLETE_EXPIRED"
  | "CANCELLED";
export type ReleaseMode = "IMMEDIATE" | "NIGHTLY";
export type TripMemberRole = "OWNER" | "MEMBER";
export type TripMemberState = "PENDING_KEY" | "ACTIVE" | "REJECTED";
export type MediaType = "PHOTO";
export type ObjectVariant = "PREVIEW" | "ORIGINAL";
export type UploadSessionState =
  "CREATED" | "VERIFIED" | "COMMITTED" | "EXPIRED";
export type AssetState = "COMMITTED" | "PURGE_PENDING" | "PURGED" | "EXPIRED";
export type DeliveryState = "HELD" | "READY" | "SAVED_LOCALLY" | "EXPIRED";
export type ReceiptType = "SOURCE_PRESENT" | "SAVED_LOCALLY";

export interface UserTable {
  id: string;
  clerk_subject: string;
  display_name: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface DeviceTable {
  id: string;
  user_id: string;
  installation_id: string;
  platform: DevicePlatform;
  authentication_key_algorithm: "P-256";
  authentication_public_key: Uint8Array;
  authentication_key_version: 1;
  e2ee_key_algorithm: "X25519";
  e2ee_public_key: Uint8Array;
  e2ee_key_version: 1;
  background_credential_hash: Uint8Array;
  background_credential_expires_at: Timestamp;
  encrypted_push_token: Uint8Array | null;
  push_token_hash: Uint8Array | null;
  app_version: string;
  last_seen_at: Timestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  revoked_at: NullableTimestamp;
}

export interface TripTable {
  id: string;
  owner_user_id: string;
  name: string;
  state: TripState;
  release_mode: ReleaseMode;
  release_timezone: string | null;
  release_local_time: string | null;
  ends_at: Timestamp;
  hard_delete_at: Timestamp;
  member_count: Generated<number>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  started_at: NullableTimestamp;
  ending_started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
}

export interface UserActiveTripTable {
  user_id: string;
  trip_id: string;
  acquired_at: GeneratedTimestamp;
}

export interface TripInviteTable {
  id: string;
  trip_id: string;
  invite_code_hmac: Uint8Array;
  expires_at: Timestamp;
  max_uses: number;
  uses_count: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  revoked_at: NullableTimestamp;
}

export interface TripMemberTable {
  left_incomplete: Generated<boolean>;
  leaving_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  left_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  sharing_paused_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  drained_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  sharing_pauses: ColumnType<
    readonly { from: string; until: string | null }[],
    readonly { from: string; until: string | null }[] | undefined,
    readonly { from: string; until: string | null }[]
  >;
  id: string;
  trip_id: string;
  user_id: string;
  participating_device_id: string;
  role: TripMemberRole;
  state: TripMemberState;
  key_epoch: number | null;
  full_photo_library_access: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  approved_at: NullableTimestamp;
  rejected_at: NullableTimestamp;
}

export interface TripKeyEnvelopeTable {
  trip_id: string;
  key_epoch: 1;
  recipient_device_id: string;
  sender_device_id: string;
  algorithm_version: 1;
  wrapped_key: Uint8Array;
  created_at: GeneratedTimestamp;
}

export interface UploadSessionTable {
  id: string;
  client_asset_id: string;
  trip_id: string;
  source_device_id: string;
  source_asset_key: string;
  media_type: MediaType;
  key_epoch: 1;
  encryption_version: 1;
  encrypted_manifest: Uint8Array;
  state: UploadSessionState;
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface UploadObjectTable {
  upload_session_id: string;
  variant: ObjectVariant;
  s3_key: string;
  expected_ciphertext_bytes: BigIntValue;
  expected_ciphertext_sha256: Uint8Array;
  etag: string | null;
  verified_at: NullableTimestamp;
}

export interface AssetTable {
  id: string;
  trip_id: string;
  source_device_id: string;
  source_asset_key: string;
  committed_at: Timestamp;
  media_type: MediaType;
  key_epoch: 1;
  encryption_version: 1;
  encrypted_manifest: Uint8Array;
  state: AssetState;
  purge_pending_at: NullableTimestamp;
  purged_at: NullableTimestamp;
  expired_at: NullableTimestamp;
}

export interface AssetObjectTable {
  asset_id: string;
  variant: ObjectVariant;
  s3_key: string;
  ciphertext_bytes: BigIntValue;
  ciphertext_sha256: Uint8Array;
  etag: string;
  created_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface DeliveryTable {
  id: string;
  asset_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  state: DeliveryState;
  available_at: Timestamp;
  saved_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export interface ReceiptTable {
  id: string;
  delivery_id: string;
  receipt_type: ReceiptType;
  client_event_id: string;
  client_observed_at: Timestamp;
  accepted_at: Timestamp;
}

export interface InboxEventTable {
  sequence: Generated<string>;
  recipient_device_id: string;
  trip_id: string;
  event_type: string;
  aggregate_id: string;
  available_at: Timestamp;
  payload: JsonObjectColumn;
  created_at: GeneratedTimestamp;
}

export interface OutboxEventTable {
  id: string;
  event_type: string;
  aggregate_id: string;
  dedupe_key: string;
  payload: JsonObjectColumn;
  available_at: Timestamp;
  published_at: NullableTimestamp;
  attempt_count: Generated<number>;
  last_error: string | null;
  created_at: GeneratedTimestamp;
}

export interface ApiIdempotencyTable {
  user_id: string;
  route_key: string;
  idempotency_key: string;
  request_sha256: Uint8Array;
  response_status: number;
  response_body: JsonObjectColumn;
  expires_at: Timestamp;
}

export interface AuditEventTable {
  id: string;
  trip_id: string | null;
  actor_user_id: string | null;
  actor_device_id: string | null;
  event_type: string;
  metadata: JsonObjectColumn;
  occurred_at: Timestamp;
}

export interface ClerkWebhookEventTable {
  event_id: string;
  event_type: string;
  processed_at: Timestamp;
}

export interface Database {
  users: UserTable;
  devices: DeviceTable;
  trips: TripTable;
  user_active_trips: UserActiveTripTable;
  trip_invites: TripInviteTable;
  trip_members: TripMemberTable;
  trip_key_envelopes: TripKeyEnvelopeTable;
  upload_sessions: UploadSessionTable;
  upload_objects: UploadObjectTable;
  assets: AssetTable;
  asset_objects: AssetObjectTable;
  deliveries: DeliveryTable;
  receipts: ReceiptTable;
  inbox_events: InboxEventTable;
  outbox_events: OutboxEventTable;
  api_idempotency: ApiIdempotencyTable;
  audit_events: AuditEventTable;
  clerk_webhook_events: ClerkWebhookEventTable;
}
