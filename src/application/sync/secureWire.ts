import {
  AEAD_TAG_BYTES,
  FRAME_SECURITY_VERSION,
  MAX_RESOURCE_CHUNK_BYTES,
  PROTOCOL_VERSION,
  XCHACHA20_POLY1305_NONCE_BYTES,
} from '../../core/constants';
import {
  parseProtocolEnvelope,
  type ProtocolEnvelope,
} from '../../core/protocol';
import {
  FRAME_CIPHER_SUITES,
  parseSecureFrame,
  type SecureFrame,
  type SessionKeyHandle,
} from '../../core/security';
import { assertParsed } from '../../core/validation';
import { decodeBase64Url, encodeBase64Url } from '../security/base64url';
import type { SignedSecureFrame } from '../security/frameAuthenticity';
import type { DeviceId, TripId } from '@/core/ids';

export const SECURE_CONTROL_TRANSPORT_TYPE = 'AIRMESH_SECURE_CONTROL_V2';
export const MAX_SECURE_CONTROL_PLAINTEXT_BYTES = 40 * 1024;

const BINARY_MAGIC = new Uint8Array([0x41, 0x4d, 0x53, 0x31]); // AMS1
const SIGNED_BINARY_MAGIC = new Uint8Array([0x41, 0x4d, 0x53, 0x32]); // AMS2
const COUNTER_BYTES = 8;
const BINARY_FIXED_PREFIX_BYTES = BINARY_MAGIC.byteLength + COUNTER_BYTES;
const IDENTITY_PUBLIC_KEY_BYTES = 32;
const IDENTITY_SIGNATURE_BYTES = 64;
const SIGNED_BINARY_FIXED_PREFIX_BYTES =
  SIGNED_BINARY_MAGIC.byteLength +
  COUNTER_BYTES +
  IDENTITY_PUBLIC_KEY_BYTES +
  IDENTITY_SIGNATURE_BYTES;
const MAX_BINARY_METADATA_BYTES = 16 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface SerializedSecureControlFrame {
  readonly securityVersion: number;
  readonly protocolVersion: number;
  readonly tripId: string;
  readonly senderDeviceId: string;
  readonly keyId: string;
  readonly keyEpoch: number;
  readonly senderCounter: number;
  readonly cipherSuite: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export interface SerializedSignedSecureControlFrame extends SerializedSecureControlFrame {
  readonly senderIdentityPublicKey: string;
  readonly signature: string;
}

export interface SecureBinaryContext {
  readonly tripId: TripId;
  readonly senderDeviceId: DeviceId;
  readonly key: SessionKeyHandle;
}

export function encodeControlEnvelopePlaintext(envelope: ProtocolEnvelope): Uint8Array {
  const validated = assertParsed(parseProtocolEnvelope(envelope));
  if (validated.type === 'RESOURCE_CHUNK') {
    throw new Error('RESOURCE_CHUNK must use the encrypted binary codec.');
  }
  const json = JSON.stringify(validated, (_key, value: unknown) => {
    if (value instanceof Uint8Array) {
      throw new Error('Binary values are forbidden in control envelopes.');
    }
    return value;
  });
  const bytes = textEncoder.encode(json);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SECURE_CONTROL_PLAINTEXT_BYTES) {
    throw new RangeError(
      `Secure control plaintext must contain 1-${MAX_SECURE_CONTROL_PLAINTEXT_BYTES} bytes.`,
    );
  }
  return bytes;
}

export function decodeControlEnvelopePlaintext(bytes: Uint8Array): ProtocolEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('Secure control plaintext must be a non-empty Uint8Array.');
  }
  if (bytes.byteLength > MAX_SECURE_CONTROL_PLAINTEXT_BYTES) {
    throw new RangeError('Secure control plaintext exceeds its size limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new Error('Secure control plaintext is not valid JSON.', { cause: error });
  }
  const envelope = assertParsed(parseProtocolEnvelope(value));
  if (envelope.type === 'RESOURCE_CHUNK') {
    throw new Error('RESOURCE_CHUNK is forbidden on the control channel.');
  }
  return envelope;
}

/** Base64url is limited to the small encrypted control frame carried in JSON. */
export function serializeSecureControlFrame(
  frameValue: SecureFrame,
): SerializedSecureControlFrame {
  const frame = assertParsed(parseSecureFrame(frameValue));
  return {
    securityVersion: frame.securityVersion,
    protocolVersion: frame.protocolVersion,
    tripId: frame.tripId,
    senderDeviceId: frame.senderDeviceId,
    keyId: frame.keyId,
    keyEpoch: frame.keyEpoch,
    senderCounter: frame.senderCounter,
    cipherSuite: frame.cipherSuite,
    nonce: encodeBase64Url(frame.nonce),
    ciphertext: encodeBase64Url(frame.ciphertext),
    authenticationTag: encodeBase64Url(frame.authenticationTag),
  };
}

