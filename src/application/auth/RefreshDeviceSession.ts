import type { RefreshDeviceSessionCommand } from "@crewroll/contracts/native/protocol";

import { createUuidV4, type RandomBytesPort } from "../../domain/ids/random";
import { withDeadline } from "../shared/withDeadline";
import {
  createDeviceRegistrationBody,
  parseDeviceRegistrationContext,
  type ProvisionCurrentDeviceInput,
  type ProvisionedDevice,
} from "./ProvisionDevice";
import type { DeviceRegistrationPort } from "./ports";

const SUCCESS_INTERVAL_MS = 86_400_000;
const FAILURE_BACKOFF_MS = 60_000;
const REFRESH_DEADLINE_MS = 30_000;

export type RefreshDeviceSessionInput = Readonly<{
  context: ProvisionCurrentDeviceInput;
  device: ProvisionedDevice;
  sessionBinding: string;
  isCurrent(): boolean;
}>;

type RefreshingNativePort = Readonly<{
  refreshDeviceSession?(command: RefreshDeviceSessionCommand): Promise<void>;
}>;

type RefreshState = {
  pending?: Promise<void>;
  successfulAt?: number;
  failedAt?: number;
};

/** Renews the selected device's credential without replacing its trip/session. */
export function createRefreshDeviceSession({
  native,
  random,
  registration,
  sessionBinding,
  now = Date.now,
}: Readonly<{
  native(): RefreshingNativePort;
  random: RandomBytesPort;
  registration: DeviceRegistrationPort;
  sessionBinding(): string | null;
  now?: () => number;
}>) {
  const states = new Map<string, RefreshState>();

  return async (input: RefreshDeviceSessionInput): Promise<void> => {
    const context = parseDeviceRegistrationContext(input.context);
    const assertCurrent = () => {
      if (
        !input.isCurrent() ||
        input.sessionBinding.length === 0 ||
        sessionBinding() !== input.sessionBinding
      )
        throw new Error("Device session refresh ended");
    };
    assertCurrent();
    const capturedNative = native();
    // A legacy binary may keep its current session, but cannot safely use the
    // selection-changing install command as a substitute for warm refresh.
    if (!capturedNative.refreshDeviceSession) return;
    const refreshNative =
      capturedNative.refreshDeviceSession.bind(capturedNative);
    const body = createDeviceRegistrationBody(input.device.identity, context);
    const key = JSON.stringify([
      input.sessionBinding,
      context,
      input.device.deviceId,
      body,
    ]);
    let state = states.get(key);
    if (!state) {
      state = {};
      states.set(key, state);
    }
    if (state.pending) return state.pending;
    const startedAt = now();
    if (
      (state.successfulAt !== undefined &&
        startedAt >= state.successfulAt &&
        startedAt - state.successfulAt < SUCCESS_INTERVAL_MS) ||
      (state.failedAt !== undefined &&
        startedAt >= state.failedAt &&
        startedAt - state.failedAt < FAILURE_BACKOFF_MS)
    )
      return;

    const currentState = state;
    let waiting = true;
    const check = () => {
      assertCurrent();
      if (!waiting) throw new Error("Device session refresh ended");
    };
    const pending = withDeadline(async () => {
      const commandId = await createUuidV4(random);
      check();
      const response = await registration.registerDevice(commandId, body);
      check();
      if (response.deviceId !== input.device.deviceId)
        throw new Error("Device session refresh returned another device");
      // Check ownership immediately before dispatch, including Clerk changes
      // that have not committed a new React session snapshot yet.
      check();
      await refreshNative({
        protocolVersion: 1,
        accountId: context.accountId,
        installationId: input.device.identity.installationId,
        deviceId: input.device.deviceId,
        backgroundBearer: response.backgroundBearer,
        backgroundBearerExpiresAt: response.backgroundBearerExpiresAt,
        apiBaseUrl: context.apiBaseUrl,
      });
      check();
      currentState.successfulAt = now();
      delete currentState.failedAt;
    }, REFRESH_DEADLINE_MS)
      .catch((error: unknown) => {
        currentState.failedAt = now();
        throw error;
      })
      .finally(() => {
        waiting = false;
        delete currentState.pending;
      });
    currentState.pending = pending;
    return pending;
  };
}
