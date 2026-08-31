import type {
  MembershipResponse,
  ProblemCode,
  TripResponse,
} from "@crewroll/contracts";
import type {
  NativeDeviceIdentity,
  WrapTripKeyResult,
} from "@crewroll/contracts/native/protocol";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { userFacingProblems } from "../problems/userFacingProblem";
import { TripTransportProblem } from "./CreateImmediateTrip";
import type { ApproveMemberNativePort, TripApiPort } from "./ports";

export type ApproveMemberResult = Readonly<{
  tripId: string;
  membershipId: string;
  status: "ACTIVE";
}>;

export type ApproveMemberDependencies = Readonly<{
  api: TripApiPort;
  device: Readonly<{
    deviceId: string;
    identity: NativeDeviceIdentity;
  }>;
  native: ApproveMemberNativePort;
  random: RandomBytesPort;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC_3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const TEXT_1_TO_80_PATTERN =
  /^(?:(?:[\uD800-\uDBFF][\uDC00-\uDFFF])|[^\uD800-\uDFFF]){1,80}$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const X25519_PUBLIC_KEY_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/;
const WRAPPED_KEY_PATTERN = /^(?:[A-Za-z0-9+/]{4}){49}[A-Za-z0-9+/][AQgw]==$/;

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
}

function envelopeProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("KEY_ENVELOPE_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => typeof key === "string" && expected.includes(key)) &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isTripId(value: unknown): value is string {
  return typeof value === "string" && TRIP_ID_PATTERN.test(value);
}

function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC_3339_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value === "UTC" || value.includes("/");
  } catch {
    return false;
  }
}

function isRelease(value: unknown): value is TripResponse["release"] {
  if (!isRecord(value) || typeof value.mode !== "string") return false;
  if (value.mode === "IMMEDIATE") {
    return hasExactKeys(value, ["mode"]);
  }
  if (value.mode === "NIGHTLY") {
    return (
      hasExactKeys(value, ["mode", "timeZone", "localTime"]) &&
      isIanaTimeZone(value.timeZone) &&
      typeof value.localTime === "string" &&
      LOCAL_TIME_PATTERN.test(value.localTime)
    );
  }
  return false;
}

function isKeyEnvelope(
  value: unknown,
): value is Exclude<TripResponse["tripKeyEnvelope"], null> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["keyEpoch", "algorithmVersion", "wrappedKey"]) &&
    value.keyEpoch === 1 &&
    value.algorithmVersion === 1 &&
    typeof value.wrappedKey === "string" &&
    WRAPPED_KEY_PATTERN.test(value.wrappedKey)
  );
}

function isNominatedDevice(
  value: unknown,
): value is NonNullable<TripResponse["members"][number]["nominatedDevice"]> {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "deviceId",
      "e2eeKeyAlgorithm",
      "e2eePublicKey",
      "e2eeKeyVersion",
    ]) &&
    isUuid(value.deviceId) &&
    value.e2eeKeyAlgorithm === "X25519" &&
    typeof value.e2eePublicKey === "string" &&
    X25519_PUBLIC_KEY_PATTERN.test(value.e2eePublicKey) &&
    value.e2eeKeyVersion === 1
  );
}

function isTripMember(
  value: unknown,
): value is TripResponse["members"][number] {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "membershipId",
      "role",
      "displayName",
      "status",
      "readiness",
      "nominatedDevice",
    ]) &&
    isUuid(value.membershipId) &&
    (value.role === "OWNER" || value.role === "MEMBER") &&
    typeof value.displayName === "string" &&
    TEXT_1_TO_80_PATTERN.test(value.displayName) &&
    (value.status === "PENDING_KEY" || value.status === "ACTIVE") &&
    isRecord(value.readiness) &&
    hasExactKeys(value.readiness, ["fullPhotoLibraryAccess"]) &&
    typeof value.readiness.fullPhotoLibraryAccess === "boolean" &&
    (value.nominatedDevice === null || isNominatedDevice(value.nominatedDevice))
  );
}

