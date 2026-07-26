import { DOMAIN_SCHEMA_VERSION } from '../../core/constants';
import type { FrameIdentityAuthenticator } from '@/application/security/frameAuthenticity';
import { signSyncOperation } from '@/application/security/operationAuthenticity';
import {
  parseMediaItem,
  parseMediaResource,
  parseReplicaReceipt,
  parseSyncOperation,
  type MediaItem,
  type MediaResource,
  type ReplicaReceipt,
  type SyncOperation,
} from '../../core/domain';
import { CoreValidationError, type ParseResult } from '../../core/validation';
import type {
  DeviceSettingsRepository,
  MediaRepository,
  MemberRepository,
  OutboxRepository,
  ReplicaReceiptRepository,
  ResourceRepository,
  SyncOperationRepository,
  TripRepository,
} from '@/data/repositories/contracts';
import type {
  JsonValue,
  MediaRecord,
  MemberRecord,
  OutboxRecord,
  ReplicaReceiptRecord,
  ResourceRecord,
  SyncOperationRecord,
  TripRecord,
} from '@/data/types';
import type { ChunkedFileStore, StoredFile } from '@/platform/files';
import type {
  DeviceImageAsset,
  MediaGateway,
  MediaScanCursor,
  MediaScanFailure,
} from '@/platform/media';

import { createLocalMediaId, createResourceId, sha256Hex } from './contentIdentity';
import { hashFile } from './hashFile';
import { captureDateMetadata, imageFileMetadata } from './metadata';

export const MEDIA_OPERATION_OUTBOX_TYPE = 'SYNC_OPERATION';
const SCAN_CURSOR_KEY_PREFIX = 'media.scan-cursor.v1';
const DEFERRED_ASSETS_KEY_PREFIX = 'media.deferred-assets.v1';
const DEFAULT_MAX_PAGES = 20;
const MAX_DEFERRED_ASSETS = 5_000;
const MAX_INSERTED_ASSET_IDS = 200;
const MAX_DEFERRED_RETRIES_PER_PASS = 4;
const DEFERRED_RETRY_BASE_DELAY_MS = 2_000;
const DEFERRED_RETRY_MAX_DELAY_MS = 5 * 60_000;
const MAX_DEFERRED_ATTEMPT_COUNT = 31;
const textEncoder = new TextEncoder();

export type MediaIngestionStage =
  | 'scan'
  | 'deduplicate'
  | 'identity'
  | 'resolve-source'
  | 'copy-original'
  | 'hash-original'
  | 'thumbnail'
  | 'sequence'
  | 'validate'
  | 'persist';

export interface MediaIngestionFailure {
  assetId: string;
  stage: MediaIngestionStage;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export interface MediaIngestionWarning {
  assetId: string;
  stage: 'thumbnail';
  message: string;
  cause?: unknown;
}

export type MediaAssetIngestionOutcome =
  | {
      kind: 'published';
      assetId: string;
      mediaId: string;
      originalResourceId: string;
      thumbnailResourceId: string | null;
    }
  | {
      kind: 'private';
      assetId: string;
      mediaId: string;
      originalResourceId: string;
      thumbnailResourceId: string | null;
    }
  | {
      kind: 'duplicate';
      assetId: string;
      mediaId: string;
      existingShareStatus: MediaRecord['shareStatus'];
    }
  | {
      kind: 'excluded';
      assetId: string;
    };

export interface ScanAndIngestRequest {
  tripId: string;
  localMemberId: string;
  localDeviceId: string;
  /** MediaLibrary incremental IDs to hydrate and ingest before cursor scanning. */
  insertedAssetIds?: readonly string[];
  batchSize?: number;
  /** Bounds foreground work; defaults to 20 pages. */
  maxPages?: number;
  /** Runs after the durable thumbnail announcement commits, before original processing. */
  onPreviewPublished?: (outcome: {
    mediaId: string;
    thumbnailResourceId: string;
  }) => Promise<void> | void;
}

export interface ScanAndIngestResult {
  tripId: string;
  sharingMode: 'AUTO_SHARE' | 'REVIEW_FIRST';
  initialCursor: MediaScanCursor | null;
  persistedCursor: MediaScanCursor | null;
  pagesScanned: number;
  excludedScreenshotCount: number;
  outcomes: MediaAssetIngestionOutcome[];
  failures: MediaIngestionFailure[];
  warnings: MediaIngestionWarning[];
  hasMore: boolean;
  /** A failed page deliberately retains its old cursor for safe retry. */
  stoppedAtFailure: boolean;
  /** Retryable assets (for example iCloud-only originals) that no longer block newer photos. */
  deferredAssetCount: number;
  /** Earliest durable retry time, used by the runtime to wake without polling. */
  nextDeferredRetryAtMs: number | null;
}

export interface MonotonicSequenceRequest {
  tripId: string;
  originDeviceId: string;
  /** The allocator must return the same sequence when this key is retried. */
  idempotencyKey: string;
}

/**
 * A durable, idempotent monotonic allocator. Media and operation sequences use
 * separate injected instances so neither stream can create gaps in the other.
 */
export interface MonotonicSequenceAllocator {
  allocate(request: MonotonicSequenceRequest): Promise<number>;
}

export interface MediaIngestionIdFactory {
  mediaId(deviceId: string, sourceAssetId: string): string;
  resourceId(mediaId: string, kind: 'ORIGINAL' | 'THUMBNAIL'): string;
  replicaReceiptId(resourceId: string, holderDeviceId: string): string;
  operationId(mediaId: string, originDeviceId: string): string;
  originalOperationId(mediaId: string, originDeviceId: string): string;
  replicaOperationId(receiptId: string, originDeviceId: string): string;
  outboxId(operationId: string): string;
}

export interface MediaIngestionClock {
  nowMs(): number;
}

export interface MediaIngestionRepositories {
  trips: Pick<TripRepository, 'getById'>;
  members: Pick<MemberRepository, 'getById'>;
  media: Pick<MediaRepository, 'getBySourceAssetId' | 'upsert'>;
  resources: Pick<ResourceRepository, 'getById' | 'upsert'>;
  replicaReceipts: Pick<ReplicaReceiptRepository, 'upsert'>;
  syncOperations: Pick<SyncOperationRepository, 'append'>;
  outbox: Pick<OutboxRepository, 'upsert'>;
  deviceSettings: Pick<DeviceSettingsRepository, 'get' | 'set'>;
}

export interface MediaIngestionPersistence {
  repositories: MediaIngestionRepositories;
  transaction<T>(task: (repositories: MediaIngestionRepositories) => Promise<T>): Promise<T>;
}

export interface MediaIngestionDependencies {
  persistence: MediaIngestionPersistence;
  mediaGateway: MediaGateway;
  fileStore: ChunkedFileStore;
  mediaSequenceAllocator: MonotonicSequenceAllocator;
  operationSequenceAllocator: MonotonicSequenceAllocator;
  identity: Pick<FrameIdentityAuthenticator, 'sign'>;
  ids?: MediaIngestionIdFactory;
  clock?: MediaIngestionClock;
}

export class MediaIngestionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaIngestionConfigurationError';
  }
}

