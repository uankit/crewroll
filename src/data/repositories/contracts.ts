import type {
  DeviceSettingRecord,
  JsonValue,
  MediaRecord,
  MemberStatus,
  MemberRecord,
  OutboxRecord,
  ReplicaReceiptRecord,
  ResourceAvailability,
  ResourceKind,
  ResourceRecord,
  SyncOperationRecord,
  TransferRecord,
  TransferState,
  TripRecord,
} from '../types';

export interface TripRepository {
  upsert(trip: TripRecord): Promise<void>;
  getById(id: string): Promise<TripRecord | null>;
  getActive(): Promise<TripRecord | null>;
  list(): Promise<TripRecord[]>;
  setActive(id: string): Promise<void>;
  clearActive(): Promise<void>;
  remove(id: string): Promise<boolean>;
}

export interface MemberRepository {
  upsert(member: MemberRecord): Promise<void>;
  getById(tripId: string, memberId: string): Promise<MemberRecord | null>;
  getByDeviceId(tripId: string, deviceId: string): Promise<MemberRecord | null>;
  listByTrip(tripId: string): Promise<MemberRecord[]>;
  setStatus(
    tripId: string,
    memberId: string,
    status: MemberStatus,
    leftAtMs: number | null,
    membershipEpoch: number,
    updatedAtMs: number,
  ): Promise<void>;
}

export interface MediaRepository {
  upsert(media: MediaRecord): Promise<void>;
  getById(tripId: string, mediaId: string): Promise<MediaRecord | null>;
  getByOrigin(
    tripId: string,
    originDeviceId: string,
    originSequence: number,
  ): Promise<MediaRecord | null>;
  getBySourceAssetId(
    tripId: string,
    originDeviceId: string,
    sourceAssetId: string,
  ): Promise<MediaRecord | null>;
  listByTrip(
    tripId: string,
    options?: { originMemberId?: string; includeTombstoned?: boolean; limit?: number; offset?: number },
  ): Promise<MediaRecord[]>;
}

export interface GalleryCursor {
  capturedAtMs: number;
  mediaId: string;
}

export interface GalleryItemRecord {
  media: MediaRecord;
  thumbnail: ResourceRecord | null;
  original: ResourceRecord | null;
}

export interface GalleryPage {
  items: GalleryItemRecord[];
  nextCursor: GalleryCursor | null;
}

export interface GalleryRepository {
  listPage(
    tripId: string,
    options?: { limit?: number; cursor?: GalleryCursor | null },
  ): Promise<GalleryPage>;
}

export interface ResourceRepository {
  /** Immutable manifest upsert; verified local availability is sticky. */
  upsert(resource: ResourceRecord): Promise<void>;
  getById(tripId: string, resourceId: string): Promise<ResourceRecord | null>;
  listByTrip(tripId: string): Promise<ResourceRecord[]>;
  listByMedia(tripId: string, mediaId: string): Promise<ResourceRecord[]>;
  listUnavailable(
    tripId: string,
    limit?: number,
    after?: {
      readonly kind: ResourceKind;
      readonly createdAtMs: number;
      readonly id: string;
    } | null,
  ): Promise<ResourceRecord[]>;
  setLocalAvailability(
    tripId: string,
    resourceId: string,
    availability: ResourceAvailability,
    localUri: string | null,
    verifiedAtMs: number | null,
    updatedAtMs: number,
  ): Promise<void>;
  /**
   * Clears an available local copy only when a verifier observed the exact
   * URI/version that is still current. A concurrent replacement wins and the
   * method returns false instead of downgrading the newer verified copy.
   */
  markVerifiedLocalCopyLost(
    tripId: string,
    resourceId: string,
    expectedLocalUri: string,
    expectedVerifiedAtMs: number,
    expectedUpdatedAtMs: number,
    updatedAtMs: number,
  ): Promise<boolean>;
}

export interface ReplicaReceiptRepository {
  upsert(receipt: ReplicaReceiptRecord): Promise<void>;
  getById(tripId: string, receiptId: string): Promise<ReplicaReceiptRecord | null>;
  listByResource(tripId: string, resourceId: string): Promise<ReplicaReceiptRecord[]>;
  listByHolder(tripId: string, holderMemberId: string): Promise<ReplicaReceiptRecord[]>;
  countVerified(tripId: string, resourceId: string): Promise<number>;
}

export interface SyncOperationRepository {
  append(operation: SyncOperationRecord): Promise<boolean>;
  appendMany(operations: readonly SyncOperationRecord[]): Promise<number>;
  getById(tripId: string, operationId: string): Promise<SyncOperationRecord | null>;
  listRange(
    tripId: string,
    originDeviceId: string,
    afterSequence: number,
    throughSequence: number | null,
    limit: number,
  ): Promise<SyncOperationRecord[]>;
  getContiguousHighWaterMarks(tripId: string): Promise<Record<string, number>>;
}

export interface OutboxRepository {
  upsert(message: OutboxRecord): Promise<void>;
  getById(tripId: string, id: string): Promise<OutboxRecord | null>;
  countUndelivered(tripId: string): Promise<number>;
  /** Earliest pending availability or in-flight lease expiry; null when idle. */
  getNextWakeAt(tripId: string): Promise<number | null>;
  claimDue(
    tripId: string,
    nowMs: number,
    limit: number,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<OutboxRecord[]>;
  markDelivered(tripId: string, id: string, updatedAtMs: number): Promise<void>;
  reschedule(
    tripId: string,
    id: string,
    availableAtMs: number,
    lastError: string,
    updatedAtMs: number,
  ): Promise<void>;
  markDeadLetter(
    tripId: string,
    id: string,
    lastError: string,
    updatedAtMs: number,
  ): Promise<void>;
  removeDeliveredBefore(cutoffMs: number): Promise<number>;
  removeDeadLetterBefore(cutoffMs: number): Promise<number>;
}

export interface TransferRepository {
  /**
   * Inserts an attempt or advances an active one. Context is immutable,
   * checkpoints/time are monotonic, and terminal attempts cannot reopen.
   */
  upsert(transfer: TransferRecord): Promise<void>;
  getById(tripId: string, id: string): Promise<TransferRecord | null>;
  listActive(tripId: string): Promise<TransferRecord[]>;
  /** Presentation/history read. Unlike listActive, terminal attempts are retained. */
  listRecent(tripId: string, limit?: number): Promise<TransferRecord[]>;
  /** Deletes only terminal history older than the caller's retention cutoff. */
  removeTerminalBefore(cutoffMs: number): Promise<number>;
  updateProgress(
    tripId: string,
    id: string,
    bytesTransferred: number,
    nextChunkIndex: number,
    state: TransferState,
    updatedAtMs: number,
  ): Promise<void>;
  markPaused(
    tripId: string,
    id: string,
    reason: string,
    updatedAtMs: number,
  ): Promise<void>;
  markCancelled(
    tripId: string,
    id: string,
    reason: string,
    updatedAtMs: number,
  ): Promise<boolean>;
  markFailed(
    tripId: string,
    id: string,
    error: string,
    updatedAtMs: number,
  ): Promise<void>;
}

export interface DeviceSettingsRepository {
  get<T extends JsonValue = JsonValue>(key: string): Promise<DeviceSettingRecord<T> | null>;
  set<T extends JsonValue = JsonValue>(record: DeviceSettingRecord<T>): Promise<void>;
  remove(key: string): Promise<boolean>;
  list(): Promise<DeviceSettingRecord[]>;
}