export function parseSerializedSecureControlFrame(value: unknown): SecureFrame {
  if (!isRecord(value)) throw new Error('Secure control frame must be an object.');
  rejectUnknownKeys(value, [
    'securityVersion',
    'protocolVersion',
    'tripId',
    'senderDeviceId',
    'keyId',
    'keyEpoch',
    'senderCounter',
    'cipherSuite',
    'nonce',
    'ciphertext',
    'authenticationTag',
  ]);
  const frame = {
    securityVersion: value.securityVersion,
    protocolVersion: value.protocolVersion,
    tripId: value.tripId,
    senderDeviceId: value.senderDeviceId,
    keyId: value.keyId,
    keyEpoch: value.keyEpoch,
    senderCounter: value.senderCounter,
    cipherSuite: value.cipherSuite,
    nonce: decodeRequiredBase64Url(value.nonce, 'nonce'),
    ciphertext: decodeRequiredBase64Url(value.ciphertext, 'ciphertext'),
    authenticationTag: decodeRequiredBase64Url(
      value.authenticationTag,
      'authenticationTag',
    ),
  };
  return assertParsed(parseSecureFrame(frame));
}

export function serializeSignedSecureControlFrame(
  value: SignedSecureFrame,
): SerializedSignedSecureControlFrame {
  const serialized = serializeSecureControlFrame(value.frame);
  assertEncodedBytes(value.senderIdentityPublicKey, IDENTITY_PUBLIC_KEY_BYTES, 'identity public key');
  assertEncodedBytes(value.signature, IDENTITY_SIGNATURE_BYTES, 'identity signature');
  return {
    ...serialized,
    senderIdentityPublicKey: value.senderIdentityPublicKey,
    signature: value.signature,
  };
}

export function parseSerializedSignedSecureControlFrame(value: unknown): SignedSecureFrame {
  if (!isRecord(value)) throw new Error('Signed secure control frame must be an object.');
  rejectUnknownKeys(value, [
    'securityVersion',
    'protocolVersion',
    'tripId',
    'senderDeviceId',
    'keyId',
    'keyEpoch',
    'senderCounter',
    'cipherSuite',
    'nonce',
    'ciphertext',
    'authenticationTag',
    'senderIdentityPublicKey',
    'signature',
  ]);
  const senderIdentityPublicKey = requiredEncodedString(
    value.senderIdentityPublicKey,
    IDENTITY_PUBLIC_KEY_BYTES,
    'identity public key',
  );
  const signature = requiredEncodedString(
    value.signature,
    IDENTITY_SIGNATURE_BYTES,
    'identity signature',
  );
  const frame = parseSerializedSecureControlFrame({
    securityVersion: value.securityVersion,
    protocolVersion: value.protocolVersion,
    tripId: value.tripId,
    senderDeviceId: value.senderDeviceId,
    keyId: value.keyId,
    keyEpoch: value.keyEpoch,
    senderCounter: value.senderCounter,
    cipherSuite: value.cipherSuite,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authenticationTag: value.authenticationTag,
  });
  return { frame, senderIdentityPublicKey, signature };
}

/**
 * Binary packets keep nonce, ciphertext, and tag as bytes. Trip/device/key
 * context is reconstructed from the authenticated connection and is included
 * in NobleFrameCrypto's AEAD associated data.
 */
export function serializeSecureBinaryFrame(frameValue: SecureFrame): Uint8Array {
  const frame = assertParsed(parseSecureFrame(frameValue));
  const output = new Uint8Array(
    BINARY_FIXED_PREFIX_BYTES +
      frame.nonce.byteLength +
      frame.ciphertext.byteLength +
      frame.authenticationTag.byteLength,
  );
  output.set(BINARY_MAGIC, 0);
  writeSafeCounter(output, BINARY_MAGIC.byteLength, frame.senderCounter);
  let offset = BINARY_FIXED_PREFIX_BYTES;
  output.set(frame.nonce, offset);
  offset += frame.nonce.byteLength;
  output.set(frame.ciphertext, offset);
  offset += frame.ciphertext.byteLength;
  output.set(frame.authenticationTag, offset);
  return output;
}

