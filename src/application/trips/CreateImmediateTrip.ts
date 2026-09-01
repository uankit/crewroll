import type {
  CreateTripBody,
  CreateTripOutcomeResponse,
  ProblemCode,
  TripResponse,
} from "@crewroll/contracts";
import type {
  CreateTripKeyResult,
  ImportTripKeyCommand,
  NativeDeviceIdentity,
  WrapTripKeyResult,
} from "@crewroll/contracts/native/protocol";

import {
  createInviteCode,
  createUuidV4,
  createUuidV7,
} from "../../domain/ids/random";
import type { ClockPort, RandomBytesPort } from "../../domain/ids/random";
import type { TripView } from "../../domain/trips/model";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { projectTrip } from "./projectTrip";
import type {
  AcceptedTripMutationResponsePort,
  CreateTripNativePort,
  TripApiPort,
  TripRecoveryPort,
  TripRecoveryRecord,
  TripRecoveryScope,
} from "./ports";

type CreateOutcomePolicy = "RETAIN_UNKNOWN";

const createOutcomePolicy = {
  AUTH_REQUIRED: "RETAIN_UNKNOWN",
  AUTH_INVALID: "RETAIN_UNKNOWN",
  DEVICE_NOT_OWNED: "RETAIN_UNKNOWN",
  DEVICE_REVOKED: "RETAIN_UNKNOWN",
  DEVICE_NOT_PARTICIPANT: "RETAIN_UNKNOWN",
  INSTALLATION_OWNED_BY_ANOTHER_USER: "RETAIN_UNKNOWN",
  IDEMPOTENCY_CONFLICT: "RETAIN_UNKNOWN",
  INVALID_REQUEST: "RETAIN_UNKNOWN",
  RATE_LIMITED: "RETAIN_UNKNOWN",
  ACTIVE_TRIP_EXISTS: "RETAIN_UNKNOWN",
  TRIP_ID_CONFLICT: "RETAIN_UNKNOWN",
  TRIP_DURATION_INVALID: "RETAIN_UNKNOWN",
  INVITE_CODE_CONFLICT: "RETAIN_UNKNOWN",
  TRIP_FULL: "RETAIN_UNKNOWN",
  INVITE_INVALID: "RETAIN_UNKNOWN",
  TRIP_OWNER_REQUIRED: "RETAIN_UNKNOWN",
  MEMBERSHIP_FROZEN: "RETAIN_UNKNOWN",
  PENDING_JOIN_REQUESTS: "RETAIN_UNKNOWN",
  KEY_ENVELOPE_MISSING: "RETAIN_UNKNOWN",
  KEY_ENVELOPE_INVALID: "RETAIN_UNKNOWN",
  PHOTO_LIBRARY_ACCESS_REQUIRED: "RETAIN_UNKNOWN",
  TRIP_STATE_CONFLICT: "RETAIN_UNKNOWN",
  VERSION_CONFLICT: "RETAIN_UNKNOWN",
  UPLOAD_EXPIRED: "RETAIN_UNKNOWN",
  OBJECT_MISMATCH: "RETAIN_UNKNOWN",
  CURSOR_EXPIRED: "RETAIN_UNKNOWN",
  NOT_FOUND: "RETAIN_UNKNOWN",
  CONFLICT: "RETAIN_UNKNOWN",
  INTERNAL_ERROR: "RETAIN_UNKNOWN",
} as const satisfies Record<ProblemCode, CreateOutcomePolicy>;

export class TripTransportProblem extends Error {
  readonly kind = "TRANSPORT_UNAVAILABLE";

  constructor() {
    super("TRANSPORT_UNAVAILABLE");
    this.name = "TripTransportProblem";
  }
}

export class CreateTripTerminalProblem extends Error {
  readonly kind = "CREATE_TERMINAL";

  constructor() {
    super("CREATE_TERMINAL");
    this.name = "CreateTripTerminalProblem";
  }
}

export type CreateImmediateTripInput = Readonly<{
  name: string;
  endsAt: string;
}>;

export type CreateImmediateTripDependencies = Readonly<{
  afterAccepted: AcceptedTripMutationResponsePort;
  api: TripApiPort;
  clock: ClockPort;
  device: Readonly<{
    deviceId: string;
    identity: NativeDeviceIdentity;
  }>;
  native: CreateTripNativePort;
  random: RandomBytesPort;
  recoveryStore: TripRecoveryPort;
  scope: TripRecoveryScope;
}>;

type PreparedTrip = Readonly<{
  importCommand: ImportTripKeyCommand;
  view: TripView;
}>;