export function isClosedTripResponse(value: unknown): value is TripResponse {
  try {
    return (
      isRecord(value) &&
      hasExactKeys(value, [
        "id",
        "version",
        "name",
        "status",
        "release",
        "startsAt",
        "endsAt",
        "ownerDeviceId",
        "currentMembershipId",
        "keyEpoch",
        "tripKeyEnvelope",
        "members",
      ]) &&
      isTripId(value.id) &&
      typeof value.version === "number" &&
      Number.isInteger(value.version) &&
      value.version >= 1 &&
      typeof value.name === "string" &&
      TEXT_1_TO_80_PATTERN.test(value.name) &&
      (value.status === "LOBBY" ||
        value.status === "ACTIVE" ||
        value.status === "ENDING" ||
        value.status === "COMPLETE" ||
        value.status === "INCOMPLETE_EXPIRED" ||
        value.status === "CANCELLED") &&
      isRelease(value.release) &&
      (value.startsAt === null || isRfc3339DateTime(value.startsAt)) &&
      isRfc3339DateTime(value.endsAt) &&
      isUuid(value.ownerDeviceId) &&
      isUuid(value.currentMembershipId) &&
      value.keyEpoch === 1 &&
      (value.tripKeyEnvelope === null ||
        isKeyEnvelope(value.tripKeyEnvelope)) &&
      Array.isArray(value.members) &&
      value.members.length >= 1 &&
      value.members.length <= 10 &&
      value.members.every(isTripMember)
    );
  } catch {
    return false;
  }
}

function isWrapResult(value: unknown): value is WrapTripKeyResult {
  try {
    return (
      isRecord(value) &&
      hasExactKeys(value, [
        "protocolVersion",
        "tripId",
        "keyEpoch",
        "algorithmVersion",
        "senderDeviceId",
        "recipientDeviceId",
        "recipientE2eeKeyVersion",
        "wrappedKey",
      ]) &&
      value.protocolVersion === 1 &&
      isTripId(value.tripId) &&
      value.keyEpoch === 1 &&
      value.algorithmVersion === 1 &&
      isUuid(value.senderDeviceId) &&
      isUuid(value.recipientDeviceId) &&
      value.recipientE2eeKeyVersion === 1 &&
      typeof value.wrappedKey === "string" &&
      WRAPPED_KEY_PATTERN.test(value.wrappedKey)
    );
  } catch {
    return false;
  }
}

function isMembershipResponse(value: unknown): value is MembershipResponse {
  try {
    return (
      isRecord(value) &&
      hasExactKeys(value, [
        "membershipId",
        "tripId",
        "deviceId",
        "status",
        "keyEpoch",
        "tripKeyEnvelope",
      ]) &&
      isUuid(value.membershipId) &&
      isTripId(value.tripId) &&
      isUuid(value.deviceId) &&
      (value.status === "PENDING_KEY" ||
        value.status === "ACTIVE" ||
        value.status === "REJECTED") &&
      value.keyEpoch === 1 &&
      (value.tripKeyEnvelope === null || isKeyEnvelope(value.tripKeyEnvelope))
    );
  } catch {
    return false;
  }
}

function apiProblemCode(error: unknown): ProblemCode | null {
  try {
    if (!isRecord(error) || error.kind !== "API_PROBLEM") return null;
    const code = error.code;
    return typeof code === "string" && Object.hasOwn(userFacingProblems, code)
      ? (code as ProblemCode)
      : null;
  } catch {
    return null;
  }
}

function sanitizeApiFailure(error: unknown): Error {
  const code = apiProblemCode(error);
  if (code !== null) return new CrewRollApiProblem(code);
  try {
    if (isRecord(error) && error.kind === "TRANSPORT_UNAVAILABLE") {
      return new TripTransportProblem();
    }
  } catch {
    return internalProblem();
  }
  return internalProblem();
}

function hasValidLocalKeyContext(identity: NativeDeviceIdentity): boolean {
  try {
    return (
      identity.protocolVersion === 1 &&
      identity.e2eeKeyAlgorithm === "X25519" &&
      X25519_PUBLIC_KEY_PATTERN.test(identity.e2eePublicKey) &&
      identity.e2eeKeyVersion === 1
    );
  } catch {
    return false;
  }
}