export class MediaLibraryPermissionError extends Error {
  constructor(access: string) {
    super(`Photo-library read access is required; current access is '${access}'.`);
    this.name = 'MediaLibraryPermissionError';
  }
}

export class MediaScanCursorError extends Error {
  constructor(key: string) {
    super(`Persisted media scan cursor '${key}' is malformed.`);
    this.name = 'MediaScanCursorError';
  }
}

export class MediaDeferredQueueError extends Error {
  constructor(key: string) {
    super(`Persisted deferred media queue '${key}' is malformed.`);
    this.name = 'MediaDeferredQueueError';
  }
}

class AssetStageError extends Error {
  constructor(
    readonly assetId: string,
    readonly stage: MediaIngestionStage,
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AssetStageError';
  }
}

interface AssetPipelineResult {
  outcome: MediaAssetIngestionOutcome;
  warnings: MediaIngestionWarning[];
}

interface PreparedResource {
  domain: MediaResource;
  record: ResourceRecord;
}

interface DeferredAssetRetry {
  asset: DeviceImageAsset;
  attemptCount: number;
  nextAttemptAtMs: number;
  lastFailureStage: MediaIngestionStage;
}

type MediaPreviewPublishedOperation = Extract<
  SyncOperation,
  { kind: 'MEDIA_PREVIEW_PUBLISHED' }
>;
type MediaOriginalPublishedOperation = Extract<
  SyncOperation,
  { kind: 'MEDIA_ORIGINAL_PUBLISHED' }
>;
type ReplicaRecordedOperation = Extract<SyncOperation, { kind: 'REPLICA_RECORDED' }>;

type IngestibleTrip = Omit<TripRecord, 'defaultSharingMode'> & {
  defaultSharingMode: 'AUTO_SHARE' | 'REVIEW_FIRST';
};

export class MediaIngestionService {
  private readonly persistence: MediaIngestionPersistence;
  private readonly mediaGateway: MediaGateway;
  private readonly fileStore: ChunkedFileStore;
  private readonly mediaSequenceAllocator: MonotonicSequenceAllocator;
  private readonly operationSequenceAllocator: MonotonicSequenceAllocator;
  private readonly identity: Pick<FrameIdentityAuthenticator, 'sign'>;
  private readonly ids: MediaIngestionIdFactory;
  private readonly clock: MediaIngestionClock;

  constructor(dependencies: MediaIngestionDependencies) {
    this.persistence = dependencies.persistence;
    this.mediaGateway = dependencies.mediaGateway;
    this.fileStore = dependencies.fileStore;
    this.mediaSequenceAllocator = dependencies.mediaSequenceAllocator;
    this.operationSequenceAllocator = dependencies.operationSequenceAllocator;
    this.identity = dependencies.identity;
    this.ids = dependencies.ids ?? defaultMediaIngestionIdFactory;
    this.clock = dependencies.clock ?? systemMediaIngestionClock;
  }

  async excludeSourceAsset(request: {
    tripId: string;
    localDeviceId: string;
    assetId: string;
  }): Promise<void> {
    if (!request.tripId.trim() || !request.localDeviceId.trim() || !request.assetId.trim()) {
      throw new MediaIngestionConfigurationError(
        'tripId, localDeviceId, and assetId are required to exclude a saved image.',
      );
    }
    await this.persistence.repositories.deviceSettings.set({
      key: excludedSourceAssetKey(request.tripId, request.localDeviceId, request.assetId),
      value: true,
      updatedAt: checkedNow(this.clock),
    });
  }

