import type { DeviceResponse, RegisterDeviceBody } from "@crewroll/contracts";
import type {
  NativeDeviceIdentity,
  RestoreDeviceSessionCommand,
  RestoredDeviceSession,
} from "@crewroll/contracts/native/protocol";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import type { DeviceRegistrationPort } from "./ports";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

type DevicePlatform = "android" | "ios";

export type ProvisionCurrentDeviceInput = Readonly<{
  accountId: string;
  apiBaseUrl: string;
  appVersion: string | null | undefined;
  platform: string;
}>;

export type ProvisionedDevice = Readonly<{
  deviceId: string;
  identity: NativeDeviceIdentity;
}>;

type EnsureDeviceIdentityCommand = Readonly<{
  protocolVersion: 1;
  accountId: string;
}>;

type InstallDeviceSessionCommand = Readonly<{
  protocolVersion: 1;
  accountId: string;
  installationId: string;
  deviceId: string;
  backgroundBearer: string;
  backgroundBearerExpiresAt: string;
  apiBaseUrl: string;
}>;

export interface ProvisioningNativePort {
  restoreDeviceSession?(
    command: RestoreDeviceSessionCommand,
  ): Promise<RestoredDeviceSession>;
  ensureDeviceIdentity(
    command: EnsureDeviceIdentityCommand,
  ): Promise<NativeDeviceIdentity>;
  installDeviceSession(command: InstallDeviceSessionCommand): Promise<void>;
}

export type ProvisionCurrentDeviceDependencies = Readonly<{
  native: ProvisioningNativePort;
  random: RandomBytesPort;
  registration: DeviceRegistrationPort;
}>;

type ProvisioningContext = Readonly<{
  accountId: string;
  apiBaseUrl: string;
  appVersion: string;
  platform: DevicePlatform;
}>;

type PendingAttempt = {
  commandId: string;
  readonly context: ProvisioningContext;
  identity?: NativeDeviceIdentity;
  registrationBody?: RegisterDeviceBody;
  response?: DeviceResponse;
};

function invalidRequest(): CrewRollApiProblem {
  return new CrewRollApiProblem("INVALID_REQUEST");
}

function isSupportedPlatform(value: string): value is DevicePlatform {
  return value === "android" || value === "ios";
}

function parseContext(input: ProvisionCurrentDeviceInput): ProvisioningContext {
  const appVersion = input.appVersion;
  if (
    input.accountId.length < 1 ||
    input.accountId.length > 255 ||
    !ACCOUNT_ID_PATTERN.test(input.accountId) ||
    !isSupportedPlatform(input.platform) ||
    typeof appVersion !== "string" ||
    appVersion.length > 128 ||
    !APP_VERSION_PATTERN.test(appVersion)
  ) {
    throw invalidRequest();
  }

  try {
    if (new URL(input.apiBaseUrl).protocol.length <= 1) {
      throw invalidRequest();
    }
  } catch {
    throw invalidRequest();
  }

  return {
    accountId: input.accountId,
    apiBaseUrl: input.apiBaseUrl,
    appVersion,
    platform: input.platform,
  };
}

function sameContext(
  left: ProvisioningContext,
  right: ProvisioningContext,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.apiBaseUrl === right.apiBaseUrl &&
    left.appVersion === right.appVersion &&
    left.platform === right.platform
  );
}

function registrationBody(
  identity: NativeDeviceIdentity,
  context: ProvisioningContext,
): RegisterDeviceBody {
  return {
    installationId: identity.installationId,
    platform: context.platform,
    authenticationKeyAlgorithm: identity.authenticationKeyAlgorithm,
    authenticationPublicKey: identity.authenticationPublicKey,
    authenticationKeyVersion: identity.authenticationKeyVersion,
    e2eeKeyAlgorithm: identity.e2eeKeyAlgorithm,
    e2eePublicKey: identity.e2eePublicKey,
    e2eeKeyVersion: identity.e2eeKeyVersion,
    appVersion: context.appVersion,
  };
}

export function createProvisionCurrentDevice({
  native,
  random,
  registration,
}: ProvisionCurrentDeviceDependencies) {
  let pendingAttempt: PendingAttempt | undefined;
  const inFlight = new Map<string, Promise<ProvisionedDevice>>();

  async function provision(
    context: ProvisioningContext,
  ): Promise<ProvisionedDevice> {
    let attempt = pendingAttempt;

    if (attempt === undefined || !sameContext(attempt.context, context)) {
      attempt = {
        commandId: await createUuidV4(random),
        context,
      };
      pendingAttempt = attempt;
    }

    if (attempt.identity === undefined) {
      attempt.identity = await native.ensureDeviceIdentity({
        protocolVersion: 1,
        accountId: context.accountId,
      });
    }

    const identity = attempt.identity;
    const restored = await native.restoreDeviceSession?.({
      protocolVersion: 1,
      accountId: context.accountId,
      installationId: identity.installationId,
      apiBaseUrl: context.apiBaseUrl,
    });
    if (restored) {
      if (pendingAttempt === attempt) pendingAttempt = undefined;
      return { deviceId: restored.deviceId, identity };
    }
    attempt.registrationBody ??= registrationBody(identity, context);
    if (
      attempt.response &&
      new Date(attempt.response.backgroundBearerExpiresAt).getTime() <=
        Date.now() + 300_000
    ) {
      // A long-delayed native install retry must obtain a fresh credential,
      // rather than replaying the old idempotency response indefinitely.
      attempt.commandId = await createUuidV4(random);
      delete attempt.response;
    }
    const response = (attempt.response ??= await registration.registerDevice(
      attempt.commandId,
      attempt.registrationBody,
    ));

    await native.installDeviceSession({
      protocolVersion: 1,
      accountId: context.accountId,
      installationId: identity.installationId,
      deviceId: response.deviceId,
      backgroundBearer: response.backgroundBearer,
      backgroundBearerExpiresAt: response.backgroundBearerExpiresAt,
      apiBaseUrl: context.apiBaseUrl,
    });

    if (pendingAttempt === attempt) pendingAttempt = undefined;
    return { deviceId: response.deviceId, identity };
  }

  return async function provisionCurrentDevice(
    input: ProvisionCurrentDeviceInput,
  ): Promise<ProvisionedDevice> {
    const context = parseContext(input);
    const key = JSON.stringify(context);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = provision(context);
    inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }
  };
}