type ValidatedCreateInput = Readonly<{
  name: string;
  endsAt: string;
}>;

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
}

function envelopeProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("KEY_ENVELOPE_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC_3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const TRIP_NAME_PATTERN =
  /^(?:(?:[\uD800-\uDBFF][\uDC00-\uDFFF])|[^\uD800-\uDFFF]){1,80}$/;
const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const X25519_PUBLIC_KEY_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/;
const WRAPPED_KEY_PATTERN = /^(?:[A-Za-z0-9+/]{4}){49}[A-Za-z0-9+/][AQgw]==$/;

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.getOwnPropertyNames(value);
  return (
    actual.length === expected.length &&
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "membershipId",
      "role",
      "displayName",
      "status",
      "readiness",
      "nominatedDevice",
    ]) ||
    !isUuid(value.membershipId) ||
    (value.role !== "OWNER" && value.role !== "MEMBER") ||
    typeof value.displayName !== "string" ||
    value.displayName.length < 1 ||
    value.displayName.length > 80 ||
    (value.status !== "PENDING_KEY" && value.status !== "ACTIVE") ||
    !isRecord(value.readiness) ||
    !hasExactKeys(value.readiness, ["fullPhotoLibraryAccess"]) ||
    typeof value.readiness.fullPhotoLibraryAccess !== "boolean"
  ) {
    return false;
  }
  return (
    value.nominatedDevice === null || isNominatedDevice(value.nominatedDevice)
  );
}

function isTripResponse(value: unknown): value is TripResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    !isTripId(value.id) ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    typeof value.name !== "string" ||
    !TRIP_NAME_PATTERN.test(value.name) ||
    ![
      "LOBBY",
      "ACTIVE",
      "ENDING",
      "COMPLETE",
      "INCOMPLETE_EXPIRED",
      "CANCELLED",
    ].includes(value.status as string) ||
    !isRelease(value.release) ||
    !(value.startsAt === null || isRfc3339DateTime(value.startsAt)) ||
    !isRfc3339DateTime(value.endsAt) ||
    !isUuid(value.ownerDeviceId) ||
    !isUuid(value.currentMembershipId) ||
    value.keyEpoch !== 1 ||
    !(value.tripKeyEnvelope === null || isKeyEnvelope(value.tripKeyEnvelope)) ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 10 ||
    !value.members.every(isTripMember)
  ) {
    return false;
  }
  return true;
}

function isCreateTripKeyResult(value: unknown): value is CreateTripKeyResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["protocolVersion", "tripId", "keyEpoch"]) &&
    value.protocolVersion === 1 &&
    isTripId(value.tripId) &&
    value.keyEpoch === 1
  );
}

function isWrapTripKeyResult(value: unknown): value is WrapTripKeyResult {
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
}

function isCreateTripBody(value: unknown): value is CreateTripBody {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "tripId",
      "name",
      "inviteCode",
      "release",
      "endsAt",
      "ownerDeviceId",
      "ownerKeyEnvelope",
    ]) &&
    isTripId(value.tripId) &&
    typeof value.name === "string" &&
    TRIP_NAME_PATTERN.test(value.name) &&
    typeof value.inviteCode === "string" &&
    INVITE_CODE_PATTERN.test(value.inviteCode) &&
    isRelease(value.release) &&
    isRfc3339DateTime(value.endsAt) &&
    isUuid(value.ownerDeviceId) &&
    isKeyEnvelope(value.ownerKeyEnvelope)
  );
}

function isCreateTripOutcomeResponse(
  value: unknown,
): value is CreateTripOutcomeResponse {
  if (!isRecord(value) || typeof value.outcome !== "string") return false;
  switch (value.outcome) {
    case "COMMITTED":
      return (
        hasExactKeys(value, ["outcome", "trip"]) && isTripResponse(value.trip)
      );
    case "TERMINAL_NOT_COMMITTED":
    case "STILL_UNKNOWN":
      return hasExactKeys(value, ["outcome"]);
    default:
      return false;
  }
}

function passesValidation<T>(
  value: unknown,
  validate: (candidate: unknown) => candidate is T,
): value is T {
  try {
    return validate(value);
  } catch {
    return false;
  }
}

function validateCreateInput(
  input: CreateImmediateTripInput,
  now: number,
): ValidatedCreateInput | null {
  if (!Number.isFinite(now)) return null;
  const name = input.name.trim();
  const endsAtMilliseconds = Date.parse(input.endsAt);
  if (
    !TRIP_NAME_PATTERN.test(name) ||
    !isRfc3339DateTime(input.endsAt) ||
    !Number.isFinite(endsAtMilliseconds) ||
    endsAtMilliseconds <= now
  ) {
    return null;
  }
  return Object.freeze({ name, endsAt: input.endsAt });
}