  async scanAndIngest(request: ScanAndIngestRequest): Promise<ScanAndIngestResult> {
    const maxPages = positiveInteger(request.maxPages ?? DEFAULT_MAX_PAGES, 'maxPages');
    const insertedAssetIds = normalizeInsertedAssetIds(request.insertedAssetIds);
    const { trip, member } = await this.loadContext(request);

    const permission = await this.mediaGateway.getPermissionState();
    if (!permission.granted) {
      throw new MediaLibraryPermissionError(permission.access);
    }

    const cursorKey = mediaScanCursorSettingKey(trip.id, request.localDeviceId);
    const deferredKey = deferredAssetsSettingKey(trip.id, request.localDeviceId);
    const initialCursor = await this.loadCursor(cursorKey);
    let persistedCursor = initialCursor;
    let scanCursor = initialCursor;
    let pagesScanned = 0;
    let excludedScreenshotCount = 0;
    let hasMore = false;
    const stoppedAtFailure = false;
    const outcomes: MediaAssetIngestionOutcome[] = [];
    const failures: MediaIngestionFailure[] = [];
    const warnings: MediaIngestionWarning[] = [];
    const deferredAssets = new Map(
      (await this.loadDeferredAssets(deferredKey)).map((retry) => [retry.asset.assetId, retry]),
    );
    const attemptedAssetIds = new Set<string>();

    const processAsset = async (asset: DeviceImageAsset, forceRetry = false): Promise<void> => {
      if (attemptedAssetIds.has(asset.assetId)) return;
      const deferred = deferredAssets.get(asset.assetId);
      if (!forceRetry && deferred && deferred.nextAttemptAtMs > checkedNow(this.clock)) return;
      attemptedAssetIds.add(asset.assetId);
      try {
        const result = await this.ingestAsset(
          trip,
          member.id,
          request.localDeviceId,
          member.identityPublicKey,
          asset,
          request.onPreviewPublished,
        );
        outcomes.push(result.outcome);
        warnings.push(...result.warnings);
        deferredAssets.delete(asset.assetId);
        removeRetryableFailures(failures, asset.assetId);
      } catch (error) {
        const failure = mapAssetFailure(asset.assetId, error);
        failures.push(failure);
        if (failure.retryable) {
          deferredAssets.set(
            asset.assetId,
            nextDeferredRetry(deferred, asset, failure.stage, checkedNow(this.clock)),
          );
        } else {
          await this.excludeSourceAsset({
            tripId: trip.id,
            localDeviceId: request.localDeviceId,
            assetId: asset.assetId,
          });
          deferredAssets.delete(asset.assetId);
        }
      }
    };

    const recordDiscoveryFailure = (failure: MediaScanFailure): void => {
      if (attemptedAssetIds.has(failure.assetId)) return;
      const mapped = mapScanFailure(failure);
      failures.push(mapped);
      if (failure.retryable && failure.asset) {
        const existing = deferredAssets.get(failure.assetId);
        deferredAssets.set(
          failure.assetId,
          nextDeferredRetry(existing, failure.asset, mapped.stage, checkedNow(this.clock)),
        );
      }
    };

    // iOS supplies inserted IDs. Resolve those first so a new capture never
    // waits behind cursor catch-up or a large deferred retry queue.
    if (insertedAssetIds.length > 0) {
      const inserted = await this.mediaGateway.getImageAssetsByIds(insertedAssetIds);
      excludedScreenshotCount += inserted.excludedScreenshotCount;
      for (const failure of inserted.failures) recordDiscoveryFailure(failure);
      for (const asset of inserted.assets) {
        if (asset.capturedAtMs >= trip.startsAtMs) await processAsset(asset, true);
      }
      await this.persistDeferredAssets(deferredKey, deferredAssets.values());
    }

    // Advance discovery before touching old retries. This preserves the hot
    // path on Android, whose MediaLibrary change event cannot provide IDs.
    while (pagesScanned < maxPages) {
      const page = await this.mediaGateway.scanPage({
        canonicalTripStartMs: trip.startsAtMs,
        cursor: scanCursor,
        batchSize: request.batchSize,
      });
      pagesScanned += 1;
      excludedScreenshotCount += page.excludedScreenshotCount;
      hasMore = page.hasMore;

      for (const failure of page.failures) recordDiscoveryFailure(failure);
      for (const asset of page.assets) await processAsset(asset);

      await this.persistScanState(
        cursorKey,
        page.nextCursor,
        deferredKey,
        deferredAssets.values(),
      );
      persistedCursor = page.nextCursor;
      scanCursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    // Retry only a small due batch. Exponential durable backoff prevents each
    // library event from reprocessing the entire queue (the former O(N²) path).
    const dueRetries = [...deferredAssets.values()]
      .filter(
        (retry) =>
          !attemptedAssetIds.has(retry.asset.assetId) &&
          retry.nextAttemptAtMs <= checkedNow(this.clock),
      )
      .sort(compareDeferredRetries)
      .slice(0, MAX_DEFERRED_RETRIES_PER_PASS);
    for (const retry of dueRetries) await processAsset(retry.asset, true);
    await this.persistDeferredAssets(deferredKey, deferredAssets.values());

    return {
      tripId: trip.id,
      sharingMode: trip.defaultSharingMode,
      initialCursor,
      persistedCursor,
      pagesScanned,
      excludedScreenshotCount,
      outcomes,
      failures,
      warnings,
      hasMore,
      stoppedAtFailure,
      deferredAssetCount: deferredAssets.size,
      nextDeferredRetryAtMs: earliestDeferredRetryAt(deferredAssets.values()),
    };
  }

  private async loadContext(request: ScanAndIngestRequest): Promise<{
    trip: IngestibleTrip;
    member: MemberRecord;
  }> {
    const trip = await this.persistence.repositories.trips.getById(request.tripId);
    if (!trip) {
      throw new MediaIngestionConfigurationError(`Trip '${request.tripId}' was not found.`);
    }
    if (!trip.isActive || trip.status !== 'ACTIVE') {
      throw new MediaIngestionConfigurationError('Media ingestion requires the active trip.');
    }

    const member = await this.persistence.repositories.members.getById(
      request.tripId,
      request.localMemberId,
    );
    if (!member || member.deviceId !== request.localDeviceId || member.status !== 'ACTIVE') {
      throw new MediaIngestionConfigurationError(
        'The local ACTIVE member does not match the requested device.',
      );
    }
    if (trip.defaultSharingMode === 'MANUAL') {
      throw new MediaIngestionConfigurationError('MANUAL trips cannot scan automatically.');
    }
    return { trip: trip as IngestibleTrip, member };
  }

  private async ingestAsset(
    trip: IngestibleTrip,
    localMemberId: string,
    localDeviceId: string,
    localIdentityPublicKey: string,
    asset: DeviceImageAsset,
    onPreviewPublished?: ScanAndIngestRequest['onPreviewPublished'],
  ): Promise<AssetPipelineResult> {
    const excluded = await atStage(asset.assetId, 'deduplicate', true, () =>
      this.persistence.repositories.deviceSettings.get<boolean>(
        excludedSourceAssetKey(trip.id, localDeviceId, asset.assetId),
      ),
    );
    if (excluded?.value === true) {
      return { outcome: { kind: 'excluded', assetId: asset.assetId }, warnings: [] };
    }

    const existing = await atStage(asset.assetId, 'deduplicate', true, () =>
      this.persistence.repositories.media.getBySourceAssetId(
        trip.id,
        localDeviceId,
        asset.assetId,
      ),
    );
    if (existing) {
      if (existing.shareStatus === 'PUBLISHED') {
        const original = await atStage(asset.assetId, 'deduplicate', true, () =>
          this.persistence.repositories.resources.getById(
            trip.id,
            existing.originalResourceId,
          ),
        );
        if (!original) {
          const source = await atStage(asset.assetId, 'resolve-source', true, () =>
            this.mediaGateway.resolveReadableSource(asset.assetId),
          );
          if (!source.locallyAvailable || !source.uri) {
            throw new AssetStageError(
              asset.assetId,
              'resolve-source',
              true,
              'The original is not available locally; CrewRoll will not download it from cloud storage.',
            );
          }
          return this.completeAutoSharedOriginal({
            trip,
            localMemberId,
            localDeviceId,
            localIdentityPublicKey,
            asset,
            item: toDomainMediaItem(existing),
            sourceUri: source.uri,
            createdAtMs: existing.ingestedAtMs,
          });
        }
      }
      return {
        outcome: {
          kind: 'duplicate',
          assetId: asset.assetId,
          mediaId: existing.id,
          existingShareStatus: existing.shareStatus,
        },
        warnings: [],
      };
    }

    const width = positiveDimension(asset.width, 'width', asset.assetId);
    const height = positiveDimension(asset.height, 'height', asset.assetId);
    const mediaId = await atStage(asset.assetId, 'identity', false, async () =>
      this.ids.mediaId(localDeviceId, asset.assetId),
    );
    const originalResourceId = await atStage(asset.assetId, 'identity', false, async () =>
      this.ids.resourceId(mediaId, 'ORIGINAL'),
    );
    const desiredThumbnailResourceId = await atStage(
      asset.assetId,
      'identity',
      false,
      async () => this.ids.resourceId(mediaId, 'THUMBNAIL'),
    );

    const source = await atStage(asset.assetId, 'resolve-source', true, () =>
      this.mediaGateway.resolveReadableSource(asset.assetId),
    );
    if (!source.locallyAvailable || !source.uri) {
      throw new AssetStageError(
        asset.assetId,
        'resolve-source',
        true,
        'The original is not available locally; CrewRoll will not download it from cloud storage.',
      );
    }

    const fileMetadata = imageFileMetadata(asset.filename, source.uri);
    if (trip.defaultSharingMode === 'AUTO_SHARE') {
      return this.ingestAutoSharedAsset({
        trip,
        localMemberId,
        localDeviceId,
        localIdentityPublicKey,
        asset,
        mediaId,
        originalResourceId,
        thumbnailResourceId: desiredThumbnailResourceId,
        sourceUri: source.uri,
        onPreviewPublished,
      });
    }
    const storedOriginal = await atStage(asset.assetId, 'copy-original', true, async () => {
      const cached = this.fileStore.getOriginal(originalResourceId, fileMetadata.extension);
      return cached ?? this.fileStore.copyOriginalExact({
        sourceUri: source.uri!,
        storageKey: originalResourceId,
        extension: fileMetadata.extension,
      });
    });
    const ingestedAtMs = checkedNow(this.clock);
    // Hashing the exact original and rendering its preview are independent
    // native/file-system workloads. Running them together removes a serial
    // delay from the live-share hot path without weakening exact-byte checks.
    // Thumbnail failure remains retryable and blocks the immutable publish
    // operation; otherwise peers would receive a permanent preview-less item.
    const [originalDigest, thumbnail] = await Promise.all([
      atStage(asset.assetId, 'hash-original', true, () =>
        hashFile(this.fileStore, storedOriginal.uri),
      ),
      this.prepareThumbnail(
        asset.assetId,
        trip.id,
        mediaId,
        desiredThumbnailResourceId,
        storedOriginal.uri,
        ingestedAtMs,
      ),
    ]);
    assertStoredSize(asset.assetId, storedOriginal, originalDigest.byteLength);

    const original = await atStage(asset.assetId, 'validate', false, async () => {
      const domain = expectValid(
        parseMediaResource({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: originalResourceId,
          tripId: trip.id,
          mediaId,
          kind: 'ORIGINAL',
          mimeType: fileMetadata.mimeType,
          fileExtension: fileMetadata.extension,
          byteLength: originalDigest.byteLength,
          sha256: originalDigest.sha256,
          width,
          height,
          createdAtMs: ingestedAtMs,
        }),
        'original resource',
      );
      return prepareResource(domain, storedOriginal.uri, ingestedAtMs);
    });

    const mediaSequence = await atStage(asset.assetId, 'sequence', true, async () =>
      positiveInteger(
        await this.mediaSequenceAllocator.allocate({
          tripId: trip.id,
          originDeviceId: localDeviceId,
          idempotencyKey: `media:${asset.assetId}`,
        }),
        'media sequence',
      ),
    );
    const capture = await atStage(asset.assetId, 'validate', false, async () =>
      captureDateMetadata(asset.capturedAtMs),
    );
    const domainMedia = await atStage(asset.assetId, 'validate', false, async () =>
      expectValid(
        parseMediaItem({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: mediaId,
          tripId: trip.id,
          originMemberId: localMemberId,
          originDeviceId: localDeviceId,
          originSequence: mediaSequence,
          source: 'SYSTEM_LIBRARY',
          mediaType: 'IMAGE',
          shareStatus: 'PRIVATE',
          capturedAtMs: asset.capturedAtMs,
          captureTimeZoneOffsetMinutes: capture.timeZoneOffsetMinutes,
          captureLocalDate: capture.localDate,
          ingestedAtMs,
          publishedAtMs: null,
          tombstonedAtMs: null,
          // Location access is intentionally absent from this service.
          location: null,
          originalResourceId: original.domain.id,
          thumbnailResourceId: thumbnail.domain.id,
        }),
        'media item',
      ),
    );
    const mediaRecord = toMediaRecord(domainMedia, asset.assetId);

    await atStage(asset.assetId, 'persist', true, () =>
      this.persistence.transaction(async (repositories) => {
        await repositories.media.upsert(mediaRecord);
        await repositories.resources.upsert(original.record);
        await repositories.resources.upsert(thumbnail.record);
      }),
    );
    return {
      outcome: {
        kind: 'private',
        assetId: asset.assetId,
        mediaId,
        originalResourceId: original.domain.id,
        thumbnailResourceId: thumbnail.domain.id,
      },
      warnings: [],
    };
  }

  private async ingestAutoSharedAsset(input: {
    trip: IngestibleTrip;
    localMemberId: string;
    localDeviceId: string;
    localIdentityPublicKey: string;
    asset: DeviceImageAsset;
    mediaId: string;
    originalResourceId: string;
    thumbnailResourceId: string;
    sourceUri: string;
    onPreviewPublished?: ScanAndIngestRequest['onPreviewPublished'];
  }): Promise<AssetPipelineResult> {
    const {
      trip,
      localMemberId,
      localDeviceId,
      localIdentityPublicKey,
      asset,
      mediaId,
      originalResourceId,
      thumbnailResourceId,
      sourceUri,
      onPreviewPublished,
    } = input;
    const ingestedAtMs = checkedNow(this.clock);
    const thumbnail = await this.prepareThumbnail(
      asset.assetId,
      trip.id,
      mediaId,
      thumbnailResourceId,
      sourceUri,
      ingestedAtMs,
    );
    const mediaSequence = await atStage(asset.assetId, 'sequence', true, async () =>
      positiveInteger(
        await this.mediaSequenceAllocator.allocate({
          tripId: trip.id,
          originDeviceId: localDeviceId,
          idempotencyKey: `media:${asset.assetId}`,
        }),
        'media sequence',
      ),
    );
    const capture = await atStage(asset.assetId, 'validate', false, async () =>
      captureDateMetadata(asset.capturedAtMs),
    );
    const item = await atStage(asset.assetId, 'validate', false, async () =>
      expectValid(
        parseMediaItem({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: mediaId,
          tripId: trip.id,
          originMemberId: localMemberId,
          originDeviceId: localDeviceId,
          originSequence: mediaSequence,
          source: 'SYSTEM_LIBRARY',
          mediaType: 'IMAGE',
          shareStatus: 'PUBLISHED',
          capturedAtMs: asset.capturedAtMs,
          captureTimeZoneOffsetMinutes: capture.timeZoneOffsetMinutes,
          captureLocalDate: capture.localDate,
          ingestedAtMs,
          publishedAtMs: ingestedAtMs,
          tombstonedAtMs: null,
          location: null,
          originalResourceId,
          thumbnailResourceId: thumbnail.domain.id,
        }),
        'preview media item',
      ),
    );
    const previewSequence = await atStage(asset.assetId, 'sequence', true, async () =>
      positiveInteger(
        await this.operationSequenceAllocator.allocate({
          tripId: trip.id,
          originDeviceId: localDeviceId,
          idempotencyKey: `MEDIA_PREVIEW_PUBLISHED:${mediaId}`,
        }),
        'preview operation sequence',
      ),
    );
    const previewOperation = await this.createPreviewOperation(
      asset.assetId,
      trip,
      localMemberId,
      localDeviceId,
      localIdentityPublicKey,
      mediaId,
      previewSequence,
      item,
      thumbnail.domain,
      ingestedAtMs,
    );
    await atStage(asset.assetId, 'persist', true, () =>
      this.persistence.transaction(async (repositories) => {
        await repositories.media.upsert(toMediaRecord(item, asset.assetId));
        await repositories.resources.upsert(thumbnail.record);
        await repositories.syncOperations.append(toOperationRecord(previewOperation));
        await repositories.outbox.upsert(this.createOutbox(previewOperation, ingestedAtMs));
      }),
    );

    // The preview is now durable and independently syncable. A flush failure
    // must not roll it back or prevent exact-original recovery on the next pass.
    try {
      await onPreviewPublished?.({
        mediaId,
        thumbnailResourceId: thumbnail.domain.id,
      });
    } catch {
      // The normal scan completion flush and durable outbox retry remain active.
    }

    return this.completeAutoSharedOriginal({
      trip,
      localMemberId,
      localDeviceId,
      localIdentityPublicKey,
      asset,
      item,
      sourceUri,
      createdAtMs: ingestedAtMs,
    });
  }

  private async completeAutoSharedOriginal(input: {
    trip: IngestibleTrip;
    localMemberId: string;
    localDeviceId: string;
    localIdentityPublicKey: string;
    asset: DeviceImageAsset;
    item: MediaItem;
    sourceUri: string;
    createdAtMs: number;
  }): Promise<AssetPipelineResult> {
    const {
      trip,
      localMemberId,
      localDeviceId,
      localIdentityPublicKey,
      asset,
      item,
      sourceUri,
      createdAtMs,
    } = input;
    const fileMetadata = imageFileMetadata(asset.filename, sourceUri);
    const storedOriginal = await atStage(asset.assetId, 'copy-original', true, async () => {
      const cached = this.fileStore.getOriginal(item.originalResourceId, fileMetadata.extension);
      return cached ?? this.fileStore.copyOriginalExact({
        sourceUri,
        storageKey: item.originalResourceId,
        extension: fileMetadata.extension,
      });
    });
    const originalDigest = await atStage(asset.assetId, 'hash-original', true, () =>
      hashFile(this.fileStore, storedOriginal.uri),
    );
    assertStoredSize(asset.assetId, storedOriginal, originalDigest.byteLength);
    const original = await atStage(asset.assetId, 'validate', false, async () => {
      const domain = expectValid(
        parseMediaResource({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: item.originalResourceId,
          tripId: trip.id,
          mediaId: item.id,
          kind: 'ORIGINAL',
          mimeType: fileMetadata.mimeType,
          fileExtension: fileMetadata.extension,
          byteLength: originalDigest.byteLength,
          sha256: originalDigest.sha256,
          width: positiveDimension(asset.width, 'width', asset.assetId),
          height: positiveDimension(asset.height, 'height', asset.assetId),
          createdAtMs,
        }),
        'original resource',
      );
      return prepareResource(domain, storedOriginal.uri, checkedNow(this.clock));
    });
    const nowMs = checkedNow(this.clock);
    const originalSequence = await atStage(asset.assetId, 'sequence', true, async () =>
      positiveInteger(
        await this.operationSequenceAllocator.allocate({
          tripId: trip.id,
          originDeviceId: localDeviceId,
          idempotencyKey: `MEDIA_ORIGINAL_PUBLISHED:${item.id}`,
        }),
        'original operation sequence',
      ),
    );
    const originalOperation = await this.createOriginalOperation(
      asset.assetId,
      trip,
      localMemberId,
      localDeviceId,
      localIdentityPublicKey,
      item.id,
      originalSequence,
      original.domain,
      nowMs,
    );
    const receipt = await this.createReceipt(
      asset.assetId,
      trip.id,
      localMemberId,
      localDeviceId,
      item.id,
      original.domain,
      nowMs,
    );
    const receiptSequence = await atStage(asset.assetId, 'sequence', true, async () =>
      positiveInteger(
        await this.operationSequenceAllocator.allocate({
          tripId: trip.id,
          originDeviceId: localDeviceId,
          idempotencyKey: `REPLICA_RECORDED:${receipt.id}`,
        }),
        'receipt operation sequence',
      ),
    );
    const receiptOperation = await this.createReceiptOperation(
      asset.assetId,
      trip,
      localMemberId,
      localDeviceId,
      localIdentityPublicKey,
      receipt,
      receiptSequence,
      nowMs,
    );
    // Even without the live preview callback, durable outbox ordering must
    // preserve catalog dependencies: preview -> original manifest -> receipt.
    const originalOutboxAtMs = Math.max(nowMs, createdAtMs + 1);
    const receiptOutboxAtMs = originalOutboxAtMs + 1;
    await atStage(asset.assetId, 'persist', true, () =>
      this.persistence.transaction(async (repositories) => {
        await repositories.resources.upsert(original.record);
        await repositories.replicaReceipts.upsert(toReceiptRecord(receipt));
        await repositories.syncOperations.append(toOperationRecord(originalOperation));
        await repositories.syncOperations.append(toOperationRecord(receiptOperation));
        await repositories.outbox.upsert(
          this.createOutbox(originalOperation, originalOutboxAtMs),
        );
        await repositories.outbox.upsert(
          this.createOutbox(receiptOperation, receiptOutboxAtMs),
        );
      }),
    );
    return {
      outcome: {
        kind: 'published',
        assetId: asset.assetId,
        mediaId: item.id,
        originalResourceId: original.domain.id,
        thumbnailResourceId: item.thumbnailResourceId,
      },
      warnings: [],
    };
  }

  private async prepareThumbnail(
    assetId: string,
    tripId: string,
    mediaId: string,
    thumbnailResourceId: string,
    originalUri: string,
    createdAtMs: number,
  ): Promise<PreparedResource> {
    return atStage(assetId, 'thumbnail', true, async () => {
      // Regeneration is intentional: a crash after file creation but before
      // SQLite commit leaves a cached thumbnail whose dimensions are unknown.
      const stored = await this.fileStore.createThumbnail({
        sourceUri: originalUri,
        storageKey: thumbnailResourceId,
        overwrite: true,
      });
      const width = positiveDimension(stored.width, 'thumbnail width', assetId);
      const height = positiveDimension(stored.height, 'thumbnail height', assetId);
      const digest = await hashFile(this.fileStore, stored.uri);
      assertStoredSize(assetId, stored, digest.byteLength);
      const domain = expectValid(
        parseMediaResource({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: thumbnailResourceId,
          tripId,
          mediaId,
          kind: 'THUMBNAIL',
          mimeType: 'image/jpeg',
          fileExtension: 'jpg',
          byteLength: digest.byteLength,
          sha256: digest.sha256,
          width,
          height,
          createdAtMs,
        }),
        'thumbnail resource',
      );
      return prepareResource(domain, stored.uri, createdAtMs);
    });
  }

  private async createReceipt(
    assetId: string,
    tripId: string,
    localMemberId: string,
    localDeviceId: string,
    mediaId: string,
    original: MediaResource,
    nowMs: number,
  ): Promise<ReplicaReceipt> {
    return atStage(assetId, 'validate', false, async () =>
      expectValid(
        parseReplicaReceipt({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: this.ids.replicaReceiptId(original.id, localDeviceId),
          tripId,
          mediaId,
          resourceId: original.id,
          holderMemberId: localMemberId,
          holderDeviceId: localDeviceId,
          resourceSha256: original.sha256,
          resourceByteLength: original.byteLength,
          status: 'VERIFIED',
          verifiedAtMs: nowMs,
          updatedAtMs: nowMs,
        }),
        'replica receipt',
      ),
    );
  }

  private async createPreviewOperation(
    assetId: string,
    trip: TripRecord,
    localMemberId: string,
    localDeviceId: string,
    localIdentityPublicKey: string,
    mediaId: string,
    operationSequence: number,
    item: MediaItem,
    thumbnail: MediaResource,
    nowMs: number,
  ): Promise<MediaPreviewPublishedOperation> {
    return atStage(assetId, 'validate', false, async () => {
      const operation = expectValid(
        parseSyncOperation({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          operationId: this.ids.operationId(mediaId, localDeviceId),
          tripId: trip.id,
          originDeviceId: localDeviceId,
          originSequence: operationSequence,
          actorMemberId: localMemberId,
          membershipEpoch: trip.membershipEpoch,
          createdAtMs: nowMs,
          kind: 'MEDIA_PREVIEW_PUBLISHED',
          payload: { item, resources: [thumbnail] },
        }),
        'MEDIA_PREVIEW_PUBLISHED operation',
      );
      if (operation.kind !== 'MEDIA_PREVIEW_PUBLISHED') {
        throw new Error('Validated operation unexpectedly changed kind.');
      }
      return signSyncOperation(operation, localIdentityPublicKey, this.identity);
    });
  }

  private async createOriginalOperation(
    assetId: string,
    trip: TripRecord,
    localMemberId: string,
    localDeviceId: string,
    localIdentityPublicKey: string,
    mediaId: string,
    operationSequence: number,
    resource: MediaResource,
    nowMs: number,
  ): Promise<MediaOriginalPublishedOperation> {
    return atStage(assetId, 'validate', false, async () => {
      const operation = expectValid(
        parseSyncOperation({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          operationId: this.ids.originalOperationId(mediaId, localDeviceId),
          tripId: trip.id,
          originDeviceId: localDeviceId,
          originSequence: operationSequence,
          actorMemberId: localMemberId,
          membershipEpoch: trip.membershipEpoch,
          createdAtMs: nowMs,
          kind: 'MEDIA_ORIGINAL_PUBLISHED',
          payload: { mediaId, resource },
        }),
        'MEDIA_ORIGINAL_PUBLISHED operation',
      );
      if (operation.kind !== 'MEDIA_ORIGINAL_PUBLISHED') {
        throw new Error('Validated operation unexpectedly changed kind.');
      }
      return signSyncOperation(operation, localIdentityPublicKey, this.identity);
    });
  }

  private createOutbox(operation: SyncOperation, nowMs: number): OutboxRecord {
    return {
      id: this.ids.outboxId(operation.operationId),
      tripId: operation.tripId,
      recipientMemberId: null,
      messageType: MEDIA_OPERATION_OUTBOX_TYPE,
      payload: operation as unknown as JsonValue,
      dedupeKey: `operation:${operation.operationId}`,
      state: 'pending',
      attemptCount: 0,
      availableAt: nowMs,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
  }

  private async createReceiptOperation(
    assetId: string,
    trip: TripRecord,
    localMemberId: string,
    localDeviceId: string,
    localIdentityPublicKey: string,
    receipt: ReplicaReceipt,
    operationSequence: number,
    nowMs: number,
  ): Promise<ReplicaRecordedOperation> {
    return atStage(assetId, 'validate', false, async () => {
      const operation = expectValid(
        parseSyncOperation({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          operationId: this.ids.replicaOperationId(receipt.id, localDeviceId),
          tripId: trip.id,
          originDeviceId: localDeviceId,
          originSequence: operationSequence,
          actorMemberId: localMemberId,
          membershipEpoch: trip.membershipEpoch,
          createdAtMs: nowMs,
          kind: 'REPLICA_RECORDED',
          payload: { receipt },
        }),
        'REPLICA_RECORDED operation',
      );
      if (operation.kind !== 'REPLICA_RECORDED') {
        throw new Error('Validated receipt operation unexpectedly changed kind.');
      }
      return signSyncOperation(operation, localIdentityPublicKey, this.identity);
    });
  }

  private async loadCursor(key: string): Promise<MediaScanCursor | null> {
    const setting = await this.persistence.repositories.deviceSettings.get(key);
    if (!setting) {
      return null;
    }
    return parseCursor(setting.value, key);
  }

  private async loadDeferredAssets(key: string): Promise<DeferredAssetRetry[]> {
    const setting = await this.persistence.repositories.deviceSettings.get(key);
    return setting ? parseDeferredAssets(setting.value, key) : [];
  }

  private async persistDeferredAssets(
    key: string,
    assets: Iterable<DeferredAssetRetry>,
  ): Promise<void> {
    const values = boundedDeferredAssets(assets);
    await this.persistence.repositories.deviceSettings.set({
      key,
      value: values as unknown as JsonValue,
      updatedAt: checkedNow(this.clock),
    });
  }

  private async persistScanState(
    cursorKey: string,
    cursor: MediaScanCursor,
    deferredKey: string,
    assets: Iterable<DeferredAssetRetry>,
  ): Promise<void> {
    const updatedAt = checkedNow(this.clock);
    const deferred = boundedDeferredAssets(assets);
    await this.persistence.transaction(async (repositories) => {
      await repositories.deviceSettings.set({
        key: cursorKey,
        value: {
          creationTimeMs: cursor.creationTimeMs,
          offsetAtCreationTime: cursor.offsetAtCreationTime,
        },
        updatedAt,
      });
      await repositories.deviceSettings.set({
        key: deferredKey,
        value: deferred as unknown as JsonValue,
        updatedAt,
      });
    });
  }
}

export function mediaScanCursorSettingKey(tripId: string, deviceId: string): string {
  if (!tripId || !deviceId) {
    throw new MediaIngestionConfigurationError('tripId and deviceId are required for a scan cursor.');
  }
  return `${SCAN_CURSOR_KEY_PREFIX}:${tripId}:${deviceId}`;
}

export function excludedSourceAssetKey(
  tripId: string,
  deviceId: string,
  assetId: string,
): string {
  return `media.excluded-source.v1:${tripId}:${deviceId}:${sha256Hex(textEncoder.encode(assetId))}`;
}

export function deferredAssetsSettingKey(tripId: string, deviceId: string): string {
  if (!tripId || !deviceId) {
    throw new MediaIngestionConfigurationError(
      'tripId and deviceId are required for a deferred asset queue.',
    );
  }
  return `${DEFERRED_ASSETS_KEY_PREFIX}:${tripId}:${deviceId}`;
}

export const defaultMediaIngestionIdFactory: MediaIngestionIdFactory = {
  mediaId: createLocalMediaId,
  resourceId: createResourceId,
  replicaReceiptId: (resourceId, holderDeviceId) =>
    deterministicId('receipt', resourceId, holderDeviceId),
  operationId: (mediaId, originDeviceId) =>
    deterministicId('operation', mediaId, originDeviceId, 'MEDIA_PREVIEW_PUBLISHED'),
  originalOperationId: (mediaId, originDeviceId) =>
    deterministicId('operation', mediaId, originDeviceId, 'MEDIA_ORIGINAL_PUBLISHED'),
  replicaOperationId: (receiptId, originDeviceId) =>
    deterministicId('operation', receiptId, originDeviceId, 'REPLICA_RECORDED'),
  outboxId: (operationId) => deterministicId('outbox', operationId),
};

export const systemMediaIngestionClock: MediaIngestionClock = {
  nowMs: () => Date.now(),
};

function deterministicId(prefix: string, ...parts: string[]): string {
  const digest = sha256Hex(textEncoder.encode(['airmesh-ingestion-v1', ...parts].join('\0')));
  return `${prefix}_${digest.slice(0, 32)}`;
}

function prepareResource(
  domain: MediaResource,
  localUri: string,
  updatedAtMs: number,
): PreparedResource {
  return {
    domain,
    record: {
      ...domain,
      availability: 'available',
      localUri,
      verifiedAtMs: updatedAtMs,
      updatedAtMs,
    },
  };
}

function toMediaRecord(item: MediaItem, sourceAssetId: string): MediaRecord {
  return { ...item, sourceAssetId };
}

function toDomainMediaItem(record: MediaRecord): MediaItem {
  const { sourceAssetId: _sourceAssetId, ...item } = record;
  return expectValid(parseMediaItem(item), 'persisted media item');
}

function toReceiptRecord(receipt: ReplicaReceipt): ReplicaReceiptRecord {
  return { ...receipt };
}

function toOperationRecord(operation: SyncOperation): SyncOperationRecord {
  return {
    schemaVersion: operation.schemaVersion,
    operationId: operation.operationId,
    tripId: operation.tripId,
    originDeviceId: operation.originDeviceId,
    originSequence: operation.originSequence,
    actorMemberId: operation.actorMemberId,
    membershipEpoch: operation.membershipEpoch,
    createdAtMs: operation.createdAtMs,
    originIdentityPublicKey: operation.originIdentityPublicKey ?? null,
    originSignature: operation.originSignature ?? null,
    kind: operation.kind,
    payload: operation.payload as unknown as JsonValue,
  };
}

function expectValid<T>(result: ParseResult<T>, label: string): T {
  if (result.ok) {
    return result.value;
  }
  throw new CoreValidationError(`Invalid ${label}.`, result.issues);
}

async function atStage<T>(
  assetId: string,
  stage: MediaIngestionStage,
  retryable: boolean,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof AssetStageError) {
      throw error;
    }
    throw new AssetStageError(assetId, stage, retryable, errorMessage(error), { cause: error });
  }
}

