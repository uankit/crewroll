import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export interface XChaChaSealedBytes {
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
}

export function sealXChaCha20Poly1305(input: {
  key: Uint8Array;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  associatedData: Uint8Array;
  tagLength: number;
}): XChaChaSealedBytes {
  validateInput(input.key, input.nonce, input.tagLength);
  const combined = xchacha20poly1305(
    input.key,
    input.nonce,
    input.associatedData,
  ).encrypt(input.plaintext);
  return {
    ciphertext: combined.slice(0, -input.tagLength),
    authenticationTag: combined.slice(-input.tagLength),
  };
}

export function openXChaCha20Poly1305(input: {
  key: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
  associatedData: Uint8Array;
}): Uint8Array {
  validateInput(input.key, input.nonce, input.authenticationTag.byteLength);
  const combined = new Uint8Array(
    input.ciphertext.byteLength + input.authenticationTag.byteLength,
  );
  combined.set(input.ciphertext);
  combined.set(input.authenticationTag, input.ciphertext.byteLength);
  return xchacha20poly1305(input.key, input.nonce, input.associatedData).decrypt(combined);
}

function validateInput(key: Uint8Array, nonce: Uint8Array, tagLength: number): void {
  if (key.byteLength !== 32) throw new Error('XChaCha20-Poly1305 requires a 32-byte key.');
  if (nonce.byteLength !== 24) throw new Error('XChaCha20-Poly1305 requires a 24-byte nonce.');
  if (tagLength !== 16) throw new Error('XChaCha20-Poly1305 requires a 16-byte tag.');
}
