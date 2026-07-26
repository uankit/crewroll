import { describe, expect, it } from 'vitest';

import type { PhotoView } from '@/application/runtime/AirMeshRuntime';
import type { TransferRecord, TransferState } from '@/data';

import {
  countMissingPreviews,
  latestDownloadTransfer,
  originalTransferPresentation,
  previewPresentation,
} from './photoPresentation';

describe('photo transfer presentation', () => {
  it('uses the newest attempt instead of an older failed transfer', () => {
    const oldFailure = transfer('old', 'failed', 9, 100, 10);
    const retry = transfer('retry', 'transferring', 40, 100, 20);

    expect(latestDownloadTransfer([oldFailure, retry], 'original')).toBe(retry);
    expect(originalTransferPresentation(photo(), [oldFailure, retry], true)).toMatchObject({
      phase: 'transferring',
      progress: 0.4,
      canRequest: false,
    });
  });

  it('separates all-bytes-received from verified availability', () => {
    expect(originalTransferPresentation(
      photo(),
      [transfer('receiving', 'transferring', 100, 100, 20)],
      true,
    )).toMatchObject({
      phase: 'verifying',
      label: 'Verifying exact original',
      progress: 1,
    });
    expect(originalTransferPresentation(
      photo(),
      [transfer('verifying', 'verifying', 100, 100, 21)],
      true,
    )).toMatchObject({
      phase: 'verifying',
      label: 'Verifying exact original',
      progress: 1,
    });
  });

  it('offers the existing request action again after a failed attempt', () => {
    expect(originalTransferPresentation(
      photo(),
      [transfer('failed', 'failed', 63, 100, 20)],
      true,
    )).toMatchObject({
      phase: 'failed',
      canRequest: true,
      actionLabel: 'Retry exact original',
    });
  });

  it('offers a targeted retry for paused originals without restarting the connection', () => {
    expect(originalTransferPresentation(
      photo(),
      [transfer('paused', 'paused', 55, 100, 20)],
      true,
    )).toMatchObject({
      phase: 'paused',
      progress: 0.55,
      canRequest: true,
      actionLabel: 'Retry exact original',
    });
    expect(originalTransferPresentation(
      photo(),
      [transfer('completed', 'completed', 100, 100, 30)],
      true,
    )).toMatchObject({
      phase: 'verifying',
      label: 'Finishing exact original',
    });
  });

  it('lets verified resource availability override stale transfer failures', () => {
    expect(originalTransferPresentation(
      photo({ originalAvailable: true }),
      [transfer('failed', 'failed', 100, 100, 20)],
      true,
    )).toMatchObject({
      phase: 'ready',
      canRequest: false,
    });
  });

  it('supports an optimistic queued state until the runtime snapshot catches up', () => {
    expect(originalTransferPresentation(photo(), [], true, true)).toMatchObject({
      phase: 'queued',
      label: 'Original queued',
    });
  });

  it('describes an unstarted original as automatic delivery with a manual retry', () => {
    expect(originalTransferPresentation(photo(), [], true)).toMatchObject({
      phase: 'idle',
      label: 'Automatic original delivery is waiting',
      canRequest: true,
      actionLabel: 'Retry exact original',
    });
  });

  it('shows the intentional preview-first phase while the original manifest is pending', () => {
    const previewOnly = { ...photo({ withThumbnail: true }), original: null };
    expect(originalTransferPresentation(previewOnly, [], true)).toMatchObject({
      phase: 'preparing',
      label: 'Preparing exact original',
      canRequest: false,
    });
  });

  it('distinguishes preview progress, verification, and recoverable errors', () => {
    const value = photo({ withThumbnail: true });
    expect(previewPresentation(
      value,
      [transfer('thumb-progress', 'transferring', 42, 100, 20, 'thumbnail')],
      { connected: true, hasSyncError: false },
    )).toMatchObject({ phase: 'transferring', label: 'Preview 42%' });
    expect(previewPresentation(
      value,
      [transfer('thumb-verify', 'transferring', 100, 100, 30, 'thumbnail')],
      { connected: true, hasSyncError: false },
    )).toMatchObject({ phase: 'verifying', label: 'Finishing preview' });
    expect(previewPresentation(
      value,
      [transfer('thumb-verifying-state', 'verifying', 100, 100, 31, 'thumbnail')],
      { connected: true, hasSyncError: false },
    )).toMatchObject({ phase: 'verifying', label: 'Finishing preview' });
    expect(previewPresentation(
      value,
      [transfer('thumb-failed', 'failed', 42, 100, 40, 'thumbnail')],
      { connected: true, hasSyncError: false },
    )).toMatchObject({
      phase: 'failed',
      label: 'Preview will retry',
      canRetry: false,
    });
  });

  it('shows automatic recovery instead of asking for repeated preview taps', () => {
    expect(previewPresentation(
      photo({ withThumbnail: true }),
      [],
      { connected: false, hasSyncError: true },
    )).toMatchObject({
      phase: 'failed',
      label: 'Preview will retry',
      canRetry: false,
    });
  });

  it('counts only photos whose preview cannot be rendered locally', () => {
    expect(countMissingPreviews([
      photo({ thumbnailUri: 'file:///thumbnail.jpg', withThumbnail: true }),
      photo({ withThumbnail: true }),
      photo({ originalAvailable: true }),
    ])).toBe(1);
  });
});

