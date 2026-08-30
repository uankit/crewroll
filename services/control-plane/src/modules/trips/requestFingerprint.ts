import { createHash } from "node:crypto";

import type {
  ApproveTripFingerprintInput,
  CreateTripFingerprintInput,
  JoinTripFingerprintInput,
  ReadinessTripFingerprintInput,
  RejectTripFingerprintInput,
  StartTripFingerprintInput,
} from "./types.js";
import { isCanonicalTripName, isValidatedTripRelease } from "./tripPolicy.js";

const FRAME_DOMAIN = Buffer.from("CREWROLL-TRIP-FINGERPRINT-V1\0", "ascii");
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INVALID_MESSAGE = "Invalid trip fingerprint input";

type FieldValue = string | Readonly<Uint8Array>;
type Field = readonly [name: string, value: FieldValue];

function invalid(): never {
  throw new Error(INVALID_MESSAGE);
}

function exactInputKeys(
  input: unknown,
  expected: readonly string[],
): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid();
  }
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== "string") ||
    expected.some((key) => !Object.hasOwn(input, key))
  ) {
    return invalid();
  }
}

function uuidV7(value: unknown): string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value)
    ? value
    : invalid();
}

function canonicalUuid(value: unknown): string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value)
    ? value
    : invalid();
}

function exactBytes(value: unknown, length: number): Readonly<Uint8Array> {
  return value instanceof Uint8Array && value.byteLength === length
    ? value
    : invalid();
}

function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1
    ? Number(value)
    : invalid();
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}

function frameField([name, value]: Field): Buffer {
  const nameBytes = Buffer.from(name, "ascii");
  const valueBytes =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (nameBytes.byteLength > 0xffff || valueBytes.byteLength > 0xffffffff) {
    nameBytes.fill(0);
    valueBytes.fill(0);
    return invalid();
  }
  const frame = Buffer.alloc(
    2 + nameBytes.byteLength + 4 + valueBytes.byteLength,
  );
  frame.writeUInt16BE(nameBytes.byteLength, 0);
  nameBytes.copy(frame, 2);
  frame.writeUInt32BE(valueBytes.byteLength, 2 + nameBytes.byteLength);
  valueBytes.copy(frame, 2 + nameBytes.byteLength + 4);
  nameBytes.fill(0);
  valueBytes.fill(0);
  return frame;
}

function fingerprint(
  routeKey: string,
  fields: readonly Field[],
): Readonly<Uint8Array> {
  const framed = [
    frameField(["routeKey", routeKey]),
    ...fields.map(frameField),
  ];
  const count = Buffer.alloc(2);
  count.writeUInt16BE(framed.length, 0);
  const payload = Buffer.concat([FRAME_DOMAIN, count, ...framed]);
  let digest: Buffer | undefined;
  try {
    digest = createHash("sha256").update(payload).digest();
    return Uint8Array.from(digest);
  } finally {
    count.fill(0);
    payload.fill(0);
    digest?.fill(0);
    for (const field of framed) field.fill(0);
  }
}

export function createTripRequestFingerprint(
  input: CreateTripFingerprintInput,
): Readonly<Uint8Array> {
  exactInputKeys(input, [
    "canonicalTripName",
    "endsAt",
    "inviteCodeHmac",
    "ownerDeviceId",
    "ownerKeyEnvelope",
    "release",
    "tripId",
  ]);
  if (!isCanonicalTripName(input.canonicalTripName)) return invalid();
  if (!isValidatedTripRelease(input.release)) return invalid();
  if (
    !(input.endsAt instanceof Date) ||
    !Number.isFinite(input.endsAt.getTime())
  ) {
    return invalid();
  }
  const releaseTimeZone =
    input.release.mode === "NIGHTLY" ? input.release.timeZone : "";
  const releaseLocalTime =
    input.release.mode === "NIGHTLY" ? input.release.localTime : "";
  return fingerprint("trips.create.v1", [
    ["tripId", uuidV7(input.tripId)],
    ["canonicalTripName", input.canonicalTripName],
    ["inviteCodeHmac", exactBytes(input.inviteCodeHmac, 32)],
    ["releaseMode", input.release.mode],
    ["releaseTimeZone", releaseTimeZone],
    ["releaseLocalTime", releaseLocalTime],
    ["endsAtEpochMs", String(input.endsAt.getTime())],
    ["ownerDeviceId", canonicalUuid(input.ownerDeviceId)],
    ["ownerKeyEpoch", "1"],
    ["ownerAlgorithmVersion", "1"],
    ["ownerKeyEnvelope", exactBytes(input.ownerKeyEnvelope, 148)],
  ]);
}

export function joinTripRequestFingerprint(
  input: JoinTripFingerprintInput,
): Readonly<Uint8Array> {
  exactInputKeys(input, ["deviceId", "inviteCodeHmac"]);
  return fingerprint("trips.join.v1", [
    ["inviteCodeHmac", exactBytes(input.inviteCodeHmac, 32)],
    ["deviceId", canonicalUuid(input.deviceId)],
  ]);
}

export function approveTripRequestFingerprint(
  input: ApproveTripFingerprintInput,
): Readonly<Uint8Array> {
  exactInputKeys(input, [
    "algorithmVersion",
    "keyEpoch",
    "membershipId",
    "tripId",
    "wrappedKey",
  ]);
  if (input.keyEpoch !== 1 || input.algorithmVersion !== 1) return invalid();
  return fingerprint("trips.approve.v1", [
    ["tripId", uuidV7(input.tripId)],
    ["membershipId", canonicalUuid(input.membershipId)],
    ["keyEpoch", "1"],
    ["algorithmVersion", "1"],
    ["wrappedKey", exactBytes(input.wrappedKey, 148)],
  ]);
}

export function rejectTripRequestFingerprint(
  input: RejectTripFingerprintInput,
): Readonly<Uint8Array> {
  exactInputKeys(input, ["membershipId", "tripId"]);
  return fingerprint("trips.reject.v1", [
    ["tripId", uuidV7(input.tripId)],
    ["membershipId", canonicalUuid(input.membershipId)],
  ]);
}

export function readinessTripRequestFingerprint(
  input: ReadinessTripFingerprintInput,
): Readonly<Uint8Array> {
  exactInputKeys(input, ["fullPhotoLibraryAccess", "tripId"]);
  return fingerprint("trips.readiness.v1", [
    ["tripId", uuidV7(input.tripId)],
    [
      "fullPhotoLibraryAccess",
      booleanValue(input.fullPhotoLibraryAccess) ? "1" : "0",
    ],
  ]);
}

export function startTripRequestFingerprint(
  input: StartTripFingerprintInput,
): Readonly<Uint8Array> {
  exactInputKeys(input, ["expectedVersion", "tripId"]);
  return fingerprint("trips.start.v1", [
    ["tripId", uuidV7(input.tripId)],
    ["expectedVersion", String(positiveInteger(input.expectedVersion))],
  ]);
}
