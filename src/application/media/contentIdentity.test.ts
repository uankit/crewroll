import { describe, expect, it } from 'vitest';

import { createLocalMediaId, createResourceId, sha256Hex } from './contentIdentity';

describe('content identity', () => {
  it('creates deterministic, device-scoped media ids', () => {
    expect(createLocalMediaId('device-a', 'asset-1')).toBe(
      createLocalMediaId('device-a', 'asset-1'),
    );
    expect(createLocalMediaId('device-a', 'asset-1')).not.toBe(
      createLocalMediaId('device-b', 'asset-1'),
    );
  });

  it('uses distinct resource ids for thumbnail and original', () => {
    expect(createResourceId('media_1', 'ORIGINAL')).toBe('media_1_original');
    expect(createResourceId('media_1', 'THUMBNAIL')).toBe('media_1_thumbnail');
  });

  it('matches the SHA-256 empty input vector', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
