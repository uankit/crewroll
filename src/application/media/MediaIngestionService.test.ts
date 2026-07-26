import { describe, expect, it } from 'vitest';

import type {
  DeviceSettingRecord,
  JsonValue,
  MediaRecord,
  MemberRecord,
  OutboxRecord,
  ReplicaReceiptRecord,
  ResourceRecord,
  SyncOperationRecord,
  TripRecord,
} from '@/data/types';
import type {
  ChunkedFileStore,
  CopyOriginalRequest,
  FileChunk,
  FinalizeIncomingRequest,
  IncomingChunk,
  ReadChunksRequest,
  StoredFile,
  StoredThumbnail,
  ThumbnailRequest,
} from '@/platform/files';
import type {
  DeviceImageAsset,
  MediaAssetLookupResult,
  MediaChangeSubscription,
  MediaGateway,
  MediaLibraryChange,
  MediaPermissionState,
  MediaScanPage,
  MediaScanRequest,
  ResolvedMediaSource,
} from '@/platform/media';

import {
  MEDIA_OPERATION_OUTBOX_TYPE,
  MediaIngestionService,
  deferredAssetsSettingKey,
  mediaScanCursorSettingKey,
  type MediaIngestionClock,
  type MediaIngestionPersistence,
  type MediaIngestionRepositories,
  type MonotonicSequenceAllocator,
  type MonotonicSequenceRequest,
} from './MediaIngestionService';
import { sha256Hex } from './contentIdentity';

const TRIP_ID = 'trip_0001';
const MEMBER_ID = 'member_0001';
const DEVICE_ID = 'device_0001';
const ASSET_ID = 'asset_0001';
const SOURCE_URI = 'content://camera/asset_0001.jpg';

function trip(defaultSharingMode: 'AUTO_SHARE' | 'REVIEW_FIRST'): TripRecord {
  return {
    schemaVersion: 1,
    id: TRIP_ID,
    name: 'Test trip',
    createdByMemberId: MEMBER_ID,
    createdAtMs: 500,
    updatedAtMs: 500,
    startsAtMs: 1_000,
    endsAtMs: null,
    timeZone: 'UTC',
    status: 'ACTIVE',
    defaultSharingMode,
    locationSharingMode: 'NONE',
    targetReplicaCount: 2,
    completeKeeperCount: 1,
    membershipEpoch: 1,
    isActive: true,
  };
}

const localMember: MemberRecord = {
  schemaVersion: 1,
  id: MEMBER_ID,
  tripId: TRIP_ID,
  deviceId: DEVICE_ID,
  displayName: 'Ankit',
  identityPublicKey: 'a'.repeat(32),
  role: 'ADMIN',
  status: 'ACTIVE',
  replicaRole: 'KEEPER_PRIMARY',
  joinedAtMs: 500,
  updatedAtMs: 500,
  leftAtMs: null,
  membershipEpoch: 1,
};

const page: MediaScanPage = {
  assets: [
    {
      assetId: ASSET_ID,
      filename: 'IMG_0001.JPG',
      capturedAtMs: 1_500,
      modifiedAtMs: 1_500,
      width: 4_032,
      height: 3_024,
    },
  ],
  failures: [],
  excludedScreenshotCount: 0,
  nextCursor: { creationTimeMs: 1_500, offsetAtCreationTime: 1 },
  hasMore: false,
};

class FakeSequenceAllocator implements MonotonicSequenceAllocator {
  readonly calls: MonotonicSequenceRequest[] = [];
  private readonly values = new Map<string, number>();

  async allocate(request: MonotonicSequenceRequest): Promise<number> {
    this.calls.push(request);
    const key = `${request.tripId}|${request.originDeviceId}|${request.idempotencyKey}`;
    const existing = this.values.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const value = this.values.size + 1;
    this.values.set(key, value);
    return value;
  }
}

class MutableClock implements MediaIngestionClock {
  constructor(public now = 2_000) {}

  nowMs(): number {
    return this.now;
  }
}

