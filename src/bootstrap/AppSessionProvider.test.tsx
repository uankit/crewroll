import * as Clipboard from "expo-clipboard";
import type { TripListResponse, TripTransferState } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { useLayoutEffect, useState, type PropsWithChildren } from "react";
import { AppState, Text, type AppStateStatus } from "react-native";

import { CrewRollApiProblem } from "../application/problems/crewRollApiProblem";
import { createCrewRollApi } from "../infrastructure/api/crewRollApi";
import type { ProvisionedDevice } from "../application/auth/ProvisionDevice";
import {
  createRefreshDeviceSession,
  type RefreshDeviceSessionInput,
} from "../application/auth/RefreshDeviceSession";
import {
  JoinTripTerminalProblem,
  type JoinTripResult,
} from "../application/trips/JoinTrip";
import { TripActivationFailed } from "../application/trips/ActivateObservedTrip";
import { CreateTripTerminalProblem } from "../application/trips/CreateImmediateTrip";
import type {
  TripRecoveryRecord,
  TripRecoveryScope,
} from "../application/trips/ports";
import type { TripView } from "../domain/trips/model";
import {
  AppSessionProvider,
  permissionForVisibleTrip,
  resolveLaunchPhase,
  useAppSession,
  useTripProjection,
  type AppSessionAuthSnapshot,
  type AppSessionRuntime,
  type ScopedTripSession,
  type TripMutationResult,
} from "./AppSessionProvider";
import {
  canPublishPhotoReadiness,
  usePhotoReadinessEntryBoundary,
  usePhotoReadinessRecovery,
} from "./photoReadinessReconciler";
import { createPhotoReadinessService } from "./photoReadinessService";
import { useTripLibrary } from "./useTripLibrary";

const userId = "user_one";
const sessionId = "session_one";
const deviceId = "10000000-0000-4000-8000-000000000001";
const tripId = "018f22c4-6e80-7000-8000-000000000001";
const membershipId = "20000000-0000-4000-8000-000000000001";

const identity: NativeDeviceIdentity = Object.freeze({
  protocolVersion: 1,
  installationId: "30000000-0000-4000-8000-000000000001",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey:
    "BBDQzXEkLyd0T0dl5zDy1x4U2A6dHw9Gw6aY8PKnCz6S+ddt5K7AqQ6zW7VQk1PFQ/NYz7t0b6F0j1w2G3H4I5J=",
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  e2eeKeyVersion: 1,
});

const lobby: TripView = Object.freeze({
  id: tripId,
  version: 1,
  name: "Kyoto",
  status: "LOBBY",
  release: Object.freeze({ mode: "IMMEDIATE" }),
  startsAt: null,
  endsAt: "2030-01-02T00:00:00.000Z",
  ownerDeviceId: deviceId,
  currentMembershipId: membershipId,
  members: Object.freeze([
    Object.freeze({
      membershipId,
      role: "OWNER" as const,
      displayName: "Owner",
      status: "ACTIVE" as const,
      fullPhotoLibraryAccess: true,
      deviceState: "AVAILABLE" as const,
      isCurrentMember: true,
    }),
  ]),
});

const signedOut: AppSessionAuthSnapshot = Object.freeze({
  isLoaded: true,
  isSignedIn: false,
});

const signedIn: AppSessionAuthSnapshot = Object.freeze({
  isLoaded: true,
  isSignedIn: true,
  userId,
  sessionId,
});

