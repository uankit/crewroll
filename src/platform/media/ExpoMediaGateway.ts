import {
  Asset,
  AssetField,
  MediaSubtype,
  MediaType,
  PermissionStatus,
  Query,
  addListener,
  getPermissionsAsync,
  presentPermissionsPicker,
  requestPermissionsAsync,
} from 'expo-media-library';
import type {
  MediaLibraryAssetsChangeEvent,
  PermissionResponse,
} from 'expo-media-library';
import { Platform } from 'react-native';

/** The read scope granted by the system photo picker. */
export type MediaLibraryAccess = 'full' | 'limited' | 'denied' | 'undetermined';

export interface MediaPermissionState {
  access: MediaLibraryAccess;
  canAskAgain: boolean;
  expires: PermissionResponse['expires'];
  granted: boolean;
}

/**
 * A keyset-style cursor that can be serialized to SQLite after each page.
 *
 * `offsetAtCreationTime` disambiguates assets with the same millisecond creation
 * timestamp. The canonical trip start is intentionally not stored in the
 * cursor: every read requires it from the authoritative trip record.
 */
export interface MediaScanCursor {
  creationTimeMs: number;
  offsetAtCreationTime: number;
}

export interface MediaScanRequest {
  canonicalTripStartMs: number;
  cursor?: MediaScanCursor | null;
  /** Defaults to 50 and is clamped to 1...200. */
  batchSize?: number;
}

export interface DeviceImageAsset {
  assetId: string;
  filename: string | null;
  capturedAtMs: number;
  modifiedAtMs: number | null;
  width: number | null;
  height: number | null;
}

export interface MediaScanFailure {
  assetId: string;
  reason: string;
  retryable: boolean;
  /** Present when enough metadata exists to retry independently of the scan cursor. */
  asset: DeviceImageAsset | null;
}

export interface MediaScanPage {
  assets: DeviceImageAsset[];
  failures: MediaScanFailure[];
  excludedScreenshotCount: number;
  nextCursor: MediaScanCursor;
  /**
   * A full raw query page was returned, so another page may exist. An exact
   * final page can produce one harmless empty follow-up query.
   */
  hasMore: boolean;
}

export interface MediaAssetLookupResult {
  assets: DeviceImageAsset[];
  failures: MediaScanFailure[];
  excludedScreenshotCount: number;
}

export interface ResolvedMediaSource {
  assetId: string;
  /** Null means the original is only in iCloud and should not be fetched offline. */
  uri: string | null;
  locallyAvailable: boolean;
}

export interface MediaLocation {
  latitude: number;
  longitude: number;
}

export type MediaLibraryChange =
  | {
      kind: 'incremental';
      insertedAssetIds: string[];
      deletedAssetIds: string[];
      updatedAssetIds: string[];
    }
  | { kind: 'rescan-required' };

export interface MediaChangeSubscription {
  remove(): void;
}

export interface MediaGateway {
  getPermissionState(): Promise<MediaPermissionState>;
  requestPermission(): Promise<MediaPermissionState>;
  presentLimitedLibraryPicker(): Promise<void>;
  getImageAssetsByIds(assetIds: readonly string[]): Promise<MediaAssetLookupResult>;
  scanPage(request: MediaScanRequest): Promise<MediaScanPage>;
  scan(request: MediaScanRequest): AsyncGenerator<MediaScanPage, void, void>;
  resolveReadableSource(assetId: string): Promise<ResolvedMediaSource>;
  readLocation(assetId: string): Promise<MediaLocation | null>;
  saveImageToLibrary(uri: string): Promise<string>;
  subscribe(listener: (change: MediaLibraryChange) => void): MediaChangeSubscription;
}

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const MAX_DIRECT_ASSET_LOOKUP = 200;
const IOS_METADATA_CONCURRENCY = 8;

/**
 * Expo SDK 57 photo-library adapter.
 *
 * Discovery is metadata-only. Resolving a full-size URI is a separate call so
 * a gallery scan never downloads an iCloud original or loads original bytes
 * into JavaScript memory.
 */
export class ExpoMediaGateway implements MediaGateway {
  async getPermissionState(): Promise<MediaPermissionState> {
    return mapPermission(await getPermissionsAsync(false, ['photo']));
  }

  async requestPermission(): Promise<MediaPermissionState> {
    return mapPermission(await requestPermissionsAsync(false, ['photo']));
  }

  async presentLimitedLibraryPicker(): Promise<void> {
    await presentPermissionsPicker(['photo']);
  }

