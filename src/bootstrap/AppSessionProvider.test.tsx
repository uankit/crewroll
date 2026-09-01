import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import {
  AppState,
  Linking,
  Share,
  Text,
  type AppStateStatus,
} from "react-native";

import { CrewRollApiProblem } from "../application/problems/crewRollApiProblem";
import type { ProvisionedDevice } from "../application/auth/ProvisionDevice";
import type { JoinTripResult } from "../application/trips/JoinTrip";
import { TripActivationFailed } from "../application/trips/ActivateObservedTrip";
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
import { sessionUiStore } from "./state/sessionUiStore";
import { usePhotoReadinessEntryBoundary } from "./photoReadinessReconciler";

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
  auth: AppSessionAuthSnapshot;
  runtime: AppSessionRuntime;
  queryClient?: QueryClient;
  onAuthInvalid?: () => void | Promise<void>;
}>;

function Harness({
  auth,
  children,
  runtime,
  queryClient = createQueryClient(),
  onAuthInvalid,
}: HarnessProps) {
  return (
    <AppSessionProvider
      auth={auth}
      fontsReady
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
    sessionUiStore.getState().clear();
  });

  it("does no native or API work while Clerk is loading or signed out", async () => {
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

  it("delegates UNKNOWN_JOIN only to Task 8 replay and hydrates confirmed membership", async () => {
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
      expect(screen.getByText(`READY_LOBBY:${tripId}`)).toBeOnTheScreen(),
    );
    expect(replayUnknownJoin).toHaveBeenCalledTimes(1);
    expect(hydrateTrip).toHaveBeenCalledWith(tripId);
    expect(scoped.reconcileUnknownCreate).not.toHaveBeenCalled();
  });

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
    sessionUiStore.getState().setPendingInvite("ABCD2345");
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
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
  });

  it("fails AUTH_INVALID closed to signed out and exposes no raw metadata", async () => {
    const queryClient = createQueryClient();
    const onAuthInvalid = jest.fn(async () => undefined);
    sessionUiStore.getState().setPendingInvite("ABCD2345");
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
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/private|requestId/i);
  });

  it("starts Task 8 join only after explicit confirmation", async () => {
    const requestJoin = jest.fn(async () => ({
      tripId,
      membershipId,
      status: "PENDING_KEY" as const,
    }));
    const { runtime } = createRuntime({ requestJoin });
    function ConfirmationProbe() {
      const session = useAppSession();
      return (
        <Text onPress={() => void session.confirmPendingInvite()}>
          {session.snapshot.phase}
        </Text>
      );
    }

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <ConfirmationProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    expect(requestJoin).not.toHaveBeenCalled();
    sessionUiStore.getState().setPendingInvite("ABCD2345");

    await act(async () => {
      screen.getByText("READY_NO_TRIP").props.onPress();
    });
    await waitFor(() => expect(requestJoin).toHaveBeenCalledWith("ABCD2345"));
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

  it("polls only the focused foreground lobby and stops for every closed condition", async () => {
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
      expect(hydrateTrip).toHaveBeenCalledTimes(activeCalls);

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

  it("preserves an explicit invite while signed out and through provisioning", async () => {
    sessionUiStore.getState().setPendingInvite("ABCD2345");
    const deferred = new Promise<ProvisionedDevice>(() => undefined);
    const { runtime } = createRuntime({ provision: () => deferred });
    const view = await render(
      <Harness auth={signedOut} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );

    await act(async () => undefined);
    expect(sessionUiStore.getState().pendingInviteCode).toBe("ABCD2345");

    await view.rerender(
      <Harness auth={signedIn} runtime={runtime}>
        <SessionProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("PROVISIONING_DEVICE")).toBeOnTheScreen(),
    );
    expect(sessionUiStore.getState().pendingInviteCode).toBe("ABCD2345");
  });

  it("applies auth-invalid teardown to normal foreground actions", async () => {
    const queryClient = createQueryClient();
    const onAuthInvalid = jest.fn(async () => undefined);
    const { runtime } = createRuntime({
      create: jest.fn(async () => {
        throw new CrewRollApiProblem("AUTH_INVALID");
      }),
    });
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
    sessionUiStore.getState().setPendingInvite("ABCD2345");

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
      await screen.getByTestId("action-probe").props.onPress();
    });
    expect(actionFailure).toEqual(new CrewRollApiProblem("AUTH_INVALID"));
    await waitFor(() =>
      expect(screen.getByText("SIGNED_OUT:closed")).toBeOnTheScreen(),
    );
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
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

  it("tears down an auth-invalid confirmed join exactly once", async () => {
    const onAuthInvalid = jest.fn(async () => undefined);
    const requestJoin = jest.fn(async () => {
      throw new CrewRollApiProblem("AUTH_INVALID");
    });
    const { runtime } = createRuntime({ requestJoin });
    function ConfirmProbe() {
      const session = useAppSession();
      return (
        <Text onPress={() => void session.confirmPendingInvite()}>
          {session.snapshot.phase}
        </Text>
      );
    }
    sessionUiStore.getState().setPendingInvite("ABCD2345");

    await render(
      <Harness auth={signedIn} onAuthInvalid={onAuthInvalid} runtime={runtime}>
        <ConfirmProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    await act(async () => {
      screen.getByText("READY_NO_TRIP").props.onPress();
    });
    await waitFor(() =>
      expect(screen.getByText("SIGNED_OUT")).toBeOnTheScreen(),
    );
    expect(requestJoin).toHaveBeenCalledWith("ABCD2345");
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
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
    sessionUiStore.getState().setPendingInvite("ABCD2345");

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
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
  });

  it("discards the matching queued invite after a conclusive invalid result", async () => {
    const requestJoin = jest.fn(async () => {
      throw new CrewRollApiProblem("INVITE_INVALID");
    });
    const { runtime } = createRuntime({ requestJoin });
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
          {session.snapshot.phase}
        </Text>
      );
    }
    sessionUiStore.getState().setPendingInvite("ABCD2345");

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <JoinProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen(),
    );
    await act(async () => {
      await screen.getByTestId("invalid-join-probe").props.onPress();
    });

    expect(actionFailure).toEqual(new CrewRollApiProblem("INVITE_INVALID"));
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
    expect(screen.getByText("READY_NO_TRIP")).toBeOnTheScreen();
  });

  it("contains native invite action failures without exposing their payload", async () => {
    const privateNativeError = new Error("private native share payload");
    const openURL = jest
      .spyOn(Linking, "openURL")
      .mockRejectedValue(privateNativeError);
    const share = jest
      .spyOn(Share, "share")
      .mockRejectedValue(privateNativeError);
    const { runtime } = createRuntime({
      recovery: {
        state: "CONFIRMED",
        tripId,
        membershipId,
        ownerInviteCode: "ABCD2345",
      },
    });
    function InviteActionsProbe() {
      const session = useAppSession();
      return (
        <>
          <Text onPress={session.openOwnerInvite} testID="open-invite">
            open
          </Text>
          <Text onPress={session.shareOwnerInvite} testID="share-invite">
            share
          </Text>
        </>
      );
    }

    await render(
      <Harness auth={signedIn} runtime={runtime}>
        <InviteActionsProbe />
      </Harness>,
    );
    await waitFor(() => expect(screen.getByText("open")).toBeOnTheScreen());

    await expect(
      screen.getByTestId("open-invite").props.onPress(),
    ).resolves.toBeUndefined();
    await expect(
      screen.getByTestId("share-invite").props.onPress(),
    ).resolves.toBeUndefined();
    expect(openURL).toHaveBeenCalledWith("airmesh://invite/ABCD2345");
    expect(share).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(screen.toJSON())).not.toMatch(
      /private|native|error/i,
    );

    openURL.mockRestore();
    share.mockRestore();
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
