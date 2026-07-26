import type { PhotoView } from '@/application/runtime/AirMeshRuntime';
import type { TransferRecord } from '@/data';

export type OriginalTransferPhase =
  | 'ready'
  | 'preparing'
  | 'queued'
  | 'transferring'
  | 'verifying'
  | 'paused'
  | 'failed'
  | 'idle'
  | 'unavailable';

export interface OriginalTransferPresentation {
  phase: OriginalTransferPhase;
  label: string;
  detail: string;
  progress: number | null;
  canRequest: boolean;
  actionLabel: string | null;
}

export type PreviewPhase =
  | 'ready'
  | 'queued'
  | 'transferring'
  | 'verifying'
  | 'paused'
  | 'failed'
  | 'waiting';

export interface PreviewPresentation {
  phase: PreviewPhase;
  label: string;
  progress: number | null;
  canRetry: boolean;
}

export function latestDownloadTransfer(
  transfers: readonly TransferRecord[],
  resourceId: string | null | undefined,
): TransferRecord | null {
  if (!resourceId) return null;
  let latest: TransferRecord | null = null;
  for (const transfer of transfers) {
    if (transfer.direction !== 'download' || transfer.resourceId !== resourceId) continue;
    if (!latest || compareTransferRecency(transfer, latest) > 0) latest = transfer;
  }
  return latest;
}

export function originalTransferPresentation(
  photo: PhotoView,
  transfers: readonly TransferRecord[],
  isActiveTrip: boolean,
  optimisticQueued = false,
): OriginalTransferPresentation {
  const original = photo.original;
  if (original?.availability === 'available' && original.localUri) {
    return {
      phase: 'ready',
      label: 'Original ready',
      detail: 'Byte-for-byte verified and ready to save.',
      progress: 1,
      canRequest: false,
      actionLabel: null,
    };
  }
  if (!original) {
    if (isActiveTrip && photo.media.shareStatus === 'PUBLISHED') {
      return {
        phase: 'preparing',
        label: 'Preparing exact original',
        detail: 'The preview arrived first. Original-file verification is continuing in the background.',
        progress: null,
        canRequest: false,
        actionLabel: null,
      };
    }
    return {
      phase: 'unavailable',
      label: 'Original unavailable',
      detail: 'This photo does not include original-file metadata.',
      progress: null,
      canRequest: false,
      actionLabel: null,
    };
  }
  if (!isActiveTrip) {
    return {
      phase: 'unavailable',
      label: 'Original not stored',
      detail: photoPreviewUri(photo)
        ? 'Only the preview was kept on this phone. Rejoin while a holder is connected to recover the exact file automatically.'
        : 'Only the catalog entry remains on this phone. Rejoin while a holder is connected to recover the file automatically.',
      progress: null,
      canRequest: false,
      actionLabel: null,
    };
  }

  const transfer = latestDownloadTransfer(transfers, original.id);
  if (optimisticQueued && (!transfer || transfer.state === 'failed' || transfer.state === 'cancelled')) {
    return queuedOriginal();
  }
  if (!transfer) {
    return {
      phase: 'idle',
      label: 'Automatic original delivery is waiting',
      detail: 'CrewRoll will fetch the exact file when a holder connects. You can retry now.',
      progress: null,
      canRequest: true,
      actionLabel: 'Retry exact original',
    };
  }

  const progress = transferProgress(transfer);
  switch (transfer.state) {
    case 'queued':
      return queuedOriginal();
    case 'transferring':
      if (progress >= 1 && transfer.totalBytes > 0) {
        return {
          phase: 'verifying',
          label: 'Verifying exact original',
          detail: 'All bytes arrived. CrewRoll is checking the file before making it available.',
          progress: 1,
          canRequest: false,
          actionLabel: null,
        };
      }
      return {
        phase: 'transferring',
        label: 'Getting exact original',
        detail: 'Keep CrewRoll open while the exact file transfers.',
        progress,
        canRequest: false,
        actionLabel: null,
      };
    case 'verifying':
      return {
        phase: 'verifying',
        label: 'Verifying exact original',
        detail: 'All bytes arrived. CrewRoll is checking the file before making it available.',
        progress: 1,
        canRequest: false,
        actionLabel: null,
      };
    case 'paused':
      return {
        phase: 'paused',
        label: 'Original waiting to resume',
        detail: 'CrewRoll retries automatically. Tap below to ask a connected holder again now.',
        progress,
        canRequest: true,
        actionLabel: 'Retry exact original',
      };
    case 'failed':
      return {
        phase: 'failed',
        label: 'Original transfer interrupted',
        detail: 'The file was not marked ready. Retry when a holder is connected.',
        progress,
        canRequest: true,
        actionLabel: 'Retry exact original',
      };
    case 'completed':
      return {
        phase: 'verifying',
        label: 'Finishing exact original',
        detail: 'The transfer completed. CrewRoll is committing the verified local file.',
        progress: 1,
        canRequest: false,
        actionLabel: null,
      };
    case 'cancelled':
      return {
        phase: 'idle',
        label: 'Automatic original delivery was cancelled',
        detail: 'CrewRoll will retry when a holder reconnects, or you can retry now.',
        progress: null,
        canRequest: true,
        actionLabel: 'Retry exact original',
      };
  }
  return {
    phase: 'unavailable',
    label: 'Original status unavailable',
    detail: 'CrewRoll could not read this transfer state.',
    progress: null,
    canRequest: false,
    actionLabel: null,
  };
}

