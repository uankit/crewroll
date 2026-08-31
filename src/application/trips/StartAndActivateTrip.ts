import type { ProblemCode, TripResponse } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import type { MemberView, TripView } from "../../domain/trips/model";
import { startBlockerFor } from "../../domain/trips/startEligibility";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { userFacingProblems } from "../problems/userFacingProblem";
import { createActivateObservedTrip } from "./ActivateObservedTrip";
import { TripTransportProblem } from "./CreateImmediateTrip";
import type { ActiveTripNativePort, TripApiPort } from "./ports";

export type StartAndActivateTripDependencies = Readonly<{
  api: TripApiPort;
  device: Readonly<{
    deviceId: string;
    identity: NativeDeviceIdentity;
  }>;
  native: ActiveTripNativePort;
  random: RandomBytesPort;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const X25519_PUBLIC_KEY_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/;

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isValidMember(member: MemberView): boolean {
  try {
    return (
      isUuid(member.membershipId) &&
      (member.role === "OWNER" || member.role === "MEMBER") &&
      typeof member.displayName === "string" &&
      member.displayName.length > 0 &&
      (member.status === "ACTIVE" || member.status === "PENDING_KEY") &&
      typeof member.fullPhotoLibraryAccess === "boolean" &&
      (member.deviceState === "AVAILABLE" ||
        member.deviceState === "MISSING" ||
        member.deviceState === "NOT_DISCLOSED") &&
      typeof member.isCurrentMember === "boolean"
    );
  } catch {
    return false;
  }
}

function isValidStartView(trip: TripView): boolean {
  try {
    if (
      !TRIP_ID_PATTERN.test(trip.id) ||
      !Number.isInteger(trip.version) ||
      trip.version < 1 ||
      !isUuid(trip.ownerDeviceId) ||
      !isUuid(trip.currentMembershipId) ||
      trip.release.mode !== "IMMEDIATE" ||
      !Array.isArray(trip.members) ||
      trip.members.length < 1 ||
      trip.members.length > 10 ||
      !trip.members.every(isValidMember)
    ) {
      return false;
    }
    const current = trip.members.filter(
      (member) =>
        member.membershipId === trip.currentMembershipId &&
        member.isCurrentMember,
    );
    return (
      current.length === 1 &&
      trip.members.filter((member) => member.isCurrentMember).length === 1
    );
  } catch {
    return false;
  }
}

function hasValidLocalKeyContext(
  deviceId: string,
  identity: NativeDeviceIdentity,
): boolean {
  try {
    return (
      isUuid(deviceId) &&
      identity.protocolVersion === 1 &&
      identity.e2eeKeyAlgorithm === "X25519" &&
      X25519_PUBLIC_KEY_PATTERN.test(identity.e2eePublicKey) &&
      identity.e2eeKeyVersion === 1
    );
  } catch {
    return false;
  }
}

function blockerProblem(trip: TripView): CrewRollApiProblem | null {
  let blocker: ReturnType<typeof startBlockerFor>;
  try {
    blocker = startBlockerFor(trip);
  } catch {
    return internalProblem();
  }
  switch (blocker) {
    case null:
      return null;
    case "OWNER_ONLY":
      return new CrewRollApiProblem("TRIP_OWNER_REQUIRED");
    case "NOT_LOBBY":
      return new CrewRollApiProblem("TRIP_STATE_CONFLICT");
    case "MEMBER_PENDING_KEY":
      return new CrewRollApiProblem("PENDING_JOIN_REQUESTS");
    case "MEMBER_NEEDS_FULL_ACCESS":
      return new CrewRollApiProblem("PHOTO_LIBRARY_ACCESS_REQUIRED");
    case "MEMBER_DEVICE_MISSING":
      return new CrewRollApiProblem("KEY_ENVELOPE_MISSING");
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

export function createStartAndActivateTrip(
  dependencies: StartAndActivateTripDependencies,
) {
  const { api, device, native, random } = dependencies;
  const observed = createActivateObservedTrip({ device, native });

  async function start(trip: TripView): Promise<TripView> {
    if (
      !isValidStartView(trip) ||
      !hasValidLocalKeyContext(device.deviceId, device.identity)
    ) {
      throw internalProblem();
    }
    const blocked = blockerProblem(trip);
    if (blocked !== null) throw blocked;
    if (trip.ownerDeviceId !== device.deviceId) throw internalProblem();

    let commandId: string;
    try {
      commandId = await createUuidV4(random);
    } catch {
      throw internalProblem();
    }

    let response: TripResponse;
    try {
      response = await api.startTrip(device.deviceId, commandId, trip.id, {
        expectedVersion: trip.version,
      });
    } catch (error) {
      throw sanitizeApiFailure(error);
    }
    try {
      if (
        response.id !== trip.id ||
        response.currentMembershipId !== trip.currentMembershipId ||
        response.ownerDeviceId !== trip.ownerDeviceId
      ) {
        throw internalProblem();
      }
    } catch {
      throw internalProblem();
    }

    return observed.activateObserved(response);
  }

  return Object.freeze({ start });
}