  async getImageAssetsByIds(assetIds: readonly string[]): Promise<MediaAssetLookupResult> {
    const uniqueAssetIds = [...new Set(assetIds)];
    if (uniqueAssetIds.length > MAX_DIRECT_ASSET_LOOKUP) {
      throw new RangeError(
        `At most ${MAX_DIRECT_ASSET_LOOKUP} inserted media assets can be resolved at once.`,
      );
    }
    for (const assetId of uniqueAssetIds) requireIdentifier(assetId, 'assetId');

    const hydrated = await mapWithConcurrency(
      uniqueAssetIds,
      IOS_METADATA_CONCURRENCY,
      async (assetId) => {
        try {
          const asset = new Asset(assetId);
          const [mediaType, creationTime, filename, modificationTime, shape, subtypes] =
            await Promise.all([
              asset.getMediaType(),
              asset.getCreationTime(),
              asset.getFilename(),
              asset.getModificationTime(),
              asset.getShape(),
              Platform.OS === 'ios' ? asset.getMediaSubtypes() : Promise.resolve([]),
            ]);
          if (mediaType !== MediaType.IMAGE) {
            return {
              kind: 'failure' as const,
              failure: {
                assetId,
                reason: 'Inserted media is not an image.',
                retryable: false,
                asset: null,
              },
            };
          }
          if (creationTime === null) {
            return {
              kind: 'failure' as const,
              failure: {
                assetId,
                reason: 'Photo has no creation timestamp.',
                retryable: false,
                asset: null,
              },
            };
          }
          if (subtypes.includes(MediaSubtype.SCREENSHOT)) {
            return { kind: 'screenshot' as const };
          }
          return {
            kind: 'asset' as const,
            asset: {
              assetId,
              filename,
              capturedAtMs: creationTime,
              modifiedAtMs: modificationTime,
              width: shape?.width ?? null,
              height: shape?.height ?? null,
            } satisfies DeviceImageAsset,
          };
        } catch (error) {
          return {
            kind: 'failure' as const,
            failure: {
              assetId,
              reason: errorMessage(error),
              retryable: true,
              asset: null,
            },
          };
        }
      },
    );

    const result: MediaAssetLookupResult = {
      assets: [],
      failures: [],
      excludedScreenshotCount: 0,
    };
    for (const item of hydrated) {
      if (item.kind === 'asset') result.assets.push(item.asset);
      else if (item.kind === 'failure') result.failures.push(item.failure);
      else result.excludedScreenshotCount += 1;
    }
    return result;
  }

  async scanPage(request: MediaScanRequest): Promise<MediaScanPage> {
    const canonicalTripStartMs = requireTimestamp(
      request.canonicalTripStartMs,
      'canonicalTripStartMs'
    );
    const batchSize = clampBatchSize(request.batchSize);
    const cursor = normalizeCursor(request.cursor, canonicalTripStartMs);

    const metadata = await new Query()
      .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
      .gte(AssetField.CREATION_TIME, cursor.creationTimeMs)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
      .offset(cursor.offsetAtCreationTime)
      .limit(batchSize)
      .exeForMetadata();

    const nextCursor = advanceCursor(cursor, metadata);
    const hydrated = await mapWithConcurrency(metadata, IOS_METADATA_CONCURRENCY, async (item) => {
      if (item.creationTime === null) {
        return {
          kind: 'failure' as const,
          failure: {
            assetId: item.id,
            reason: 'Photo has no creation timestamp.',
            retryable: false,
            asset: null,
          },
        };
      }

      if (Platform.OS === 'ios') {
        try {
          const subtypes = await new Asset(item.id).getMediaSubtypes();
          if (subtypes.includes(MediaSubtype.SCREENSHOT)) {
            return { kind: 'screenshot' as const };
          }
        } catch (error) {
          return {
            kind: 'failure' as const,
            failure: {
              assetId: item.id,
              reason: errorMessage(error),
              retryable: true,
              asset: deviceImageAsset(item, item.creationTime),
            },
          };
        }
      }

      return {
        kind: 'asset' as const,
        asset: deviceImageAsset(item, item.creationTime),
      };
    });

    const assets: DeviceImageAsset[] = [];
    const failures: MediaScanFailure[] = [];
    let excludedScreenshotCount = 0;

    for (const result of hydrated) {
      if (result.kind === 'asset') {
        assets.push(result.asset);
      } else if (result.kind === 'failure') {
        failures.push(result.failure);
      } else {
        excludedScreenshotCount += 1;
      }
    }

    return {
      assets,
      failures,
      excludedScreenshotCount,
      nextCursor,
      hasMore: metadata.length === batchSize,
    };
  }

  async *scan(request: MediaScanRequest): AsyncGenerator<MediaScanPage, void, void> {
    let cursor = request.cursor;

    do {
      const page = await this.scanPage({ ...request, cursor });
      yield page;
      cursor = page.nextCursor;

      if (!page.hasMore) {
        return;
      }
    } while (true);
  }

  async resolveReadableSource(assetId: string): Promise<ResolvedMediaSource> {
    requireIdentifier(assetId, 'assetId');
    const asset = new Asset(assetId);

    // getUri() can cause PhotoKit to resolve an iCloud-backed resource. Refuse
    // that work here so AirMesh remains offline-first and does not consume data.
    if (Platform.OS === 'ios') {
      const isInCloud = await asset.getIsInCloud();
      if (isInCloud) {
        return { assetId, uri: null, locallyAvailable: false };
      }
    }

    // Android asset IDs are MediaStore content:// URIs. The private file store
    // copies them through the native content provider because SDK 57 cannot
    // create a FileHandle for generic MediaStore URIs.
    const uri =
      Platform.OS === 'android' && assetId.startsWith('content://')
        ? assetId
        : await asset.getUri();

    return { assetId, uri, locallyAvailable: true };
  }