function apiProblemCode(error: unknown): ProblemCode | null {
  if (!isRecord(error) || error.kind !== "API_PROBLEM") return null;
  const code = error.code;
  return typeof code === "string" && Object.hasOwn(createOutcomePolicy, code)
    ? (code as ProblemCode)
    : null;
}

function isTransportProblem(error: unknown): boolean {
  return isRecord(error) && error.kind === "TRANSPORT_UNAVAILABLE";
}

function sanitizeApiFailure(error: unknown): Error {
  const code = apiProblemCode(error);
  if (code !== null) {
    switch (createOutcomePolicy[code]) {
      case "RETAIN_UNKNOWN":
        return new CrewRollApiProblem(code);
    }
  }
  if (isTransportProblem(error)) return new TripTransportProblem();
  return internalProblem();
}

function frozenCreateBody(
  input: CreateImmediateTripInput,
  tripId: string,
  inviteCode: string,
  deviceId: string,
  wrappedKey: string,
): CreateTripBody {
  return Object.freeze({
    tripId,
    name: input.name,
    inviteCode,
    release: Object.freeze({ mode: "IMMEDIATE" as const }),
    endsAt: input.endsAt,
    ownerDeviceId: deviceId,
    ownerKeyEnvelope: Object.freeze({
      keyEpoch: 1 as const,
      algorithmVersion: 1 as const,
      wrappedKey,
    }),
  });
}

function prepareTrip(
  response: TripResponse,
  expectedTripId: string,
  device: CreateImmediateTripDependencies["device"],
): PreparedTrip {
  if (!passesValidation(response, isTripResponse)) throw internalProblem();
  if (
    response.id !== expectedTripId ||
    response.ownerDeviceId !== device.deviceId
  ) {
    throw internalProblem();
  }

  const currentMember = response.members.find(
    (member) => member.membershipId === response.currentMembershipId,
  );
  const nominatedDevice = currentMember?.nominatedDevice;
  if (
    currentMember?.role !== "OWNER" ||
    currentMember.status !== "ACTIVE" ||
    nominatedDevice === null ||
    nominatedDevice === undefined ||
    nominatedDevice.deviceId !== device.deviceId ||
    nominatedDevice.e2eeKeyAlgorithm !== "X25519" ||
    nominatedDevice.e2eePublicKey !== device.identity.e2eePublicKey ||
    nominatedDevice.e2eeKeyVersion !== device.identity.e2eeKeyVersion
  ) {
    throw internalProblem();
  }

  const envelope = response.tripKeyEnvelope;
  if (envelope === null) {
    throw new CrewRollApiProblem("KEY_ENVELOPE_MISSING");
  }

  let view: TripView;
  try {
    view = projectTrip(response, device.deviceId);
  } catch {
    throw internalProblem();
  }

  return {
    view,
    importCommand: {
      protocolVersion: 1,
      tripId: response.id,
      keyEpoch: envelope.keyEpoch,
      algorithmVersion: envelope.algorithmVersion,
      expectedSenderDeviceId: response.ownerDeviceId,
      recipientDeviceId: device.deviceId,
      recipientE2eeKeyVersion: nominatedDevice.e2eeKeyVersion,
      wrappedKey: envelope.wrappedKey,
    },
  };
}

function confirmedRecord(
  response: TripResponse,
  ownerInviteCode: string,
): TripRecoveryRecord {
  return {
    state: "CONFIRMED",
    tripId: response.id,
    membershipId: response.currentMembershipId,
    ownerInviteCode,
  };
}

function unreachableOutcome(_outcome: never): never {
  throw internalProblem();
}

