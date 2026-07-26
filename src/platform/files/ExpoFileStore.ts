import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageManipulatorContext, ImageRef } from 'expo-image-manipulator';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import { MAX_RESOURCE_CHUNK_BYTES } from '../../core/constants';

export interface StoredFile {
  uri: string;
  byteSize: number;
  mimeType: string;
}

export interface FileChunk {
  offset: number;
  bytes: Uint8Array;
  isLast: boolean;
}

export interface ReadChunksRequest {
  uri: string;
  offset?: number;
  endOffsetExclusive?: number;
  /** Defaults to 256 KiB and is clamped to 16 KiB...1 MiB. */
  chunkSize?: number;
}

export interface IncomingChunk {
  transferId: string;
  offset: number;
  bytes: Uint8Array;
}

export interface FinalizeIncomingRequest {
  transferId: string;
  storageKey: string;
  extension: string;
  expectedByteSize: number;
  overwrite?: boolean;
}

export interface CopyOriginalRequest {
  sourceUri: string;
  storageKey: string;
  extension: string;
  chunkSize?: number;
  overwrite?: boolean;
}

export interface ThumbnailRequest {
  sourceUri: string;
  storageKey: string;
  /** Longest thumbnail edge. Defaults to 480 pixels. */
  maxDimension?: number;
  /** JPEG quality from 0 to 1. Defaults to 0.72. */
  quality?: number;
  overwrite?: boolean;
}

export interface StoredThumbnail extends StoredFile {
  width: number | null;
  height: number | null;
}

export interface StoredResourceReference {
  localUri: string | null;
}

export interface DeleteTripFilesResult {
  requested: number;
  deleted: number;
  missing: number;
}

export interface ChunkedFileStore {
  readChunks(request: ReadChunksRequest): AsyncGenerator<FileChunk, void, void>;
  getIncoming(transferId: string): StoredFile | null;
  prepareIncoming(transferId: string, reset?: boolean): Promise<StoredFile>;
  writeIncomingChunk(chunk: IncomingChunk): Promise<number>;
  finalizeIncoming(request: FinalizeIncomingRequest): Promise<StoredFile>;
  discardIncoming(transferId: string): Promise<void>;
  deleteStoredFile(uri: string): Promise<boolean>;
  /** Caller supplies resource rows already scoped to one trip. */
  deleteTripFiles(
    resources: readonly StoredResourceReference[],
  ): Promise<DeleteTripFilesResult>;
  copyOriginalExact(request: CopyOriginalRequest): Promise<StoredFile>;
  createThumbnail(request: ThumbnailRequest): Promise<StoredThumbnail>;
  getOriginal(storageKey: string, extension: string): StoredFile | null;
  getThumbnail(storageKey: string): StoredThumbnail | null;
}

const DEFAULT_CHUNK_SIZE = 256 * 1024;
const MIN_CHUNK_SIZE = 16 * 1024;
const MAX_CHUNK_SIZE = MAX_RESOURCE_CHUNK_BYTES;
const DEFAULT_THUMBNAIL_DIMENSION = 480;
const DEFAULT_THUMBNAIL_QUALITY = 0.72;
const INTERNAL_MIME_TYPE = 'application/octet-stream';

/**
 * Durable Expo SDK 57 file store.
 *
 * Original files are always copied and transferred through FileHandle chunks;
 * the original is never converted to base64 or read into one JS allocation.
 */
export class ExpoFileStore implements ChunkedFileStore {
  private readonly root = new Directory(Paths.document, 'airmesh');
  private readonly originals = new Directory(this.root, 'originals');
  private readonly thumbnails = new Directory(this.root, 'thumbnails');
  private readonly incoming = new Directory(this.root, 'incoming');
  private readonly locks = new Map<string, Promise<void>>();
  private directoriesReady = false;