function mapScanFailure(failure: MediaScanFailure): MediaIngestionFailure {
  return {
    assetId: failure.assetId,
    stage: 'scan',
    message: failure.reason,
    retryable: failure.retryable,
  };
}

function mapAssetFailure(assetId: string, error: unknown): MediaIngestionFailure {
  if (error instanceof AssetStageError) {
    return {
      assetId: error.assetId,
      stage: error.stage,
      message: error.message,
      retryable: error.retryable,
      cause: error.cause,
    };
  }
  return {
    assetId,
    stage: 'persist',
    message: errorMessage(error),
    retryable: true,
    cause: error,
  };
}

function parseCursor(value: JsonValue, key: string): MediaScanCursor {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new MediaScanCursorError(key);
  }
  const creationTimeMs = value.creationTimeMs;
  const offsetAtCreationTime = value.offsetAtCreationTime;
  if (
    !Number.isSafeInteger(creationTimeMs) ||
    (creationTimeMs as number) < 0 ||
    !Number.isSafeInteger(offsetAtCreationTime) ||
    (offsetAtCreationTime as number) < 0
  ) {
    throw new MediaScanCursorError(key);
  }
  return {
    creationTimeMs: creationTimeMs as number,
    offsetAtCreationTime: offsetAtCreationTime as number,
  };
}

