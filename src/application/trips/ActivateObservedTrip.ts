import type { ProblemCode, TripResponse } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";

import type { TripView } from "../../domain/trips/model";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { isClosedTripResponse } from "./ApproveMember";
import type { ActiveTripNativePort } from "./ports";
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
  ) {
    super(code);
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
      response.status !== "ACTIVE" ||
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
      throw new TripActivationFailed("KEY_ENVELOPE_MISSING", view);
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
      throw new TripActivationFailed(envelopeProblem().code, view);
    }

    try {
      await native.activateTrip(
        Object.freeze({
          protocolVersion: 1,
          tripId: response.id,
          membershipId: response.currentMembershipId,
          startsAt: response.startsAt,
          endsAt: response.endsAt,
          releaseAt: null,
          keyEpoch: 1,
        }),
      );
    } catch {
      throw new TripActivationFailed(internalProblem().code, view);
    }

    return view;
  }

  return Object.freeze({ activateObserved });
}
