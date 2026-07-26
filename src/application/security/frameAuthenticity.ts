import type { SecureFrame } from '@/core/security';

import { decodeBase64Url, encodeBase64Url } from './base64url';

const textEncoder = new TextEncoder();

export interface FrameIdentityAuthenticator {
  sign(bytes: Uint8Array): Promise<string>;
  verify(bytes: Uint8Array, signature: string, publicKey: string): boolean;
}

export interface SignedSecureFrame {
  readonly frame: SecureFrame;
  readonly senderIdentityPublicKey: string;
  readonly signature: string;
}

/**
 * Signs the ciphertext and every routing/security field. The group AEAD keeps
 * contents private; this Ed25519 signature proves which member produced it.
 */
export async function signSecureFrame(
  frame: SecureFrame,
  senderIdentityPublicKey: string,
  identity: FrameIdentityAuthenticator,
): Promise<SignedSecureFrame> {
  assertIdentityPublicKey(senderIdentityPublicKey);
  const signature = await identity.sign(
    secureFrameSigningBytes(frame, senderIdentityPublicKey),
  );
  assertSignature(signature);
  return { frame, senderIdentityPublicKey, signature };
}

export function verifySignedSecureFrame(
  value: SignedSecureFrame,
  identity: Pick<FrameIdentityAuthenticator, 'verify'>,
): boolean {
  try {
    assertIdentityPublicKey(value.senderIdentityPublicKey);
    assertSignature(value.signature);
    return identity.verify(
      secureFrameSigningBytes(value.frame, value.senderIdentityPublicKey),
      value.signature,
      value.senderIdentityPublicKey,
    );
  } catch {
    return false;
  }
}

export function secureFrameSigningBytes(
  frame: SecureFrame,
  senderIdentityPublicKey: string,
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify([
      'airmesh-secure-frame-signature-v1',
      senderIdentityPublicKey,
      frame.securityVersion,
      frame.protocolVersion,
      frame.tripId,
      frame.senderDeviceId,
      frame.keyId,
      frame.keyEpoch,
      frame.senderCounter,
      frame.cipherSuite,
      encodeBase64Url(frame.nonce),
      encodeBase64Url(frame.ciphertext),
      encodeBase64Url(frame.authenticationTag),
    ]),
  );
}

function assertIdentityPublicKey(value: string): void {
  if (decodeBase64Url(value).byteLength !== 32) {
    throw new Error('Frame identity public key must decode to exactly 32 bytes.');
  }
}

function assertSignature(value: string): void {
  if (decodeBase64Url(value).byteLength !== 64) {
    throw new Error('Frame identity signature must decode to exactly 64 bytes.');
  }
}
