import type { DeviceResponse, RegisterDeviceBody } from "@crewroll/contracts";
import type {
  NativeDeviceIdentity,
  PrepareDeviceSessionCommand,
  PreparedDeviceSession,
  RestoreDeviceSessionCommand,
  RestoredDeviceSession,
} from "@crewroll/contracts/native/protocol";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import type { DeviceRegistrationPort } from "./ports";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
// Keep native restore and delayed install retries aligned with server renewal.
const BACKGROUND_CREDENTIAL_RENEWAL_WINDOW_MS = 7 * 86_400_000;

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
  /** Present only after account-scoped native preparation; absent on older binaries. */
  activeTripId?: string | null;
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
  prepareDeviceSession?:
    | ((command: PrepareDeviceSessionCommand) => Promise<PreparedDeviceSession>)
    | undefined;
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

export type DeviceRegistrationContext = Readonly<{
  accountId: string;
  apiBaseUrl: string;
  appVersion: string;
  platform: DevicePlatform;
}>;

type PendingAttempt = {
  commandId: string;
  readonly context: DeviceRegistrationContext;
  identity?: NativeDeviceIdentity;
  registrationBody?: RegisterDeviceBody;
  response?: DeviceResponse;
};

type RestorePreparation = Readonly<{
  identity: NativeDeviceIdentity;
  prepared?: PreparedDeviceSession;
  restored: RestoredDeviceSession;
}>;

function invalidRequest(): CrewRollApiProblem {
  return new CrewRollApiProblem("INVALID_REQUEST");
}

function isSupportedPlatform(value: string): value is DevicePlatform {
  return value === "android" || value === "ios";
}

export function parseDeviceRegistrationContext(
  input: ProvisionCurrentDeviceInput,
): DeviceRegistrationContext {
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
  left: DeviceRegistrationContext,
  right: DeviceRegistrationContext,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.apiBaseUrl === right.apiBaseUrl &&
    left.appVersion === right.appVersion &&
    left.platform === right.platform
  );
}

