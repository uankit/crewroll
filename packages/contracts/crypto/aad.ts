import { BinaryWriter, assertExactObject } from "./binary.js";
import {
  MANIFEST_AAD_BYTES,
  MANIFEST_AAD_DOMAIN,
  MEDIA_AAD_BYTES,
  MEDIA_AAD_DOMAIN,
  VARIANT_CODES,
  type EncryptionFormatVersion,
  type KeyEpoch,
  type ObjectVariant,
} from "./protocol.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const MEDIA_AAD_KEYS = [
  "tripId",
  "assetId",
  "variant",
  "keyEpoch",
  "formatVersion",
] as const;
const MANIFEST_AAD_KEYS = [
  "tripId",
  "assetId",
  "keyEpoch",
  "formatVersion",
] as const;

export type MediaAssociatedData = Readonly<{
  tripId: string;
  assetId: string;
  variant: ObjectVariant;
  keyEpoch: KeyEpoch;
  formatVersion: EncryptionFormatVersion;
}>;

export type ManifestAssociatedData = Readonly<{
  tripId: string;
  assetId: string;
  keyEpoch: KeyEpoch;
  formatVersion: EncryptionFormatVersion;
}>;

export function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical-shape UUID`);
  }
  return value.toLowerCase();
}

function exactV1(value: unknown, label: string): 1 {
  if (value !== 1) {
    throw new RangeError(`${label} must be 1 for format v1`);
  }
  return value;
}

function exactVariant(value: unknown): ObjectVariant {
  if (value !== "PREVIEW" && value !== "ORIGINAL") {
    throw new TypeError("variant must be PREVIEW or ORIGINAL");
  }
  return value;
}

export function encodeMediaAssociatedData(value: unknown): Uint8Array {
  const record = assertExactObject(value, MEDIA_AAD_KEYS, "media AAD");
  const tripId = canonicalUuid(record.tripId, "tripId");
  const assetId = canonicalUuid(record.assetId, "assetId");
  const variant = exactVariant(record.variant);
  const keyEpoch = exactV1(record.keyEpoch, "keyEpoch");
  const formatVersion = exactV1(record.formatVersion, "formatVersion");

  return new BinaryWriter(MEDIA_AAD_BYTES)
    .writeAscii(MEDIA_AAD_DOMAIN)
    .writeAscii(tripId)
    .writeAscii(assetId)
    .writeUint8(VARIANT_CODES[variant])
    .writeUint32(keyEpoch)
    .writeUint32(formatVersion)
    .toUint8Array();
}

export function encodeManifestAssociatedData(value: unknown): Uint8Array {
  const record = assertExactObject(value, MANIFEST_AAD_KEYS, "manifest AAD");
  const tripId = canonicalUuid(record.tripId, "tripId");
  const assetId = canonicalUuid(record.assetId, "assetId");
  const keyEpoch = exactV1(record.keyEpoch, "keyEpoch");
  const formatVersion = exactV1(record.formatVersion, "formatVersion");

  return new BinaryWriter(MANIFEST_AAD_BYTES)
    .writeAscii(MANIFEST_AAD_DOMAIN)
    .writeAscii(tripId)
    .writeAscii(assetId)
    .writeUint32(keyEpoch)
    .writeUint32(formatVersion)
    .toUint8Array();
}
