import type { ProblemCode, TripResponse } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";

import type { TripView } from "../../domain/trips/model";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import {
  nativeLocalKeyFailure,
  type NativeLocalKeyFailure,
} from "../problems/nativeLocalKeyFailure";
import { isClosedTripResponse } from "./ApproveMember";
import {
  ImportedTripActivationFailed,
  type ActiveTripNativePort,
} from "./ports";
import { projectTrip } from "./projectTrip";

export type ActivateObservedTripDependencies = Readonly<{
  device: Readonly<{
    deviceId: string;
    identity: NativeDeviceIdentity;
  }>;
  native: ActiveTripNativePort;
}>;

export class TripActivationFailed extends CrewRollApiProblem {
  constructor(
    code: ProblemCode,
    readonly trip: TripView,
    readonly localKeyFailure?: NativeLocalKeyFailure,
  ) {
    super(code);
    Object.defineProperty(this, "localKeyFailure", {
      configurable: false,
      enumerable: false,
      value: localKeyFailure,
      writable: false,
    });
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "TripActivationFailed",
      writable: true,
    });
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const X25519_PUBLIC_KEY_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/;

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
}

function envelopeProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("KEY_ENVELOPE_INVALID");
}

type ActivationStage =
  | "envelope"
  | "album-capability"
  | "album-command"
  | "composite-capability"
  | "composite-command"
  | "import-key"
  | "activation";

const activationErrorCodes = new Set([
  "ERR_ARGUMENT_CAST",
  "ERR_INVALID_ARGS_NUMBER",
  "ERR_INCOMPATIBLE_ARG_TYPE",
  "ERR_NULL_ARGUMENT",
  "ERR_FUNCTION_CALL",
  "ERR_UNEXPECTED",
  "ERR_COLLECTION_ELEMENT_CAST",
  "ERR_DYNAMIC_CAST",
  "ERR_METHOD_NOT_FOUND",
  "ERR_CREWROLL_NATIVE_PROTOCOL",
  "ERR_CREWROLL_TRIP_ACTIVATION",
  "KEY_ACCESS_LOCKED",
  "KEY_MATERIAL_LOST",
  "KEY_ENVELOPE_INVALID",
  "KEY_ENVELOPE_MISSING",
]);
const activationBoundaryOperations = new Set([
  "importAndActivateTripWithAlbum capability",
  "importAndActivateTripWithAlbum data",
  "importAndActivateTripWithAlbum command",
  "importAndActivateTripWithAlbum context",
  "importAndActivateTripWithAlbum result",
  "importAndActivateTrip capability",
  "importAndActivateTrip command",
  "importAndActivateTrip context",
  "importAndActivateTrip result",
  "importTripKey command",
  "activateTrip command",
]);

/** Failure telemetry is a closed vocabulary and never includes command data. */
function reportActivationFailure(stage: ActivationStage, error: unknown) {
  let code = "UNKNOWN";
  let operation = "UNKNOWN";
  let errorKind = "OTHER";
  let messageClass = "OTHER";
  try {
    errorKind =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof Error
            ? "Error"
            : "OTHER";
    if (error instanceof Error) {
      const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
      if (typeof message === "string") {
        if (/\bnull\b.*\bexpected\b.*\bobject\b/i.test(message))
          messageClass = "NULL_EXPECTED_OBJECT";
        else if (/read.?only|not writable|not extensible/i.test(message))
          messageClass = "READ_ONLY_MUTATION";
      }
    }
    if (error instanceof ImportedTripActivationFailed) {
      code = "ERR_CREWROLL_TRIP_ACTIVATION";
    } else if (error instanceof Error) {
      const candidate = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (typeof candidate === "string" && activationErrorCodes.has(candidate))
        code = candidate;
      if (
        Object.getOwnPropertyDescriptor(error, "message")?.value ===
        "Native session ended"
      )
        code = "NATIVE_SESSION_ENDED";
      const boundary = Object.getOwnPropertyDescriptor(
        error,
        "operation",
      )?.value;
      if (
        code === "ERR_CREWROLL_NATIVE_PROTOCOL" &&
        typeof boundary === "string" &&
        activationBoundaryOperations.has(boundary)
      )
        operation = boundary;
    }
  } catch {
    // Exotic errors cannot expand the finite diagnostic payload.
  }
  try {
    console.warn(
      JSON.stringify({
        event: "trip_activation_failed",
        stage,
        code,
        operation,
        errorKind,
        messageClass,
      }),
    );
  } catch {
    // Diagnostics must preserve the original failure and retry behavior.
  }
}