function parseDeferredAssets(value: JsonValue, key: string): DeferredAssetRetry[] {
  if (!Array.isArray(value) || value.length > MAX_DEFERRED_ASSETS) {
    throw new MediaDeferredQueueError(key);
  }
  return value.map((entry) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object') {
      throw new MediaDeferredQueueError(key);
    }
    // v1 stored DeviceImageAsset directly. Accept it as immediately due and
    // rewrite it with retry metadata on the next persistence pass.
    if (entry.asset === undefined) {
      return {
        asset: parseDeferredAsset(entry, key),
        attemptCount: 0,
        nextAttemptAtMs: 0,
        lastFailureStage: 'scan',
      };
    }
    const attemptCount = entry.attemptCount;
    const nextAttemptAtMs = entry.nextAttemptAtMs;
    const lastFailureStage = entry.lastFailureStage;
    if (
      !isNonNegativeSafeInteger(attemptCount) ||
      attemptCount > MAX_DEFERRED_ATTEMPT_COUNT ||
      !isNonNegativeSafeInteger(nextAttemptAtMs) ||
      !isMediaIngestionStage(lastFailureStage)
    ) {
      throw new MediaDeferredQueueError(key);
    }
    return {
      asset: parseDeferredAsset(entry.asset, key),
      attemptCount,
      nextAttemptAtMs,
      lastFailureStage,
    };
  });
}

