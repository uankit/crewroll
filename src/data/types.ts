/**
 * Persistence-facing records.
 *
 * These deliberately describe the durable shape instead of importing UI or
 * transport types. Application services can map them to richer domain models
 * without making SQLite depend on either layer.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TripStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'ARCHIVED';
export type SharingMode = 'REVIEW_FIRST' | 'AUTO_SHARE' | 'MANUAL';
export type LocationSharingMode = 'NONE' | 'APPROXIMATE' | 'EXACT';

export interface TripRecord {
  schemaVersion: number;
  id: string;
  name: string;
  createdByMemberId: string;
  createdAtMs: number;
  updatedAtMs: number;
  startsAtMs: number;
  endsAtMs: number | null;
  timeZone: string;
  status: TripStatus;
  defaultSharingMode: SharingMode;
  locationSharingMode: LocationSharingMode;
  targetReplicaCount: number;
  completeKeeperCount: number;
  membershipEpoch: number;
  isActive: boolean;
}

export interface MemberRecord {
  schemaVersion: number;
  id: string;
  tripId: string;
  deviceId: string;
  displayName: string;
  identityPublicKey: string;
  role: MemberRole;
  status: MemberStatus;
  replicaRole: ReplicaRole;
  joinedAtMs: number;
  updatedAtMs: number;
  leftAtMs: number | null;
  membershipEpoch: number;
}

export type MemberRole = 'ADMIN' | 'MEMBER';
export type MemberStatus = 'ACTIVE' | 'LEAVING' | 'LEFT' | 'REMOVED';
export type ReplicaRole = 'NONE' | 'KEEPER_PRIMARY' | 'KEEPER_SECONDARY' | 'WITNESS';

export type MediaLocation =
  | {
      kind: 'EXACT';
      latitudeE7: number;
      longitudeE7: number;
      accuracyMeters: number | null;
    }
  | { kind: 'APPROXIMATE'; cellId: string };

export type MediaShareStatus = 'PRIVATE' | 'QUEUED' | 'PUBLISHED' | 'TOMBSTONED';

export interface MediaRecord {
  schemaVersion: number;
  id: string;
  tripId: string;
  originMemberId: string;
  originDeviceId: string;
  originSequence: number;
  /** Local MediaLibrary/PHAsset identifier. Never exchanged as protocol identity. */
  sourceAssetId: string | null;
  /** Discovered through the OS photo library; no reliable cross-platform Camera-origin flag exists. */
  source: 'SYSTEM_LIBRARY';
  mediaType: 'IMAGE';
  shareStatus: MediaShareStatus;
  capturedAtMs: number;
  captureTimeZoneOffsetMinutes: number;
  captureLocalDate: string;
  ingestedAtMs: number;
  publishedAtMs: number | null;
  tombstonedAtMs: number | null;
  location: MediaLocation | null;
  originalResourceId: string;
  thumbnailResourceId: string | null;
}

export type ResourceKind = 'ORIGINAL' | 'THUMBNAIL';
export type ResourceAvailability = 'missing' | 'partial' | 'available';

export interface ResourceRecord {
  schemaVersion: number;
  id: string;
  tripId: string;
  mediaId: string;
  kind: ResourceKind;
  mimeType: string;
  fileExtension: string;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  createdAtMs: number;
  availability: ResourceAvailability;
  localUri: string | null;
  verifiedAtMs: number | null;
  updatedAtMs: number;
}

export interface ReplicaReceiptRecord {
  schemaVersion: number;
  id: string;
  tripId: string;
  mediaId: string;
  resourceId: string;
  holderMemberId: string;
  holderDeviceId: string;
  resourceSha256: string;
  resourceByteLength: number;
  status: 'VERIFIED' | 'RELEASED' | 'LOST';
  verifiedAtMs: number;
  updatedAtMs: number;
}

export interface SyncOperationRecord {
  schemaVersion: number;
  operationId: string;
  tripId: string;
  originDeviceId: string;
  originSequence: number;
  actorMemberId: string;
  membershipEpoch: number;
  createdAtMs: number;
  originIdentityPublicKey?: string | null;
  originSignature?: string | null;
  kind: SyncOperationKind;
  payload: JsonValue;
}

export type SyncOperationKind =
  | 'TRIP_CREATED'
  | 'TRIP_STATUS_CHANGED'
  | 'MEMBER_JOINED'
  | 'MEMBER_STATUS_CHANGED'
  | 'MEDIA_PREVIEW_PUBLISHED'
  | 'MEDIA_ORIGINAL_PUBLISHED'
  | 'MEDIA_PUBLISHED'
  | 'MEDIA_TOMBSTONED'
  | 'REPLICA_RECORDED'
  | 'REPLICA_STATUS_CHANGED';

export type OutboxState = 'pending' | 'in_flight' | 'delivered' | 'dead_letter';

export interface OutboxRecord {
  id: string;
  tripId: string;
  recipientMemberId: string | null;
  /** Control-plane message type. RESOURCE_CHUNK bytes belong in transfers, never JSON. */
  messageType: string;
  payload: JsonValue;
  dedupeKey: string | null;
  state: OutboxState;
  attemptCount: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TransferDirection = 'upload' | 'download';
export type TransferState =
  | 'queued'
  | 'transferring'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TransferRecord {
  id: string;
  tripId: string;
  resourceId: string;
  peerMemberId: string;
  direction: TransferDirection;
  state: TransferState;
  bytesTransferred: number;
  totalBytes: number;
  chunkSize: number;
  nextChunkIndex: number;
  attemptCount: number;
  lastError: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceSettingRecord<T extends JsonValue = JsonValue> {
  /** Non-secret preference key. Identity/private keys must stay in SecureStore. */
  key: string;
  value: T;
  updatedAt: number;
}