class FakeMediaGateway implements MediaGateway {
  readonly insertedLookupRequests: string[][] = [];
  readonly scanRequests: MediaScanRequest[] = [];
  readonly resolvedAssetIds: string[] = [];
  locationReads = 0;

  constructor(
    private readonly result: MediaScanPage = page,
    private readonly directAssets: readonly DeviceImageAsset[] = result.assets,
  ) {}

  async getPermissionState(): Promise<MediaPermissionState> {
    return { access: 'full', canAskAgain: true, expires: 'never', granted: true };
  }

  async requestPermission(): Promise<MediaPermissionState> {
    return this.getPermissionState();
  }

  async presentLimitedLibraryPicker(): Promise<void> {}

  async getImageAssetsByIds(assetIds: readonly string[]): Promise<MediaAssetLookupResult> {
    this.insertedLookupRequests.push([...assetIds]);
    const requested = new Set(assetIds);
    const assets = this.directAssets.filter((asset) => requested.has(asset.assetId));
    const found = new Set(assets.map((asset) => asset.assetId));
    return {
      assets,
      failures: assetIds
        .filter((assetId) => !found.has(assetId))
        .map((assetId) => ({
          assetId,
          reason: 'Inserted asset metadata is not ready.',
          retryable: true,
          asset: null,
        })),
      excludedScreenshotCount: 0,
    };
  }

  async scanPage(request: MediaScanRequest): Promise<MediaScanPage> {
    this.scanRequests.push(request);
    return this.result;
  }

  async *scan(request: MediaScanRequest): AsyncGenerator<MediaScanPage, void, void> {
    yield await this.scanPage(request);
  }

  async resolveReadableSource(assetId: string): Promise<ResolvedMediaSource> {
    this.resolvedAssetIds.push(assetId);
    return { assetId, uri: SOURCE_URI, locallyAvailable: true };
  }

  async readLocation(): Promise<null> {
    this.locationReads += 1;
    throw new Error('Media ingestion must not read location.');
  }

  async saveImageToLibrary(): Promise<string> {
    return 'saved-asset-id';
  }

  subscribe(_listener: (change: MediaLibraryChange) => void): MediaChangeSubscription {
    return { remove() {} };
  }
}

class FakeChunkedFileStore implements ChunkedFileStore {
  readonly bytesByUri = new Map<string, Uint8Array>([
    [SOURCE_URI, new TextEncoder().encode('exact original bytes')],
  ]);
  copyCount = 0;
  thumbnailCount = 0;
  failThumbnail = false;
  failOriginalCopy = false;

  async *readChunks(request: ReadChunksRequest): AsyncGenerator<FileChunk, void, void> {
    const bytes = this.bytesByUri.get(request.uri);
    if (!bytes) throw new Error(`Missing fake file ${request.uri}.`);
    const chunkSize = Math.min(request.chunkSize ?? 4, 4);
    for (let offset = request.offset ?? 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      yield { offset, bytes: bytes.slice(offset, end), isLast: end === bytes.byteLength };
    }
  }

  getIncoming(): StoredFile | null {
    return null;
  }

  async prepareIncoming(): Promise<StoredFile> {
    throw new Error('unused');
  }

  async writeIncomingChunk(_chunk: IncomingChunk): Promise<number> {
    throw new Error('unused');
  }

  async finalizeIncoming(_request: FinalizeIncomingRequest): Promise<StoredFile> {
    throw new Error('unused');
  }

  async discardIncoming(): Promise<void> {}

  async deleteStoredFile(uri: string): Promise<boolean> {
    return this.bytesByUri.delete(uri);
  }

  async deleteTripFiles(resources: readonly { localUri: string | null }[]) {
    let deleted = 0;
    const uris = [...new Set(
      resources.map((resource) => resource.localUri).filter((uri): uri is string => uri !== null),
    )];
    for (const uri of uris) {
      if (this.bytesByUri.delete(uri)) deleted += 1;
    }
    return { requested: uris.length, deleted, missing: uris.length - deleted };
  }