export function parseSecureBinaryFrame(
  packet: Uint8Array,
  context: SecureBinaryContext,
): SecureFrame {
  if (!(packet instanceof Uint8Array)) throw new Error('Secure binary packet must be bytes.');
  const minimum =
    BINARY_FIXED_PREFIX_BYTES + XCHACHA20_POLY1305_NONCE_BYTES + AEAD_TAG_BYTES + 1;
  if (packet.byteLength < minimum) throw new Error('Secure binary packet is truncated.');
  for (let index = 0; index < BINARY_MAGIC.byteLength; index += 1) {
    if (packet[index] !== BINARY_MAGIC[index]) throw new Error('Secure binary packet magic is invalid.');
  }
  const senderCounter = readSafeCounter(packet, BINARY_MAGIC.byteLength);
  const nonceStart = BINARY_FIXED_PREFIX_BYTES;
  const ciphertextStart = nonceStart + XCHACHA20_POLY1305_NONCE_BYTES;
  const tagStart = packet.byteLength - AEAD_TAG_BYTES;
  return assertParsed(
    parseSecureFrame({
      securityVersion: FRAME_SECURITY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId: context.tripId,
      senderDeviceId: context.senderDeviceId,
      keyId: context.key.keyId,
      keyEpoch: context.key.keyEpoch,
      senderCounter,
      cipherSuite: FRAME_CIPHER_SUITES[0],
      nonce: packet.slice(nonceStart, ciphertextStart),
      ciphertext: packet.slice(ciphertextStart, tagStart),
      authenticationTag: packet.slice(tagStart),
    }),
  );
}

/** Signed binary wire format used by production resource transfers. */
export function serializeSignedSecureBinaryFrame(value: SignedSecureFrame): Uint8Array {
  const frame = assertParsed(parseSecureFrame(value.frame));
  const publicKey = decodeBase64Url(value.senderIdentityPublicKey);
  const signature = decodeBase64Url(value.signature);
  if (publicKey.byteLength !== IDENTITY_PUBLIC_KEY_BYTES) {
    throw new Error('Binary frame identity public key has an invalid length.');
  }
  if (signature.byteLength !== IDENTITY_SIGNATURE_BYTES) {
    throw new Error('Binary frame identity signature has an invalid length.');
  }
  const output = new Uint8Array(
    SIGNED_BINARY_FIXED_PREFIX_BYTES +
      frame.nonce.byteLength +
      frame.ciphertext.byteLength +
      frame.authenticationTag.byteLength,
  );
  output.set(SIGNED_BINARY_MAGIC, 0);
  writeSafeCounter(output, SIGNED_BINARY_MAGIC.byteLength, frame.senderCounter);
  let offset = SIGNED_BINARY_MAGIC.byteLength + COUNTER_BYTES;
  output.set(publicKey, offset);
  offset += publicKey.byteLength;
  output.set(signature, offset);
  offset += signature.byteLength;
  output.set(frame.nonce, offset);
  offset += frame.nonce.byteLength;
  output.set(frame.ciphertext, offset);
  offset += frame.ciphertext.byteLength;
  output.set(frame.authenticationTag, offset);
  return output;
}

export function parseSignedSecureBinaryFrame(
  packet: Uint8Array,
  context: SecureBinaryContext,
): SignedSecureFrame {
  if (!(packet instanceof Uint8Array)) throw new Error('Signed secure binary packet must be bytes.');
  const minimum =
    SIGNED_BINARY_FIXED_PREFIX_BYTES + XCHACHA20_POLY1305_NONCE_BYTES + AEAD_TAG_BYTES + 1;
  if (packet.byteLength < minimum) throw new Error('Signed secure binary packet is truncated.');
  for (let index = 0; index < SIGNED_BINARY_MAGIC.byteLength; index += 1) {
    if (packet[index] !== SIGNED_BINARY_MAGIC[index]) {
      throw new Error('Signed secure binary packet magic is invalid.');
    }
  }
  const senderCounter = readSafeCounter(packet, SIGNED_BINARY_MAGIC.byteLength);
  let offset = SIGNED_BINARY_MAGIC.byteLength + COUNTER_BYTES;
  const publicKey = packet.slice(offset, offset + IDENTITY_PUBLIC_KEY_BYTES);
  offset += IDENTITY_PUBLIC_KEY_BYTES;
  const signature = packet.slice(offset, offset + IDENTITY_SIGNATURE_BYTES);
  offset += IDENTITY_SIGNATURE_BYTES;
  const nonceStart = offset;
  const ciphertextStart = nonceStart + XCHACHA20_POLY1305_NONCE_BYTES;
  const tagStart = packet.byteLength - AEAD_TAG_BYTES;
  const frame = assertParsed(
    parseSecureFrame({
      securityVersion: FRAME_SECURITY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId: context.tripId,
      senderDeviceId: context.senderDeviceId,
      keyId: context.key.keyId,
      keyEpoch: context.key.keyEpoch,
      senderCounter,
      cipherSuite: FRAME_CIPHER_SUITES[0],
      nonce: packet.slice(nonceStart, ciphertextStart),
      ciphertext: packet.slice(ciphertextStart, tagStart),
      authenticationTag: packet.slice(tagStart),
    }),
  );
  return {
    frame,
    senderIdentityPublicKey: encodeBase64Url(publicKey),
    signature: encodeBase64Url(signature),
  };
}

