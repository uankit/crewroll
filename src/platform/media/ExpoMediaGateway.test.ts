import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpoMediaGateway } from './ExpoMediaGateway';

const mediaLibraryMock = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'asset:saved' })),
  getCreationTime: vi.fn(),
  getFilename: vi.fn(),
  getMediaSubtypes: vi.fn(),
  getMediaType: vi.fn(),
  getModificationTime: vi.fn(),
  getPermissions: vi.fn(),
  getShape: vi.fn(),
  requestPermissions: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-media-library', () => ({
  Asset: class Asset {
    static create = mediaLibraryMock.create;

    constructor(readonly id: string) {}

    getCreationTime = mediaLibraryMock.getCreationTime;
    getFilename = mediaLibraryMock.getFilename;
    getMediaSubtypes = mediaLibraryMock.getMediaSubtypes;
    getMediaType = mediaLibraryMock.getMediaType;
    getModificationTime = mediaLibraryMock.getModificationTime;
    getShape = mediaLibraryMock.getShape;
  },
  AssetField: {},
  MediaSubtype: { SCREENSHOT: 'screenshot' },
  MediaType: { IMAGE: 'image' },
  PermissionStatus: { UNDETERMINED: 'undetermined' },
  Query: class Query {},
  addListener: vi.fn(),
  getPermissionsAsync: mediaLibraryMock.getPermissions,
  presentPermissionsPicker: vi.fn(),
  requestPermissionsAsync: mediaLibraryMock.requestPermissions,
}));

describe('ExpoMediaGateway saving', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaLibraryMock.getCreationTime.mockResolvedValue(2_000);
    mediaLibraryMock.getFilename.mockResolvedValue('IMG_0001.jpg');
    mediaLibraryMock.getMediaSubtypes.mockResolvedValue([]);
    mediaLibraryMock.getMediaType.mockResolvedValue('image');
    mediaLibraryMock.getModificationTime.mockResolvedValue(2_001);
    mediaLibraryMock.getShape.mockResolvedValue({ width: 4_032, height: 3_024 });
  });

  it('hydrates an incremental inserted asset ID without a cursor query', async () => {
    await expect(
      new ExpoMediaGateway().getImageAssetsByIds(['asset:new']),
    ).resolves.toEqual({
      assets: [{
        assetId: 'asset:new',
        filename: 'IMG_0001.jpg',
        capturedAtMs: 2_000,
        modifiedAtMs: 2_001,
        width: 4_032,
        height: 3_024,
      }],
      failures: [],
      excludedScreenshotCount: 0,
    });
  });

  it('requests write-only access before creating an iOS library asset', async () => {
    mediaLibraryMock.getPermissions.mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    });
    mediaLibraryMock.requestPermissions.mockResolvedValueOnce({
      granted: true,
      canAskAgain: true,
    });

    await expect(new ExpoMediaGateway().saveImageToLibrary('file:///original.jpg')).resolves.toBe(
      'asset:saved',
    );

    expect(mediaLibraryMock.getPermissions).toHaveBeenCalledWith(true);
    expect(mediaLibraryMock.requestPermissions).toHaveBeenCalledWith(true);
    expect(mediaLibraryMock.create).toHaveBeenCalledWith('file:///original.jpg');
  });

  it('does not write when photo-add access was denied permanently', async () => {
    mediaLibraryMock.getPermissions.mockResolvedValueOnce({
      granted: false,
      canAskAgain: false,
    });

    await expect(
      new ExpoMediaGateway().saveImageToLibrary('file:///original.jpg'),
    ).rejects.toThrow(/Photo add access is off/i);
    expect(mediaLibraryMock.requestPermissions).not.toHaveBeenCalled();
    expect(mediaLibraryMock.create).not.toHaveBeenCalled();
  });
});