  async copyOriginalExact(request: CopyOriginalRequest): Promise<StoredFile> {
    this.copyCount += 1;
    if (this.failOriginalCopy) throw new Error('original copier unavailable');
    const source = this.bytesByUri.get(request.sourceUri);
    if (!source) throw new Error('Source missing.');
    const uri = originalUri(request.storageKey, request.extension);
    if (this.bytesByUri.has(uri) && !request.overwrite) {
      throw new Error('Original already exists.');
    }
    this.bytesByUri.set(uri, source.slice());
    return storedFile(uri, source.byteLength);
  }

  async createThumbnail(request: ThumbnailRequest): Promise<StoredThumbnail> {
    this.thumbnailCount += 1;
    if (this.failThumbnail) throw new Error('thumbnail renderer unavailable');
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const uri = thumbnailUri(request.storageKey);
    this.bytesByUri.set(uri, bytes);
    return { ...storedFile(uri, bytes.byteLength, 'image/jpeg'), width: 120, height: 90 };
  }

  getOriginal(storageKey: string, extension: string): StoredFile | null {
    const uri = originalUri(storageKey, extension);
    const bytes = this.bytesByUri.get(uri);
    return bytes ? storedFile(uri, bytes.byteLength) : null;
  }

  getThumbnail(storageKey: string): StoredThumbnail | null {
    const uri = thumbnailUri(storageKey);
    const bytes = this.bytesByUri.get(uri);
    return bytes
      ? { ...storedFile(uri, bytes.byteLength, 'image/jpeg'), width: null, height: null }
      : null;
  }
}

class FakePersistence implements MediaIngestionPersistence {
  media = new Map<string, MediaRecord>();
  resources = new Map<string, ResourceRecord>();
  receipts = new Map<string, ReplicaReceiptRecord>();
  operations = new Map<string, SyncOperationRecord>();
  outbox = new Map<string, OutboxRecord>();
  settings = new Map<string, DeviceSettingRecord>();
  failNextOutbox = false;

  readonly repositories: MediaIngestionRepositories;

  constructor(readonly storedTrip: TripRecord) {
    this.repositories = {
      trips: {
        getById: async (id) => (id === storedTrip.id ? storedTrip : null),
      },
      members: {
        getById: async (tripId, memberId) =>
          tripId === localMember.tripId && memberId === localMember.id ? localMember : null,
      },
      media: {
        getBySourceAssetId: async (tripId, deviceId, sourceAssetId) =>
          [...this.media.values()].find(
            (record) =>
              record.tripId === tripId &&
              record.originDeviceId === deviceId &&
              record.sourceAssetId === sourceAssetId,
          ) ?? null,
        upsert: async (record) => {
          this.media.set(`${record.tripId}/${record.id}`, record);
        },
      },
      resources: {
        getById: async (tripId, resourceId) =>
          this.resources.get(`${tripId}/${resourceId}`) ?? null,
        upsert: async (record) => {
          this.resources.set(`${record.tripId}/${record.id}`, record);
        },
      },
      replicaReceipts: {
        upsert: async (record) => {
          this.receipts.set(`${record.tripId}/${record.id}`, record);
        },
      },
      syncOperations: {
        append: async (record) => {
          const key = `${record.tripId}/${record.operationId}`;
          if (this.operations.has(key)) return false;
          this.operations.set(key, record);
          return true;
        },
      },
      outbox: {
        upsert: async (record) => {
          if (this.failNextOutbox) {
            this.failNextOutbox = false;
            throw new Error('simulated outbox failure');
          }
          this.outbox.set(`${record.tripId}/${record.id}`, record);
        },
      },
      deviceSettings: {
        get: async <T extends JsonValue = JsonValue>(key: string) =>
          (this.settings.get(key) as DeviceSettingRecord<T> | undefined) ?? null,
        set: async (record) => {
          this.settings.set(record.key, record);
        },
      },
    };
  }