function hasValidLocalKeyContext(
  deviceId: string,
  identity: NativeDeviceIdentity,
): boolean {
  try {
    return (
      UUID_PATTERN.test(deviceId) &&
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

export function createActivateObservedTrip(
  dependencies: ActivateObservedTripDependencies,
) {
  const { device, native } = dependencies;

  async function activateObserved(response: TripResponse): Promise<TripView> {
    if (
      !hasValidLocalKeyContext(device.deviceId, device.identity) ||
      !isClosedTripResponse(response) ||
      (response.status !== "ACTIVE" && response.status !== "ENDING") ||
      response.release.mode !== "IMMEDIATE" ||
      response.startsAt === null
    ) {
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
      currentMember.status !== "ACTIVE" ||
      nomination === null ||
      nomination === undefined ||
      nomination.deviceId !== device.deviceId ||
      nomination.e2eeKeyAlgorithm !== "X25519" ||
      nomination.e2eePublicKey !== device.identity.e2eePublicKey ||
      nomination.e2eeKeyVersion !== device.identity.e2eeKeyVersion
    ) {
      throw internalProblem();
    }

    const view = safelyProject(response, device.deviceId);
    const envelope = response.tripKeyEnvelope;
    if (envelope === null) {
      const failure = new TripActivationFailed("KEY_ENVELOPE_MISSING", view);
      reportActivationFailure("envelope", failure);
      throw failure;
    }

    const imported = Object.freeze({
      protocolVersion: 1,
      tripId: response.id,
      keyEpoch: envelope.keyEpoch,
      algorithmVersion: envelope.algorithmVersion,
      expectedSenderDeviceId: envelope.senderDeviceId ?? response.ownerDeviceId,
      recipientDeviceId: device.deviceId,
      recipientE2eeKeyVersion: nomination.e2eeKeyVersion,
      endsAt: response.endsAt,
      wrappedKey: envelope.wrappedKey,
    } as const);
    const activation = Object.freeze({
      protocolVersion: 1,
      tripId: response.id,
      membershipId: response.currentMembershipId,
      startsAt: response.startsAt,
      endsAt: response.endsAt,
      releaseAt: null,
      keyEpoch: 1,
    } as const);

    let stage: ActivationStage = "album-capability";
    try {
      const withAlbum = native.importAndActivateTripWithAlbum;
      if (withAlbum !== undefined) {
        stage = "album-command";
        await withAlbum.call(
          native,
          Object.freeze({
            protocolVersion: 1,
            envelope: imported,
            activation,
            album: Object.freeze({ tripName: response.name }),
          }),
        );
        return view;
      }
      stage = "composite-capability";
      const combined = native.importAndActivateTrip;
      if (combined !== undefined) {
        stage = "composite-command";
        await combined.call(
          native,
          Object.freeze({
            protocolVersion: 1,
            envelope: imported,
            activation,
          }),
        );
        return view;
      }
      stage = "import-key";
      await native.importTripKey(imported);
    } catch (error) {
      reportActivationFailure(stage, error);
      if (error instanceof ImportedTripActivationFailed)
        throw new TripActivationFailed(internalProblem().code, view);
      throw new TripActivationFailed(
        envelopeProblem().code,
        view,
        nativeLocalKeyFailure(error),
      );
    }

    try {
      await native.activateTrip(activation);
    } catch (error) {
      reportActivationFailure("activation", error);
      throw new TripActivationFailed(
        internalProblem().code,
        view,
        nativeLocalKeyFailure(error),
      );
    }

    return view;
  }

  return Object.freeze({ activateObserved });
}