  async readLocation(assetId: string): Promise<MediaLocation | null> {
    requireIdentifier(assetId, 'assetId');
    const location = await new Asset(assetId).getLocation();
    if (!location) {
      return null;
    }
    return { latitude: location.latitude, longitude: location.longitude };
  }

  async saveImageToLibrary(uri: string): Promise<string> {
    requireIdentifier(uri, 'uri');
    let permission = await getPermissionsAsync(true);
    if (!permission.granted && permission.canAskAgain) {
      permission = await requestPermissionsAsync(true);
    }
    if (!permission.granted) {
      throw new Error(
        'Photo add access is off. Allow CrewRoll to add photos in system Settings, then try again.',
      );
    }
    const asset = await Asset.create(uri);
    return asset.id;
  }

  subscribe(listener: (change: MediaLibraryChange) => void): MediaChangeSubscription {
    return addListener((event) => listener(mapChangeEvent(event)));
  }
}

function deviceImageAsset(
  item: {
    id: string;
    filename: string | null;
    modificationTime: number | null;
    width: number | null;
    height: number | null;
  },
  creationTime: number,
): DeviceImageAsset {
  return {
    assetId: item.id,
    filename: item.filename,
    capturedAtMs: creationTime,
    modifiedAtMs: item.modificationTime,
    width: item.width,
    height: item.height,
  };
}

function mapPermission(permission: PermissionResponse): MediaPermissionState {
  let access: MediaLibraryAccess;

  if (permission.accessPrivileges === 'limited') {
    access = 'limited';
  } else if (permission.status === PermissionStatus.UNDETERMINED) {
    access = 'undetermined';
  } else if (!permission.granted || permission.accessPrivileges === 'none') {
    access = 'denied';
  } else {
    // Older Android versions may omit accessPrivileges even after granting.
    access = 'full';
  }

  return {
    access,
    canAskAgain: permission.canAskAgain,
    expires: permission.expires,
    granted: access === 'full' || access === 'limited',
  };
}

function mapChangeEvent(event: MediaLibraryAssetsChangeEvent): MediaLibraryChange {
  if (!event?.hasIncrementalChanges) {
    return { kind: 'rescan-required' };
  }

  return {
    kind: 'incremental',
    insertedAssetIds: event.insertedAssets ?? [],
    deletedAssetIds: event.deletedAssets ?? [],
    updatedAssetIds: event.updatedAssets ?? [],
  };
}

function normalizeCursor(
  cursor: MediaScanCursor | null | undefined,
  canonicalTripStartMs: number
): MediaScanCursor {
  if (!cursor) {
    return { creationTimeMs: canonicalTripStartMs, offsetAtCreationTime: 0 };
  }

  const creationTimeMs = requireTimestamp(cursor.creationTimeMs, 'cursor.creationTimeMs');
  if (!Number.isSafeInteger(cursor.offsetAtCreationTime) || cursor.offsetAtCreationTime < 0) {
    throw new RangeError('cursor.offsetAtCreationTime must be a non-negative safe integer.');
  }

  if (creationTimeMs < canonicalTripStartMs) {
    return { creationTimeMs: canonicalTripStartMs, offsetAtCreationTime: 0 };
  }

  return { creationTimeMs, offsetAtCreationTime: cursor.offsetAtCreationTime };
}

function advanceCursor(
  current: MediaScanCursor,
  metadata: readonly { creationTime: number | null }[]
): MediaScanCursor {
  if (metadata.length === 0) {
    return current;
  }

  const lastCreationTime = metadata.at(-1)?.creationTime;
  if (lastCreationTime === null || lastCreationTime === undefined) {
    // A gte creation-time query should not return null timestamps. Keep the
    // page movable if a platform implementation nevertheless does so.
    return {
      creationTimeMs: current.creationTimeMs,
      offsetAtCreationTime: current.offsetAtCreationTime + metadata.length,
    };
  }

  const countAtLastTimestamp = metadata.reduce(
    (count, item) => count + (item.creationTime === lastCreationTime ? 1 : 0),
    0
  );

  return {
    creationTimeMs: lastCreationTime,
    offsetAtCreationTime:
      lastCreationTime === current.creationTimeMs
        ? current.offsetAtCreationTime + countAtLastTimestamp
        : countAtLastTimestamp,
  };
}

function clampBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) {
    return DEFAULT_BATCH_SIZE;
  }
  if (!Number.isFinite(batchSize)) {
    throw new RangeError('batchSize must be finite.');
  }
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(batchSize)));
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative millisecond timestamp.`);
  }
  return value;
}

function requireIdentifier(value: string, field: string): void {
  if (value.length === 0 || value.length > 2_048) {
    throw new RangeError(`${field} must contain between 1 and 2,048 characters.`);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
