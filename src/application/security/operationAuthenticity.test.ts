import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from '@/application/security/base64url';
import { DOMAIN_SCHEMA_VERSION } from '@/core/constants';
import type { SyncOperation } from '@/core/domain';

import { signSyncOperation, verifySyncOperation } from './operationAuthenticity';

const secret = new Uint8Array(32).fill(13);
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

describe('sync operation authenticity', () => {
  it('survives relay unchanged and rejects payload or origin tampering', async () => {
    const unsigned: Extract<SyncOperation, { kind: 'MEDIA_TOMBSTONED' }> = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      operationId: 'operation_signed-one' as SyncOperation['operationId'],
      tripId: 'trip_signed-operation' as SyncOperation['tripId'],
      originDeviceId: 'device_signed-origin' as SyncOperation['originDeviceId'],
      originSequence: 4,
      actorMemberId: 'member_signed-origin' as SyncOperation['actorMemberId'],
      membershipEpoch: 1,
      createdAtMs: 9_000,
      kind: 'MEDIA_TOMBSTONED',
      payload: {
        mediaId: 'media_signed-one' as Extract<SyncOperation, { kind: 'MEDIA_TOMBSTONED' }>['payload']['mediaId'],
        tombstonedAtMs: 9_000,
      },
    };
    const signed = await signSyncOperation(unsigned, publicKey, identity);

    expect(verifySyncOperation(signed, identity, publicKey)).toBe(true);
    expect(
      verifySyncOperation(
        { ...signed, payload: { ...signed.payload, tombstonedAtMs: 9_001 } },
        identity,
        publicKey,
      ),
    ).toBe(false);
    expect(
      verifySyncOperation(
        { ...signed, originSequence: 5 },
        identity,
        publicKey,
      ),
    ).toBe(false);
  });
});
