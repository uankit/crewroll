import { describe, expect, it } from 'vitest';

import { imageFileMetadata } from './metadata';

describe('imageFileMetadata', () => {
  it('normalizes common image extensions', () => {
    expect(imageFileMetadata('IMG_1.HEIC', 'file:///unused')).toEqual({
      extension: 'heic',
      mimeType: 'image/heic',
    });
  });

  it('does not misclassify an unknown format', () => {
    expect(imageFileMetadata('photo.raw', 'file:///photo.raw')).toEqual({
      extension: 'raw',
      mimeType: 'application/octet-stream',
    });
  });
});
