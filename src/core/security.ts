import {
  AEAD_TAG_BYTES,
  FRAME_SECURITY_VERSION,
  MAX_SECURE_FRAME_CIPHERTEXT_BYTES,
  PROTOCOL_VERSION,
  XCHACHA20_POLY1305_NONCE_BYTES,
  type FrameSecurityVersion,
  type ProtocolVersion,
} from "./constants";
import {
  parseDeviceId,
  parseTripId,
  type DeviceId,
  type TripId,
} from "./ids";
import {
  appendResult,
  issue,
  parseFailure,
  parseSuccess,
  readEnum,
  readNumber,
  readString,
  readUint8Array,
  rejectUnknownKeys,
  requireRecord,
  type ParseResult,
  type ValidationIssue,
} from "./validation";

export const FRAME_CIPHER_SUITES = ["XCHACHA20_POLY1305"] as const;
export type FrameCipherSuite = (typeof FRAME_CIPHER_SUITES)[number];

export interface SecureFrameHeader {
  readonly securityVersion: FrameSecurityVersion;
  readonly protocolVersion: ProtocolVersion;
  readonly tripId: TripId;
  readonly senderDeviceId: DeviceId;
  readonly keyId: string;
  readonly keyEpoch: number;
  /** Monotonic per sender device and key epoch; must never be reused. */
  readonly senderCounter: number;
  readonly cipherSuite: FrameCipherSuite;
}

export interface SecureFrame extends SecureFrameHeader {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authenticationTag: Uint8Array;
}

export interface SessionKeyHandle {
  readonly tripId: TripId;
  readonly keyId: string;
  readonly keyEpoch: number;
  readonly cipherSuite: FrameCipherSuite;
}

/**
 * Boundary implemented by an audited native/platform crypto provider.
 *
 * Implementations MUST authenticate every SecureFrameHeader field as AEAD
 * associated data, generate nonces with a CSPRNG or proven counter scheme,
 * persist senderCounter before transmission, reject authentication failures,
 * and never expose raw key bytes to this core. The core intentionally contains
 * no encryption, key derivation, or fallback-to-plaintext implementation.
 */
export interface AuthenticatedFrameCrypto {
  seal(input: {
    readonly header: SecureFrameHeader;
    readonly plaintext: Uint8Array;
    readonly key: SessionKeyHandle;
  }): Promise<SecureFrame>;

  open(input: {
    readonly frame: SecureFrame;
    readonly key: SessionKeyHandle;
  }): Promise<Uint8Array>;
}

/** Must atomically reject a repeated or stale (sender, keyEpoch, counter). */
export interface SecureFrameReplayGuard {
  accept(input: {
    readonly tripId: TripId;
    readonly senderDeviceId: DeviceId;
    readonly keyEpoch: number;
    readonly senderCounter: number;
  }): Promise<boolean>;
}

const SECURE_FRAME_KEYS = [
  "securityVersion",
  "protocolVersion",
  "tripId",
  "senderDeviceId",
  "keyId",
  "keyEpoch",
  "senderCounter",
  "cipherSuite",
  "nonce",
  "ciphertext",
  "authenticationTag",
] as const;

export function parseSecureFrame(value: unknown): ParseResult<SecureFrame> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, SECURE_FRAME_KEYS, "$", issues);

  const securityVersion = readNumber(record, "securityVersion", "$", issues, {
    integer: true,
    safeInteger: true,
    min: FRAME_SECURITY_VERSION,
    max: FRAME_SECURITY_VERSION,
  });
  const protocolVersion = readNumber(record, "protocolVersion", "$", issues, {
    integer: true,
    safeInteger: true,
    min: PROTOCOL_VERSION,
    max: PROTOCOL_VERSION,
  });
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const senderDeviceId = appendResult(
    parseDeviceId(record.senderDeviceId),
    issues,
    "senderDeviceId",
  );
  const keyId = readString(record, "keyId", "$", issues, {
    minLength: 8,
    maxLength: 128,
    pattern: /^[A-Za-z0-9._:-]+$/,
  });
  const keyEpoch = readNumber(record, "keyEpoch", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 0,
  });
  const senderCounter = readNumber(record, "senderCounter", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
  });
  const cipherSuite = readEnum(
    record,
    "cipherSuite",
    FRAME_CIPHER_SUITES,
    "$",
    issues,
  );
  const nonce = readUint8Array(record, "nonce", "$", issues, {
    minLength: XCHACHA20_POLY1305_NONCE_BYTES,
    maxLength: XCHACHA20_POLY1305_NONCE_BYTES,
  });
  const ciphertext = readUint8Array(record, "ciphertext", "$", issues, {
    minLength: 1,
    maxLength: MAX_SECURE_FRAME_CIPHERTEXT_BYTES,
  });
  const authenticationTag = readUint8Array(
    record,
    "authenticationTag",
    "$",
    issues,
    { minLength: AEAD_TAG_BYTES, maxLength: AEAD_TAG_BYTES },
  );
  if (issues.length > 0) return parseFailure(issues);

  return parseSuccess({
    securityVersion: securityVersion as FrameSecurityVersion,
    protocolVersion: protocolVersion as ProtocolVersion,
    tripId: tripId!,
    senderDeviceId: senderDeviceId!,
    keyId: keyId!,
    keyEpoch: keyEpoch!,
    senderCounter: senderCounter!,
    cipherSuite: cipherSuite!,
    nonce: nonce!,
    ciphertext: ciphertext!,
    authenticationTag: authenticationTag!,
  });
}

export function validateFrameContext(
  frame: SecureFrame,
  key: SessionKeyHandle,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (frame.tripId !== key.tripId) {
    issues.push(issue("tripId", "TRIP_MISMATCH", "Frame and key belong to different trips."));
  }
  if (frame.keyId !== key.keyId || frame.keyEpoch !== key.keyEpoch) {
    issues.push(issue("keyId", "KEY_MISMATCH", "Frame does not match the selected session key."));
  }
  if (frame.cipherSuite !== key.cipherSuite) {
    issues.push(issue("cipherSuite", "CIPHER_MISMATCH", "Frame and key use different cipher suites."));
  }
  return issues;
}