export function previewPresentation(
  photo: PhotoView,
  transfers: readonly TransferRecord[],
  options: { connected: boolean; hasSyncError: boolean },
): PreviewPresentation {
  if (photoPreviewUri(photo)) {
    return { phase: 'ready', label: 'Preview ready', progress: 1, canRetry: false };
  }

  const transfer = latestDownloadTransfer(transfers, photo.thumbnail?.id);
  if (!transfer) {
    if (options.hasSyncError) {
      return { phase: 'failed', label: 'Preview will retry', progress: null, canRetry: false };
    }
    return {
      phase: 'waiting',
      label: options.connected ? 'Waiting for connected holder' : 'Waiting for connection',
      progress: null,
      canRetry: false,
    };
  }

  const progress = transferProgress(transfer);
  switch (transfer.state) {
    case 'queued':
      return { phase: 'queued', label: 'Preview queued', progress: 0, canRetry: false };
    case 'transferring':
      if (progress >= 1 && transfer.totalBytes > 0) {
        return { phase: 'verifying', label: 'Finishing preview', progress: 1, canRetry: false };
      }
      return {
        phase: 'transferring',
        label: `Preview ${Math.round(progress * 100)}%`,
        progress,
        canRetry: false,
      };
    case 'verifying':
      return { phase: 'verifying', label: 'Finishing preview', progress: 1, canRetry: false };
    case 'paused':
      return { phase: 'paused', label: 'Preview will retry', progress, canRetry: false };
    case 'failed':
      return { phase: 'failed', label: 'Preview will retry', progress, canRetry: false };
    case 'completed':
      return { phase: 'verifying', label: 'Finishing preview', progress: 1, canRetry: false };
    case 'cancelled':
      return { phase: 'failed', label: 'Preview cancelled', progress: null, canRetry: true };
  }
  return { phase: 'waiting', label: 'Waiting for connected holder', progress: null, canRetry: false };
}

export function photoPreviewUri(photo: PhotoView): string | null {
  return photo.thumbnail?.localUri
    ?? (photo.original?.availability === 'available' ? photo.original.localUri : null);
}

export function photoDisplayUri(photo: PhotoView): string | null {
  return (photo.original?.availability === 'available' ? photo.original.localUri : null)
    ?? photo.thumbnail?.localUri
    ?? null;
}

export function countMissingPreviews(photos: readonly PhotoView[]): number {
  return photos.reduce((count, photo) => count + (photoPreviewUri(photo) ? 0 : 1), 0);
}

function queuedOriginal(): OriginalTransferPresentation {
  return {
    phase: 'queued',
    label: 'Original queued',
    detail: 'Waiting for a connected holder to start sending the exact file.',
    progress: 0,
    canRequest: false,
    actionLabel: null,
  };
}

function transferProgress(transfer: TransferRecord): number {
  if (transfer.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(1, transfer.bytesTransferred / transfer.totalBytes));
}

function compareTransferRecency(left: TransferRecord, right: TransferRecord): number {
  return left.updatedAt - right.updatedAt
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}