  async *readChunks(request: ReadChunksRequest): AsyncGenerator<FileChunk, void, void> {
    const chunkSize = normalizeChunkSize(request.chunkSize);
    const offset = requireNonNegativeInteger(request.offset ?? 0, 'offset');
    const file = new File(requireUri(request.uri));
    const handle = file.open(FileMode.ReadOnly);

    try {
      const fileSize = handle.size;
      if (fileSize === null) {
        throw new Error('The source file was closed before it could be read.');
      }

      const requestedEnd =
        request.endOffsetExclusive === undefined
          ? fileSize
          : requireNonNegativeInteger(request.endOffsetExclusive, 'endOffsetExclusive');
      const endOffsetExclusive = Math.min(requestedEnd, fileSize);

      if (offset > endOffsetExclusive) {
        throw new RangeError('offset cannot be greater than endOffsetExclusive.');
      }

      handle.offset = offset;
      let currentOffset = offset;

      while (currentOffset < endOffsetExclusive) {
        const bytesToRead = Math.min(chunkSize, endOffsetExclusive - currentOffset);
        const bytes = handle.readBytes(bytesToRead);
        if (bytes.byteLength === 0) {
          throw new Error(`Unexpected end of file at byte ${currentOffset}.`);
        }

        const chunkOffset = currentOffset;
        currentOffset += bytes.byteLength;
        yield {
          offset: chunkOffset,
          bytes,
          isLast: currentOffset >= endOffsetExclusive,
        };

        // Let rendering and network callbacks run between synchronous native
        // handle reads without accumulating the whole original in memory.
        await Promise.resolve();
      }
    } finally {
      handle.close();
    }
  }

  getIncoming(transferId: string): StoredFile | null {
    this.ensureDirectories();
    const file = this.incomingFile(transferId);
    return file.exists ? fileRecord(file, INTERNAL_MIME_TYPE) : null;
  }

  async prepareIncoming(transferId: string, reset = false): Promise<StoredFile> {
    this.ensureDirectories();
    const file = this.incomingFile(transferId);

    await this.withFileLock(file.uri, async () => {
      if (!file.exists) {
        file.create({ intermediates: true });
      } else if (reset) {
        const handle = file.open(FileMode.Truncate);
        handle.close();
      }
    });

    return fileRecord(file, INTERNAL_MIME_TYPE);
  }

  async writeIncomingChunk(chunk: IncomingChunk): Promise<number> {
    this.ensureDirectories();
    const offset = requireNonNegativeInteger(chunk.offset, 'offset');
    if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0) {
      throw new RangeError('bytes must be a non-empty Uint8Array.');
    }

