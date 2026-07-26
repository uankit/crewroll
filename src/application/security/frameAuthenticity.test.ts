import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { FRAME_SECURITY_VERSION, PROTOCOL_VERSION } from '@/core/constants';
import type { SecureFrame } from '@/core/security';

import { decodeBase64Url, encodeBase64Url } from './base64url';
import { signSecureFrame, verifySignedSecureFrame } from './frameAuthenticity';

const secret = new Uint8Array(32).fill(11);
const publicKey = encodeBase64Url(ed25519.getPublicKey(secret));
const identity = {
  sign: async (bytes: Uint8Array) => encodeBase64Url(ed25519.sign(bytes, secret)),
  verify: (bytes: Uint8Array, signature: string, candidatePublicKey: string) =>
    ed25519.verify(
      decodeBase64Url(signature),
      bytes,
      decodeBase64Url(candidatePublicKey),
      { zip215: false },
    ),
};

const frame: SecureFrame = {
  securityVersion: FRAME_SECURITY_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  tripId: 'trip_signed-frame' as SecureFrame['tripId'],
  senderDeviceId: 'device_signed-frame' as SecureFrame['senderDeviceId'],
  keyId: 'key_signed-frame',
  keyEpoch: 1,
  senderCounter: 17,
  cipherSuite: 'XCHACHA20_POLY1305',
  nonce: new Uint8Array(24).fill(1),
  ciphertext: new Uint8Array([2, 3, 4]),
  authenticationTag: new Uint8Array(16).fill(5),
};

describe('secure frame authenticity', () => {
  it('verifies the complete encrypted frame and rejects counter poisoning', async () => {
    const signed = await signSecureFrame(frame, publicKey, identity);
    expect(verifySignedSecureFrame(signed, identity)).toBe(true);
    expect(
      verifySignedSecureFrame(
        { ...signed, frame: { ...signed.frame, senderCounter: Number.MAX_SAFE_INTEGER } },
        identity,
      ),
    ).toBe(false);
  });
});
