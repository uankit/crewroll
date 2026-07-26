import { describe, expect, it } from 'vitest';

import { FRAME_SECURITY_VERSION, PROTOCOL_VERSION } from '../../core/constants';
import {
  parseDeviceId,
  parseMemberId,
  parseMessageId,
  parseResourceId,
  parseSha256Hex,
  parseTransferId,
  parseTripId,
} from '../../core/ids';
import type { ProtocolEnvelope } from '../../core/protocol';
import type { SecureFrame, SessionKeyHandle } from '../../core/security';
import { assertParsed } from '../../core/validation';

import {
  decodeResourceChunkPlaintext,
  encodeControlEnvelopePlaintext,
  encodeResourceChunkPlaintext,
  parseSecureBinaryFrame,
  parseSerializedSecureControlFrame,
  serializeSecureBinaryFrame,
  serializeSecureControlFrame,
} from './secureWire';

const tripId = assertParsed(parseTripId('trip:test-123456'));
const memberId = assertParsed(parseMemberId('member:test-1234'));
const deviceId = assertParsed(parseDeviceId('device:test-1234'));
const messageId = assertParsed(parseMessageId('message:test-123'));
const transferId = assertParsed(parseTransferId('transfer:test-12'));
const resourceId = assertParsed(parseResourceId('resource:test-12'));
const sha = assertParsed(parseSha256Hex('a'.repeat(64)));
const key: SessionKeyHandle = {
  tripId,
  keyId: 'trip-key:test',
  keyEpoch: 1,
  cipherSuite: 'XCHACHA20_POLY1305',
};

function chunkEnvelope(bytes: Uint8Array): Extract<ProtocolEnvelope, { type: 'RESOURCE_CHUNK' }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    tripId,
    senderMemberId: memberId,
    senderDeviceId: deviceId,
    membershipEpoch: 1,
    senderMessageSequence: 9,
    sentAtMs: 1_000,
    type: 'RESOURCE_CHUNK',
    payload: {
      transferId,
      resourceId,
      chunkIndex: 3,
      offset: 128,
      bytes,
      chunkSha256: sha,
    },
  };
}

function secureFrame(ciphertext = new Uint8Array([41, 42, 43])): SecureFrame {
  return {
    securityVersion: FRAME_SECURITY_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    tripId,
    senderDeviceId: deviceId,
    keyId: key.keyId,
    keyEpoch: key.keyEpoch,
    senderCounter: 9,
    cipherSuite: key.cipherSuite,
    nonce: new Uint8Array(24).fill(7),
    ciphertext,
    authenticationTag: new Uint8Array(16).fill(8),
  };
}

describe('secure wire codecs', () => {
  it('keeps media bytes binary and round-trips authenticated chunk metadata', () => {
    const bytes = new Uint8Array([0, 255, 12, 13, 77, 91]);
    const encoded = encodeResourceChunkPlaintext(chunkEnvelope(bytes));
    const decoded = decodeResourceChunkPlaintext(encoded);

    expect(decoded.payload.bytes).toEqual(bytes);
    expect(decoded.payload.offset).toBe(128);
    expect(decoded.payload.chunkIndex).toBe(3);
    expect(encoded.slice(-bytes.byteLength)).toEqual(bytes);
  });

  it('rejects resource bytes on the JSON control channel', () => {
    expect(() => encodeControlEnvelopePlaintext(chunkEnvelope(new Uint8Array([1])))).toThrow(
      /binary codec/i,
    );
  });

  it('uses base64url only for the small encrypted control container', () => {
    const serialized = serializeSecureControlFrame(secureFrame());
    expect(serialized.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(serialized.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(serialized.authenticationTag).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseSerializedSecureControlFrame(serialized)).toEqual(secureFrame());
    expect(() =>
      parseSerializedSecureControlFrame({ ...serialized, plaintext: 'forbidden' }),
    ).toThrow(/unknown fields/i);
  });

  it('serializes encrypted chunk frames without JSON or base64', () => {
    const frame = secureFrame(new Uint8Array([0, 1, 2, 250, 251, 252]));
    const packet = serializeSecureBinaryFrame(frame);
    const parsed = parseSecureBinaryFrame(packet, { tripId, senderDeviceId: deviceId, key });

    expect(parsed).toEqual(frame);
    expect(packet).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(packet)).not.toContain('ciphertext');
  });
});
