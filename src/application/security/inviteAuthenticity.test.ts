import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from '@/application/security/base64url';
import {
  DOMAIN_SCHEMA_VERSION,
  INVITE_VERSION,
  PROTOCOL_VERSION,
} from '@/core/constants';
import type { TripInvite } from '@/core/invite';

import { signTripInvite, verifyTripInviteSignature } from './inviteAuthenticity';

const secret = new Uint8Array(32).fill(7);
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

describe('signed trip invites', () => {
  it('authenticates every admission-bearing field and rejects tampering', async () => {
    const invite = await signTripInvite({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      inviteVersion: INVITE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId: 'trip_signed-invite' as TripInvite['tripId'],
      inviteId: 'invite_signed-one' as TripInvite['inviteId'],
      inviterMemberId: 'member_signed-one' as TripInvite['inviterMemberId'],
      inviterDeviceId: 'device_signed-one' as TripInvite['inviterDeviceId'],
      inviterIdentityPublicKey: publicKey as TripInvite['inviterIdentityPublicKey'],
      membershipEpoch: 1,
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
      groupSecret: `${'B'.repeat(42)}A` as TripInvite['groupSecret'],
      endpointHint: 'wss://relay.example.test/v1/relay',
    }, identity);

    expect(verifyTripInviteSignature(invite, identity)).toBe(true);
    expect(
      verifyTripInviteSignature(
        { ...invite, expiresAtMs: invite.expiresAtMs + 1 },
        identity,
      ),
    ).toBe(false);
    expect(
      verifyTripInviteSignature(
        { ...invite, inviteId: 'invite_superseded' as TripInvite['inviteId'] },
        identity,
      ),
    ).toBe(false);
  });
});