  async transaction<T>(
    task: (repositories: MediaIngestionRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = {
      media: new Map(this.media),
      resources: new Map(this.resources),
      receipts: new Map(this.receipts),
      operations: new Map(this.operations),
      outbox: new Map(this.outbox),
    };
    try {
      return await task(this.repositories);
    } catch (error) {
      this.media = snapshot.media;
      this.resources = snapshot.resources;
      this.receipts = snapshot.receipts;
      this.operations = snapshot.operations;
      this.outbox = snapshot.outbox;
      throw error;
    }
  }
}

describe('MediaIngestionService', () => {
  it('publishes exact originals, receipt, operation, outbox and cursor without reading location', async () => {
    const persistence = new FakePersistence(trip('AUTO_SHARE'));
    const gateway = new FakeMediaGateway();
    const files = new FakeChunkedFileStore();
    const mediaSequences = new FakeSequenceAllocator();
    const operationSequences = new FakeSequenceAllocator();
    const clock = new MutableClock();
    const service = createService(
      persistence,
      gateway,
      files,
      mediaSequences,
      operationSequences,
      clock,
    );

    const result = await service.scanAndIngest(request());

    expect(result.failures).toEqual([]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.kind).toBe('published');
    expect(gateway.scanRequests[0]).toMatchObject({
      canonicalTripStartMs: 1_000,
      cursor: null,
    });
    expect(gateway.locationReads).toBe(0);
    expect(files.copyCount).toBe(1);
    expect(persistence.media.size).toBe(1);
    expect(persistence.resources.size).toBe(2);
    expect(persistence.receipts.size).toBe(1);
    expect(persistence.operations.size).toBe(3);
    expect(persistence.outbox.size).toBe(3);

    const original = [...persistence.resources.values()].find(
      (resource) => resource.kind === 'ORIGINAL',
    );
    expect(original?.sha256).toBe(
      sha256Hex(new TextEncoder().encode('exact original bytes')),
    );
    expect([...persistence.receipts.values()][0]).toMatchObject({
      resourceSha256: original?.sha256,
      status: 'VERIFIED',
      holderDeviceId: DEVICE_ID,
    });
    expect([...persistence.operations.values()].map((item) => item.kind)).toEqual([
      'MEDIA_PREVIEW_PUBLISHED',
      'MEDIA_ORIGINAL_PUBLISHED',
      'REPLICA_RECORDED',
    ]);
    expect(
      [...persistence.outbox.values()].every(
        (item) => item.messageType === MEDIA_OPERATION_OUTBOX_TYPE && item.state === 'pending',
      ),
    ).toBe(true);
    expect(
      persistence.settings.get(mediaScanCursorSettingKey(TRIP_ID, DEVICE_ID))?.value,
    ).toEqual(page.nextCursor);
  });

  it('commits and announces the thumbnail before copying or hashing the original', async () => {
    const persistence = new FakePersistence(trip('AUTO_SHARE'));
    const files = new FakeChunkedFileStore();
    const service = createService(
      persistence,
      new FakeMediaGateway(),
      files,
      new FakeSequenceAllocator(),
      new FakeSequenceAllocator(),
    );
    let callbackCount = 0;

    const result = await service.scanAndIngest({
      ...request(),
      onPreviewPublished: async ({ mediaId, thumbnailResourceId }) => {
        callbackCount += 1;
        expect(mediaId).toBe([...persistence.media.values()][0]?.id);
        expect(files.copyCount).toBe(0);
        expect([...persistence.resources.values()]).toMatchObject([
          { id: thumbnailResourceId, kind: 'THUMBNAIL', availability: 'available' },
        ]);
        expect([...persistence.operations.values()].map((item) => item.kind)).toEqual([
          'MEDIA_PREVIEW_PUBLISHED',
        ]);
        expect(persistence.outbox.size).toBe(1);
      },
    });

    expect(result.failures).toEqual([]);
    expect(callbackCount).toBe(1);
    expect(files.copyCount).toBe(1);
    expect([...persistence.operations.values()].map((item) => item.kind)).toEqual([
      'MEDIA_PREVIEW_PUBLISHED',
      'MEDIA_ORIGINAL_PUBLISHED',
      'REPLICA_RECORDED',
    ]);
  });

  it('recovers a durable preview after original processing fails without regenerating it', async () => {
    const persistence = new FakePersistence(trip('AUTO_SHARE'));
    const files = new FakeChunkedFileStore();
    files.failOriginalCopy = true;
    const mediaSequences = new FakeSequenceAllocator();
    const operationSequences = new FakeSequenceAllocator();
    const clock = new MutableClock();
    const service = createService(
      persistence,
      new FakeMediaGateway(),
      files,
      mediaSequences,
      operationSequences,
      clock,
    );

    const failed = await service.scanAndIngest(request());

    expect(failed.failures).toMatchObject([
      { assetId: ASSET_ID, stage: 'copy-original', retryable: true },
    ]);
    expect(persistence.media.size).toBe(1);
    expect([...persistence.resources.values()].map((item) => item.kind)).toEqual(['THUMBNAIL']);
    expect([...persistence.operations.values()].map((item) => item.kind)).toEqual([
      'MEDIA_PREVIEW_PUBLISHED',
    ]);
    expect(persistence.outbox.size).toBe(1);
    expect(files.thumbnailCount).toBe(1);

    files.failOriginalCopy = false;
    clock.now = 4_000;
    const restarted = createService(
      persistence,
      new FakeMediaGateway(emptyPage(page.nextCursor)),
      files,
      mediaSequences,
      operationSequences,
      clock,
    );
    const recovered = await restarted.scanAndIngest(request());

    expect(recovered.failures).toEqual([]);
    expect(recovered.outcomes).toMatchObject([{ kind: 'published', assetId: ASSET_ID }]);
    expect(files.thumbnailCount).toBe(1);
    expect(persistence.resources.size).toBe(2);
    expect(persistence.receipts.size).toBe(1);
    expect([...persistence.operations.values()].map((item) => item.kind)).toEqual([
      'MEDIA_PREVIEW_PUBLISHED',
      'MEDIA_ORIGINAL_PUBLISHED',
      'REPLICA_RECORDED',
    ]);
    expect(persistence.outbox.size).toBe(3);
  });

  it('rolls back publication, defers the asset, advances the cursor, and safely retries', async () => {
    const persistence = new FakePersistence(trip('AUTO_SHARE'));
    persistence.failNextOutbox = true;
    const gateway = new FakeMediaGateway();
    const files = new FakeChunkedFileStore();
    const mediaSequences = new FakeSequenceAllocator();
    const operationSequences = new FakeSequenceAllocator();
    const clock = new MutableClock();
    const service = createService(
      persistence,
      gateway,
      files,
      mediaSequences,
      operationSequences,
      clock,
    );

    const failed = await service.scanAndIngest(request());
    expect(failed.failures).toMatchObject([
      { assetId: ASSET_ID, stage: 'persist', retryable: true },
    ]);
    expect(failed.persistedCursor).toEqual(page.nextCursor);
    expect(failed.stoppedAtFailure).toBe(false);
    expect(failed.deferredAssetCount).toBe(1);
    expect(persistence.media.size).toBe(0);
    expect(persistence.resources.size).toBe(0);
    expect(persistence.receipts.size).toBe(0);
    expect(persistence.operations.size).toBe(0);
    expect(persistence.outbox.size).toBe(0);
    expect(files.copyCount).toBe(0);
    expect(failed.nextDeferredRetryAtMs).toBe(4_000);

    const beforeBackoff = await service.scanAndIngest(request());
    expect(beforeBackoff.outcomes).toEqual([]);
    expect(beforeBackoff.deferredAssetCount).toBe(1);
    expect(files.thumbnailCount).toBe(1);

    clock.now = 4_000;
    const retried = await service.scanAndIngest(request());
    expect(retried.failures).toEqual([]);
    expect(retried.outcomes[0]?.kind).toBe('published');
    expect(files.copyCount).toBe(1);
    expect(files.thumbnailCount).toBe(2);
    expect(mediaSequences.calls).toHaveLength(2);
    expect(operationSequences.calls).toHaveLength(4);
    expect(mediaSequences.calls[0]?.idempotencyKey).toBe(
      mediaSequences.calls[1]?.idempotencyKey,
    );
    expect(operationSequences.calls[0]?.idempotencyKey).toBe(
      operationSequences.calls[1]?.idempotencyKey,
    );
    expect(operationSequences.calls[2]?.idempotencyKey).toContain(
      'MEDIA_ORIGINAL_PUBLISHED',
    );
    expect(operationSequences.calls[3]?.idempotencyKey).toContain('REPLICA_RECORDED');
    expect(persistence.media.size).toBe(1);
    expect(persistence.outbox.size).toBe(3);
  });

  it('persists REVIEW_FIRST candidates privately without operations or outbox', async () => {
    const persistence = new FakePersistence(trip('REVIEW_FIRST'));
    const gateway = new FakeMediaGateway();
    const files = new FakeChunkedFileStore();
    const mediaSequences = new FakeSequenceAllocator();
    const operationSequences = new FakeSequenceAllocator();
    const service = createService(
      persistence,
      gateway,
      files,
      mediaSequences,
      operationSequences,
    );

    const result = await service.scanAndIngest(request());

    expect(result.outcomes[0]?.kind).toBe('private');
    expect([...persistence.media.values()][0]?.shareStatus).toBe('PRIVATE');
    expect(persistence.resources.size).toBe(2);
    expect(persistence.receipts.size).toBe(0);
    expect(persistence.operations.size).toBe(0);
    expect(persistence.outbox.size).toBe(0);
    expect(operationSequences.calls).toHaveLength(0);
  });

  it('retries a transient thumbnail failure durably across a service restart', async () => {
    const persistence = new FakePersistence(trip('AUTO_SHARE'));
    const gateway = new FakeMediaGateway();
    const files = new FakeChunkedFileStore();
    const clock = new MutableClock();
    files.failThumbnail = true;
    const service = createService(
      persistence,
      gateway,
      files,
      new FakeSequenceAllocator(),
      new FakeSequenceAllocator(),
      clock,
    );

    const failed = await service.scanAndIngest(request());

    expect(failed.failures).toMatchObject([
      { assetId: ASSET_ID, stage: 'thumbnail', retryable: true },
    ]);
    expect(failed.outcomes).toEqual([]);
    expect(failed.deferredAssetCount).toBe(1);
    expect(failed.nextDeferredRetryAtMs).toBe(4_000);
    expect(persistence.media.size).toBe(0);
    expect(persistence.operations.size).toBe(0);
    expect(persistence.settings.get(deferredAssetsSettingKey(TRIP_ID, DEVICE_ID))?.value)
      .toMatchObject([{
        asset: { assetId: ASSET_ID },
        attemptCount: 1,
        nextAttemptAtMs: 4_000,
        lastFailureStage: 'thumbnail',
      }]);

    files.failThumbnail = false;
    clock.now = 4_000;
    const restarted = createService(
      persistence,
      new FakeMediaGateway(emptyPage(page.nextCursor)),
      files,
      new FakeSequenceAllocator(),
      new FakeSequenceAllocator(),
      clock,
    );
    const recovered = await restarted.scanAndIngest(request());

    expect(recovered.failures).toEqual([]);
    expect(recovered.deferredAssetCount).toBe(0);
    expect(recovered.outcomes).toMatchObject([{
      kind: 'published',
      assetId: ASSET_ID,
      thumbnailResourceId: expect.any(String),
    }]);
    expect([...persistence.media.values()][0]?.thumbnailResourceId).toEqual(expect.any(String));
    expect(persistence.resources.size).toBe(2);
    expect(files.copyCount).toBe(1);
    expect(files.thumbnailCount).toBe(2);
    const operation = [...persistence.operations.values()].find(
      (candidate) => candidate.kind === 'MEDIA_PREVIEW_PUBLISHED',
    );
    expect(operation?.payload).toMatchObject({
      item: { thumbnailResourceId: expect.any(String) },
    });
    expect((operation?.payload as { resources: unknown[] } | undefined)?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'THUMBNAIL' })]),
    );
  });

  it('publishes a newly scanned capture before a bounded batch from 100 deferred assets', async () => {
    const persistence = new FakePersistence(trip('AUTO_SHARE'));
    const deferredAssets = Array.from({ length: 100 }, (_, index) =>
      imageAsset(`asset_deferred_${index}`, 1_100 + index));
    persistence.settings.set(deferredAssetsSettingKey(TRIP_ID, DEVICE_ID), {
      key: deferredAssetsSettingKey(TRIP_ID, DEVICE_ID),
      value: deferredAssets as unknown as JsonValue,
      updatedAt: 1_000,
    });
    const fresh = imageAsset('asset_fresh_capture', 9_000);
    const gateway = new FakeMediaGateway({
      assets: [fresh],
      failures: [],
      excludedScreenshotCount: 0,
      nextCursor: { creationTimeMs: fresh.capturedAtMs, offsetAtCreationTime: 1 },
      hasMore: false,
    });
    const service = createService(
      persistence,
      gateway,
      new FakeChunkedFileStore(),
      new FakeSequenceAllocator(),
      new FakeSequenceAllocator(),
      new MutableClock(10_000),
    );

    const result = await service.scanAndIngest(request());

    expect(result.outcomes[0]).toMatchObject({
      kind: 'published',
      assetId: fresh.assetId,
    });
    expect(gateway.resolvedAssetIds[0]).toBe(fresh.assetId);
    expect(result.outcomes).toHaveLength(1 + 4);
    expect(result.deferredAssetCount).toBe(96);
    const persisted = persistence.settings.get(
      deferredAssetsSettingKey(TRIP_ID, DEVICE_ID),
    )?.value;
    expect(persisted).toHaveLength(96);
    expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({
      asset: expect.objectContaining({ assetId: expect.any(String) }),
      attemptCount: 0,
      nextAttemptAtMs: 0,
    })]));
  });

  it('hydrates inserted asset IDs before cursor discovery', async () => {
    const inserted = imageAsset('asset_inserted_fast_path', 9_500);
    const gateway = new FakeMediaGateway(emptyPage(null), [inserted]);
    const service = createService(
      new FakePersistence(trip('AUTO_SHARE')),
      gateway,
      new FakeChunkedFileStore(),
      new FakeSequenceAllocator(),
      new FakeSequenceAllocator(),
    );

    const result = await service.scanAndIngest({
      ...request(),
      insertedAssetIds: [inserted.assetId],
    });

    expect(gateway.insertedLookupRequests).toEqual([[inserted.assetId]]);
    expect(result.outcomes[0]).toMatchObject({
      kind: 'published',
      assetId: inserted.assetId,
    });
  });
});

