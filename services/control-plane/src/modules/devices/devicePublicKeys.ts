import { ECDH } from "node:crypto";

import { DomainError } from "../../shared/errors/domainError.js";

export interface DevicePublicKeyInput {
  readonly authenticationKeyAlgorithm: string;
  readonly authenticationKeyVersion: number;
  readonly authenticationPublicKey: string;
  readonly e2eeKeyAlgorithm: string;
  readonly e2eeKeyVersion: number;
  readonly e2eePublicKey: string;
}

export interface ValidatedDevicePublicKeys {
  readonly authenticationPublicKey: Readonly<Uint8Array>;
  readonly e2eePublicKey: Readonly<Uint8Array>;
}

function invalid(): never {
  throw new DomainError("INVALID_REQUEST");
}

function decodeCanonical(input: string, expectedLength: number): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(input, "base64");
  } catch {
    return invalid();
  }
  if (
    decoded.byteLength !== expectedLength ||
    decoded.toString("base64") !== input
  ) {
    return invalid();
  }
  return decoded;
}

export function validateDevicePublicKeys(
  input: DevicePublicKeyInput,
): ValidatedDevicePublicKeys {
  if (
    input.authenticationKeyAlgorithm !== "P-256" ||
    input.authenticationKeyVersion !== 1 ||
    input.e2eeKeyAlgorithm !== "X25519" ||
    input.e2eeKeyVersion !== 1
  ) {
    return invalid();
  }

  const authenticationPublicKey = decodeCanonical(
    input.authenticationPublicKey,
    65,
  );
  if (authenticationPublicKey[0] !== 0x04) return invalid();
  try {
    const roundTrip = ECDH.convertKey(
      authenticationPublicKey,
      "prime256v1",
      undefined,
      undefined,
      "uncompressed",
    );
    if (!Buffer.from(roundTrip).equals(authenticationPublicKey))
      return invalid();
  } catch {
    return invalid();
  }

  const e2eePublicKey = decodeCanonical(input.e2eePublicKey, 32);
  return {
    authenticationPublicKey: Uint8Array.from(authenticationPublicKey),
    e2eePublicKey: Uint8Array.from(e2eePublicKey),
  };
}
