import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpoFileStore } from './ExpoFileStore';

const fileSystem = vi.hoisted(() => {
  const existing = new Set<string>();
  const deletions: string[] = [];
  const directoryCreations: string[] = [];
  const copies: { source: string; target: string }[] = [];
  const moves: { source: string; target: string }[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const openFactories = new Map<string, () => unknown>();
  const sizes = new Map<string, number>();

  class FakeDirectory {
    readonly uri: string;

    constructor(base: string | { uri: string }, ...parts: string[]) {
      this.uri = joinUri(typeof base === 'string' ? base : base.uri, parts);
    }

    create() {
      directoryCreations.push(this.uri);
    }
  }

  class FakeFile {
    readonly uri: string;

    constructor(base: string | { uri: string }, ...parts: string[]) {
      this.uri = joinUri(typeof base === 'string' ? base : base.uri, parts);
    }

    get exists() {
      return existing.has(this.uri);
    }

    get parentDirectory() {
      return new FakeDirectory(this.uri.slice(0, this.uri.lastIndexOf('/')));
    }

    get size() {
      return sizes.get(this.uri) ?? 0;
    }

    get type() {
      return this.uri.endsWith('.jpg') ? 'image/jpeg' : '';
    }

    delete() {
      existing.delete(this.uri);
      sizes.delete(this.uri);
      deletions.push(this.uri);
    }

    create() {
      existing.add(this.uri);
      sizes.set(this.uri, 0);
    }

    open() {
      opened.push(this.uri);
      const factory = openFactories.get(this.uri);
      if (factory) return factory();
      throw new Error(`FileHandle is unavailable for ${this.uri}`);
    }

    async copy(target: FakeFile) {
      if (!existing.has(this.uri)) throw new Error(`Missing source ${this.uri}`);
      existing.add(target.uri);
      sizes.set(target.uri, sizes.get(this.uri) ?? 0);
      copies.push({ source: this.uri, target: target.uri });
    }

    async move(target: FakeFile) {
      if (!existing.has(this.uri)) throw new Error(`Missing source ${this.uri}`);
      existing.delete(this.uri);
      existing.add(target.uri);
      sizes.set(target.uri, sizes.get(this.uri) ?? 0);
      sizes.delete(this.uri);
      moves.push({ source: this.uri, target: target.uri });
    }
  }

  function joinUri(base: string, parts: readonly string[]) {
    return [base.replace(/\/+$/, ''), ...parts.map((part) => part.replace(/^\/+|\/+$/g, ''))]
      .filter(Boolean)
      .join('/');
  }

  return {
    FakeDirectory,
    FakeFile,
    closed,
    copies,
    deletions,
    directoryCreations,
    existing,
    moves,
    opened,
    openFactories,
    sizes,
  };
});

vi.mock('expo-file-system', () => ({
  Directory: fileSystem.FakeDirectory,
  File: fileSystem.FakeFile,
  FileMode: { ReadOnly: 'read-only', ReadWrite: 'read-write', Truncate: 'truncate' },
  Paths: { document: { uri: 'file:///documents' } },
}));

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: {},
  SaveFormat: { JPEG: 'jpeg' },
}));

const originalUri = 'file:///documents/airmesh/originals/resource-one.jpg';
const incomingUri = 'file:///documents/airmesh/incoming/transfer-one.part';
const missingThumbnailUri = 'file:///documents/airmesh/thumbnails/resource-two.jpg';

beforeEach(() => {
  fileSystem.existing.clear();
  fileSystem.closed.length = 0;
  fileSystem.copies.length = 0;
  fileSystem.deletions.length = 0;
  fileSystem.directoryCreations.length = 0;
  fileSystem.moves.length = 0;
  fileSystem.opened.length = 0;
  fileSystem.openFactories.clear();
  fileSystem.sizes.clear();
});