function photo(options: {
  originalAvailable?: boolean;
  withThumbnail?: boolean;
  thumbnailUri?: string | null;
} = {}): PhotoView {
  const originalAvailable = options.originalAvailable ?? false;
  return {
    contributorName: 'Ari',
    media: {
      schemaVersion: 1,
      id: 'media',
      tripId: 'trip',
      originMemberId: 'member',
      originDeviceId: 'device',
      originSequence: 1,
      sourceAssetId: null,
      source: 'SYSTEM_LIBRARY',
      mediaType: 'IMAGE',
      shareStatus: 'PUBLISHED',
      capturedAtMs: 1,
      captureTimeZoneOffsetMinutes: 0,
      captureLocalDate: '2026-07-24',
      ingestedAtMs: 1,
      publishedAtMs: 1,
      tombstonedAtMs: null,
      location: null,
      originalResourceId: 'original',
      thumbnailResourceId: options.withThumbnail ? 'thumbnail' : null,
    },
    original: {
      schemaVersion: 1,
      id: 'original',
      tripId: 'trip',
      mediaId: 'media',
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 100,
      sha256: 'a'.repeat(64),
      width: 100,
      height: 100,
      createdAtMs: 1,
      availability: originalAvailable ? 'available' : 'missing',
      localUri: originalAvailable ? 'file:///original.jpg' : null,
      verifiedAtMs: originalAvailable ? 2 : null,
      updatedAtMs: 2,
    },
    thumbnail: options.withThumbnail ? {
      schemaVersion: 1,
      id: 'thumbnail',
      tripId: 'trip',
      mediaId: 'media',
      kind: 'THUMBNAIL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 10,
      sha256: 'b'.repeat(64),
      width: 10,
      height: 10,
      createdAtMs: 1,
      availability: options.thumbnailUri ? 'available' : 'missing',
      localUri: options.thumbnailUri ?? null,
      verifiedAtMs: options.thumbnailUri ? 2 : null,
      updatedAtMs: 2,
    } : null,
  };
}

function transfer(
  id: string,
  state: TransferState,
  bytesTransferred: number,
  totalBytes: number,
  updatedAt: number,
  resourceId = 'original',
): TransferRecord {
  return {
    id,
    tripId: 'trip',
    resourceId,
    peerMemberId: 'peer',
    direction: 'download',
    state,
    bytesTransferred,
    totalBytes,
    chunkSize: 10,
    nextChunkIndex: 1,
    attemptCount: state === 'failed' ? 1 : 0,
    lastError: state === 'failed' ? 'PEER_DISCONNECTED' : null,
    startedAt: 1,
    completedAt: state === 'completed' ? updatedAt : null,
    createdAt: updatedAt,
    updatedAt,
  };
}
