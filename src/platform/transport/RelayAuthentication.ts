import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { DeviceIdentityService } from '@/application/identity/DeviceIdentityService';
import { decodeBase64Url, encodeBase64Url } from '@/application/security/base64url';
import { parseGroupSecret, type GroupSecret } from '@/core/invite';
import { assertParsed } from '@/core/validation';

const ROOM_CONTEXT = 'airmesh-relay-room-v1';
const ROUTE_CONTEXT = 'airmesh-relay-route-v1';
const PEER_AUTHENTICATION_CONTEXT = 'airmesh-relay-peer-auth-v1';

export interface RelayHelloAuthentication {
  readonly issuedAtMs: number;
  readonly roomToken: string;
  readonly challenge: string;
  readonly identityPublicKey: string;
  readonly challengeSignature: string;
}

export interface RelayAuthenticationRequest {
  readonly sessionId: string;
  readonly peerId: string;
  readonly routeId: string;
  readonly challenge: string;
  readonly issuedAtMs: number;
}

export interface RelayAuthenticator {
  (request: RelayAuthenticationRequest): Promise<RelayHelloAuthentication>;
  /**
   * Opaque, capability-bound routing verifier. It is safe to expose in the WSS
   * URL because deriving the room token from it still requires a 256-bit
   * preimage, while a relay can validate it without retaining room state.
   */
  routeId(sessionId: string): string;
}

/**
 * Creates a relay-only bearer capability from the trip secret. The trip secret
 * itself never leaves the phone, and the resulting capability is scoped to one
 * room. Application frames remain end-to-end encrypted by SyncEngine.
 */
export function createRelayAuthenticator(
  groupSecret: GroupSecret | string,
  identity: Pick<DeviceIdentityService, 'load' | 'sign'>,
): RelayAuthenticator {
  const canonicalSecret = assertParsed(parseGroupSecret(groupSecret));
  const secretBytes = decodeBase64Url(canonicalSecret);
  const capabilities = new Map<string, { readonly roomToken: string; readonly routeId: string }>();
  let loadedIdentity: ReturnType<typeof identity.load> | null = null;

  const capabilityFor = (sessionId: string) => {
    requireIdentifier(sessionId, 'sessionId');
    const cached = capabilities.get(sessionId);
    if (cached) return cached;
    const roomTokenBytes = hmac(
      sha256,
      secretBytes,
      encode(`${ROOM_CONTEXT}\0${sessionId}`),
    );
    const capability = {
      roomToken: encodeBase64Url(roomTokenBytes),
      routeId: encodeBase64Url(
        hmac(sha256, roomTokenBytes, encode(`${ROUTE_CONTEXT}\0${sessionId}`)),
      ),
    };
    capabilities.set(sessionId, capability);
    return capability;
  };

  const authenticate = async ({
    sessionId,
    peerId,
    routeId,
    challenge,
    issuedAtMs,
  }: RelayAuthenticationRequest) => {
    requireIdentifier(sessionId, 'sessionId');
    requireIdentifier(peerId, 'peerId');
    requireCanonicalBytes(routeId, 32, 'routeId');
    requireCanonicalBytes(challenge, 32, 'challenge');
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
      throw new RangeError('issuedAtMs must be a non-negative safe integer.');
    }

    const capability = capabilityFor(sessionId);
    if (routeId !== capability.routeId) {
      throw new Error('Relay route does not match the trip capability.');
    }
    loadedIdentity ??= identity.load().catch((error) => {
      loadedIdentity = null;
      throw error;
    });
    const deviceIdentity = await loadedIdentity;
    requireCanonicalBytes(deviceIdentity.identityPublicKey, 32, 'identityPublicKey');
    if (deviceIdentity.deviceId !== peerId) {
      throw new Error('Relay peer ID does not match this device identity.');
    }

    const challengeSignature = await identity.sign(
      relayPeerAuthenticationBytes({
        challenge,
        routeId,
        sessionId,
        peerId,
        identityPublicKey: deviceIdentity.identityPublicKey,
        issuedAtMs,
      }),
    );
    requireCanonicalBytes(challengeSignature, 64, 'challengeSignature');
    return {
      issuedAtMs,
      roomToken: capability.roomToken,
      challenge,
      identityPublicKey: deviceIdentity.identityPublicKey,
      challengeSignature,
    };
  };

  return Object.assign(authenticate, {
    routeId: (sessionId: string) => capabilityFor(sessionId).routeId,
  });
}

export function relayPeerAuthenticationBytes({
  challenge,
  routeId,
  sessionId,
  peerId,
  identityPublicKey,
  issuedAtMs,
}: {
  readonly challenge: string;
  readonly routeId: string;
  readonly sessionId: string;
  readonly peerId: string;
  readonly identityPublicKey: string;
  readonly issuedAtMs: number;
}): Uint8Array {
  return encode(JSON.stringify([
    PEER_AUTHENTICATION_CONTEXT,
    challenge,
    routeId,
    sessionId,
    peerId,
    identityPublicKey,
    issuedAtMs,
  ]));
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function requireIdentifier(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new RangeError(`${field} is not a valid relay route identifier.`);
  }
}

function requireCanonicalBytes(value: string, byteLength: number, field: string): void {
  const decoded = decodeBase64Url(value);
  if (decoded.byteLength !== byteLength || encodeBase64Url(decoded) !== value) {
    throw new RangeError(`${field} must be canonical base64url for ${byteLength} bytes.`);
  }
}
