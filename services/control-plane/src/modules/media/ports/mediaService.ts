import type {
  CommitAssetBody,
  CommitAssetResponse,
  CreateDownloadSessionBody,
  CreateUploadSessionBody,
  DownloadSessionResponse,
  SavedReceiptBody,
  SavedReceiptResponse,
  UploadSessionResponse,
  PublishPreviewBody,
  PublishPreviewResponse,
  PreviewDownloadResponse,
  PreviewFeedResponse,
} from "@crewroll/contracts";

export interface MediaActor {
  readonly userId: string;
  readonly deviceId: string;
}

export interface CiphertextObject {
  readonly key: string;
  readonly bytes: string;
  readonly checksum: string;
}

/** This port handles ciphertext only. No media keys or plaintext reach it. */
export interface CiphertextStore {
  upload(object: CiphertextObject, expiresAt: Date): Promise<string>;
  inspect(key: string): Promise<{
    bytes: string;
    checksum: string;
    etag: string;
  } | null>;
  download(key: string, expiresAt: Date): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface PendingDelivery {
  deliveryId: string;
  assetId: string;
  tripId: string;
  sourceDeviceId: string;
  committedAt: string;
}

export interface MediaService {
  publishPreview(
    actor: MediaActor,
    assetId: string,
    body: PublishPreviewBody,
  ): Promise<PublishPreviewResponse>;
  previewFeed(
    actor: MediaActor,
    tripId: string,
    after: string,
  ): Promise<PreviewFeedResponse>;
  previewDownload(
    actor: MediaActor,
    assetId: string,
  ): Promise<PreviewDownloadResponse>;
  createUpload(
    actor: MediaActor,
    body: CreateUploadSessionBody,
  ): Promise<UploadSessionResponse>;
  commit(
    actor: MediaActor,
    assetId: string,
    body: CommitAssetBody,
  ): Promise<CommitAssetResponse>;
  pending(actor: MediaActor): Promise<{ items: PendingDelivery[] }>;
  download(
    actor: MediaActor,
    deliveryId: string,
    body: CreateDownloadSessionBody,
  ): Promise<DownloadSessionResponse>;
  saved(
    actor: MediaActor,
    deliveryId: string,
    eventId: string,
    body: SavedReceiptBody,
  ): Promise<SavedReceiptResponse>;
  cleanup(): Promise<number>;
}