export function createDeviceRegistrationBody(
  identity: NativeDeviceIdentity,
  context: DeviceRegistrationContext,
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
  const restoring = new Map<string, Promise<ProvisionedDevice | null>>();
  // A restore miss may wait for account/profile consent before registration.
  // Reuse just this completed preparation once; later registration/install
  // retries still revalidate native identity through the original path.
  let preparedMiss:
    Readonly<{ key: string; value: RestorePreparation }> | undefined;

  async function restoreOnly(
    context: DeviceRegistrationContext,
  ): Promise<ProvisionedDevice | null> {
    const key = JSON.stringify(context);
    const prepare = native.prepareDeviceSession;
    const prepared =
      prepare === undefined
        ? undefined
        : await prepare.call(native, {
            protocolVersion: 1,
            accountId: context.accountId,
            apiBaseUrl: context.apiBaseUrl,
          });
    if (prepare !== undefined && prepared === undefined)
      throw new CrewRollApiProblem("INTERNAL_ERROR");
    const identity =
      prepared?.identity ??
      (await native.ensureDeviceIdentity({
        protocolVersion: 1,
        accountId: context.accountId,
      }));
    const restored =
      prepared === undefined
        ? ((await native.restoreDeviceSession?.({
            protocolVersion: 1,
            accountId: context.accountId,
            installationId: identity.installationId,
            apiBaseUrl: context.apiBaseUrl,
          })) ?? null)
        : prepared.restoredSession;
    if (restored !== null) {
      preparedMiss = undefined;
      if (pendingAttempt && sameContext(pendingAttempt.context, context))
        pendingAttempt = undefined;
      return {
        deviceId: restored.deviceId,
        identity,
        ...(prepared === undefined
          ? {}
          : { activeTripId: prepared.activeTripId }),
      };
    }
    preparedMiss = {
      key,
      value: {
        identity,
        ...(prepared === undefined ? {} : { prepared }),
        restored: null,
      },
    };
    return null;
  }

  async function provision(
    context: DeviceRegistrationContext,
  ): Promise<ProvisionedDevice> {
    let attempt = pendingAttempt;

    if (attempt === undefined || !sameContext(attempt.context, context)) {
      attempt = {
        commandId: await createUuidV4(random),
        context,
      };
      pendingAttempt = attempt;
    }

    const preparationKey = JSON.stringify(context);
    const priorPreparation =
      preparedMiss?.key === preparationKey ? preparedMiss.value : undefined;
    preparedMiss = undefined;
    const prepare = priorPreparation ? undefined : native.prepareDeviceSession;
    const prepared =
      priorPreparation?.prepared ??
      (prepare === undefined
        ? undefined
        : await prepare.call(native, {
            protocolVersion: 1,
            accountId: context.accountId,
            apiBaseUrl: context.apiBaseUrl,
          }));
    if (priorPreparation) {
      if (
        attempt.identity !== undefined &&
        JSON.stringify(
          createDeviceRegistrationBody(attempt.identity, context),
        ) !==
          JSON.stringify(
            createDeviceRegistrationBody(priorPreparation.identity, context),
          )
      )
        throw new CrewRollApiProblem("INTERNAL_ERROR");
      attempt.identity = priorPreparation.identity;
    }
    if (prepare !== undefined) {
      if (prepared === undefined)
        throw new CrewRollApiProblem("INTERNAL_ERROR");
      if (
        attempt.identity !== undefined &&
        JSON.stringify(
          createDeviceRegistrationBody(attempt.identity, context),
        ) !==
          JSON.stringify(
            createDeviceRegistrationBody(prepared.identity, context),
          )
      )
        throw new CrewRollApiProblem("INTERNAL_ERROR");
      attempt.identity = prepared.identity;
    } else if (attempt.identity === undefined) {
      attempt.identity = await native.ensureDeviceIdentity({
        protocolVersion: 1,
        accountId: context.accountId,
      });
    }

    const identity = attempt.identity;
    if (identity === undefined) throw new CrewRollApiProblem("INTERNAL_ERROR");
    const restored = priorPreparation
      ? priorPreparation.restored
      : prepared === undefined
        ? await native.restoreDeviceSession?.({
            protocolVersion: 1,
            accountId: context.accountId,
            installationId: identity.installationId,
            apiBaseUrl: context.apiBaseUrl,
          })
        : prepared.restoredSession;
    if (restored) {
      if (pendingAttempt === attempt) pendingAttempt = undefined;
      return {
        deviceId: restored.deviceId,
        identity,
        ...(prepared === undefined
          ? {}
          : { activeTripId: prepared.activeTripId }),
      };
    }
    attempt.registrationBody ??= createDeviceRegistrationBody(
      identity,
      context,
    );
    if (
      attempt.response &&
      new Date(attempt.response.backgroundBearerExpiresAt).getTime() <=
        Date.now() + BACKGROUND_CREDENTIAL_RENEWAL_WINDOW_MS
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
    // Installing a renewed session may preserve native trip metadata. A miss is
    // not an authoritative empty selection: keep the fresh snapshot path.
    return { deviceId: response.deviceId, identity };
  }

  const provisionCurrentDevice = async function (
    input: ProvisionCurrentDeviceInput,
  ): Promise<ProvisionedDevice> {
    const context = parseDeviceRegistrationContext(input);
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

  return Object.assign(provisionCurrentDevice, {
    async restore(input: ProvisionCurrentDeviceInput) {
      const context = parseDeviceRegistrationContext(input);
      const key = JSON.stringify(context);
      const pending = restoring.get(key);
      if (pending) return pending;
      const operation = restoreOnly(context);
      restoring.set(key, operation);
      try {
        return await operation;
      } finally {
        if (restoring.get(key) === operation) restoring.delete(key);
      }
    },
  });
}