describe("ready session credential renewal", () => {
  it("retries only in foreground without restarting setup or hiding the ready screen", async () => {
    jest.useFakeTimers();
    const originalAppState = AppState.currentState;
    AppState.currentState = "background";
    const listeners = new Set<(state: AppStateStatus) => void>();
    const originalSubscribe = AppState.addEventListener;
    AppState.addEventListener = (_event, callback) => {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    };
    const client = createQueryClient();
    const { runtime: base } = createRuntime();
    const refresh = jest
      .fn(async (_input: RefreshDeviceSessionInput) => undefined)
      .mockRejectedValueOnce(new Error("offline"));
    const runtime = { ...base, refreshDeviceSession: refresh };
    try {
      const view = await render(
        <Harness auth={signedIn} runtime={runtime} queryClient={client}>
          <SessionProbe />
        </Harness>,
      );
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(screen.getByTestId("session-probe")).toHaveTextContent(
        "READY_NO_TRIP",
      );
      expect(refresh).not.toHaveBeenCalled();
      await act(async () => {
        AppState.currentState = "active";
        listeners.forEach((callback) => callback("active"));
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("session-probe")).toHaveTextContent(
        "READY_NO_TRIP",
      );
      await act(async () => {
        AppState.currentState = "background";
        listeners.forEach((callback) => callback("background"));
        await jest.advanceTimersByTimeAsync(120_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(async () => {
        AppState.currentState = "active";
        listeners.forEach((callback) => callback("active"));
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(base.provisionCurrentDevice).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("session-probe")).toHaveTextContent(
        "READY_NO_TRIP",
      );
      await view.unmount();
    } finally {
      client.clear();
      AppState.addEventListener = originalSubscribe;
      AppState.currentState = originalAppState;
      jest.useRealTimers();
    }
  });

  it("renews daily after eight days in one ready process using the current device", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-14T10:00:00.000Z"));
    const originalAppState = AppState.currentState;
    AppState.currentState = "active";
    const listeners = new Set<(state: AppStateStatus) => void>();
    const originalSubscribe = AppState.addEventListener;
    AppState.addEventListener = (_event, callback) => {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    };
    const client = createQueryClient();
    const { runtime: base } = createRuntime();
    const nativeRefresh = jest.fn(async () => undefined);
    const registerDevice = jest.fn(async () => ({
      deviceId,
      backgroundBearer: "new-credential",
      backgroundBearerExpiresAt: new Date(
        Date.now() + 30 * 86_400_000,
      ).toISOString(),
    }));
    let byte = 0;
    const refreshDeviceSession = createRefreshDeviceSession({
      native: () => ({ refreshDeviceSession: nativeRefresh }),
      registration: { registerDevice },
      random: {
        getBytes: async (length) => new Uint8Array(length).fill(++byte),
      },
      sessionBinding: () => JSON.stringify([userId, sessionId]),
      now: () => Date.now(),
    });
    const runtime = { ...base, refreshDeviceSession };
    try {
      const view = await render(
        <Harness auth={signedIn} runtime={runtime} queryClient={client}>
          <SessionProbe />
        </Harness>,
      );
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(registerDevice).toHaveBeenCalledTimes(1);
      for (let elapsedDays = 1; elapsedDays <= 8; elapsedDays++) {
        jest.setSystemTime(Date.now() + 86_400_000);
        await act(async () => {
          listeners.forEach((callback) => callback("active"));
          await jest.advanceTimersByTimeAsync(0);
        });
        expect(registerDevice).toHaveBeenCalledTimes(elapsedDays + 1);
        expect(screen.getByTestId("session-probe")).toHaveTextContent(
          "READY_NO_TRIP",
        );
      }
      expect(nativeRefresh).toHaveBeenCalledTimes(9);
      expect(base.provisionCurrentDevice).toHaveBeenCalledTimes(1);
      expect(base.createScopedTripSession).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      client.clear();
      AppState.addEventListener = originalSubscribe;
      AppState.currentState = originalAppState;
      jest.useRealTimers();
    }
  });

  it.each(["account switch", "sign-out", "unmount"])(
    "invalidates a pending ready-device renewal on %s",
    async (change) => {
      const originalAppState = AppState.currentState;
      AppState.currentState = "active";
      const client = createQueryClient();
      const { runtime: base } = createRuntime();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => (finish = resolve));
      const inputs: RefreshDeviceSessionInput[] = [];
      const nativeWrites: string[] = [];
      const refresh = jest.fn(async (input: RefreshDeviceSessionInput) => {
        inputs.push(input);
        if (inputs.length === 1) await pending;
        if (input.isCurrent()) nativeWrites.push(input.context.accountId);
      });
      const runtime = { ...base, refreshDeviceSession: refresh };
      try {
        const view = await render(
          <Harness auth={signedIn} runtime={runtime} queryClient={client}>
            <SessionProbe />
          </Harness>,
        );
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(inputs[0]?.isCurrent()).toBe(true);
        if (change === "unmount") await view.unmount();
        else
          await view.rerender(
            <Harness
              auth={
                change === "sign-out"
                  ? signedOut
                  : {
                      ...signedIn,
                      userId: "user_two",
                      sessionId: "session_two",
                    }
              }
              runtime={runtime}
              queryClient={client}
            >
              <SessionProbe />
            </Harness>,
          );
        expect(inputs[0]?.isCurrent()).toBe(false);
        await act(async () => finish());
        expect(nativeWrites).not.toContain(userId);
        if (change !== "unmount") await view.unmount();
      } finally {
        client.clear();
        AppState.currentState = originalAppState;
      }
    },
  );
});

function completeLaunchInput(
  input: Partial<Parameters<typeof resolveLaunchPhase>[0]>,
): Parameters<typeof resolveLaunchPhase>[0] {
  return {
    fontsReady: true,
    clerkLoaded: true,
    signedIn: true,
    provisioned: true,
    failure: false,
    recoveryState: null,
    activeNativeTripId: null,
    tripStatus: null,
    ...input,
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });
}

type RuntimeOptions = Readonly<{
  recovery?: TripRecoveryRecord | null;
  activeTripId?: string | null;
  reconcileCreate?: () => Promise<TripView | "STILL_UNKNOWN">;
  replayJoin?: () => Promise<JoinTripResult | null>;
  hydrate?: (requestedTripId: string) => Promise<TripView>;
  requestJoin?: (inviteCode: string) => Promise<JoinTripResult>;
  provision?: () => Promise<ProvisionedDevice>;
  create?: () => Promise<TripView>;
  replayPendingMutation?: () => Promise<TripView | null>;
  setPhotoReadiness?: ScopedTripSession["setPhotoReadiness"];
}>;

function createRuntime(options: RuntimeOptions = {}) {
  const calls: string[] = [];
  const scoped: ScopedTripSession = {
    previewInvite: jest.fn(),
    approveMember: jest.fn(async () => lobby),
    openPhotoSettings: jest.fn(async () => undefined),
    replayPendingMutation:
      options.replayPendingMutation ?? jest.fn(async () => null),
    setPhotoReadiness:
      options.setPhotoReadiness ??
      jest.fn(async () => ({
        permission: {
          kind: "FULL" as const,
          fullPhotoLibraryAccess: true as const,
          canAskAgain: true,
        },
        trip: lobby,
      })),
    createTrip: options.create ?? jest.fn(async () => lobby),
    reconcileUnknownCreate:
      options.reconcileCreate ??
      jest.fn(async () => {
        calls.push("reconcile-create");
        return "STILL_UNKNOWN";
      }),
    replayUnknownJoin:
      options.replayJoin ??
      jest.fn(async () => {
        calls.push("replay-join");
        return null;
      }),
    hydrateTrip:
      options.hydrate ??
      jest.fn(async (requestedTripId) => {
        calls.push(`hydrate:${requestedTripId}`);
        return { ...lobby, id: requestedTripId };
      }),
    requestJoin:
      options.requestJoin ??
      (async () => {
        throw new Error("unexpected join");
      }),
    startTrip: jest.fn(async () => ({ ...lobby, status: "ACTIVE" as const })),
  };
  const runtime: AppSessionRuntime = {
    invalidatePendingSetup: jest.fn(),
    provisionCurrentDevice: jest.fn(
      options.provision ??
        (async () => {
          calls.push("provision");
          return { deviceId, identity };
        }),
    ),
    getNativeSnapshot: jest.fn(async () => {
      calls.push("native-snapshot");
      return { activeTripId: options.activeTripId ?? null };
    }),
    loadRecovery: jest.fn(async () => {
      calls.push("load-recovery");
      return options.recovery ?? null;
    }),
    createScopedTripSession: jest.fn(
      (_scope: TripRecoveryScope): ScopedTripSession => scoped,
    ),
  };
  return { calls, runtime, scoped };
}

function SessionProbe() {
  const session = useAppSession();
  return (
    <Text testID="session-probe">
      {session.snapshot.phase}
      {"tripId" in session.snapshot ? `:${session.snapshot.tripId}` : ""}
    </Text>
  );
}

function SnapshotProbe() {
  const session = useAppSession();
  return (
    <Text testID="snapshot-probe">
      {JSON.stringify({
        ownerInviteCode: session.ownerInviteCode,
        snapshot: session.snapshot,
      })}
    </Text>
  );
}

type HarnessProps = PropsWithChildren<{
  profileReady?: boolean;
  auth: AppSessionAuthSnapshot;
  runtime: AppSessionRuntime;
  queryClient?: QueryClient;
  onAuthInvalid?: () => void | Promise<void>;
}>;

function Harness({
  profileReady = true,
  auth,
  children,
  runtime,
  queryClient: suppliedQueryClient,
  onAuthInvalid,
}: HarnessProps) {
  const [fallbackQueryClient] = useState(createQueryClient);
  const queryClient = suppliedQueryClient ?? fallbackQueryClient;
  return (
    <AppSessionProvider
      auth={auth}
      fontsReady
      profileReady={profileReady}
      {...(onAuthInvalid === undefined ? {} : { onAuthInvalid })}
      provisionInput={{
        apiBaseUrl: "https://api.crewroll.test",
        appVersion: "0.2.0",
        platform: "ios",
      }}
      queryClient={queryClient}
      runtime={runtime}
    >
      {children}
    </AppSessionProvider>
  );
}

describe("resolveLaunchPhase", () => {
  it("bounds a stalled Settings launch without granting access or losing the session", async () => {
    jest.useFakeTimers();
    const client = createQueryClient();
    const { runtime, scoped } = createRuntime();
    jest
      .mocked(scoped.openPhotoSettings)
      .mockReturnValueOnce(new Promise(() => {}));
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <SessionProbe />;
    }
    try {
      const view = await render(
        <Harness auth={signedIn} runtime={runtime} queryClient={client}>
          <Probe />
        </Harness>,
      );
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(current.snapshot.phase).toBe("READY_NO_TRIP");
      let outcome!: Promise<unknown>;
      await act(() => {
        outcome = current.actions!.openPhotoSettings().catch((error) => error);
      });
      await act(() => jest.advanceTimersByTimeAsync(5_000));
      await expect(outcome).resolves.toMatchObject({
        name: "OperationDeadlineExceeded",
      });
      expect(current.snapshot.phase).toBe("READY_NO_TRIP");
      expect(current.photoPermission.kind).toBe("CHECKING");
      await act(() => current.actions!.openPhotoSettings());
      expect(scoped.openPhotoSettings).toHaveBeenCalledTimes(2);
      await view.unmount();
    } finally {
      client.clear();
      jest.useRealTimers();
    }
  });

  it("shows the recovered trip library without a duplicate request and discards it on account change", async () => {
    const initialAppState = AppState.currentState;
    AppState.currentState = "active";
    const client = createQueryClient();
    const { runtime: base, scoped } = createRuntime();
    const listTrips = jest.fn().mockResolvedValue({ items: [] });
    const runtime = {
      ...base,
      createScopedTripSession: () => ({ ...scoped, listTrips }),
    };
    function HomeProbe() {
      const session = useAppSession();
      const library = useTripLibrary();
      return (
        <Text testID="library-probe">
          {session.snapshot.phase}:{library.data ? "loaded" : "loading"}
        </Text>
      );
    }
    const view = await render(
      <QueryClientProvider client={client}>
        <Harness auth={signedIn} runtime={runtime} queryClient={client}>
          <HomeProbe />
        </Harness>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("library-probe")).toHaveTextContent(
        "READY_NO_TRIP:loaded",
      ),
    );
    expect(listTrips).toHaveBeenCalledTimes(1);
    const firstScope = client
      .getQueryCache()
      .getAll()
      .find(
        (q) => q.queryKey[0] === "trip-library" && q.state.data !== undefined,
      )!.queryKey;
    await view.rerender(
      <QueryClientProvider client={client}>
        <Harness
          auth={{
            ...signedIn,
            userId: "other-account",
            sessionId: "other-session",
          }}
          runtime={runtime}
          queryClient={client}
        >
          <HomeProbe />
        </Harness>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listTrips).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("library-probe")).toHaveTextContent(
        "READY_NO_TRIP:loaded",
      ),
    );
    expect(client.getQueryData(firstScope)).toBeUndefined();
    await view.unmount();
    client.clear();
    AppState.currentState = initialAppState;
  });
  it("stops native transfers before explicit sign-out and keeps the session retryable if teardown fails", async () => {
    const queryClient = createQueryClient();
    const { runtime: baseRuntime, scoped } = createRuntime({
      recovery: { state: "CONFIRMED", tripId, membershipId },
      activeTripId: tripId,
    });
    const pauseTransfers = jest
      .fn<Promise<void>, []>()
      .mockResolvedValue(undefined);
    const onAuthInvalid = jest.fn(async () => undefined);
    const runtime = { ...baseRuntime, pauseTransfers };
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <SessionProbe />;
    }
    await render(
      <Harness
        auth={signedIn}
        runtime={runtime}
        queryClient={queryClient}
        onAuthInvalid={onAuthInvalid}
      >
        <Probe />
      </Harness>,
    );
    await waitFor(() => expect(current.snapshot.phase).toBe("READY_LOBBY"));
    queryClient.setQueryData(["trip", "private"], lobby);
    pauseTransfers.mockRejectedValueOnce(new Error("KEYCHAIN_UNAVAILABLE"));
    await act(async () => {
      await expect(current.signOut()).rejects.toThrow("KEYCHAIN_UNAVAILABLE");
    });
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(current.snapshot).toEqual({
      phase: "RECOVERABLE_FAILURE",
      publicErrorCode: "SESSION_TEARDOWN_FAILED",
    });
    expect(current.actions).toBeNull();
    expect(current.queryScope).toBeNull();

    let finishPause!: () => void;
    pauseTransfers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPause = resolve;
        }),
    );
    let signOut!: Promise<void>;
    await act(async () => {
      signOut = current.signOut();
    });
    expect(current.snapshot.phase).toBe("SIGNING_OUT");
    expect(current.actions).toBeNull();
    expect(onAuthInvalid).not.toHaveBeenCalled();
    await act(async () => {
      finishPause();
      await signOut;
    });
    expect(current.snapshot.phase).toBe("SIGNED_OUT");
    expect(current.actions).toBeNull();
    expect(current.queryScope).toBeNull();
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(scoped.createTrip).not.toHaveBeenCalled();
    expect(scoped.startTrip).not.toHaveBeenCalled();
    expect(scoped.setPhotoReadiness).not.toHaveBeenCalled();
  });

  it.each(["native pause", "Clerk sign-out"] as const)(
    "closes private views, bounds a stalled %s and retries teardown without provisioning again",
    async (stage) => {
      jest.useFakeTimers();
      try {
        let finishOld!: () => void;
        const stalled = new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        const { runtime: base } = createRuntime();
        const pauseTransfers = jest
          .fn<Promise<void>, []>()
          .mockResolvedValue(undefined);
        const onAuthInvalid = jest
          .fn<Promise<void>, []>()
          .mockResolvedValue(undefined);
        const runtime = { ...base, pauseTransfers };
        let current!: ReturnType<typeof useAppSession>;
        function Probe() {
          const session = useAppSession();
          useLayoutEffect(() => {
            current = session;
          }, [session]);
          return <SessionProbe />;
        }
        const view = await render(
          <Harness
            auth={signedIn}
            runtime={runtime}
            onAuthInvalid={onAuthInvalid}
          >
            <Probe />
          </Harness>,
        );
        expect(current.snapshot.phase).toBe("READY_NO_TRIP");
        const oldActions = current.actions!;
        if (stage === "native pause")
          pauseTransfers.mockReturnValueOnce(stalled);
        else onAuthInvalid.mockReturnValueOnce(stalled);
        let first!: Promise<void>;
        let duplicate!: Promise<void>;
        await act(() => {
          first = current.signOut();
          duplicate = current.signOut();
        });
        expect(duplicate).toBe(first);
        expect(current.snapshot.phase).toBe("SIGNING_OUT");
        expect(current.actions).toBeNull();
        const rejection = expect(first).rejects.toThrow(
          "OPERATION_DEADLINE_EXCEEDED",
        );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(
            stage === "native pause" ? 10_000 : 20_000,
          );
          await rejection;
        });
        expect(current.snapshot).toEqual({
          phase: "RECOVERABLE_FAILURE",
          publicErrorCode: "SESSION_TEARDOWN_FAILED",
        });
        expect(current.actions).toBeNull();
        expect(current.queryScope).toBeNull();
        await expect(
          oldActions.create({ name: "stale", endsAt: lobby.endsAt }),
        ).rejects.toThrow("TRIP_SESSION_UNAVAILABLE");
        await act(() => current.retry());
        expect(current.snapshot.phase).toBe("SIGNED_OUT");
        expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
        await act(() => finishOld());
        expect(current.snapshot.phase).toBe("SIGNED_OUT");
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(["failed", "stalled"] as const)(
    "keeps a signed-out cold launch recoverable when native cleanup has %s without exposing protected views",
    async (failure) => {
      jest.useFakeTimers();
      try {
        let finishOld!: () => void;
        const old = new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        const { runtime: base } = createRuntime();
        const pauseTransfers = jest
          .fn<Promise<void>, []>()
          .mockResolvedValue(undefined);
        if (failure === "failed")
          pauseTransfers.mockRejectedValueOnce(new Error("keychain locked"));
        else pauseTransfers.mockReturnValueOnce(old);
        const runtime = { ...base, pauseTransfers };
        const onAuthInvalid = jest.fn();
        const committedPhases: string[] = [];
        function Probe() {
          const session = useAppSession();
          useLayoutEffect(() => {
            committedPhases.push(session.snapshot.phase);
          }, [session.snapshot.phase]);
          return (
            <Text testID="signed-out-cleanup" onPress={session.retry}>
              {JSON.stringify(session.snapshot)}
            </Text>
          );
        }
        const view = await render(
          <Harness
            auth={signedOut}
            runtime={runtime}
            onAuthInvalid={onAuthInvalid}
          >
            <Probe />
          </Harness>,
        );
        expect(committedPhases).not.toContain("SIGNED_OUT");
        if (failure === "stalled")
          expect(screen.getByTestId("signed-out-cleanup").props.children).toBe(
            JSON.stringify({ phase: "SIGNING_OUT" }),
          );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10_000);
        });
        expect(screen.getByTestId("signed-out-cleanup").props.children).toBe(
          JSON.stringify({
            phase: "RECOVERABLE_FAILURE",
            publicErrorCode: "SESSION_TEARDOWN_FAILED",
          }),
        );
        await act(() =>
          screen.getByTestId("signed-out-cleanup").props.onPress(),
        );
        expect(screen.getByTestId("signed-out-cleanup").props.children).toBe(
          JSON.stringify({ phase: "SIGNED_OUT" }),
        );
        await act(() => finishOld());
        expect(screen.getByTestId("signed-out-cleanup").props.children).toBe(
          JSON.stringify({ phase: "SIGNED_OUT" }),
        );
        expect(pauseTransfers).toHaveBeenCalledTimes(2);
        expect(base.provisionCurrentDevice).not.toHaveBeenCalled();
        expect(onAuthInvalid).not.toHaveBeenCalled();
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it("keeps unchanged permission rechecks local and clears the gallery on account change and sign-out", async () => {
    const full = {
      kind: "FULL" as const,
      fullPhotoLibraryAccess: true as const,
      canAskAgain: true,
    };
    const localRead = jest.fn(async () => full);
    const hydrate = jest.fn(async () => lobby);
    const { runtime } = createRuntime({
      recovery: { state: "CONFIRMED", tripId, membershipId },
      setPhotoReadiness: createPhotoReadinessService({
        photoPermission: {
          read: localRead,
          request: jest.fn(async () => full),
          openSettings: jest.fn(),
        },
        hydrate,
        reconcile: async (trip) => trip,
      }),
    });
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <Text>{session.snapshot.phase}</Text>;
    }
    const view = await render(
      <Harness auth={signedIn} runtime={runtime}>
        <Probe />
      </Harness>,
    );
    await waitFor(() => expect(current.snapshot.phase).toBe("READY_LOBBY"));
    await act(async () => {
      await current.actions!.publishPhotoReadiness(tripId, false);
      current.actions!.invalidatePhotoReadiness();
      await current.actions!.publishPhotoReadiness(tripId, false);
    });
    expect(localRead).toHaveBeenCalledTimes(2);
    expect(hydrate).not.toHaveBeenCalled();
    const firstCache = current.galleryCache;
    firstCache.saveScrollY(280);
    firstCache.setFilters({
      sourceMembershipId: membershipId,
      day: null,
      order: "NEWEST",
    });
    const oldToken = firstCache.token();
    await view.rerender(
      <Harness
        auth={{
          ...signedIn,
          userId: "another-account",
          sessionId: "another-session",
        }}
        runtime={runtime}
      >
        <Probe />
      </Harness>,
    );
    await waitFor(() => expect(current.snapshot.phase).toBe("READY_LOBBY"));
    expect(current.galleryCache).not.toBe(firstCache);
    expect(current.galleryCache.getScrollY()).toBe(0);
    expect(firstCache.accepts(oldToken)).toBe(false);
    expect(firstCache.getSnapshot().filters.sourceMembershipId).toBeNull();
    const lastCache = current.galleryCache;
    lastCache.saveScrollY(450);
    await act(async () => current.signOut());
    expect(lastCache.getScrollY()).toBe(0);
    expect(lastCache.accepts(lastCache.token())).toBe(false);
  });

  it("clears cached access as soon as the OS reports revocation, before server readiness finishes", async () => {
    const denied = {
      kind: "SETTINGS_REQUIRED" as const,
      fullPhotoLibraryAccess: false as const,
      canAskAgain: false as const,
    };
    let finish!: (
      value: Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>,
    ) => void;
    const { runtime } = createRuntime({
      recovery: { state: "CONFIRMED", tripId, membershipId },
      setPhotoReadiness: async (_, __, options) => {
        options?.onPermission?.(denied);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <Text>{session.snapshot.phase}</Text>;
    }
    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <Probe />
      </Harness>,
    );
    await waitFor(() => expect(current.snapshot.phase).toBe("READY_LOBBY"));
    current.galleryCache.saveScrollY(350);
    const token = current.galleryCache.token();
    let pending!: Promise<TripMutationResult>;
    await act(async () => {
      pending = current.actions!.publishPhotoReadiness(tripId, false);
    });
    expect(current.photoPermission.kind).toBe("SETTINGS_REQUIRED");
    expect(current.galleryCache.getScrollY()).toBe(0);
    expect(current.galleryCache.accepts(token)).toBe(false);
    await act(async () => {
      finish({ permission: denied, trip: lobby });
      await pending;
    });
  });
  it("blocks a new lobby from inheriting another trip's FULL permission", () => {
    const full = {
      kind: "FULL" as const,
      fullPhotoLibraryAccess: true as const,
      canAskAgain: false,
    };
    const otherTripId = `${tripId.slice(0, -1)}2`;
    expect(
      permissionForVisibleTrip(
        { phase: "READY_LOBBY", deviceId, tripId: otherTripId },
        tripId,
        full,
      ),
    ).toEqual({ kind: "CHECKING" });
    expect(
      permissionForVisibleTrip(
        { phase: "READY_LOBBY", deviceId, tripId },
        tripId,
        full,
      ),
    ).toBe(full);
  });
  it.each([
    [{ fontsReady: false }, "LOADING_FONTS_OR_CLERK"],
    [{ clerkLoaded: false }, "LOADING_FONTS_OR_CLERK"],
    [{ signedIn: false }, "SIGNED_OUT"],
    [{ provisioned: false }, "PROVISIONING_DEVICE"],
    [{ failure: true }, "RECOVERABLE_FAILURE"],
    [{ recoveryState: "UNKNOWN_CREATE" }, "READY_UNKNOWN_CREATE"],
    [{ recoveryState: "UNKNOWN_JOIN" }, "READY_UNKNOWN_JOIN"],
    [{ tripStatus: "LOBBY" }, "READY_LOBBY"],
    [{ tripStatus: "ACTIVE" }, "READY_ACTIVE"],
    [{ activeNativeTripId: tripId }, "READY_ACTIVE"],
    [{}, "READY_NO_TRIP"],
  ] as const)("resolves %j deterministically", (input, expected) => {
    expect(resolveLaunchPhase(completeLaunchInput(input))).toBe(expected);
  });
});