export function createApproveMember(dependencies: ApproveMemberDependencies) {
  const { api, device, native, random } = dependencies;

  async function approve(
    tripCandidate: TripResponse,
    targetMembershipId: string,
  ): Promise<ApproveMemberResult> {
    if (
      !isClosedTripResponse(tripCandidate) ||
      !isUuid(device.deviceId) ||
      !hasValidLocalKeyContext(device.identity) ||
      !isUuid(targetMembershipId)
    ) {
      throw internalProblem();
    }

    const currentMembers = tripCandidate.members.filter(
      (member) => member.membershipId === tripCandidate.currentMembershipId,
    );
    const targetMembers = tripCandidate.members.filter(
      (member) => member.membershipId === targetMembershipId,
    );
    const currentMember = currentMembers[0];
    const targetMember = targetMembers[0];
    const currentNomination = currentMember?.nominatedDevice;
    const targetNomination = targetMember?.nominatedDevice;
    if (
      currentMembers.length !== 1 ||
      targetMembers.length !== 1 ||
      targetMembershipId === tripCandidate.currentMembershipId ||
      tripCandidate.status !== "LOBBY" ||
      tripCandidate.ownerDeviceId !== device.deviceId ||
      currentMember?.role !== "OWNER" ||
      currentMember.status !== "ACTIVE" ||
      currentNomination === null ||
      currentNomination === undefined ||
      currentNomination.deviceId !== device.deviceId ||
      currentNomination.e2eeKeyAlgorithm !== "X25519" ||
      currentNomination.e2eePublicKey !== device.identity.e2eePublicKey ||
      currentNomination.e2eeKeyVersion !== device.identity.e2eeKeyVersion ||
      targetMember?.role !== "MEMBER" ||
      targetMember.status !== "PENDING_KEY" ||
      targetNomination === null ||
      targetNomination === undefined ||
      targetNomination.e2eeKeyAlgorithm !== "X25519" ||
      targetNomination.e2eeKeyVersion !== 1
    ) {
      throw internalProblem();
    }

    let commandId: string;
    try {
      commandId = await createUuidV4(random);
    } catch {
      throw internalProblem();
    }

    let wrapResult: WrapTripKeyResult;
    try {
      wrapResult = await native.wrapTripKey({
        protocolVersion: 1,
        tripId: tripCandidate.id,
        keyEpoch: 1,
        recipientDeviceId: targetNomination.deviceId,
        recipientE2eePublicKey: targetNomination.e2eePublicKey,
        recipientE2eeKeyVersion: targetNomination.e2eeKeyVersion,
      });
    } catch {
      throw envelopeProblem();
    }

    if (
      !isWrapResult(wrapResult) ||
      wrapResult.tripId !== tripCandidate.id ||
      wrapResult.senderDeviceId !== device.deviceId ||
      wrapResult.recipientDeviceId !== targetNomination.deviceId ||
      wrapResult.recipientE2eeKeyVersion !== targetNomination.e2eeKeyVersion
    ) {
      throw envelopeProblem();
    }

    let response: MembershipResponse;
    try {
      response = await api.approveMember(
        device.deviceId,
        commandId,
        tripCandidate.id,
        targetMembershipId,
        Object.freeze({
          keyEpoch: 1,
          algorithmVersion: 1,
          wrappedKey: wrapResult.wrappedKey,
        }),
      );
    } catch (error) {
      throw sanitizeApiFailure(error);
    }

    if (
      !isMembershipResponse(response) ||
      response.tripId !== tripCandidate.id ||
      response.membershipId !== targetMembershipId ||
      response.deviceId !== targetNomination.deviceId ||
      response.status !== "ACTIVE"
    ) {
      throw internalProblem();
    }

    return Object.freeze({
      tripId: response.tripId,
      membershipId: response.membershipId,
      status: "ACTIVE" as const,
    });
  }

  return Object.freeze({ approve });
}