export function createCreateImmediateTrip(
  dependencies: CreateImmediateTripDependencies,
) {
  const {
    afterAccepted,
    api,
    clock,
    device,
    native,
    random,
    recoveryStore,
    scope,
  } = dependencies;

  async function cleanLocalAttempt(tripId: string): Promise<void> {
    try {
      await native.discardProvisionalTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
      });
      await recoveryStore.clear(scope);
    } catch {
      throw internalProblem();
    }
  }

  async function finishCommitted(
    response: TripResponse,
    expectedTripId: string,
    ownerInviteCode: string,
  ): Promise<TripView> {
    const prepared = prepareTrip(response, expectedTripId, device);
    try {
      await recoveryStore.save(
        scope,
        confirmedRecord(response, ownerInviteCode),
      );
    } catch {
      throw internalProblem();
    }

    try {
      await native.importTripKey(prepared.importCommand);
    } catch {
      throw envelopeProblem();
    }
    return prepared.view;
  }

  async function acceptedCreateAttempt(
    commandId: string,
    body: CreateTripBody,
    expectedTripId: string,
  ): Promise<TripResponse> {
    const response = await api.createTrip(device.deviceId, commandId, body);
    prepareTrip(response, expectedTripId, device);
    await afterAccepted.afterAccepted({ kind: "CREATE", commandId });
    return response;
  }

  async function create(input: CreateImmediateTripInput): Promise<TripView> {
    let validatedInput: ValidatedCreateInput | null;
    try {
      validatedInput = validateCreateInput(input, clock.now());
    } catch {
      throw internalProblem();
    }
    if (validatedInput === null) {
      throw new CrewRollApiProblem("INVALID_REQUEST");
    }

    let tripId: string;
    let commandId: string;
    let ownerInviteCode: string;
    try {
      tripId = await createUuidV7(clock, random);
      commandId = await createUuidV4(random);
      ownerInviteCode = await createInviteCode(random);
      await recoveryStore.save(scope, {
        state: "UNKNOWN_CREATE",
        tripId,
        commandId,
        ownerInviteCode,
      });
    } catch {
      throw internalProblem();
    }

    let createdKey: unknown;
    try {
      createdKey = await native.createTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
      });
    } catch {
      await cleanLocalAttempt(tripId);
      throw internalProblem();
    }
    if (
      !passesValidation(createdKey, isCreateTripKeyResult) ||
      createdKey.tripId !== tripId
    ) {
      await cleanLocalAttempt(tripId);
      throw envelopeProblem();
    }

    let wrap: unknown;
    try {
      wrap = await native.wrapTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
        recipientDeviceId: device.deviceId,
        recipientE2eePublicKey: device.identity.e2eePublicKey,
        recipientE2eeKeyVersion: device.identity.e2eeKeyVersion,
      });
    } catch {
      await cleanLocalAttempt(tripId);
      throw envelopeProblem();
    }
    if (
      !passesValidation(wrap, isWrapTripKeyResult) ||
      wrap.protocolVersion !== 1 ||
      wrap.tripId !== tripId ||
      wrap.keyEpoch !== 1 ||
      wrap.algorithmVersion !== 1 ||
      wrap.senderDeviceId !== device.deviceId ||
      wrap.recipientDeviceId !== device.deviceId ||
      wrap.recipientE2eeKeyVersion !== device.identity.e2eeKeyVersion
    ) {
      await cleanLocalAttempt(tripId);
      throw envelopeProblem();
    }

    const body = frozenCreateBody(
      validatedInput,
      tripId,
      ownerInviteCode,
      device.deviceId,
      wrap.wrappedKey,
    );
    if (!passesValidation(body, isCreateTripBody)) {
      await cleanLocalAttempt(tripId);
      throw new CrewRollApiProblem("INVALID_REQUEST");
    }

    let response: TripResponse;
    try {
      response = await acceptedCreateAttempt(commandId, body, tripId);
    } catch (firstError) {
      if (!isTransportProblem(firstError)) {
        throw sanitizeApiFailure(firstError);
      }
      try {
        response = await acceptedCreateAttempt(commandId, body, tripId);
      } catch (secondError) {
        throw sanitizeApiFailure(secondError);
      }
    }

    return finishCommitted(response, tripId, ownerInviteCode);
  }

  async function reconcileUnknownCreate(): Promise<TripView | "STILL_UNKNOWN"> {
    let record: TripRecoveryRecord | null;
    try {
      record = await recoveryStore.load(scope);
    } catch {
      throw internalProblem();
    }
    if (record?.state !== "UNKNOWN_CREATE") throw internalProblem();

    let outcome: unknown;
    try {
      outcome = await api.resolveCreateTripOutcome(
        device.deviceId,
        record.commandId,
        { tripId: record.tripId },
      );
    } catch (error) {
      throw sanitizeApiFailure(error);
    }
    if (!passesValidation(outcome, isCreateTripOutcomeResponse)) {
      throw internalProblem();
    }

    switch (outcome.outcome) {
      case "STILL_UNKNOWN":
        return "STILL_UNKNOWN";
      case "TERMINAL_NOT_COMMITTED":
        await cleanLocalAttempt(record.tripId);
        throw new CreateTripTerminalProblem();
      case "COMMITTED":
        return finishCommitted(
          outcome.trip,
          record.tripId,
          record.ownerInviteCode,
        );
      default:
        return unreachableOutcome(outcome);
    }
  }

  return Object.freeze({ create, reconcileUnknownCreate });
}
