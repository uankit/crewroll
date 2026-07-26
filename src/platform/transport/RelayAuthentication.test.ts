import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from '@/application/security/base64url';

import {
  createRelayAuthenticator,
  relayPeerAuthenticationBytes,
} from './RelayAuthentication';

describe('createRelayAuthenticator', () => {
  const groupSecret = encodeBase64Url(new Uint8Array(32).fill(7));

  it('scopes stable room capabilities and signs a fresh relay challenge', async () => {
    const device = testIdentity(11);
    const authenticate = createRelayAuthenticator(groupSecret, device.service);
    const routeId = authenticate.routeId('trip:one');
    const challenge = encodeBase64Url(new Uint8Array(32).fill(13));
    const first = await authenticate({
      sessionId: 'trip:one',
      peerId: device.deviceId,
      routeId,
      challenge,
      issuedAtMs: 1_000,
    });
    const second = await authenticate({
      sessionId: 'trip:one',
      peerId: device.deviceId,
      routeId,
      challenge: encodeBase64Url(new Uint8Array(32).fill(14)),
      issuedAtMs: 1_000,
    });
    const otherRouteId = authenticate.routeId('trip:two');
    const otherRoom = await authenticate({
      sessionId: 'trip:two',
      peerId: device.deviceId,
      routeId: otherRouteId,
      challenge,
      issuedAtMs: 1_000,
    });

    expect(first.roomToken).toBe(second.roomToken);
    expect(first.roomToken).not.toBe(groupSecret);
    expect(first.roomToken).not.toBe(otherRoom.roomToken);
    expect(authenticate.routeId('trip:one')).toHaveLength(43);
    expect(authenticate.routeId('trip:one')).not.toBe(first.roomToken);
    expect(authenticate.routeId('trip:one')).not.toBe(authenticate.routeId('trip:two'));
    expect(first.challengeSignature).not.toBe(second.challengeSignature);
    expect(first.identityPublicKey).toBe(device.publicKey);
    expect(ed25519.verify(
      decodeBase64Url(first.challengeSignature),
      relayPeerAuthenticationBytes({
        challenge,
        routeId,
        sessionId: 'trip:one',
        peerId: device.deviceId,
        identityPublicKey: device.publicKey,
        issuedAtMs: 1_000,
      }),
      decodeBase64Url(device.publicKey),
      { zip215: false },
    )).toBe(true);
    expect(first).toEqual(
      await authenticate({
        sessionId: 'trip:one',
        peerId: device.deviceId,
        routeId,
        challenge,
        issuedAtMs: 1_000,
      }),
    );
  });

  it('rotates the signed timestamp without rotating the room capability', async () => {
    const device = testIdentity(12);
    const authenticate = createRelayAuthenticator(groupSecret, device.service);
    const routeId = authenticate.routeId('trip:one');
    const challenge = encodeBase64Url(new Uint8Array(32).fill(15));
    const first = await authenticate({
      sessionId: 'trip:one',
      peerId: device.deviceId,
      routeId,
      challenge,
      issuedAtMs: 1_000,
    });
    const second = await authenticate({
      sessionId: 'trip:one',
      peerId: device.deviceId,
      routeId,
      challenge,
      issuedAtMs: 2_000,
    });

    expect(first.roomToken).toBe(second.roomToken);
    expect(first.challengeSignature).not.toBe(second.challengeSignature);
    expect(authenticate.routeId('trip:one')).toBe(authenticate.routeId('trip:one'));
  });

  it('refuses to sign a caller-selected peer identity', async () => {
    const device = testIdentity(16);
    const authenticate = createRelayAuthenticator(groupSecret, device.service);
    const routeId = authenticate.routeId('trip:one');

    await expect(authenticate({
      sessionId: 'trip:one',
      peerId: 'device_attacker-selected',
      routeId,
      challenge: encodeBase64Url(new Uint8Array(32).fill(17)),
      issuedAtMs: 1_000,
    })).rejects.toThrow('Relay peer ID does not match this device identity.');
  });
});

function testIdentity(seed: number) {
  const secret = new Uint8Array(32).fill(seed);
  const publicKey = encodeBase64Url(ed25519.getPublicKey(secret));
  const deviceId = `device_${encodeBase64Url(sha256(decodeBase64Url(publicKey)))}`;
  return {
    deviceId,
    publicKey,
    service: {
      load: async () => ({ deviceId, displayName: null, identityPublicKey: publicKey }),
      sign: async (bytes: Uint8Array) => encodeBase64Url(ed25519.sign(bytes, secret)),
    },
  };
}