function parseDeferredAsset(value: JsonValue | undefined, key: string): DeviceImageAsset {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') {
    throw new MediaDeferredQueueError(key);
  }
  const assetId = value.assetId;
  const filename = value.filename;
  const capturedAtMs = value.capturedAtMs;
  const modifiedAtMs = value.modifiedAtMs;
  const width = value.width;
  const height = value.height;
  if (
    typeof assetId !== 'string' ||
    assetId.length === 0 ||
    (filename !== null && typeof filename !== 'string') ||
    !isNonNegativeSafeInteger(capturedAtMs) ||
    (modifiedAtMs !== null && !isNonNegativeSafeInteger(modifiedAtMs)) ||
    (width !== null && !isNonNegativeSafeInteger(width)) ||
    (height !== null && !isNonNegativeSafeInteger(height))
  ) {
    throw new MediaDeferredQueueError(key);
  }
  return { assetId, filename, capturedAtMs, modifiedAtMs, width, height };
}

function boundedDeferredAssets(assets: Iterable<DeferredAssetRetry>): DeferredAssetRetry[] {
  const unique = new Map<string, DeferredAssetRetry>();
  for (const retry of assets) unique.set(retry.asset.assetId, retry);
  if (unique.size > MAX_DEFERRED_ASSETS) {
    throw new MediaIngestionConfigurationError(
      `Deferred media queue exceeds ${MAX_DEFERRED_ASSETS} assets.`,
    );
  }
  return [...unique.values()];
}

