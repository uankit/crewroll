import { describe, expect, it } from 'vitest';

import type {
  AirMeshDataLayer,
  DeviceSettingRecord,
  JsonValue,
  MediaRecord,
  ResourceRecord,
  TransferRecord,
} from '@/data';

import {
  buildTransferBenchmarkExport,
  summarizeTransferBenchmarks,
  TransferBenchmarkRecorder,
  type TransferBenchmarkRecord,
} from './TransferBenchmarkRecorder';

describe('TransferBenchmarkRecorder', () => {
  it('reports p50 and p95 against the preview and normalized 5 MiB budgets', () => {
    const summary = summarizeTransferBenchmarks([
      record({ kind: 'THUMBNAIL', sourcePublishedAtMs: 1_000, readyAtMs: 5_000 }),
      record({ kind: 'THUMBNAIL', photoTag: 'photo-b', sourcePublishedAtMs: 1_000, readyAtMs: 7_000 }),
      record({
        kind: 'ORIGINAL',
        photoTag: 'photo-c',
        byteLength: 5 * 1024 * 1024,
        startedAtMs: 2_000,
        verificationAtMs: 22_000,
        readyAtMs: 24_000,
      }),
      record({
        kind: 'ORIGINAL',
        photoTag: 'photo-d',
        byteLength: 5 * 1024 * 1024,
        startedAtMs: 2_000,
        verificationAtMs: 40_000,
        readyAtMs: 42_000,
      }),
    ]);

    expect(summary.preview).toMatchObject({
      sampleCount: 2,
      p50Ms: 4_000,
      p95Ms: 6_000,
      p50WithinBudget: true,
      p95WithinBudget: false,
    });
    expect(summary.originalFiveMiBEquivalent).toMatchObject({
      sampleCount: 2,
      p50Ms: 22_000,
      p95Ms: 40_000,
      p50WithinBudget: true,
      p95WithinBudget: false,
    });
  });

  it('excludes impossible wall-clock and event ordering from percentile samples', () => {
    const summary = summarizeTransferBenchmarks([
      record({
        sourcePublishedAtMs: 4_000,
        queuedAtMs: 2_000,
        readyAtMs: 5_000,
      }),
      record({
        kind: 'ORIGINAL',
        photoTag: 'photo-b',
        byteLength: 5 * 1024 * 1024,
        startedAtMs: 3_000,
        firstProgressAtMs: 2_500,
        verificationAtMs: 4_000,
        readyAtMs: 5_000,
      }),
    ]);

    expect(summary.preview.sampleCount).toBe(0);
    expect(summary.originalFiveMiBEquivalent.sampleCount).toBe(0);
    expect(summary.invalidClockSampleCount).toBe(2);
  });

  it('survives recorder recreation and exports timestamps without full identifiers', async () => {
    const tripId = 'trip_full-secret-looking-id';
    const mediaId = 'media_full-secret-looking-id';
    const resourceId = 'resource_full-secret-looking-id';
    const transferId = 'transfer_full-secret-looking-id';
    const settings = new Map<string, DeviceSettingRecord>();
    let now = 2_000;
    let transfer: TransferRecord = {
      id: transferId,
      tripId,
      resourceId,
      peerMemberId: 'member_remote-full-id',
      direction: 'download',
      state: 'queued',
      bytesTransferred: 0,
      totalBytes: 100,
      chunkSize: 25,
      nextChunkIndex: 0,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: 2_000,
      updatedAt: 2_000,
    };
    const resource: ResourceRecord = {
      schemaVersion: 1,
      id: resourceId,
      tripId,
      mediaId,
      kind: 'THUMBNAIL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 100,
      sha256: 'a'.repeat(64),
      width: 20,
      height: 20,
      createdAtMs: 1_000,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const media: MediaRecord = {
      schemaVersion: 1,
      id: mediaId,
      tripId,
      originMemberId: 'member_origin-full-id',
      originDeviceId: 'device_origin-full-id',
      originSequence: 1,
      sourceAssetId: null,
      source: 'SYSTEM_LIBRARY',
      mediaType: 'IMAGE',
      shareStatus: 'PUBLISHED',
      capturedAtMs: 900,
      captureTimeZoneOffsetMinutes: 0,
      captureLocalDate: '2026-07-26',
      ingestedAtMs: 1_000,
      publishedAtMs: 1_000,
      tombstonedAtMs: null,
      location: null,
      originalResourceId: 'resource_original-full-id',
      thumbnailResourceId: resourceId,
    };
    const data = {
      repositories: {
        transfers: {
          getById: async () => ({ ...transfer }),
          listRecent: async () => [{ ...transfer }],
        },
        resources: { getById: async () => ({ ...resource }) },
        media: { getById: async () => ({ ...media }) },
        deviceSettings: {
          get: async (key: string) => settings.get(key) ?? null,
          set: async (setting: DeviceSettingRecord<JsonValue>) => {
            settings.set(setting.key, setting);
          },
        },
      },
    } as unknown as Pick<AirMeshDataLayer, 'repositories'>;
    const recorder = new TransferBenchmarkRecorder(data, () => now);
    await recorder.observeTransfer(tripId, transferId);

    now = 2_500;
    transfer = {
      ...transfer,
      state: 'transferring',
      bytesTransferred: 75,
      nextChunkIndex: 3,
      startedAt: 2_100,
      updatedAt: now,
    };
    await recorder.observeTransfer(tripId, transferId);

    now = 3_000;
    transfer = {
      ...transfer,
      state: 'completed',
      bytesTransferred: 100,
      nextChunkIndex: 4,
      completedAt: now,
      updatedAt: now,
    };
    resource.availability = 'available';
    resource.localUri = 'file:///private/photo.jpg';
    resource.verifiedAtMs = now;
    await recorder.observeTransfer(tripId, transferId);
    await recorder.observeResourceReady(tripId, resourceId);

    now = 4_000;
    const afterRelaunch = new TransferBenchmarkRecorder(data, () => now);
    const report = await afterRelaunch.buildExport(tripId);

    expect(report).toContain('previewPublishToUsable=n:1; p50:2000ms');
    expect(report).toContain('published=1970-01-01T00:00:01.000Z');
    expect(report).toContain('ready=1970-01-01T00:00:03.000Z');
    expect(report).not.toContain(tripId);
    expect(report).not.toContain(mediaId);
    expect(report).not.toContain(resourceId);
    expect(report).not.toContain(transferId);
    expect(report).not.toContain('file:///private/photo.jpg');
  });

  it('keeps raw identifiers out of a prebuilt compact export', () => {
    const rawPhotoId = 'photo_full-secret-looking-id';
    const report = buildTransferBenchmarkExport([record({ photoTag: rawPhotoId })], 10_000);
    expect(report).toMatch(/sample=[0-9a-f]{12}\/thumbnail/);
    expect(report).not.toContain(rawPhotoId);
    expect(report).not.toContain('trip_');
    expect(report).not.toContain('resource_');
  });

  it('marks a completion-bound verification timestamp when ready is first observed after relaunch', async () => {
    const tripId = 'trip-relaunch';
    const resourceId = 'resource-relaunch';
    const mediaId = 'media-relaunch';
    const settings = new Map<string, DeviceSettingRecord>();
    const transfer = transferRecord({
      id: 'transfer-relaunch',
      tripId,
      resourceId,
      state: 'completed',
      bytesTransferred: 5 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
      startedAt: 2_000,
      completedAt: 22_000,
      createdAt: 1_500,
      updatedAt: 22_000,
    });
    const resource = resourceRecord({
      id: resourceId,
      tripId,
      mediaId,
      kind: 'ORIGINAL',
      byteLength: 5 * 1024 * 1024,
      availability: 'available',
      verifiedAtMs: 22_000,
    });
    const media = mediaRecord({ id: mediaId, tripId, originalResourceId: resourceId });
    const data = benchmarkData({ settings, transfer, resource, media });

    const recorder = new TransferBenchmarkRecorder(data, () => 30_000);
    await recorder.observeResourceReady(tripId, resourceId);
    const report = await new TransferBenchmarkRecorder(data, () => 31_000).buildExport(tripId);

    expect(report).toContain('original5MiBEquivalent=n:0; p50:n/a');
    expect(report).toContain('verifying=1970-01-01T00:00:22.000Z');
    expect(report).toContain('verificationSource=completion-bound');
    expect(report).toContain('ready=1970-01-01T00:00:22.000Z');
    expect(report).toContain('invalidClockSamples=0; inferredVerificationSamples=1');
  });

  it('persists an observed verification boundary across recorder recreation', async () => {
    const tripId = 'trip-observed';
    const resourceId = 'resource-observed';
    const mediaId = 'media-observed';
    const settings = new Map<string, DeviceSettingRecord>();
    const transfer = transferRecord({
      id: 'transfer-observed',
      tripId,
      resourceId,
      state: 'verifying',
      bytesTransferred: 5 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
      startedAt: 2_000,
      createdAt: 1_500,
      updatedAt: 22_000,
    });
    const resource = resourceRecord({
      id: resourceId,
      tripId,
      mediaId,
      kind: 'ORIGINAL',
      byteLength: 5 * 1024 * 1024,
    });
    const media = mediaRecord({ id: mediaId, tripId, originalResourceId: resourceId });
    const data = benchmarkData({ settings, transfer, resource, media });
    const recorder = new TransferBenchmarkRecorder(data, () => 22_000);
    await recorder.observeTransfer(tripId, transfer.id);

    transfer.state = 'completed';
    transfer.completedAt = 24_000;
    transfer.updatedAt = 24_000;
    resource.availability = 'available';
    resource.verifiedAtMs = 24_000;
    await recorder.observeTransfer(tripId, transfer.id);

    const report = await new TransferBenchmarkRecorder(data, () => 25_000).buildExport(tripId);
    expect(report).toContain('original5MiBEquivalent=n:1; p50:22000ms');
    expect(report).toContain('verificationSource=observed');
    expect(report).toContain('inferredVerificationSamples=0');
  });

  it('bounds persisted records and exported samples', async () => {
    const tripId = 'trip-bounded';
    const resourceId = 'resource-bounded';
    const mediaId = 'media-bounded';
    const transfer = transferRecord({ id: 'transfer-bounded', tripId, resourceId });
    const resource = resourceRecord({ id: resourceId, tripId, mediaId });
    const media = mediaRecord({ id: mediaId, tripId, thumbnailResourceId: resourceId });
    const oversizedRecords = Array.from({ length: 300 }, (_, index) => record({
      tripTag: index.toString(16).padStart(12, '0'),
      photoTag: (index + 1_000).toString(16).padStart(12, '0'),
      resourceTag: (index + 2_000).toString(16).padStart(12, '0'),
      lastProgressAtMs: 10_000 - index,
    }));
    const settings = new Map<string, DeviceSettingRecord>([[
      'diagnostics:transfer-benchmarks:v1',
      {
        key: 'diagnostics:transfer-benchmarks:v1',
        value: { schemaVersion: 1, records: oversizedRecords } as unknown as JsonValue,
        updatedAt: 10_000,
      },
    ]]);
    const data = benchmarkData({ settings, transfer, resource, media });

    await new TransferBenchmarkRecorder(data, () => 20_000).observeTransfer(
      tripId,
      transfer.id,
    );

    const persisted = settings.get('diagnostics:transfer-benchmarks:v1')?.value as unknown as {
      records: TransferBenchmarkRecord[];
    };
    expect(persisted.records).toHaveLength(250);
    const report = buildTransferBenchmarkExport(oversizedRecords, 20_000);
    expect(report.split('\n').filter((line) => line.startsWith('sample='))).toHaveLength(20);
  });
});

function benchmarkData(input: {
  settings: Map<string, DeviceSettingRecord>;
  transfer: TransferRecord;
  resource: ResourceRecord;
  media: MediaRecord;
}): Pick<AirMeshDataLayer, 'repositories'> {
  return {
    repositories: {
      transfers: {
        getById: async () => ({ ...input.transfer }),
        listRecent: async () => [{ ...input.transfer }],
      },
      resources: { getById: async () => ({ ...input.resource }) },
      media: { getById: async () => ({ ...input.media }) },
      deviceSettings: {
        get: async (key: string) => input.settings.get(key) ?? null,
        set: async (setting: DeviceSettingRecord<JsonValue>) => {
          input.settings.set(setting.key, setting);
        },
      },
    },
  } as unknown as Pick<AirMeshDataLayer, 'repositories'>;
}

function transferRecord(patch: Partial<TransferRecord>): TransferRecord {
  return {
    id: 'transfer-a',
    tripId: 'trip-a',
    resourceId: 'resource-a',
    peerMemberId: 'member-a',
    direction: 'download',
    state: 'queued',
    bytesTransferred: 0,
    totalBytes: 100,
    chunkSize: 25,
    nextChunkIndex: 0,
    attemptCount: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...patch,
  };
}

function resourceRecord(patch: Partial<ResourceRecord>): ResourceRecord {
  return {
    schemaVersion: 1,
    id: 'resource-a',
    tripId: 'trip-a',
    mediaId: 'media-a',
    kind: 'THUMBNAIL',
    mimeType: 'image/jpeg',
    fileExtension: 'jpg',
    byteLength: 100,
    sha256: 'a'.repeat(64),
    width: 20,
    height: 20,
    createdAtMs: 1_000,
    availability: 'missing',
    localUri: null,
    verifiedAtMs: null,
    updatedAtMs: 1_000,
    ...patch,
  };
}

function mediaRecord(patch: Partial<MediaRecord>): MediaRecord {
  return {
    schemaVersion: 1,
    id: 'media-a',
    tripId: 'trip-a',
    originMemberId: 'member-a',
    originDeviceId: 'device-a',
    originSequence: 1,
    sourceAssetId: null,
    source: 'SYSTEM_LIBRARY',
    mediaType: 'IMAGE',
    shareStatus: 'PUBLISHED',
    capturedAtMs: 900,
    captureTimeZoneOffsetMinutes: 0,
    captureLocalDate: '2026-07-26',
    ingestedAtMs: 1_000,
    publishedAtMs: 1_000,
    tombstonedAtMs: null,
    location: null,
    originalResourceId: 'resource-original',
    thumbnailResourceId: 'resource-thumbnail',
    ...patch,
  };
}

function record(
  patch: Partial<TransferBenchmarkRecord>,
): TransferBenchmarkRecord {
  return {
    schemaVersion: 1,
    tripTag: 'trip-a',
    photoTag: 'photo-a',
    resourceTag: 'resource-a',
    kind: 'THUMBNAIL',
    byteLength: 100,
    sourcePublishedAtMs: null,
    queuedAtMs: 2_000,
    startedAtMs: null,
    firstProgressAtMs: null,
    progress25AtMs: null,
    progress50AtMs: null,
    progress75AtMs: null,
    verificationAtMs: null,
    verificationInferred: false,
    readyAtMs: null,
    lastProgressAtMs: 2_000,
    lastProgressBytes: 0,
    pauseCount: 0,
    lastState: 'queued',
    ...patch,
  };
}