describe("AppSessionProvider", () => {
  beforeEach(() => {
    jest
      .spyOn(AppState, "addEventListener")
      .mockReturnValue({ remove: jest.fn() });
  });

  it.each(["create", "join", "start"] as const)(
    "finishes an accepted %s when the optional owner-invite recovery read never settles",
    async (operation) => {
      jest.useFakeTimers();
      const client = createQueryClient();
      const { runtime } = createRuntime({
        ...(operation === "start"
          ? {
              recovery: {
                state: "CONFIRMED" as const,
                tripId,
                membershipId,
                ownerInviteCode: "ABCD2345",
              },
            }
          : {}),
        requestJoin: async () => ({
          tripId,
          membershipId,
          status: "ACTIVE" as const,
        }),
      });
      let current!: ReturnType<typeof useAppSession>;
      function Probe() {
        const session = useAppSession();
        useLayoutEffect(() => {
          current = session;
        }, [session]);
        return (
          <Text testID="optional-recovery-result">
            {session.snapshot.phase}:{session.ownerInviteCode ?? "none"}
          </Text>
        );
      }
      try {
        const view = await render(
          <Harness auth={signedIn} runtime={runtime} queryClient={client}>
            <Probe />
          </Harness>,
        );
        await waitFor(() =>
          expect(current.snapshot.phase).toBe(
            operation === "start" ? "READY_LOBBY" : "READY_NO_TRIP",
          ),
        );
        if (operation === "start") {
          await act(async () => {
            await current.actions!.publishPhotoReadiness(tripId, false);
          });
        }
        jest
          .mocked(runtime.loadRecovery)
          .mockReturnValue(new Promise(() => {}));
        let result: TripMutationResult | undefined;
        let failure: unknown;
        let pending!: Promise<unknown>;
        await act(async () => {
          pending = (
            operation === "create"
              ? current.actions!.create({
                  name: "Trip",
                  endsAt: "2030-01-02T00:00:00.000Z",
                })
              : operation === "join"
                ? current.actions!.join("ABCD2345")
                : current.actions!.start(tripId)
          ).then(
            (value) => {
              if (value.kind === "READY" || value.kind === "ACTIVATION_FAILED")
                result = value;
            },
            (error: unknown) => {
              failure = error;
            },
          );
        });
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_500);
        });
        expect(failure).toBeUndefined();
        expect(result).toEqual({ kind: "READY", tripId });
        expect(current.snapshot.phase).toBe(
          operation === "start" ? "READY_ACTIVE" : "READY_LOBBY",
        );
        if (operation === "start")
          expect(current.ownerInviteCode).toBe("ABCD2345");
        await pending;
        await view.unmount();
      } finally {
        client.clear();
        jest.useRealTimers();
      }
    },
  );

  it("does not publish an old account's optional owner invite after a deadline and account switch", async () => {
    jest.useFakeTimers();
    const client = createQueryClient();
    const { runtime } = createRuntime();
    let finishOld!: (value: TripRecoveryRecord | null) => void;
    const oldRead = new Promise<TripRecoveryRecord | null>((resolve) => {
      finishOld = resolve;
    });
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return (
        <Text testID="optional-recovery-account">
          {session.snapshot.phase}:{session.ownerInviteCode ?? "none"}
        </Text>
      );
    }
    try {
      const view = await render(
        <Harness auth={signedIn} runtime={runtime} queryClient={client}>
          <Probe />
        </Harness>,
      );
      await waitFor(() => expect(current.snapshot.phase).toBe("READY_NO_TRIP"));
      jest.mocked(runtime.loadRecovery).mockReturnValueOnce(oldRead);
      let finished = false;
      let failure: unknown;
      await act(async () => {
        void current
          .actions!.create({ name: "Trip", endsAt: "2030-01-02T00:00:00.000Z" })
          .then(
            () => {
              finished = true;
            },
            (error: unknown) => {
              finished = true;
              failure = error;
            },
          );
      });
      await view.rerender(
        <Harness
          auth={{
            isLoaded: true,
            isSignedIn: true,
            userId: "user_two",
            sessionId: "session_two",
          }}
          runtime={runtime}
          queryClient={client}
        >
          <Probe />
        </Harness>,
      );
      await waitFor(() => expect(current.snapshot.phase).toBe("READY_NO_TRIP"));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_500);
      });
      expect(finished).toBe(true);
      expect(failure).toEqual(new Error("TRIP_SESSION_UNAVAILABLE"));
      await act(async () => {
        finishOld({
          state: "CONFIRMED",
          tripId,
          membershipId,
          ownerInviteCode: "ABCD2345",
        });
      });
      expect(current.snapshot.phase).toBe("READY_NO_TRIP");
      expect(current.ownerInviteCode).toBeNull();
      expect(client.getQueryCache().getAll()).toHaveLength(0);
      await view.unmount();
    } finally {
      client.clear();
      jest.useRealTimers();
    }
  });

  it("a stalled setup becomes an explicit failure instead of an endless spinner", async () => {
    jest.useFakeTimers();
    try {
      const { runtime } = createRuntime({
        provision: () => new Promise(() => undefined),
      });
      const view = await render(
        <Harness auth={signedIn} runtime={runtime}>
          <SessionProbe />
        </Harness>,
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByText("RECOVERABLE_FAILURE")).toBeOnTheScreen();
      expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("retries a stalled provisioning attempt and fences its late completion", async () => {
    jest.useFakeTimers();
    try {
      let finishOld!: (value: ProvisionedDevice) => void;
      const old = new Promise<ProvisionedDevice>((resolve) => {
        finishOld = resolve;
      });
      const provision = jest
        .fn<Promise<ProvisionedDevice>, []>()
        .mockReturnValueOnce(old)
        .mockResolvedValue({ deviceId, identity });
      const { runtime: base } = createRuntime({ provision });
      const invalidatePendingSetup = jest.fn();
      const runtime = { ...base, invalidatePendingSetup };
      function RetryProbe() {
        const session = useAppSession();
        return (
          <Text testID="retry-setup" onPress={session.retry}>
            {JSON.stringify(session.snapshot)}
          </Text>
        );
      }
      const view = await render(
        <Harness auth={signedIn} runtime={runtime}>
          <RetryProbe />
        </Harness>,
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByTestId("retry-setup").props.children).toContain(
        "DEVICE_SETUP_FAILED",
      );
      expect(invalidatePendingSetup).toHaveBeenCalledTimes(1);
      await act(() => screen.getByTestId("retry-setup").props.onPress());
      expect(screen.getByTestId("retry-setup").props.children).toContain(
        "READY_NO_TRIP",
      );
      expect(provision).toHaveBeenCalledTimes(2);
      const snapshotReads = (runtime.getNativeSnapshot as jest.Mock).mock.calls
        .length;
      await act(() =>
        finishOld({ deviceId: "old-device-must-not-be-published", identity }),
      );
      expect(screen.getByTestId("retry-setup").props.children).toContain(
        deviceId,
      );
      expect(screen.getByTestId("retry-setup").props.children).not.toContain(
        "old-device",
      );
      expect(runtime.getNativeSnapshot).toHaveBeenCalledTimes(snapshotReads);
      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports a recovery stall at the correct stage and ignores its late projection", async () => {
    jest.useFakeTimers();
    try {
      let finishOld!: (value: TripView) => void;
      const pending = new Promise<TripView>((resolve) => {
        finishOld = resolve;
      });
      const { runtime: base } = createRuntime({
        recovery: { state: "CONFIRMED", tripId, membershipId },
        hydrate: async () => pending,
      });
      const invalidatePendingSetup = jest.fn();
      const runtime = { ...base, invalidatePendingSetup };
      const view = await render(
        <Harness auth={signedIn} runtime={runtime}>
          <SnapshotProbe />
        </Harness>,
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByTestId("snapshot-probe").props.children).toContain(
        "TRIP_RECOVERY_FAILED",
      );
      expect(invalidatePendingSetup).toHaveBeenCalledTimes(1);
      await act(() => finishOld(lobby));
      expect(screen.getByTestId("snapshot-probe").props.children).toContain(
        "TRIP_RECOVERY_FAILED",
      );
      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not provision or read trip recovery while Clerk is loading or signed out", async () => {
    const loadingRuntime = createRuntime();
    const loadingAuth: AppSessionAuthSnapshot = {
      isLoaded: false,
      isSignedIn: undefined,
    };
    const view = await render(
      <Harness auth={loadingAuth} runtime={loadingRuntime.runtime}>
        <SessionProbe />
      </Harness>,
    );

    expect(screen.getByText("LOADING_FONTS_OR_CLERK")).toBeOnTheScreen();
    expect(loadingRuntime.calls).toEqual([]);

    await view.rerender(
      <Harness auth={signedOut} runtime={loadingRuntime.runtime}>
        <SessionProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("SIGNED_OUT")).toBeOnTheScreen(),
    );
    expect(loadingRuntime.calls).toEqual([]);
  });

  it("provisions once per user/session and reads native state before scoped recovery", async () => {
    const { calls, runtime } = createRuntime();
    const view = await render(
      <Harness auth={signedIn} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    expect(calls).toEqual(["provision", "native-snapshot", "load-recovery"]);

    await view.rerender(
      <Harness auth={{ ...signedIn }} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );
    await act(async () => undefined);
    expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
    expect(runtime.createScopedTripSession).toHaveBeenCalledTimes(1);
  });

  it("delegates UNKNOWN_CREATE only to Task 7 reconciliation", async () => {
    const recovery: TripRecoveryRecord = {
      state: "UNKNOWN_CREATE",
      tripId,
      commandId: "40000000-0000-4000-8000-000000000001",
      ownerInviteCode: "ABCD2345",
    };
    const reconcileUnknownCreate = jest.fn(
      async () => "STILL_UNKNOWN" as const,
    );
    const { runtime, scoped } = createRuntime({
      recovery,
      reconcileCreate: reconcileUnknownCreate,
    });

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(screen.getByText("READY_UNKNOWN_CREATE")).toBeOnTheScreen(),
    );
    expect(reconcileUnknownCreate).toHaveBeenCalledTimes(1);
    expect(scoped.replayUnknownJoin).not.toHaveBeenCalled();
    expect(scoped.hydrateTrip).not.toHaveBeenCalled();
  });

  it("returns a confirmed failed create to home without reconnecting or signing out", async () => {
    const onAuthInvalid = jest.fn();
    const { runtime, scoped } = createRuntime({
      recovery: {
        state: "UNKNOWN_CREATE",
        tripId,
        commandId: "40000000-0000-4000-8000-000000000001",
        ownerInviteCode: "ABCD2345",
      },
      reconcileCreate: async () => {
        throw new CreateTripTerminalProblem();
      },
    });
    await render(
      <Harness auth={signedIn} runtime={runtime} onAuthInvalid={onAuthInvalid}>
        <SnapshotProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("snapshot-probe").props.children).snapshot
          .phase,
      ).toBe("READY_NO_TRIP"),
    );
    expect(
      JSON.parse(screen.getByTestId("snapshot-probe").props.children).snapshot
        .creationFailed,
    ).toBe(true);
    expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
    expect(scoped.reconcileUnknownCreate).toBeDefined();
    expect(scoped.hydrateTrip).not.toHaveBeenCalled();
    expect(onAuthInvalid).not.toHaveBeenCalled();
  });

  it("restores a pending join without fetching the approval-gated trip projection", async () => {
    const recovery: TripRecoveryRecord = {
      state: "UNKNOWN_JOIN",
      inviteCode: "ABCD2345",
      deviceId,
      commandId: "40000000-0000-4000-8000-000000000001",
    };
    const replayUnknownJoin = jest.fn(async () => ({
      tripId,
      membershipId,
      status: "PENDING_KEY" as const,
    }));
    const hydrateTrip = jest.fn(async () => lobby);
    const { runtime, scoped } = createRuntime({
      recovery,
      replayJoin: replayUnknownJoin,
      hydrate: hydrateTrip,
    });

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(screen.getByText("READY_PENDING_APPROVAL")).toBeOnTheScreen(),
    );
    expect(replayUnknownJoin).toHaveBeenCalledTimes(1);
    expect(hydrateTrip).not.toHaveBeenCalled();
    expect(scoped.reconcileUnknownCreate).not.toHaveBeenCalled();
  });

  it("keeps pending-poll auth teardown failure retryable without an unhandled rejection or private actions", async () => {
    jest.useFakeTimers();
    const originalState = AppState.currentState;
    AppState.currentState = "active";
    const replay = jest
      .fn<Promise<JoinTripResult>, []>()
      .mockResolvedValueOnce({ tripId, membershipId, status: "PENDING_KEY" })
      .mockRejectedValue(new CrewRollApiProblem("AUTH_INVALID"));
    const { runtime: base, scoped } = createRuntime({
      recovery: {
        state: "UNKNOWN_JOIN",
        inviteCode: "ABCD2345",
        deviceId,
        commandId: "40000000-0000-4000-8000-000000000001",
      },
      replayJoin: replay,
    });
    const pauseTransfers = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("NATIVE_PAUSE_FAILED"))
      .mockResolvedValue(undefined);
    const runtime: AppSessionRuntime = { ...base, pauseTransfers };
    const client = createQueryClient();
    const onAuthInvalid = jest.fn(async () => undefined);
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <SessionProbe />;
    }
    try {
      const view = await render(
        <Harness
          auth={signedIn}
          runtime={runtime}
          queryClient={client}
          onAuthInvalid={onAuthInvalid}
        >
          <Probe />
        </Harness>,
      );
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(current.snapshot.phase).toBe("READY_PENDING_APPROVAL");
      await act(() => jest.advanceTimersByTimeAsync(5_000));
      expect(current.snapshot).toEqual({
        phase: "RECOVERABLE_FAILURE",
        publicErrorCode: "SESSION_TEARDOWN_FAILED",
      });
      expect(current.actions).toBeNull();
      expect(current.queryScope).toBeNull();
      expect(onAuthInvalid).not.toHaveBeenCalled();
      expect(scoped.hydrateTrip).not.toHaveBeenCalled();
      expect(replay).toHaveBeenCalledTimes(2);

      await act(async () => current.retry());
      expect(current.snapshot.phase).toBe("SIGNED_OUT");
      expect(pauseTransfers).toHaveBeenCalledTimes(3);
      expect(onAuthInvalid).toHaveBeenCalledTimes(1);
      expect(client.getQueryCache().getAll()).toHaveLength(0);
      await view.unmount();
    } finally {
      client.clear();
      AppState.currentState = originalState;
      jest.useRealTimers();
    }
  });

  it.each([
    ["startup", "invalid"],
    ["pending poll", "invalid"],
    ["startup", "rejected"],
    ["pending poll", "rejected"],
  ] as const)(
    "returns a conclusively unavailable join to a visible usable Home from %s after %s",
    async (stage, outcome) => {
      jest.useFakeTimers();
      const previousState = AppState.currentState;
      AppState.currentState = "active";
      const replay = jest
        .fn<Promise<JoinTripResult>, []>()
        .mockRejectedValue(new JoinTripTerminalProblem());
      if (outcome === "rejected")
        replay.mockResolvedValue({ status: "REJECTED" });
      if (stage === "pending poll")
        replay.mockResolvedValueOnce({
          tripId,
          membershipId,
          status: "PENDING_KEY",
        });
      const { runtime, scoped } = createRuntime({
        recovery: {
          state: "UNKNOWN_JOIN",
          inviteCode: "ABCD2345",
          deviceId,
          commandId: "40000000-0000-4000-8000-000000000001",
        },
        replayJoin: replay,
      });
      try {
        const view = await render(
          <Harness auth={signedIn} runtime={runtime}>
            <SnapshotProbe />
          </Harness>,
        );
        await act(() => jest.advanceTimersByTimeAsync(0));
        if (stage === "pending poll")
          await act(() => jest.advanceTimersByTimeAsync(5_000));
        expect(
          JSON.parse(screen.getByTestId("snapshot-probe").props.children)
            .snapshot,
        ).toEqual({
          phase: "READY_NO_TRIP",
          deviceId,
          inviteUnavailable: true,
        });
        const count = replay.mock.calls.length;
        await act(() => jest.advanceTimersByTimeAsync(60_000));
        expect(replay).toHaveBeenCalledTimes(count);
        expect(scoped.hydrateTrip).not.toHaveBeenCalled();
        await view.unmount();
      } finally {
        AppState.currentState = previousState;
        jest.useRealTimers();
      }
    },
  );

  it("clears the unavailable notice when a new manual join succeeds", async () => {
    const requestJoin = jest
      .fn<Promise<JoinTripResult>, [string]>()
      .mockRejectedValueOnce(new JoinTripTerminalProblem())
      .mockResolvedValueOnce({ tripId, membershipId, status: "PENDING_KEY" });
    const { runtime } = createRuntime({ requestJoin });
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <SnapshotProbe />;
    }
    const view = await render(
      <Harness auth={signedIn} runtime={runtime}>
        <Probe />
      </Harness>,
    );
    await waitFor(() => expect(current.snapshot.phase).toBe("READY_NO_TRIP"));
    await act(async () => {
      await expect(current.actions!.join("ABCD2345")).rejects.toBeInstanceOf(
        JoinTripTerminalProblem,
      );
    });
    expect(current.snapshot).toEqual({
      phase: "READY_NO_TRIP",
      deviceId,
      inviteUnavailable: true,
    });
    await act(async () => {
      await current.actions!.join("EFGH6789");
    });
    expect(current.snapshot).toEqual({
      phase: "READY_PENDING_APPROVAL",
      deviceId,
    });
    await view.unmount();
  });

  it("does not replace a new account's Home with an older terminal join replay", async () => {
    let rejectReplay!: (error: unknown) => void;
    const waiting = new Promise<JoinTripResult>((_resolve, reject) => {
      rejectReplay = reject;
    });
    const { runtime: base } = createRuntime({ replayJoin: () => waiting });
    const runtime: AppSessionRuntime = {
      ...base,
      loadRecovery: async (scope) =>
        scope.clerkSubject === userId
          ? {
              state: "UNKNOWN_JOIN",
              inviteCode: "ABCD2345",
              deviceId,
              commandId: "40000000-0000-4000-8000-000000000001",
            }
          : null,
    };
    const client = createQueryClient();
    const view = await render(
      <Harness auth={signedIn} runtime={runtime} queryClient={client}>
        <SnapshotProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("snapshot-probe").props.children).snapshot
          .phase,
      ).toBe("READY_UNKNOWN_JOIN"),
    );
    await view.rerender(
      <Harness
        auth={{ ...signedIn, userId: "user_two", sessionId: "session_two" }}
        runtime={runtime}
        queryClient={client}
      >
        <SnapshotProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("snapshot-probe").props.children).snapshot
          .phase,
      ).toBe("READY_NO_TRIP"),
    );
    await act(async () => rejectReplay(new JoinTripTerminalProblem()));
    expect(
      JSON.parse(screen.getByTestId("snapshot-probe").props.children).snapshot,
    ).toEqual({ phase: "READY_NO_TRIP", deviceId });
    await view.unmount();
    client.clear();
  });

  it.each(["ACTIVE", "PENDING_KEY"] as const)(
    "publishes a pregranted guest permission after approval with an initial %s projection, retrying a lost readiness reply without leaving foreground",
    async (initialStatus) => {
      jest.useFakeTimers();
      const previousAppState = AppState.currentState;
      AppState.currentState = "active";
      const client = createQueryClient();
      const guest = (
        status: "ACTIVE" | "PENDING_KEY",
        full = false,
      ): TripView => ({
        ...lobby,
        ownerDeviceId: "10000000-0000-4000-8000-000000000002",
        version: status === "PENDING_KEY" ? 1 : full ? 3 : 2,
        members: lobby.members.map((member) => ({
          ...member,
          role: "MEMBER",
          status,
          fullPhotoLibraryAccess: full,
        })),
      });
      const pending = { tripId, membershipId, status: "PENDING_KEY" as const };
      const replay = jest
        .fn<Promise<JoinTripResult>, []>()
        .mockResolvedValue(pending);
      const hydrate = jest.fn(async () => guest(initialStatus));
      const permission = {
        kind: "FULL" as const,
        fullPhotoLibraryAccess: true as const,
        canAskAgain: false,
      };
      const photoPermission = {
        read: jest.fn(async () => permission),
        request: jest.fn(async () => permission),
        openSettings: jest.fn(async () => undefined),
      };
      const published = jest
        .fn<Promise<TripView>, [TripView, boolean]>()
        .mockRejectedValueOnce(new Error("readiness acknowledgement lost"))
        .mockResolvedValue(guest("ACTIVE", true));
      const reconcile = jest.fn(async (trip: TripView, full: boolean) => {
        if (trip.members[0]?.status !== "ACTIVE") return trip;
        return published(trip, full);
      });
      const { runtime } = createRuntime({
        recovery: {
          state: "UNKNOWN_JOIN",
          inviteCode: "ABCD2345",
          deviceId,
          commandId: "40000000-0000-4000-8000-000000000001",
        },
        replayJoin: replay,
        hydrate,
        setPhotoReadiness: createPhotoReadinessService({
          photoPermission,
          hydrate,
          reconcile,
        }),
      });
      function VisibleTrip() {
        const session = useAppSession();
        const projection = useTripProjection(tripId, { pollLobby: true });
        const readiness = usePhotoReadinessRecovery(
          session.actions,
          tripId,
          true,
          canPublishPhotoReadiness(projection.trip),
        );
        return (
          <Text testID="guest-readiness">
            {JSON.stringify({
              phase: session.snapshot.phase,
              trip: projection.trip,
              checked: readiness.checked,
              failed: readiness.failed,
              permission: session.photoPermission.kind,
            })}
          </Text>
        );
      }
      function Probe() {
        const session = useAppSession();
        return session.snapshot.phase === "READY_LOBBY" ? (
          <VisibleTrip />
        ) : (
          <SessionProbe />
        );
      }
      try {
        const view = await render(
          <QueryClientProvider client={client}>
            <Harness auth={signedIn} runtime={runtime} queryClient={client}>
              <Probe />
            </Harness>
          </QueryClientProvider>,
        );
        await act(() => jest.advanceTimersByTimeAsync(0));
        expect(screen.getByText("READY_PENDING_APPROVAL")).toBeOnTheScreen();
        expect(photoPermission.read).not.toHaveBeenCalled();
        replay.mockResolvedValue({ tripId, membershipId, status: "ACTIVE" });
        await act(() => jest.advanceTimersByTimeAsync(5_000));
        const state = () =>
          JSON.parse(screen.getByTestId("guest-readiness").props.children);
        expect(state().phase).toBe("READY_LOBBY");
        if (initialStatus === "PENDING_KEY") {
          // Hydration legitimately projects pending LOBBY membership. A later
          // poll must cross the readiness boundary even though phase is stable.
          expect(photoPermission.read).not.toHaveBeenCalled();
          hydrate.mockResolvedValue(guest("ACTIVE"));
          await act(() => jest.advanceTimersByTimeAsync(5_000));
        }
        expect(published).toHaveBeenCalledTimes(1);
        expect(state().failed).toBe(true);
        await act(() => jest.advanceTimersByTimeAsync(2_000));
        expect(state()).toMatchObject({
          phase: "READY_LOBBY",
          checked: true,
          failed: false,
          permission: "FULL",
          trip: {
            members: [{ status: "ACTIVE", fullPhotoLibraryAccess: true }],
          },
        });
        expect(published).toHaveBeenCalledTimes(2);
        expect(published.mock.calls.every(([, full]) => full)).toBe(true);
        expect(photoPermission.request).not.toHaveBeenCalled();
        expect(photoPermission.openSettings).not.toHaveBeenCalled();
        expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
        expect(AppState.currentState).toBe("active");
        await view.unmount();
      } finally {
        client.clear();
        AppState.currentState = previousAppState;
        jest.useRealTimers();
      }
    },
  );

  it("polls a pending join only in foreground and retries hydration after approval without replaying again", async () => {
    jest.useFakeTimers();
    const originalAppState = AppState.currentState;
    AppState.currentState = "active";
    let change: ((state: AppStateStatus) => void) | undefined;
    const listener = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, handler) => {
        change = handler;
        return { remove: jest.fn() };
      });
    const pending = { tripId, membershipId, status: "PENDING_KEY" as const };
    const replay = jest
      .fn<Promise<JoinTripResult>, []>()
      .mockResolvedValue(pending);
    const hydrate = jest.fn(async () => lobby);
    const { runtime } = createRuntime({
      recovery: {
        state: "UNKNOWN_JOIN",
        inviteCode: "ABCD2345",
        deviceId,
        commandId: "40000000-0000-4000-8000-000000000001",
      },
      replayJoin: replay,
      hydrate,
    });
    try {
      const view = await render(
        <Harness auth={signedIn} runtime={runtime}>
          <SessionProbe />
        </Harness>,
      );
      await waitFor(() =>
        expect(screen.getByText("READY_PENDING_APPROVAL")).toBeOnTheScreen(),
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000);
      });
      expect(replay).toHaveBeenCalledTimes(2);
      expect(hydrate).not.toHaveBeenCalled();
      await act(async () => {
        change!("background");
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(replay).toHaveBeenCalledTimes(2);
      replay.mockResolvedValue({ tripId, membershipId, status: "ACTIVE" });
      hydrate.mockRejectedValueOnce(new CrewRollApiProblem("INTERNAL_ERROR"));
      await act(async () => {
        change!("active");
      });
      expect(replay).toHaveBeenCalledTimes(3);
      expect(hydrate).toHaveBeenCalledTimes(1);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByText(`READY_LOBBY:${tripId}`)).toBeOnTheScreen();
      expect(replay).toHaveBeenCalledTimes(3);
      expect(hydrate).toHaveBeenCalledTimes(2);
      await view.unmount();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(replay).toHaveBeenCalledTimes(3);
    } finally {
      AppState.currentState = originalAppState;
      listener.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(["approved", "rejected", "ended"] as const)(
    "restores a server-only pending membership and follows %s without a local join record",
    async (resolution) => {
      jest.useFakeTimers();
      const originalAppState = AppState.currentState;
      AppState.currentState = "active";
      let change: ((state: AppStateStatus) => void) | undefined;
      const listener = jest
        .spyOn(AppState, "addEventListener")
        .mockImplementation((_event, handler) => {
          change = handler;
          return { remove: jest.fn() };
        });
      const pending: TripListResponse["items"][number] = {
        id: tripId,
        name: lobby.name,
        status: "ACTIVE",
        participation: "JOINING",
        role: "MEMBER",
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: lobby.endsAt,
        leftAt: null,
        sharingPaused: false,
        onThisDevice: true,
        memberCount: 2,
        savedPhotoCount: 0,
      };
      const listTrips = jest
        .fn<Promise<TripListResponse>, []>()
        .mockResolvedValue({ items: [pending] });
      const hydrate = jest.fn(async () => ({
        ...lobby,
        status: "ACTIVE" as const,
      }));
      const { runtime: base, scoped } = createRuntime({ hydrate });
      const runtime: AppSessionRuntime = {
        ...base,
        createScopedTripSession: () => ({ ...scoped, listTrips }),
      };
      try {
        const view = await render(
          <Harness auth={signedIn} runtime={runtime}>
            <SessionProbe />
          </Harness>,
        );
        await waitFor(() =>
          expect(screen.getByText("READY_PENDING_APPROVAL")).toBeOnTheScreen(),
        );
        expect(hydrate).not.toHaveBeenCalled();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(5_000);
        });
        expect(listTrips).toHaveBeenCalledTimes(2);
        expect(hydrate).not.toHaveBeenCalled();
        await act(async () => {
          change!("background");
          await jest.advanceTimersByTimeAsync(30_000);
        });
        expect(listTrips).toHaveBeenCalledTimes(2);
        listTrips.mockResolvedValue({
          items:
            resolution === "rejected"
              ? []
              : [
                  {
                    ...pending,
                    participation:
                      resolution === "approved" ? "JOINED" : "LEFT",
                  },
                ],
        });
        await act(async () => change!("active"));
        expect(
          screen.getByText(
            resolution === "approved"
              ? `READY_ACTIVE:${tripId}`
              : "READY_NO_TRIP",
          ),
        ).toBeOnTheScreen();
        expect(hydrate).toHaveBeenCalledTimes(
          resolution === "approved" ? 1 : 0,
        );
        expect(scoped.replayUnknownJoin).not.toHaveBeenCalled();
        await view.unmount();
        const lastCount = listTrips.mock.calls.length;
        await act(async () => {
          await jest.advanceTimersByTimeAsync(30_000);
        });
        expect(listTrips).toHaveBeenCalledTimes(lastCount);
      } finally {
        AppState.currentState = originalAppState;
        listener.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it("lets an active native trip win without erasing or replaying a pending record", async () => {
    const recovery: TripRecoveryRecord = {
      state: "UNKNOWN_CREATE",
      tripId: "018f22c4-6e80-7000-8000-000000000099",
      commandId: "40000000-0000-4000-8000-000000000001",
      ownerInviteCode: "ABCD2345",
    };
    const hydrateTrip = jest.fn(async () => ({
      ...lobby,
      status: "ACTIVE" as const,
    }));
    const { runtime, scoped } = createRuntime({
      activeTripId: tripId,
      recovery,
      hydrate: hydrateTrip,
    });

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(screen.getByText(`READY_ACTIVE:${tripId}`)).toBeOnTheScreen(),
    );
    expect(hydrateTrip).toHaveBeenCalledWith(tripId);
    expect(scoped.reconcileUnknownCreate).not.toHaveBeenCalled();
    expect(scoped.replayUnknownJoin).not.toHaveBeenCalled();
    expect(Object.keys(runtime)).not.toContain("clearRecovery");
  });

  it("clears account-scoped foreground state and provisions again on a session change", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(["private", userId], { token: "private" });
    const cancelQueries = jest.spyOn(queryClient, "cancelQueries");
    const clear = jest.spyOn(queryClient, "clear");
    const first = createRuntime();
    const view = await render(
      <Harness
        auth={signedIn}
        queryClient={queryClient}
        runtime={first.runtime}
      >
        <SessionProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );

    await view.rerender(
      <Harness
        auth={{
          isLoaded: true,
          isSignedIn: true,
          userId: "user_two",
          sessionId: "session_two",
        }}
        queryClient={queryClient}
        runtime={first.runtime}
      >
        <SessionProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(first.runtime.provisionCurrentDevice).toHaveBeenCalledTimes(2),
    );
    expect(cancelQueries).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("keeps the signed-in account after a key-provider 503 and retries without refreshing or clearing its session", async () => {
    const getToken = jest.fn(async () => "same-valid-clerk-token");
    const fetcher = jest
      .fn(
        async () =>
          new Response(
            JSON.stringify({ termsVersion: "2026-09-24", accepted: true }),
          ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Service unavailable",
            status: 503,
            detail: "Required service dependencies are unavailable.",
            instance: "/problems/requests/50000000-0000-4000-8000-000000000001",
            requestId: "50000000-0000-4000-8000-000000000001",
            code: "INTERNAL_ERROR",
          }),
          { status: 503 },
        ),
      );
    const api = createCrewRollApi({
      apiBaseUrl: "https://api.crewroll.test",
      fetch: fetcher,
      sessionTokenSource: { getToken },
      sessionBinding: () => JSON.stringify([userId, sessionId]),
    });
    const { runtime } = createRuntime({
      provision: async () => {
        await api.getAccountPolicy();
        return { deviceId, identity };
      },
    });
    const onAuthInvalid = jest.fn();
    let current!: ReturnType<typeof useAppSession>;
    function Probe() {
      const session = useAppSession();
      useLayoutEffect(() => {
        current = session;
      }, [session]);
      return <SessionProbe />;
    }
    const view = await render(
      <Harness auth={signedIn} runtime={runtime} onAuthInvalid={onAuthInvalid}>
        <Probe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("RECOVERABLE_FAILURE")).toBeOnTheScreen(),
    );
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getToken.mock.calls).toEqual([[]]);

    await act(async () => current.retry());
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getToken.mock.calls).toEqual([[], []]);
    await view.unmount();
  });

  it("fails AUTH_INVALID closed to signed out and exposes no raw metadata", async () => {
    const queryClient = createQueryClient();
    const onAuthInvalid = jest.fn(async () => undefined);
    const reconcileCreate = jest.fn(async () => {
      const problem = new CrewRollApiProblem("AUTH_INVALID") as Error & {
        detail?: string;
        requestId?: string;
      };
      problem.detail = "private detail";
      problem.requestId = "private request";
      throw problem;
    });
    const { runtime } = createRuntime({
      recovery: {
        state: "UNKNOWN_CREATE",
        tripId,
        commandId: "40000000-0000-4000-8000-000000000001",
        ownerInviteCode: "ABCD2345",
      },
      reconcileCreate,
    });

    await render(
      <Harness
        auth={signedIn}
        onAuthInvalid={onAuthInvalid}
        queryClient={queryClient}
        runtime={runtime}
      >
        <SessionProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(screen.getByText("SIGNED_OUT")).toBeOnTheScreen(),
    );
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/private|requestId/i);
  });

  it("keeps TripView only in the exact opaque account/device Query key", async () => {
    const queryClient = createQueryClient();
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
    });

    await render(
      <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
        <SnapshotProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(
        String(screen.getByTestId("snapshot-probe").props.children),
      ).toContain("READY_LOBBY"),
    );
    const queries = queryClient.getQueryCache().getAll();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.queryKey).toEqual([
      "trip",
      expect.stringMatching(/^account-scope-/),
      deviceId,
      tripId,
    ]);
    expect(JSON.stringify(queries[0]?.queryKey)).not.toMatch(
      new RegExp(`${userId}|${sessionId}`),
    );
    expect(queries[0]?.state.data).toEqual(lobby);
    expect(
      JSON.parse(String(screen.getByTestId("snapshot-probe").props.children)),
    ).toEqual({
      ownerInviteCode: "ABCD2345",
      snapshot: {
        deviceId,
        phase: "READY_LOBBY",
        tripId,
      },
    });
  });

  it.each(["FULL", "SETTINGS_REQUIRED"] as const)(
    "keeps lobby actions stable while photo readiness changes to %s",
    async (kind) => {
      const permission =
        kind === "FULL"
          ? { kind, fullPhotoLibraryAccess: true as const, canAskAgain: true }
          : {
              kind,
              fullPhotoLibraryAccess: false as const,
              canAskAgain: false as const,
            };
      const { runtime } = createRuntime({
        recovery: { state: "CONFIRMED", tripId, membershipId },
        setPhotoReadiness: jest.fn(async () => ({ permission, trip: lobby })),
      });
      let current: ReturnType<typeof useAppSession> | undefined;
      function ReadinessProbe() {
        const session = useAppSession();
        useLayoutEffect(() => {
          current = session;
        }, [session]);
        return <Text>{session.snapshot.phase}</Text>;
      }
      await render(
        <Harness auth={signedIn} runtime={runtime}>
          <ReadinessProbe />
        </Harness>,
      );
      await waitFor(() =>
        expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
      );
      const actions = current!.actions!;
      await act(async () => {
        await actions.publishPhotoReadiness(tripId, false);
      });
      expect(current!.photoPermission.kind).toBe(kind);
      expect(current!.actions).toBe(actions);
      await act(async () => {
        actions.invalidatePhotoReadiness();
      });
      expect(current!.photoPermission.kind).toBe(kind);
      expect(current!.actions).toBe(actions);
    },
  );

  it("polls focused foreground trips through ending and stops when hidden", async () => {
    jest.useFakeTimers();
    const originalAppState = AppState.currentState;
    AppState.currentState = "active";
    let onAppStateChange: ((state: AppStateStatus) => void) | null = null;
    const removeAppStateListener = jest.fn();
    const addEventListener = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation(((event, listener) => {
        if (event === "change") onAppStateChange = listener;
        return { remove: removeAppStateListener };
      }) as typeof AppState.addEventListener);
    const queryClient = createQueryClient();
    let nextTrip = lobby;
    const hydrateTrip = jest.fn(async () => nextTrip);
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
      },
      hydrate: hydrateTrip,
    });

    function Projection({ pollLobby }: Readonly<{ pollLobby: boolean }>) {
      const projection = useTripProjection(tripId, { pollLobby });
      return (
        <Text testID="trip-projection">
          {projection.trip?.status ?? "NONE"}:{projection.trip?.version ?? 0}
        </Text>
      );
    }

    function ProjectionHost({ pollLobby }: Readonly<{ pollLobby: boolean }>) {
      const session = useAppSession();
      if (session.snapshot.phase !== "READY_LOBBY") {
        return <Text>{session.snapshot.phase}</Text>;
      }
      return <Projection pollLobby={pollLobby} />;
    }

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <QueryClientProvider client={queryClient}>
          <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
            <ProjectionHost pollLobby />
          </Harness>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText("LOBBY:1")).toBeOnTheScreen(),
      );
      const baseline = hydrateTrip.mock.calls.length;
      expect(baseline).toBeGreaterThanOrEqual(1);

      nextTrip = { ...lobby, name: "Osaka", version: 2 };
      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_999);
      });
      expect(hydrateTrip).toHaveBeenCalledTimes(baseline);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      await waitFor(() =>
        expect(screen.getByText("LOBBY:2")).toBeOnTheScreen(),
      );
      expect(hydrateTrip).toHaveBeenCalledTimes(baseline + 1);
      const queries = queryClient.getQueryCache().getAll();
      expect(queries).toHaveLength(1);
      expect(queries[0]?.queryKey).toEqual([
        "trip",
        expect.stringMatching(/^account-scope-/),
        deviceId,
        tripId,
      ]);
      expect(queries[0]?.state.data).toMatchObject({
        name: "Osaka",
        version: 2,
      });

      await view.rerender(
        <QueryClientProvider client={queryClient}>
          <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
            <ProjectionHost pollLobby={false} />
          </Harness>
        </QueryClientProvider>,
      );
      const blurredCalls = hydrateTrip.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(hydrateTrip).toHaveBeenCalledTimes(blurredCalls);

      await view.rerender(
        <QueryClientProvider client={queryClient}>
          <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
            <ProjectionHost pollLobby />
          </Harness>
        </QueryClientProvider>,
      );
      expect(onAppStateChange).not.toBeNull();
      await act(async () => onAppStateChange?.("background"));
      const backgroundCalls = hydrateTrip.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(hydrateTrip).toHaveBeenCalledTimes(backgroundCalls);

      const queryKey = queries[0]!.queryKey;
      nextTrip = {
        ...lobby,
        startsAt: "2030-01-01T00:00:00.000Z",
        status: "ACTIVE",
        version: 3,
      };
      await act(async () => {
        queryClient.setQueryData(queryKey, nextTrip);
        onAppStateChange?.("active");
      });
      await waitFor(() =>
        expect(screen.getByText("ACTIVE:3")).toBeOnTheScreen(),
      );
      const activeCalls = hydrateTrip.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(hydrateTrip).toHaveBeenCalledTimes(activeCalls + 2);

      await act(async () => {
        queryClient.setQueryData(queryKey, { ...lobby, version: 4 });
      });
      const unmountedCalls = hydrateTrip.mock.calls.length;
      await view.unmount();
      view = undefined;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(hydrateTrip).toHaveBeenCalledTimes(unmountedCalls);
      expect(removeAppStateListener).toHaveBeenCalled();
    } finally {
      if (view !== undefined) await view.unmount();
      addEventListener.mockRestore();
      AppState.currentState = originalAppState;
      jest.useRealTimers();
    }
  });

  it("does not expose a persisted owner invite for a mismatched or non-owner trip", async () => {
    const nonOwner: TripView = {
      ...lobby,
      currentMembershipId: "20000000-0000-4000-8000-000000000002",
      members: [
        { ...lobby.members[0]!, isCurrentMember: false },
        {
          membershipId: "20000000-0000-4000-8000-000000000002",
          role: "MEMBER",
          displayName: "Member",
          status: "ACTIVE",
          fullPhotoLibraryAccess: true,
          deviceState: "AVAILABLE",
          isCurrentMember: true,
        },
      ],
    };
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
      hydrate: jest.fn(async () => nonOwner),
    });

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <SnapshotProbe />
      </Harness>,
    );

    await waitFor(() =>
      expect(
        String(screen.getByTestId("snapshot-probe").props.children),
      ).toContain("READY_LOBBY"),
    );
    expect(screen.getByTestId("snapshot-probe")).not.toHaveTextContent(
      "ABCD2345",
    );
  });

  it("fences an in-flight projection before retiring a departed trip", async () => {
    const active: TripView = {
      ...lobby,
      status: "ACTIVE",
      startsAt: "2030-01-01T00:00:00.000Z",
    };
    let confirmDeparture!: (value: TripTransferState) => void;
    const departure = new Promise<TripTransferState>((resolve) => {
      confirmDeparture = resolve;
    });
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    let finishProjection!: (value: TripView) => void;
    const lateProjection = new Promise<TripView>((resolve) => {
      finishProjection = resolve;
    });
    const hydrate = jest
      .fn()
      .mockResolvedValueOnce(active)
      .mockReturnValue(lateProjection);
    const { runtime: baseRuntime, scoped } = createRuntime({ hydrate });
    const retireTrip = jest.fn(() => retirement);
    const services: ScopedTripSession = {
      ...scoped,
      retireTrip,
      getTripLifecycle: jest.fn(() => departure),
      listTrips: jest
        .fn()
        .mockResolvedValueOnce({
          items: [
            {
              id: tripId,
              name: active.name,
              status: "ACTIVE",
              participation: "JOINED",
              role: "OWNER",
              startsAt: active.startsAt,
              endsAt: active.endsAt,
              leftAt: null,
              sharingPaused: false,
              onThisDevice: true,
              memberCount: 1,
              savedPhotoCount: 0,
            },
          ],
        })
        .mockResolvedValue({ items: [] }),
    };
    const runtime: AppSessionRuntime = {
      ...baseRuntime,
      createScopedTripSession: () => services,
    };
    let projectionFailure: unknown;
    let pending: Promise<void> | undefined;
    function ProjectionProbe() {
      const session = useAppSession();
      return (
        <Text
          testID="projection-probe"
          onPress={() => {
            pending = session
              .loadTripProjection(tripId)
              .then(() => undefined)
              .catch((error) => {
                projectionFailure = error;
              });
          }}
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <ProjectionProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_ACTIVE")).toBeOnTheScreen(),
    );
    await act(async () =>
      screen.getByTestId("projection-probe").props.onPress(),
    );
    await act(async () =>
      confirmDeparture({
        tripId,
        version: 4,
        status: "COMPLETE",
        participation: "LEFT",
        sharingPaused: false,
        captureUntil: active.endsAt,
        excludedCaptureWindows: [],
        pendingUploads: 0,
        pendingDownloads: 0,
        deliveryDeadline: active.endsAt,
      }),
    );
    await waitFor(() => expect(retireTrip).toHaveBeenCalledWith(tripId));
    await act(async () => {
      finishProjection(active);
      await pending;
    });
    expect(projectionFailure).toEqual(new Error("TRIP_SESSION_UNAVAILABLE"));
    await act(async () => finishRetirement());
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    expect(baseRuntime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
  });

  it("shows an actionable setup failure when the initial native pause fails", async () => {
    const { runtime: baseRuntime } = createRuntime({});
    const pauseTransfers = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error("KEY_MATERIAL_LOST"))
      .mockResolvedValue(undefined);
    const runtime: AppSessionRuntime = { ...baseRuntime, pauseTransfers };
    function RetryProbe() {
      const session = useAppSession();
      return (
        <Text onPress={session.retry} testID="retry-probe">
          {session.snapshot.phase}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <RetryProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("RECOVERABLE_FAILURE")).toBeOnTheScreen(),
    );
    expect(baseRuntime.provisionCurrentDevice).not.toHaveBeenCalled();
    await act(async () => screen.getByTestId("retry-probe").props.onPress());
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    expect(pauseTransfers).toHaveBeenCalledTimes(2);
  });

  it("applies auth-invalid teardown to normal foreground actions", async () => {
    const queryClient = createQueryClient();
    const teardownOrder: string[] = [];
    const onAuthInvalid = jest.fn(async () => {
      teardownOrder.push("sign-out");
    });
    const { runtime: baseRuntime } = createRuntime({
      create: jest.fn(async () => {
        throw new CrewRollApiProblem("AUTH_INVALID");
      }),
    });
    const runtime: AppSessionRuntime = {
      ...baseRuntime,
      pauseTransfers: jest.fn(async () => {
        teardownOrder.push("pause-transfers");
      }),
    };
    let actionFailure: unknown;
    function ActionsProbe() {
      const session = useAppSession();
      return (
        <Text
          onPress={async () => {
            try {
              if (session.actions === null) throw new Error("actions closed");
              await session.actions.create({
                name: "Kyoto",
                endsAt: "2030-01-02T00:00:00.000Z",
              });
            } catch (error) {
              actionFailure = error;
            }
          }}
          testID="action-probe"
        >
          {session.snapshot.phase}:
          {session.actions === null ? "closed" : "open"}
        </Text>
      );
    }

    await render(
      <Harness
        auth={signedIn}
        onAuthInvalid={onAuthInvalid}
        queryClient={queryClient}
        runtime={runtime}
      >
        <ActionsProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP:open")).toBeOnTheScreen(),
    );
    queryClient.setQueryData(["trip", "private"], lobby);
    teardownOrder.length = 0;

    await act(async () => {
      await screen.getByTestId("action-probe").props.onPress();
    });
    expect(actionFailure).toEqual(new CrewRollApiProblem("AUTH_INVALID"));
    await waitFor(() =>
      expect(screen.getByText("SIGNED_OUT:closed")).toBeOnTheScreen(),
    );
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
    expect(teardownOrder).toEqual(["pause-transfers", "sign-out"]);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("gates the first render of a new auth binding before effects provision it", async () => {
    const neverProvisioned = new Promise<ProvisionedDevice>(() => undefined);
    const provision = jest
      .fn<Promise<ProvisionedDevice>, []>()
      .mockResolvedValueOnce({ deviceId, identity })
      .mockReturnValueOnce(neverProvisioned);
    const { runtime } = createRuntime({ provision });
    const renders: string[] = [];
    function BindingProbe({ label }: Readonly<{ label: string }>) {
      const session = useAppSession();
      renders.push(
        `${label}:${session.snapshot.phase}:${
          session.actions === null ? "closed" : "open"
        }:${session.queryScope === null ? "no-query" : "query"}:${
          session.ownerInviteCode ?? "no-invite"
        }`,
      );
      return <Text>{session.snapshot.phase}</Text>;
    }
    const view = await render(
      <Harness auth={signedIn} runtime={runtime}>
        <BindingProbe label="A" />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    renders.length = 0;

    await view.rerender(
      <Harness
        auth={{
          isLoaded: true,
          isSignedIn: true,
          userId: "user_two",
          sessionId: "session_two",
        }}
        runtime={runtime}
      >
        <BindingProbe label="B" />
      </Harness>,
    );

    expect(renders[0]).toBe("B:PROVISIONING_DEVICE:closed:no-query:no-invite");
    view.unmount();
  });
  it.each(["create", "join"] as const)(
    "does not sign out a new account when an old %s API auth failure arrives late",
    async (operation) => {
      let rejectRequest!: (reason: unknown) => void;
      const pending = new Promise<TripView>((_resolve, reject) => {
        rejectRequest = reject;
      });
      const { runtime } = createRuntime({
        create: () => pending,
        requestJoin: () =>
          pending.then(() => {
            throw new Error("unexpected resolution");
          }),
      });
      const onAuthInvalid = jest.fn(async () => undefined);
      let action: Promise<unknown> | undefined;
      function Probe() {
        const session = useAppSession();
        return (
          <Text
            testID="late-auth-action"
            onPress={() => {
              action = (
                operation === "join"
                  ? session.actions!.join("ABCD2345")
                  : session.actions!.create({
                      name: "Trip",
                      endsAt: "2030-01-02T00:00:00.000Z",
                    })
              ).catch(() => undefined);
            }}
          >
            {session.snapshot.phase}
          </Text>
        );
      }
      const view = await render(
        <Harness
          auth={signedIn}
          runtime={runtime}
          onAuthInvalid={onAuthInvalid}
        >
          <Probe />
        </Harness>,
      );
      await waitFor(() =>
        expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
      );
      await act(async () => {
        screen.getByTestId("late-auth-action").props.onPress();
      });
      await view.rerender(
        <Harness
          auth={{
            isLoaded: true,
            isSignedIn: true,
            userId: "user_two",
            sessionId: "session_two",
          }}
          runtime={runtime}
          onAuthInvalid={onAuthInvalid}
        >
          <Probe />
        </Harness>,
      );
      await waitFor(() =>
        expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
      );
      await act(async () => {
        rejectRequest(new CrewRollApiProblem("AUTH_INVALID"));
        await action;
      });
      expect(onAuthInvalid).not.toHaveBeenCalled();
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen();
    },
  );

  it("does not sign out a new account when an old transfer-pause finishes late", async () => {
    let releasePause!: () => void;
    const paused = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const onAuthInvalid = jest.fn(async () => undefined);
    const { runtime: baseRuntime } = createRuntime({
      create: jest.fn(async () => {
        throw new CrewRollApiProblem("AUTH_INVALID");
      }),
    });
    let pauses = 0;
    const pauseTransfers = jest.fn(async () => {
      if (++pauses === 2) await paused;
    });
    const runtime: AppSessionRuntime = { ...baseRuntime, pauseTransfers };
    let action: Promise<void> | undefined;
    function Probe() {
      const session = useAppSession();
      return (
        <Text
          testID="late-pause-action"
          onPress={() => {
            action = session
              .actions!.create({
                name: "Trip",
                endsAt: "2030-01-02T00:00:00.000Z",
              })
              .then(
                () => undefined,
                () => undefined,
              );
          }}
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    const view = await render(
      <Harness auth={signedIn} runtime={runtime} onAuthInvalid={onAuthInvalid}>
        <Probe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    await act(async () => {
      screen.getByTestId("late-pause-action").props.onPress();
    });
    await waitFor(() => expect(pauseTransfers).toHaveBeenCalledTimes(2));
    await view.rerender(
      <Harness
        auth={{
          isLoaded: true,
          isSignedIn: true,
          userId: "user_two",
          sessionId: "session_two",
        }}
        runtime={runtime}
        onAuthInvalid={onAuthInvalid}
      >
        <Probe />
      </Harness>,
    );
    await waitFor(() =>
      expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      releasePause();
      await action;
    });
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen();
  });

  it("tears down a direct auth-invalid join action exactly once", async () => {
    const queryClient = createQueryClient();
    const onAuthInvalid = jest.fn(async () => undefined);
    const requestJoin = jest.fn(async () => {
      throw new CrewRollApiProblem("AUTH_INVALID");
    });
    const { runtime } = createRuntime({ requestJoin });
    let actionFailure: unknown;
    function ActionsProbe() {
      const session = useAppSession();
      return (
        <Text
          onPress={async () => {
            try {
              if (session.actions === null) throw new Error("actions closed");
              await session.actions.join("ABCD2345");
            } catch (error) {
              actionFailure = error;
            }
          }}
          testID="join-action-probe"
        >
          {session.snapshot.phase}:
          {session.actions === null ? "closed" : "open"}
        </Text>
      );
    }

    await render(
      <Harness
        auth={signedIn}
        onAuthInvalid={onAuthInvalid}
        queryClient={queryClient}
        runtime={runtime}
      >
        <ActionsProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP:open")).toBeOnTheScreen(),
    );
    queryClient.setQueryData(["trip", "private"], lobby);

    await act(async () => {
      await screen.getByTestId("join-action-probe").props.onPress();
    });

    expect(actionFailure).toEqual(new CrewRollApiProblem("AUTH_INVALID"));
    expect(requestJoin).toHaveBeenCalledWith("ABCD2345");
    expect(screen.getByText("SIGNED_OUT:closed")).toBeOnTheScreen();
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("surfaces an unbranded invalid-invite failure without inferring terminal recovery", async () => {
    const requestJoin = jest.fn(async () => {
      throw new CrewRollApiProblem("INVITE_INVALID");
    });
    const { runtime } = createRuntime({ requestJoin });
    const onAuthInvalid = jest.fn();
    let actionFailure: unknown;
    function JoinProbe() {
      const session = useAppSession();
      return (
        <Text
          onPress={async () => {
            try {
              if (session.actions === null) throw new Error("actions closed");
              await session.actions.join("ABCD2345");
            } catch (error) {
              actionFailure = error;
            }
          }}
          testID="invalid-join-probe"
        >
          {JSON.stringify(session.snapshot)}
        </Text>
      );
    }

    await render(
      <Harness auth={signedIn} runtime={runtime} onAuthInvalid={onAuthInvalid}>
        <JoinProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("invalid-join-probe").props.children)
          .phase,
      ).toBe("READY_NO_TRIP"),
    );
    await act(async () => {
      await screen.getByTestId("invalid-join-probe").props.onPress();
    });

    expect(actionFailure).toEqual(new CrewRollApiProblem("INVITE_INVALID"));
    expect(requestJoin).toHaveBeenCalledWith("ABCD2345");
    expect(
      JSON.parse(screen.getByTestId("invalid-join-probe").props.children),
    ).toEqual({ phase: "READY_NO_TRIP", deviceId });
    expect(onAuthInvalid).not.toHaveBeenCalled();
  });

  it("copies only the invite code and reports a clipboard failure to its caller", async () => {
    const copy = jest
      .spyOn(Clipboard, "setStringAsync")
      .mockResolvedValue(true);
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
    });
    function InviteProbe() {
      const session = useAppSession();
      return (
        <Text testID="copy-invite" onPress={session.copyOwnerInvite}>
          {session.snapshot.phase}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <InviteProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
    );
    await expect(
      screen.getByTestId("copy-invite").props.onPress(),
    ).resolves.toBeUndefined();
    expect(copy).toHaveBeenCalledWith("ABCD2345");
    copy.mockResolvedValue(false);
    await expect(
      screen.getByTestId("copy-invite").props.onPress(),
    ).rejects.toThrow("Clipboard unavailable");
    copy.mockRestore();
  });

  it("routes readiness AUTH_INVALID through shared sign-out teardown", async () => {
    const onAuthInvalid = jest.fn(async () => undefined);
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
      setPhotoReadiness: jest.fn(async () => {
        throw new CrewRollApiProblem("AUTH_INVALID");
      }),
    });
    function ReadinessProbe() {
      const session = useAppSession();
      return (
        <Text
          testID="readiness-probe"
          onPress={() =>
            void session.actions
              ?.publishPhotoReadiness(tripId, false)
              .catch(() => undefined)
          }
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} onAuthInvalid={onAuthInvalid} runtime={runtime}>
        <ReadinessProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
    );
    await act(async () =>
      screen.getByTestId("readiness-probe").props.onPress(),
    );
    await waitFor(() =>
      expect(screen.getByText("SIGNED_OUT")).toBeOnTheScreen(),
    );
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
  });

  it("blocks immediate Start in the same tick as foreground invalidation", async () => {
    const { runtime, scoped } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
    });
    let immediateStartFailure: unknown;
    function ImmediateStartProbe() {
      const session = useAppSession();
      return (
        <Text
          testID="immediate-start-probe"
          onPress={async () => {
            if (session.actions === null) return;
            await session.actions.publishPhotoReadiness(tripId, false);
            session.actions.invalidatePhotoReadiness();
            try {
              await session.actions.start(tripId);
            } catch (error) {
              immediateStartFailure = error;
            }
          }}
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <ImmediateStartProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
    );
    await act(async () =>
      screen.getByTestId("immediate-start-probe").props.onPress(),
    );
    expect(immediateStartFailure).toEqual(
      new Error("TRIP_SESSION_UNAVAILABLE"),
    );
    expect(scoped.startTrip).not.toHaveBeenCalled();
  });

  it("discards a late previous-trip readiness result without a Query write", async () => {
    let resolveReadiness!: (
      value: Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>,
    ) => void;
    const lateReadiness = new Promise<
      Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>
    >((resolve) => {
      resolveReadiness = resolve;
    });
    const queryClient = createQueryClient();
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
      setPhotoReadiness: jest.fn(async () => lateReadiness),
    });
    let pending: Promise<TripMutationResult> | null = null;
    function CaptureActions({
      visibleTripId,
    }: Readonly<{ visibleTripId: string }>) {
      const session = useAppSession();
      usePhotoReadinessEntryBoundary(
        session.actions,
        true,
        visibleTripId,
        session.snapshot.phase === "READY_LOBBY",
      );
      return (
        <Text
          testID="late-readiness-probe"
          onPress={() => {
            if (session.actions === null) return;
            pending = session.actions.publishPhotoReadiness(tripId, false);
          }}
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    const rendered = await render(
      <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
        <CaptureActions visibleTripId={tripId} />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
    );
    await act(async () =>
      screen.getByTestId("late-readiness-probe").props.onPress(),
    );
    if (pending === null) throw new Error("readiness did not start");
    await rendered.rerender(
      <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
        <CaptureActions visibleTripId={`${tripId.slice(0, -1)}2`} />
      </Harness>,
    );
    resolveReadiness({
      permission: {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: false,
      },
      trip: { ...lobby, name: "STALE-TRIP-A", version: 99 },
    });
    await expect(pending).rejects.toEqual(
      new Error("TRIP_SESSION_UNAVAILABLE"),
    );
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("STALE-TRIP-A");
  });

  it("discards late readiness across an auth session transition", async () => {
    let resolveReadiness!: (
      value: Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>,
    ) => void;
    const lateReadiness = new Promise<
      Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>
    >((resolve) => {
      resolveReadiness = resolve;
    });
    const queryClient = createQueryClient();
    const { runtime } = createRuntime({
      recovery: { state: "CONFIRMED", tripId, membershipId },
      setPhotoReadiness: jest.fn(async () => lateReadiness),
    });
    let pending: Promise<TripMutationResult> | null = null;
    function Probe() {
      const session = useAppSession();
      return (
        <Text
          testID="session-transition-readiness"
          onPress={() => {
            if (session.actions !== null) {
              pending = session.actions.publishPhotoReadiness(tripId, false);
            }
          }}
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    const rendered = await render(
      <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
        <Probe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
    );
    await act(async () =>
      screen.getByTestId("session-transition-readiness").props.onPress(),
    );
    if (pending === null) throw new Error("readiness did not start");
    await rendered.rerender(
      <Harness
        auth={{ ...signedIn, sessionId: "session_crewroll_2" }}
        queryClient={queryClient}
        runtime={runtime}
      >
        <Probe />
      </Harness>,
    );
    resolveReadiness({
      permission: {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: false,
      },
      trip: { ...lobby, name: "STALE-OLD-SESSION", version: 101 },
    });
    await expect(pending).rejects.toEqual(
      new Error("TRIP_SESSION_UNAVAILABLE"),
    );
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("STALE-OLD-SESSION");
  });

  it("discards late readiness across retry and device reprovision", async () => {
    let resolveReadiness!: (
      value: Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>,
    ) => void;
    const lateReadiness = new Promise<
      Awaited<ReturnType<ScopedTripSession["setPhotoReadiness"]>>
    >((resolve) => {
      resolveReadiness = resolve;
    });
    const queryClient = createQueryClient();
    const { runtime } = createRuntime({
      recovery: { state: "CONFIRMED", tripId, membershipId },
      setPhotoReadiness: jest.fn(async () => lateReadiness),
    });
    let pending: Promise<TripMutationResult> | null = null;
    function RetryProbe() {
      const session = useAppSession();
      return (
        <Text
          testID="retry-transition-readiness"
          onPress={() => {
            if (session.actions === null) return;
            pending = session.actions.publishPhotoReadiness(tripId, false);
            session.retry();
          }}
        >
          {session.snapshot.phase}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} queryClient={queryClient} runtime={runtime}>
        <RetryProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_LOBBY")).toBeOnTheScreen(),
    );
    await act(async () =>
      screen.getByTestId("retry-transition-readiness").props.onPress(),
    );
    if (pending === null) throw new Error("readiness did not start");
    resolveReadiness({
      permission: {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: false,
      },
      trip: { ...lobby, name: "STALE-OLD-DEVICE", version: 102 },
    });
    await expect(pending).rejects.toEqual(
      new Error("TRIP_SESSION_UNAVAILABLE"),
    );
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("STALE-OLD-DEVICE");
  });

  it("publishes replayed Start activation failure as safe ACTIVE retry state", async () => {
    const active = {
      ...lobby,
      status: "ACTIVE" as const,
      startsAt: "2030-01-01T00:00:00.000Z",
    };
    const failure = new TripActivationFailed("KEY_ENVELOPE_INVALID", active);
    const { runtime, scoped } = createRuntime({
      replayPendingMutation: jest.fn(async () => {
        throw failure;
      }),
    });
    function ActivationProbe() {
      const session = useAppSession();
      return (
        <Text testID="activation-probe">
          {session.snapshot.phase}:{session.activationFailureTripId ?? "none"}
        </Text>
      );
    }
    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <ActivationProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText(`READY_ACTIVE:${tripId}`)).toBeOnTheScreen(),
    );
    expect(scoped.startTrip).not.toHaveBeenCalled();
  });
});