    const file = this.incomingFile(chunk.transferId);
    return this.withFileLock(file.uri, async () => {
      if (!file.exists) {
        file.create({ intermediates: true });
      }

      const handle = file.open(FileMode.ReadWrite);
      try {
        const currentSize = handle.size;
        if (currentSize === null) {
          throw new Error('The incoming file was closed before it could be written.');
        }
        if (offset > currentSize) {
          throw new RangeError(
            `Chunk starts at ${offset}, leaving a gap after the current ${currentSize} bytes.`
          );
        }

        handle.offset = offset;
        handle.writeBytes(chunk.bytes);
        return handle.size ?? offset + chunk.bytes.byteLength;
      } finally {
        handle.close();
      }
    });
  }

  async finalizeIncoming(request: FinalizeIncomingRequest): Promise<StoredFile> {
    this.ensureDirectories();
    const expectedByteSize = requireNonNegativeInteger(
      request.expectedByteSize,
      'expectedByteSize'
    );
    const source = this.incomingFile(request.transferId);
    const target = this.originalFile(request.storageKey, request.extension);

    return this.withFileLocks([source.uri, target.uri], async () => {
      if (!source.exists) {
        if (target.exists && target.size === expectedByteSize) {
          // A process can stop after the atomic move but before the SQLite
          // completion transaction. Adopting the deterministic target makes
          // that boundary replay-safe; the caller still verifies its hash.
          return fileRecord(target);
        }
        throw new Error(`Incoming transfer ${request.transferId} does not exist.`);
      }
      if (source.size !== expectedByteSize) {
        throw new Error(
          `Incoming transfer size mismatch: expected ${expectedByteSize}, received ${source.size}.`
        );
      }
      if (target.exists && !request.overwrite) {
        if (target.size === expectedByteSize) return fileRecord(target);
        throw new Error(`Original already exists at ${target.uri}.`);
      }

      await source.move(target, { overwrite: request.overwrite ?? false });
      return fileRecord(target);
    });
  }

  async discardIncoming(transferId: string): Promise<void> {
    this.ensureDirectories();
    const file = this.incomingFile(transferId);
    await this.withFileLock(file.uri, async () => {
      if (file.exists) {
        file.delete();
      }
    });
  }

  async deleteStoredFile(uri: string): Promise<boolean> {
    const file = this.resourceFileForDeletion(uri);
    return this.withFileLock(file.uri, async () => {
      if (!file.exists) return false;
      file.delete();
      return true;
    });
  }

  async deleteTripFiles(
    resources: readonly StoredResourceReference[],
  ): Promise<DeleteTripFilesResult> {
    const uniqueUris = [...new Set(
      resources
        .map((resource) => resource.localUri)
        .filter((uri): uri is string => uri !== null),
    )];
    // Resolve every URI before deleting anything so a foreign/source-library
    // path cannot produce a partially applied cleanup.
    const files = uniqueUris.map((uri) => this.resourceFileForDeletion(uri));
    let deleted = 0;
    for (const file of files) {
      const removed = await this.withFileLock(file.uri, async () => {
        if (!file.exists) return false;
        file.delete();
        return true;
      });
      if (removed) deleted += 1;
    }
    return {
      requested: files.length,
      deleted,
      missing: files.length - deleted,
    };
  }

  async copyOriginalExact(request: CopyOriginalRequest): Promise<StoredFile> {
    this.ensureDirectories();
    const source = new File(requireUri(request.sourceUri));
    const target = this.originalFile(request.storageKey, request.extension);
    const temporary = this.incomingFile(`local-${requireStorageKey(request.storageKey)}`);
    const chunkSize = normalizeChunkSize(request.chunkSize);

    return this.withFileLocks([temporary.uri, target.uri], async () => {
      if (target.exists && !request.overwrite) {
        throw new Error(`Original already exists at ${target.uri}.`);
      }

      if (temporary.exists) {
        temporary.delete();
      }
      try {
        if (isContentProviderUri(request.sourceUri)) {
          // Android MediaStore returns generic content:// URIs. SDK 57 can
          // copy those natively, but its FileHandle cannot open them.
          await source.copy(temporary, { overwrite: true });
        } else {
          temporary.create({ intermediates: true });
          const reader = source.open(FileMode.ReadOnly);
          try {
            // Nest acquisition so a target-open failure still closes the source
            // handle. SDK 57 requires handles to close before another process can
            // move/delete their file.
            const writer = temporary.open(FileMode.Truncate);
            try {
              const sourceSize = reader.size;
              if (sourceSize === null) {
                throw new Error('The source file was closed before it could be copied.');
              }

              while ((reader.offset ?? sourceSize) < sourceSize) {
                const remaining = sourceSize - (reader.offset ?? sourceSize);
                const bytes = reader.readBytes(Math.min(chunkSize, remaining));
                if (bytes.byteLength === 0) {
                  throw new Error(`Unexpected end of source file after ${reader.offset ?? 0} bytes.`);
                }
                writer.writeBytes(bytes);
                await Promise.resolve();
              }
            } finally {
              writer.close();
            }
          } finally {
            reader.close();
          }
        }

        await temporary.move(target, { overwrite: request.overwrite ?? false });
        return fileRecord(target);
      } catch (error) {
        if (temporary.exists) temporary.delete();
        throw error;
      }
    });
  }

  async createThumbnail(request: ThumbnailRequest): Promise<StoredThumbnail> {
    this.ensureDirectories();
    const target = this.thumbnailFile(request.storageKey);
    const maxDimension = normalizeThumbnailDimension(request.maxDimension);
    const quality = normalizeQuality(request.quality);

    return this.withFileLock(target.uri, async () => {
      if (target.exists && !request.overwrite) {
        // Width and height cannot be read cheaply from FileSystem. Returning 0
        // makes cached dimensions explicit; persist the generated dimensions
        // alongside the resource record on first creation.
        return { ...fileRecord(target, 'image/jpeg'), width: null, height: null };
      }

      const loadContext = ImageManipulator.manipulate(requireUri(request.sourceUri));
      let resizeContext: ImageManipulatorContext | null = null;
      let originalRef: ImageRef | null = null;
      let outputRef: ImageRef | null = null;
      let cachedResult: File | null = null;

      try {
        originalRef = await loadContext.renderAsync();
        const size = fitWithin(originalRef.width, originalRef.height, maxDimension);

        if (size.width !== originalRef.width || size.height !== originalRef.height) {
          resizeContext = ImageManipulator.manipulate(originalRef);
          resizeContext.resize(size);
          outputRef = await resizeContext.renderAsync();
        } else {
          outputRef = originalRef;
        }

        const result = await outputRef.saveAsync({
          compress: quality,
          format: SaveFormat.JPEG,
          base64: false,
        });
        cachedResult = new File(result.uri);
        await cachedResult.copy(target, { overwrite: request.overwrite ?? false });

        return {
          ...fileRecord(target, 'image/jpeg'),
          width: result.width,
          height: result.height,
        };
      } finally {
        if (cachedResult?.exists) {
          cachedResult.delete();
        }
        if (outputRef && outputRef !== originalRef) {
          outputRef.release();
        }
        originalRef?.release();
        resizeContext?.release();
        loadContext.release();
      }
    });
  }

  getOriginal(storageKey: string, extension: string): StoredFile | null {
    this.ensureDirectories();
    const file = this.originalFile(storageKey, extension);
    return file.exists ? fileRecord(file) : null;
  }

  getThumbnail(storageKey: string): StoredThumbnail | null {
    this.ensureDirectories();
    const file = this.thumbnailFile(storageKey);
    return file.exists
      ? { ...fileRecord(file, 'image/jpeg'), width: null, height: null }
      : null;
  }

  private ensureDirectories(): void {
    if (this.directoriesReady) return;
    this.root.create({ intermediates: true, idempotent: true });
    this.originals.create({ intermediates: true, idempotent: true });
    this.thumbnails.create({ intermediates: true, idempotent: true });
    this.incoming.create({ intermediates: true, idempotent: true });
    this.directoriesReady = true;
  }

  private incomingFile(transferId: string): File {
    return new File(this.incoming, `${requireStorageKey(transferId)}.part`);
  }

  private originalFile(storageKey: string, extension: string): File {
    return new File(
      this.originals,
      `${requireStorageKey(storageKey)}.${normalizeExtension(extension)}`
    );
  }

  private thumbnailFile(storageKey: string): File {
    return new File(this.thumbnails, `${requireStorageKey(storageKey)}.jpg`);
  }

  private resourceFileForDeletion(uri: string): File {
    const file = new File(requireUri(uri));
    const parent = normalizedDirectoryUri(file.parentDirectory.uri);
    const originals = normalizedDirectoryUri(this.originals.uri);
    const thumbnails = normalizedDirectoryUri(this.thumbnails.uri);
    if (parent !== originals && parent !== thumbnails) {
      throw new Error('Only files in AirMesh original or thumbnail storage can be deleted.');
    }
    return file;
  }

  private async withFileLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }

  private async withFileLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      if (index >= uniqueKeys.length) {
        return operation();
      }
      return this.withFileLock(uniqueKeys[index], () => acquire(index + 1));
    };
    return acquire(0);
  }
}

