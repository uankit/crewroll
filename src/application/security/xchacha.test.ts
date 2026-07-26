import { describe, expect, it } from 'vitest';

import { openXChaCha20Poly1305, sealXChaCha20Poly1305 } from './xchacha';

describe('XChaCha20-Poly1305 adapter', () => {
  it('round-trips and authenticates associated routing data', () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(24).fill(9);
    const associatedData = new TextEncoder().encode('trip-1/device-1/counter-1');
    const sealed = sealXChaCha20Poly1305({
      key,
      nonce,
      plaintext: new TextEncoder().encode('{"type":"PING"}'),
      associatedData,
      tagLength: 16,
    });
    expect(new TextDecoder().decode(openXChaCha20Poly1305({ key, nonce, ...sealed, associatedData }))).toBe('{"type":"PING"}');
    expect(() => openXChaCha20Poly1305({
      key,
      nonce,
      ...sealed,
      associatedData: new TextEncoder().encode('trip-2/device-1/counter-1'),
    })).toThrow();
  });
});
