import { createHash, createHmac } from "node:crypto";

import type {
  BackgroundCredentialInput,
  BackgroundCredentialIssuer,
  IssuedBackgroundCredential,
} from "../../modules/devices/ports/backgroundCredentialIssuer.js";
import { DomainError } from "../../shared/errors/domainError.js";

const domain = Buffer.from("CREWROLL-BACKGROUND-V1\0", "ascii");
const frameBytes = 63;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function invalid(): never {
  throw new DomainError("INTERNAL_ERROR");
}

function uuidBytes(input: string): Buffer {
  if (!uuidPattern.test(input)) return invalid();
  return Buffer.from(input.replaceAll("-", ""), "hex");
}

function expirySeconds(expiresAt: Date): bigint {
  const milliseconds = expiresAt.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds % 1_000 !== 0
  ) {
    return invalid();
  }
  return BigInt(milliseconds / 1_000);
}

function encodeFrame({
  deviceId,
  expiresAt,
  userId,
}: BackgroundCredentialInput): Buffer {
  const userBytes = uuidBytes(userId);
  const deviceBytes = uuidBytes(deviceId);
  const frame = Buffer.alloc(frameBytes);
  let complete = false;
  try {
    domain.copy(frame, 0);
    userBytes.copy(frame, 23);
    deviceBytes.copy(frame, 39);
    frame.writeBigUInt64BE(expirySeconds(expiresAt), 55);
    complete = true;
    return frame;
  } finally {
    userBytes.fill(0);
    deviceBytes.fill(0);
    if (!complete) frame.fill(0);
  }
}

export function buildBackgroundCredentialFrame(
  input: BackgroundCredentialInput,
): Readonly<Uint8Array> {
  const frame = encodeFrame(input);
  try {
    return Uint8Array.from(frame);
  } finally {
    frame.fill(0);
  }
}

export function createHmacBackgroundCredentialIssuer(
  key: Uint8Array,
): BackgroundCredentialIssuer {
  if (key.byteLength !== 32) return invalid();
  const ownedKey = Buffer.from(key);
  return {
    issue(input): IssuedBackgroundCredential {
      const frame = encodeFrame(input);
      let mac: Buffer | undefined;
      let bearerBytes: Buffer | undefined;
      let bearerHash: Buffer | undefined;
      try {
        mac = createHmac("sha256", ownedKey).update(frame).digest();
        const bearer = `crb_${mac.toString("base64url")}`;
        bearerBytes = Buffer.from(bearer, "utf8");
        bearerHash = createHash("sha256").update(bearerBytes).digest();
        return {
          bearer,
          bearerHash: Uint8Array.from(bearerHash),
        };
      } finally {
        frame.fill(0);
        mac?.fill(0);
        bearerBytes?.fill(0);
        bearerHash?.fill(0);
      }
    },
  };
}
