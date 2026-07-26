import { describe, expect, it, vi } from 'vitest';

import { FRAME_SECURITY_VERSION, PROTOCOL_VERSION } from '@/core/constants';
import type { SessionKeyHandle, SecureFrameHeader } from '@/core/security';

import { encodeBase64Url } from './base64url';
import { NobleFrameCrypto } from './NobleFrameCrypto';
import type { TripKeyVault } from './TripKeyVault';

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (length: number) => new Uint8Array(length),
}));

const key: SessionKeyHandle = {
  tripId: 'trip:crypto-cache' as SessionKeyHandle['tripId'],
  keyId: 'key:crypto-cache',
  keyEpoch: 1,
  cipherSuite: 'XCHACHA20_POLY1305',
};

function header(senderCounter: number): SecureFrameHeader {
  return {
    securityVersion: FRAME_SECURITY_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    tripId: key.tripId,
    senderDeviceId: 'device:crypto-cache' as SecureFrameHeader['senderDeviceId'],
    keyId: key.keyId,
    keyEpoch: key.keyEpoch,
    senderCounter,
    cipherSuite: key.cipherSuite,
  };
}

describe('NobleFrameCrypto session key cache', () => {
  it('reads SecureStore once per session key and clears material on stop', async () => {
    const groupSecret = encodeBase64Url(new Uint8Array(32).fill(7));
    const get = vi.fn(async () => groupSecret as never);
    const vault = { get } as unknown as TripKeyVault;
    const crypto = new NobleFrameCrypto(
      vault,
      async () => new Uint8Array(24).fill(9),
    );

    await crypto.seal({ header: header(1), plaintext: new Uint8Array([1]), key });
    await crypto.seal({ header: header(2), plaintext: new Uint8Array([2]), key });
    expect(get).toHaveBeenCalledTimes(1);

    crypto.clearCachedKeys();
    await crypto.seal({ header: header(3), plaintext: new Uint8Array([3]), key });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
