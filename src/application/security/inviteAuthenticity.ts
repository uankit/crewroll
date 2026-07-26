import { parseTripInvite, type TripInvite } from '@/core/invite';
import { assertParsed } from '@/core/validation';

import type { FrameIdentityAuthenticator } from './frameAuthenticity';

const textEncoder = new TextEncoder();

export type UnsignedTripInvite = Omit<TripInvite, 'signature'>;

export async function signTripInvite(
  invite: UnsignedTripInvite,
  identity: Pick<FrameIdentityAuthenticator, 'sign'>,
): Promise<TripInvite> {
  const canonicalInvite = assertParsed(
    parseTripInvite({ ...invite, signature: 'A'.repeat(86) }),
  );
  const signature = await identity.sign(inviteSigningBytes(canonicalInvite));
  return assertParsed(parseTripInvite({ ...canonicalInvite, signature }));
}

export function verifyTripInviteSignature(
  invite: TripInvite,
  identity: Pick<FrameIdentityAuthenticator, 'verify'>,
): boolean {
  return identity.verify(
    inviteSigningBytes(invite),
    invite.signature,
    invite.inviterIdentityPublicKey,
  );
}

export function inviteSigningBytes(invite: UnsignedTripInvite | TripInvite): Uint8Array {
  return textEncoder.encode(
    JSON.stringify([
      'airmesh-trip-invite-signature-v1',
      invite.schemaVersion,
      invite.inviteVersion,
      invite.protocolVersion,
      invite.tripId,
      invite.inviteId,
      invite.inviterMemberId,
      invite.inviterDeviceId,
      invite.inviterIdentityPublicKey,
      invite.membershipEpoch,
      invite.issuedAtMs,
      invite.expiresAtMs,
      invite.groupSecret,
      invite.endpointHint,
    ]),
  );
}