describe("profile completion boundary", () => {
  it("preserves cold credentials but does not register until the profile is ready", async () => {
    const { runtime } = createRuntime();
    const pauseTransfers = jest.fn(async () => undefined);
    const stableRuntime = { ...runtime, pauseTransfers };
    const queryClient = createQueryClient();
    const view = (ready: boolean) => (
      <Harness
        auth={signedIn}
        runtime={stableRuntime}
        queryClient={queryClient}
        profileReady={ready}
      >
        <SessionProbe />
      </Harness>
    );
    const { rerender } = await render(view(false));
    expect(runtime.provisionCurrentDevice).not.toHaveBeenCalled();
    expect(pauseTransfers).toHaveBeenCalledWith({
      preserveDeviceSession: true,
    });
    expect(screen.getByTestId("session-probe")).toHaveTextContent(
      "PROVISIONING_DEVICE",
    );
    await rerender(view(true));
    await waitFor(() =>
      expect(screen.getByTestId("session-probe")).toHaveTextContent(
        "READY_NO_TRIP",
      ),
    );
    expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
  });

  it("pauses the previous account while the new account is missing a name", async () => {
    const { runtime } = createRuntime();
    const pauseTransfers = jest.fn(async () => undefined);
    const stableRuntime = { ...runtime, pauseTransfers };
    const queryClient = createQueryClient();
    const view = (auth: AppSessionAuthSnapshot, ready: boolean) => (
      <Harness
        auth={auth}
        runtime={stableRuntime}
        queryClient={queryClient}
        profileReady={ready}
      >
        <SessionProbe />
      </Harness>
    );
    const { rerender } = await render(view(signedIn, true));
    await waitFor(() =>
      expect(screen.getByTestId("session-probe")).toHaveTextContent(
        "READY_NO_TRIP",
      ),
    );
    const next = {
      ...signedIn,
      userId: "user_two",
      sessionId: "session_two",
    } as const;
    await rerender(view(next, false));
    expect(pauseTransfers).toHaveBeenLastCalledWith({
      preserveDeviceSession: false,
    });
    expect(runtime.provisionCurrentDevice).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("session-probe")).toHaveTextContent(
      "PROVISIONING_DEVICE",
    );
  });
});
