import type { ProblemCode, TripResponse } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";

import type { TripView } from "../../domain/trips/model";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { userFacingProblems } from "../problems/userFacingProblem";
import { isClosedTripResponse } from "./ApproveMember";
import { TripTransportProblem } from "./CreateImmediateTrip";
import type { HydrateTripNativePort, TripApiPort } from "./ports";
import { projectTrip } from "./projectTrip";

export type HydrateTripDependencies = Readonly<{
  api: TripApiPort;
  device: Readonly<{
    deviceId: string;
    identity: NativeDeviceIdentity;
  }>;
  native: HydrateTripNativePort;
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

function envelopeProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("KEY_ENVELOPE_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isTripId(value: unknown): value is string {
  return typeof value === "string" && TRIP_ID_PATTERN.test(value);
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

function safelyProject(response: TripResponse, deviceId: string): TripView {
  try {
    return projectTrip(response, deviceId);
  } catch {
    throw internalProblem();
  }
}

export function createHydrateTrip(dependencies: HydrateTripDependencies) {
  const { api, device, native } = dependencies;

  async function hydrate(tripId: string): Promise<TripView> {
    if (!isTripId(tripId)) {
      throw new CrewRollApiProblem("INVALID_REQUEST");
    }
    if (!isUuid(device.deviceId) || !hasValidLocalKeyContext(device.identity)) {
      throw internalProblem();
    }

    let response: TripResponse;
    try {
      response = await api.getTrip(device.deviceId, tripId);
    } catch (error) {
      throw sanitizeApiFailure(error);
    }

    if (!isClosedTripResponse(response) || response.id !== tripId) {
      throw internalProblem();
    }
    const currentMembers = response.members.filter(
      (member) => member.membershipId === response.currentMembershipId,
    );
    const currentMember = currentMembers[0];
    const nomination = currentMember?.nominatedDevice;
    if (
      currentMembers.length !== 1 ||
      currentMember === undefined ||
      nomination === null ||
      nomination === undefined ||
      nomination.deviceId !== device.deviceId ||
      nomination.e2eeKeyAlgorithm !== "X25519" ||
      nomination.e2eePublicKey !== device.identity.e2eePublicKey ||
      nomination.e2eeKeyVersion !== device.identity.e2eeKeyVersion
    ) {
      throw internalProblem();
    }

    const envelope = response.tripKeyEnvelope;
    if (currentMember.status === "PENDING_KEY") {
      if (envelope !== null) throw envelopeProblem();
      return safelyProject(response, device.deviceId);
    }
    if (envelope === null) {
      throw new CrewRollApiProblem("KEY_ENVELOPE_MISSING");
    }

    try {
      await native.importTripKey(
        Object.freeze({
          protocolVersion: 1,
          tripId: response.id,
          keyEpoch: envelope.keyEpoch,
          algorithmVersion: envelope.algorithmVersion,
          expectedSenderDeviceId: response.ownerDeviceId,
          recipientDeviceId: device.deviceId,
          recipientE2eeKeyVersion: nomination.e2eeKeyVersion,
          wrappedKey: envelope.wrappedKey,
        }),
      );
    } catch {
      throw envelopeProblem();
    }

    return safelyProject(response, device.deviceId);
  }

  return Object.freeze({ hydrate });
}
