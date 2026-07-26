import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from './base64url';

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(encoded)).toEqual(bytes);
  });

  it('rejects invalid and non-canonical values', () => {
    expect(() => decodeBase64Url('a')).toThrow();
    expect(() => decodeBase64Url('**')).toThrow();
  });
});
