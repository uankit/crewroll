import type { MembershipResponse, ProblemCode } from "@crewroll/contracts";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { userFacingProblems } from "../problems/userFacingProblem";
import { TripTransportProblem } from "./CreateImmediateTrip";
import type {
  AcceptedTripMutationResponsePort,
  TripApiPort,
  TripRecoveryPort,
  TripRecoveryRecord,
  TripRecoveryScope,
} from "./ports";

export type JoinTripResult =
  | Readonly<{
      tripId: string;
      membershipId: string;
      status: "ACTIVE" | "PENDING_KEY";
    }>
  | Readonly<{ status: "REJECTED" }>;

export type JoinTripDependencies = Readonly<{
  afterAccepted: AcceptedTripMutationResponsePort;
  api: TripApiPort;
  deviceId: string;
  random: RandomBytesPort;
  recoveryStore: TripRecoveryPort;
  scope: TripRecoveryScope;
}>;

const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WRAPPED_KEY_PATTERN = /^(?:[A-Za-z0-9+/]{4}){49}[A-Za-z0-9+/][AQgw]==$/;

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
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

function isEnvelope(
  value: unknown,
): value is Exclude<MembershipResponse["tripKeyEnvelope"], null> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["keyEpoch", "algorithmVersion", "wrappedKey"]) &&
    value.keyEpoch === 1 &&
    value.algorithmVersion === 1 &&
    typeof value.wrappedKey === "string" &&
    WRAPPED_KEY_PATTERN.test(value.wrappedKey)
  );
}

function isMembershipResponse(value: unknown): value is MembershipResponse {
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
    (value.status === "ACTIVE" ||
      value.status === "PENDING_KEY" ||
      value.status === "REJECTED") &&
    value.keyEpoch === 1 &&
    (value.tripKeyEnvelope === null || isEnvelope(value.tripKeyEnvelope))
  );
}

function isUnknownJoinRecord(
  value: unknown,
): value is Extract<TripRecoveryRecord, { state: "UNKNOWN_JOIN" }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["state", "inviteCode", "deviceId", "commandId"]) &&
    value.state === "UNKNOWN_JOIN" &&
    typeof value.inviteCode === "string" &&
    INVITE_CODE_PATTERN.test(value.inviteCode) &&
    isUuid(value.deviceId) &&
    isUuid(value.commandId)
  );
}

function normalizeInviteCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return INVITE_CODE_PATTERN.test(normalized) ? normalized : null;
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

function isTransportProblem(error: unknown): boolean {
  try {
    return isRecord(error) && error.kind === "TRANSPORT_UNAVAILABLE";
  } catch {
    return false;
  }
}

function sanitizeApiFailure(error: unknown): Error {
  const code = apiProblemCode(error);
  if (code !== null) return new CrewRollApiProblem(code);
  if (isTransportProblem(error)) return new TripTransportProblem();
  return internalProblem();
}

function validateScope(scope: TripRecoveryScope, deviceId: string): boolean {
  return (
    typeof scope.clerkSubject === "string" &&
    scope.clerkSubject.length > 0 &&
    isUuid(scope.deviceId) &&
    isUuid(deviceId) &&
    scope.deviceId === deviceId
  );
}

function passesValidation<T>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T,
): value is T {
  try {
    return validator(value);
  } catch {
    return false;
  }
}

export function createJoinTrip(dependencies: JoinTripDependencies) {
  const { afterAccepted, api, deviceId, random, recoveryStore, scope } =
    dependencies;

  async function finish(
    response: MembershipResponse,
    commandId: string,
  ): Promise<JoinTripResult> {
    if (
      !passesValidation(response, isMembershipResponse) ||
      response.deviceId !== deviceId
    ) {
      throw internalProblem();
    }

    try {
      await afterAccepted.afterAccepted({ kind: "JOIN", commandId });
    } catch (error) {
      throw sanitizeApiFailure(error);
    }

    if (response.status === "REJECTED") {
      try {
        await recoveryStore.clear(scope);
      } catch {
        throw internalProblem();
      }
      return Object.freeze({ status: "REJECTED" as const });
    }

    // Pending members cannot read the trip projection yet. Keep the original
    // command so polling/relaunch can read its current membership outcome
    // without consuming another invite use or creating a second join request.
    if (response.status === "ACTIVE") {
      try {
        await recoveryStore.save(scope, {
          state: "CONFIRMED",
          tripId: response.tripId,
          membershipId: response.membershipId,
        });
      } catch {
        throw internalProblem();
      }
    }

    return Object.freeze({
      tripId: response.tripId,
      membershipId: response.membershipId,
      status: response.status,
    });
  }

  async function execute(
    record: Extract<TripRecoveryRecord, { state: "UNKNOWN_JOIN" }>,
  ): Promise<JoinTripResult> {
    let response: MembershipResponse;
    try {
      response = await api.requestJoin(deviceId, record.commandId, {
        inviteCode: record.inviteCode,
        deviceId,
      });
    } catch (error) {
      throw sanitizeApiFailure(error);
    }
    return finish(response, record.commandId);
  }

  async function request(inviteCodeInput: string): Promise<JoinTripResult> {
    if (!validateScope(scope, deviceId)) throw internalProblem();
    const inviteCode = normalizeInviteCode(inviteCodeInput);
    if (inviteCode === null) {
      throw new CrewRollApiProblem("INVITE_INVALID");
    }

    let record: Extract<TripRecoveryRecord, { state: "UNKNOWN_JOIN" }>;
    try {
      const commandId = await createUuidV4(random);
      record = Object.freeze({
        state: "UNKNOWN_JOIN" as const,
        inviteCode,
        deviceId,
        commandId,
      });
      await recoveryStore.save(scope, record);
    } catch {
      throw internalProblem();
    }
    return execute(record);
  }

  async function replayUnknownJoin(): Promise<JoinTripResult | null> {
    if (!validateScope(scope, deviceId)) throw internalProblem();
    let record: TripRecoveryRecord | null;
    try {
      record = await recoveryStore.load(scope);
    } catch {
      throw internalProblem();
    }
    if (record === null) return null;
    if (
      !passesValidation(record, isUnknownJoinRecord) ||
      record.deviceId !== deviceId
    ) {
      throw internalProblem();
    }
    return execute(record);
  }

  return Object.freeze({ request, replayUnknownJoin });
}