describe('ExpoFileStore cleanup', () => {
  it('creates its private directories only once after successful initialization', () => {
    const store = new ExpoFileStore();

    expect(store.getIncoming('transfer-one')).toBeNull();
    expect(store.getIncoming('transfer-two')).toBeNull();
    expect(fileSystem.directoryCreations).toHaveLength(4);
  });

  it('exposes durable incoming size for restart checkpoint reconciliation', () => {
    fileSystem.existing.add(incomingUri);
    fileSystem.sizes.set(incomingUri, 321);
    const store = new ExpoFileStore();

    expect(store.getIncoming('transfer-one')).toEqual({
      uri: incomingUri,
      byteSize: 321,
      mimeType: 'application/octet-stream',
    });
  });

  it('adopts an already-finalized target when a crash happened after the move', async () => {
    fileSystem.existing.add(originalUri);
    fileSystem.sizes.set(originalUri, 1_234);
    const store = new ExpoFileStore();

    await expect(store.finalizeIncoming({
      transferId: 'transfer-one',
      storageKey: 'resource-one',
      extension: 'jpg',
      expectedByteSize: 1_234,
    })).resolves.toEqual({
      uri: originalUri,
      byteSize: 1_234,
      mimeType: 'image/jpeg',
    });
    expect(fileSystem.moves).toEqual([]);
  });

  it('atomically replaces a stale target with the verified incoming file', async () => {
    fileSystem.existing.add(incomingUri);
    fileSystem.sizes.set(incomingUri, 1_234);
    fileSystem.existing.add(originalUri);
    fileSystem.sizes.set(originalUri, 7);
    const store = new ExpoFileStore();

    await expect(store.finalizeIncoming({
      transferId: 'transfer-one',
      storageKey: 'resource-one',
      extension: 'jpg',
      expectedByteSize: 1_234,
      overwrite: true,
    })).resolves.toMatchObject({ uri: originalUri, byteSize: 1_234 });
    expect(fileSystem.moves).toEqual([{ source: incomingUri, target: originalUri }]);
  });

  it('deduplicates trip resource URIs and reports deleted versus missing files', async () => {
    fileSystem.existing.add(originalUri);
    const store = new ExpoFileStore();

    await expect(store.deleteTripFiles([
      { localUri: originalUri },
      { localUri: originalUri },
      { localUri: missingThumbnailUri },
      { localUri: null },
    ])).resolves.toEqual({ requested: 2, deleted: 1, missing: 1 });
    expect(fileSystem.deletions).toEqual([originalUri]);
  });

  it('validates every URI before deleting, and refuses paths outside private resource storage', async () => {
    fileSystem.existing.add(originalUri);
    const store = new ExpoFileStore();

    await expect(store.deleteTripFiles([
      { localUri: originalUri },
      { localUri: 'file:///system-photo-library/source.jpg' },
    ])).rejects.toThrow('Only files in AirMesh original or thumbnail storage can be deleted');
    expect(fileSystem.existing.has(originalUri)).toBe(true);
    expect(fileSystem.deletions).toEqual([]);
  });

  it('copies Android MediaStore content natively without opening a FileHandle', async () => {
    const sourceUri = 'content://media/external/images/media/42';
    fileSystem.existing.add(sourceUri);
    fileSystem.sizes.set(sourceUri, 1_234);
    const store = new ExpoFileStore();

    await expect(store.copyOriginalExact({
      sourceUri,
      storageKey: 'media-one',
      extension: 'jpg',
    })).resolves.toEqual({
      uri: 'file:///documents/airmesh/originals/media-one.jpg',
      byteSize: 1_234,
      mimeType: 'image/jpeg',
    });

    expect(fileSystem.copies).toEqual([{
      source: sourceUri,
      target: 'file:///documents/airmesh/incoming/local-media-one.part',
    }]);
    expect(fileSystem.moves).toEqual([{
      source: 'file:///documents/airmesh/incoming/local-media-one.part',
      target: 'file:///documents/airmesh/originals/media-one.jpg',
    }]);
    expect(fileSystem.opened).toEqual([]);
  });

  it('closes the source handle when opening the temporary writer fails', async () => {
    const sourceUri = 'file:///source/photo.jpg';
    const temporaryUri = 'file:///documents/airmesh/incoming/local-media-two.part';
    fileSystem.openFactories.set(sourceUri, () => ({
      size: 1_234,
      offset: 0,
      close: () => fileSystem.closed.push(sourceUri),
      readBytes: () => new Uint8Array(),
    }));
    fileSystem.openFactories.set(temporaryUri, () => {
      throw new Error('writer open failed');
    });
    const store = new ExpoFileStore();

    await expect(store.copyOriginalExact({
      sourceUri,
      storageKey: 'media-two',
      extension: 'jpg',
    })).rejects.toThrow('writer open failed');
    expect(fileSystem.closed).toEqual([sourceUri]);
  });
});