/** Metadata is JSON; media bytes are appended raw before the whole frame is encrypted. */
export function encodeResourceChunkPlaintext(
  envelopeValue: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_CHUNK' }>,
): Uint8Array {
  const envelope = assertParsed(parseProtocolEnvelope(envelopeValue));
  if (envelope.type !== 'RESOURCE_CHUNK') throw new Error('Expected RESOURCE_CHUNK envelope.');
  const metadata = {
    ...envelope,
    payload: {
      transferId: envelope.payload.transferId,
      resourceId: envelope.payload.resourceId,
      chunkIndex: envelope.payload.chunkIndex,
      offset: envelope.payload.offset,
      chunkSha256: envelope.payload.chunkSha256,
    },
  };
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength === 0 || metadataBytes.byteLength > MAX_BINARY_METADATA_BYTES) {
    throw new RangeError('Resource chunk metadata exceeds its binary header limit.');
  }
  if (
    envelope.payload.bytes.byteLength === 0 ||
    envelope.payload.bytes.byteLength > MAX_RESOURCE_CHUNK_BYTES
  ) {
    throw new RangeError('Resource chunk bytes exceed the protocol limit.');
  }
  const output = new Uint8Array(4 + metadataBytes.byteLength + envelope.payload.bytes.byteLength);
  new DataView(output.buffer).setUint32(0, metadataBytes.byteLength, false);
  output.set(metadataBytes, 4);
  output.set(envelope.payload.bytes, 4 + metadataBytes.byteLength);
  return output;
}

export function decodeResourceChunkPlaintext(
  plaintext: Uint8Array,
): Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_CHUNK' }> {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 5) {
    throw new Error('Resource chunk plaintext is truncated.');
  }
  const metadataLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset,
    plaintext.byteLength,
  ).getUint32(0, false);
  if (metadataLength === 0 || metadataLength > MAX_BINARY_METADATA_BYTES) {
    throw new Error('Resource chunk metadata length is invalid.');
  }
  const bytesOffset = 4 + metadataLength;
  if (bytesOffset >= plaintext.byteLength) throw new Error('Resource chunk contains no bytes.');
  let metadata: unknown;
  try {
    metadata = JSON.parse(textDecoder.decode(plaintext.slice(4, bytesOffset))) as unknown;
  } catch (error) {
    throw new Error('Resource chunk metadata is not valid JSON.', { cause: error });
  }
  if (!isRecord(metadata) || !isRecord(metadata.payload)) {
    throw new Error('Resource chunk metadata shape is invalid.');
  }
  const candidate = {
    ...metadata,
    payload: { ...metadata.payload, bytes: plaintext.slice(bytesOffset) },
  };
  const envelope = assertParsed(parseProtocolEnvelope(candidate));
  if (envelope.type !== 'RESOURCE_CHUNK') throw new Error('Binary plaintext is not RESOURCE_CHUNK.');
  return envelope;
}

function decodeRequiredBase64Url(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Secure control ${name} must be a non-empty base64url string.`);
  }
  return decodeBase64Url(value);
}

function requiredEncodedString(value: unknown, length: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`Secure control ${name} must be a string.`);
  assertEncodedBytes(value, length, name);
  return value;
}

function assertEncodedBytes(value: string, length: number, name: string): void {
  if (decodeBase64Url(value).byteLength !== length) {
    throw new Error(`Secure control ${name} has an invalid length.`);
  }
}

function writeSafeCounter(output: Uint8Array, offset: number, counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new RangeError('Secure frame counter must be a positive safe integer.');
  }
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter - high * 0x1_0000_0000;
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(offset, high, false);
  view.setUint32(offset + 4, low, false);
}

function readSafeCounter(input: Uint8Array, offset: number): number {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const counter = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new Error('Secure binary counter is outside the safe integer range.');
  }
  return counter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Secure control frame contains unknown fields: ${unknown.join(', ')}.`);
  }
}