function normalizeInsertedAssetIds(assetIds: readonly string[] | undefined): string[] {
  if (!assetIds) return [];
  const unique = [...new Set(assetIds)];
  if (unique.length > MAX_INSERTED_ASSET_IDS) {
    throw new MediaIngestionConfigurationError(
      `At most ${MAX_INSERTED_ASSET_IDS} inserted media assets can be prioritized per scan.`,
    );
  }
  for (const assetId of unique) {
    if (!assetId.trim()) {
      throw new MediaIngestionConfigurationError('Inserted media asset IDs must be non-empty.');
    }
  }
  return unique;
}

function nextDeferredRetry(
  existing: DeferredAssetRetry | undefined,
  asset: DeviceImageAsset,
  lastFailureStage: MediaIngestionStage,
  nowMs: number,
): DeferredAssetRetry {
  const attemptCount = Math.min(
    (existing?.attemptCount ?? 0) + 1,
    MAX_DEFERRED_ATTEMPT_COUNT,
  );
  const exponent = Math.min(attemptCount - 1, 20);
  const delayMs = Math.min(
    DEFERRED_RETRY_BASE_DELAY_MS * (2 ** exponent),
    DEFERRED_RETRY_MAX_DELAY_MS,
  );
  return {
    asset,
    attemptCount,
    nextAttemptAtMs: Math.min(Number.MAX_SAFE_INTEGER, nowMs + delayMs),
    lastFailureStage,
  };
}