function createService(
  persistence: FakePersistence,
  gateway: FakeMediaGateway,
  files: FakeChunkedFileStore,
  mediaSequenceAllocator: MonotonicSequenceAllocator,
  operationSequenceAllocator: MonotonicSequenceAllocator,
  clock: MediaIngestionClock = new MutableClock(),
): MediaIngestionService {
  return new MediaIngestionService({
    persistence,
    mediaGateway: gateway,
    fileStore: files,
    mediaSequenceAllocator,
    operationSequenceAllocator,
    identity: { sign: async () => 'A'.repeat(86) },
    clock,
  });
}

function request() {
  return {
    tripId: TRIP_ID,
    localMemberId: MEMBER_ID,
    localDeviceId: DEVICE_ID,
  };
}

function imageAsset(assetId: string, capturedAtMs: number): DeviceImageAsset {
  return {
    assetId,
    filename: `${assetId}.jpg`,
    capturedAtMs,
    modifiedAtMs: capturedAtMs,
    width: 4_032,
    height: 3_024,
  };
}

function emptyPage(nextCursor: MediaScanPage['nextCursor'] | null): MediaScanPage {
  return {
    assets: [],
    failures: [],
    excludedScreenshotCount: 0,
    nextCursor: nextCursor ?? { creationTimeMs: 1_000, offsetAtCreationTime: 0 },
    hasMore: false,
  };
}

function originalUri(storageKey: string, extension: string): string {
  return `file:///original/${storageKey}.${extension}`;
}

function thumbnailUri(storageKey: string): string {
  return `file:///thumbnail/${storageKey}.jpg`;
}

function storedFile(
  uri: string,
  byteSize: number,
  mimeType = 'application/octet-stream',
): StoredFile {
  return { uri, byteSize, mimeType };
}
