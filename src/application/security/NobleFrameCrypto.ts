import * as Crypto from 'expo-crypto';

import {
  AEAD_TAG_BYTES,
  XCHACHA20_POLY1305_NONCE_BYTES,
} from '@/core/constants';
import {
  validateFrameContext,
  type AuthenticatedFrameCrypto,
  type SecureFrame,
  type SecureFrameHeader,
  type SessionKeyHandle,
} from '@/core/security';

import { decodeBase64Url } from './base64url';
import type { TripKeyVault } from './TripKeyVault';
import { openXChaCha20Poly1305, sealXChaCha20Poly1305 } from './xchacha';

const encoder = new TextEncoder();

export class NobleFrameCrypto implements AuthenticatedFrameCrypto {
  private readonly keyCache = new Map<string, Uint8Array>();

  constructor(
    private readonly vault: TripKeyVault,
    private readonly randomBytes: (length: number) => Promise<Uint8Array> = Crypto.getRandomBytesAsync,
  ) {}

  async seal(input: {
    readonly header: SecureFrameHeader;
    readonly plaintext: Uint8Array;
    readonly key: SessionKeyHandle;
  }): Promise<SecureFrame> {
    assertMatchingContext(input.header, input.key);
    if (input.plaintext.byteLength === 0) {
      throw new Error('Secure frames cannot contain an empty plaintext.');
    }
    const keyBytes = await this.requireKeyBytes(input.key);
    const nonce = await this.randomBytes(XCHACHA20_POLY1305_NONCE_BYTES);
    if (nonce.byteLength !== XCHACHA20_POLY1305_NONCE_BYTES) {
      throw new Error('The platform CSPRNG returned an invalid nonce length.');
    }
    const sealed = sealXChaCha20Poly1305({
      key: keyBytes,
      nonce,
      plaintext: input.plaintext,
      associatedData: authenticatedHeader(input.header),
      tagLength: AEAD_TAG_BYTES,
    });

    return {
      ...input.header,
      nonce,
      ciphertext: sealed.ciphertext,
      authenticationTag: sealed.authenticationTag,
    };
  }

  async open(input: {
    readonly frame: SecureFrame;
    readonly key: SessionKeyHandle;
  }): Promise<Uint8Array> {
    const issues = validateFrameContext(input.frame, input.key);
    if (issues.length > 0) {
      throw new Error(`Secure frame context mismatch: ${issues.map((entry) => entry.code).join(', ')}`);
    }
    const keyBytes = await this.requireKeyBytes(input.key);
    return openXChaCha20Poly1305({
      key: keyBytes,
      nonce: input.frame.nonce,
      ciphertext: input.frame.ciphertext,
      authenticationTag: input.frame.authenticationTag,
      associatedData: authenticatedHeader(input.frame),
    });
  }

  /** Zeroes session key material when the owning sync session stops. */
  clearCachedKeys(): void {
    for (const keyBytes of this.keyCache.values()) keyBytes.fill(0);
    this.keyCache.clear();
  }

  private async requireKeyBytes(key: SessionKeyHandle): Promise<Uint8Array> {
    const cacheKey = `${key.tripId}\0${key.keyId}\0${key.keyEpoch}`;
    const cached = this.keyCache.get(cacheKey);
    if (cached) return cached;
    const groupSecret = await this.vault.get(key);
    if (!groupSecret) {
      throw new Error(`No local session key is available for ${key.keyId}.`);
    }
    const keyBytes = decodeKey(groupSecret);
    this.keyCache.set(cacheKey, keyBytes);
    return keyBytes;
  }
}

function authenticatedHeader(header: SecureFrameHeader): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      'airmesh-secure-frame',
      header.securityVersion,
      header.protocolVersion,
      header.tripId,
      header.senderDeviceId,
      header.keyId,
      header.keyEpoch,
      header.senderCounter,
      header.cipherSuite,
    ]),
  );
}

function assertMatchingContext(header: SecureFrameHeader, key: SessionKeyHandle): void {
  if (
    header.tripId !== key.tripId ||
    header.keyId !== key.keyId ||
    header.keyEpoch !== key.keyEpoch ||
    header.cipherSuite !== key.cipherSuite
  ) {
    throw new Error('Secure frame header does not match the selected session key.');
  }
}

function decodeKey(groupSecret: string): Uint8Array {
  const bytes = decodeBase64Url(groupSecret);
  if (bytes.byteLength !== 32) {
    throw new Error('The trip group secret must decode to exactly 32 bytes.');
  }
  return bytes;
}