function compareDeferredRetries(left: DeferredAssetRetry, right: DeferredAssetRetry): number {
  return left.nextAttemptAtMs - right.nextAttemptAtMs
    || left.attemptCount - right.attemptCount
    || left.asset.capturedAtMs - right.asset.capturedAtMs
    || left.asset.assetId.localeCompare(right.asset.assetId);
}

function earliestDeferredRetryAt(retries: Iterable<DeferredAssetRetry>): number | null {
  let earliest: number | null = null;
  for (const retry of retries) {
    if (earliest === null || retry.nextAttemptAtMs < earliest) {
      earliest = retry.nextAttemptAtMs;
    }
  }
  return earliest;
}

function removeRetryableFailures(
  failures: MediaIngestionFailure[],
  assetId: string,
): void {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    if (failures[index]?.assetId === assetId && failures[index]?.retryable) {
      failures.splice(index, 1);
    }
  }
}

function isMediaIngestionStage(value: unknown): value is MediaIngestionStage {
  return value === 'scan'
    || value === 'deduplicate'
    || value === 'identity'
    || value === 'resolve-source'
    || value === 'copy-original'
    || value === 'hash-original'
    || value === 'thumbnail'
    || value === 'sequence'
    || value === 'validate'
    || value === 'persist';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertStoredSize(assetId: string, stored: StoredFile, hashedByteLength: number): void {
  if (stored.byteSize !== hashedByteLength) {
    throw new AssetStageError(
      assetId,
      'hash-original',
      true,
      `Stored file size changed while hashing: expected ${stored.byteSize}, read ${hashedByteLength}.`,
    );
  }
}

function positiveDimension(value: number | null, field: string, assetId: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new AssetStageError(
      assetId,
      'validate',
      false,
      `${field} must be a positive integer.`,
    );
  }
  return value as number;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function checkedNow(clock: MediaIngestionClock): number {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MediaIngestionConfigurationError('Clock returned an invalid millisecond timestamp.');
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