function fileRecord(file: File, fallbackMimeType = INTERNAL_MIME_TYPE): StoredFile {
  return {
    uri: file.uri,
    byteSize: file.size,
    mimeType: file.type || fallbackMimeType,
  };
}

function fitWithin(width: number, height: number, maxDimension: number): {
  width: number;
  height: number;
} {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width}x${height}.`);
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function normalizeChunkSize(chunkSize: number | undefined): number {
  if (chunkSize === undefined) {
    return DEFAULT_CHUNK_SIZE;
  }
  if (!Number.isFinite(chunkSize)) {
    throw new RangeError('chunkSize must be finite.');
  }
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, Math.trunc(chunkSize)));
}

function normalizeThumbnailDimension(value: number | undefined): number {
  const dimension = value ?? DEFAULT_THUMBNAIL_DIMENSION;
  if (!Number.isSafeInteger(dimension) || dimension < 64 || dimension > 2_048) {
    throw new RangeError('maxDimension must be an integer between 64 and 2,048.');
  }
  return dimension;
}

function normalizeQuality(value: number | undefined): number {
  const quality = value ?? DEFAULT_THUMBNAIL_QUALITY;
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError('quality must be between 0 and 1.');
  }
  return quality;
}

function normalizeExtension(value: string): string {
  const extension = value.startsWith('.') ? value.slice(1) : value;
  if (!/^[A-Za-z0-9]{1,10}$/.test(extension)) {
    throw new RangeError('extension must contain 1 to 10 ASCII letters or digits.');
  }
  return extension.toLowerCase();
}

function requireStorageKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new RangeError(
      'storageKey and transferId must use 1 to 128 ASCII letters, digits, dots, underscores, or dashes.'
    );
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requireUri(uri: string): string {
  if (uri.length === 0 || uri.length > 8_192) {
    throw new RangeError('uri must contain between 1 and 8,192 characters.');
  }
  return uri;
}

function isContentProviderUri(uri: string): boolean {
  return /^content:\/\//i.test(uri);
}

function normalizedDirectoryUri(uri: string): string {
  return uri.replace(/\/+$/, '');
}
