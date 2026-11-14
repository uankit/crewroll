import type { TripLifecycleBody, TripTransferState } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { useLayoutEffect } from "react";
import { AppState, Text } from "react-native";

import {
  createJoinTrip,
  JoinTripTerminalProblem,
} from "../application/trips/JoinTrip";
import type { TripView } from "../domain/trips/model";
import { HomeScreen } from "../features/home";
import { createCrewRollApi } from "../infrastructure/api/crewRollApi";
import { TripRecoveryStore } from "../infrastructure/storage/tripRecoveryStore";
import {
  AppSessionProvider,
  useAppSession,
  type AppSessionRuntime,
  type ScopedTripSession,
} from "./AppSessionProvider";

const tripId = "018f22c4-6e80-7000-8000-000000000001";
const deviceId = "10000000-0000-4000-8000-000000000001";
const oldMember = "20000000-0000-4000-8000-000000000001";
const newMember = "20000000-0000-4000-8000-000000000002";
const hostDevice = "10000000-0000-4000-8000-000000000002";
const scope = { clerkSubject: "test-guest", deviceId };
const identity: NativeDeviceIdentity = {
  protocolVersion: 1,
  installationId: "30000000-0000-4000-8000-000000000001",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey:
    "BBDQzXEkLyd0T0dl5zDy1x4U2A6dHw9Gw6aY8PKnCz6S+ddt5K7AqQ6zW7VQk1PFQ/NYz7t0b6F0j1w2G3H4I5J=",
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  e2eeKeyVersion: 1,
};

// Actual API decoding, JoinTrip and durable store are composed with the real
// session provider. Native/host/server behavior is an explicit test boundary;
// backend re-enrollment authorization is independently covered by real PG tests.
async function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      values.delete(key);
    },
  };
  const makeStore = () =>
    new TripRecoveryStore({
      secureStore: storage,
      digest: { sha256: async () => "a".repeat(64) },
    });
  let store = makeStore();
  await store.save(scope, {
    state: "CONFIRMED",
    tripId,
    membershipId: oldMember,
  });
  let left = false;
  let mode: "terminal" | "ambiguous" | "pending" | "active" = "terminal";
  let sequence = 0;
  const commands: string[] = [];
  const fetcher = jest.fn(async (input: RequestInfo | URL) => {
    if (
      !(input instanceof Request) ||
      input.method !== "POST" ||
      new URL(input.url).pathname !== "/v1/trips/join-requests"
    )
      throw new Error("Unexpected test endpoint");
    expect(await input.json()).toEqual({ inviteCode: "ABCD2345", deviceId });
    commands.push(input.headers.get("Idempotency-Key")!);
    if (mode === "ambiguous") throw new Error("test interrupted response");
    if (mode === "terminal")
      return new Response(
        JSON.stringify({
          code: "TRIP_REJOIN_UNAVAILABLE",
          status: 409,
          type: "https://crewroll.app/problems/trip-rejoin-unavailable",
          title: "Trip cannot be rejoined",
          detail: "Use another trip.",
          instance: "/v1/trips/join-requests",
          requestId: "40000000-0000-4000-8000-000000000001",
        }),
        {
          status: 409,
          headers: { "content-type": "application/problem+json" },
        },
      );
    return new Response(
      JSON.stringify({
        membershipId: newMember,
        tripId,
        deviceId,
        status: mode === "active" ? "ACTIVE" : "PENDING_KEY",
        keyEpoch: 1,
        tripKeyEnvelope: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const api = createCrewRollApi({
    apiBaseUrl: "https://api.example",
    fetch: fetcher,
    sessionTokenSource: { getToken: async () => "test-session" },
  });
  function trip(): TripView {
    return {
      id: tripId,
      version: mode === "active" ? 3 : 1,
      name: "Test trip",
      status: "LOBBY",
      release: { mode: "IMMEDIATE" },
      startsAt: null,
      endsAt: "2030-01-02T00:00:00.000Z",
      ownerDeviceId: hostDevice,
      currentMembershipId: mode === "active" ? newMember : oldMember,
      members: [
        {
          membershipId: mode === "active" ? newMember : oldMember,
          role: "MEMBER",
          displayName: "Guest",
          status: "ACTIVE",
          fullPhotoLibraryAccess: false,
          deviceState: "AVAILABLE",
          isCurrentMember: true,
        },
      ],
    };
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const runtime: AppSessionRuntime = {
    invalidatePendingSetup: jest.fn(),
    provisionCurrentDevice: async () => ({ deviceId, identity }),
    getNativeSnapshot: async () => ({ activeTripId: null }),
    loadRecovery: (binding) => store.load(binding),
    createScopedTripSession: () => {
      const join = createJoinTrip({
        afterAccepted: { afterAccepted: async () => undefined },
        api,
        deviceId,
        random: {
          getBytes: async (length) => new Uint8Array(length).fill(++sequence),
        },
        recoveryStore: store,
        scope,
      });
      const services: ScopedTripSession = {
        requestJoin: join.request,
        replayUnknownJoin: join.replayUnknownJoin,
        hydrateTrip: async () => trip(),
        listTrips: async () => ({
          items: [
            {
              id: tripId,
              name: "Test trip",
              status: "LOBBY",
              role: "MEMBER",
              startsAt: null,
              endsAt: "2030-01-02T00:00:00.000Z",
              leftAt: left ? "2030-01-01T00:00:00.000Z" : null,
              participation: left ? "LEFT" : "JOINED",
              sharingPaused: false,
              onThisDevice: true,
              memberCount: 2,
              savedPhotoCount: 0,
            },
          ],
        }),
        retireTrip: async () => store.clear(scope),
        changeTripLifecycle: async (
          _id,
          body: TripLifecycleBody,
        ): Promise<TripTransferState> => {
          expect(body.action).toBe("LEAVE");
          left = true;
          return {
            tripId,
            version: 2,
            status: "LOBBY",
            participation: "LEFT",
            sharingPaused: false,
            captureUntil: "2030-01-01T00:00:00.000Z",
            excludedCaptureWindows: [],
            pendingUploads: 0,
            pendingDownloads: 0,
            deliveryDeadline: "2030-01-02T00:00:00.000Z",
          };
        },
        replayPendingMutation: async () => null,
        previewInvite: jest.fn(),
        createTrip: jest.fn(),
        reconcileUnknownCreate: jest.fn(),
        approveMember: jest.fn(),
        setPhotoReadiness: jest.fn(),
        openPhotoSettings: jest.fn(),
        startTrip: jest.fn(),
      };
      return services;
    },
  };
  let current!: ReturnType<typeof useAppSession>;
  function Probe() {
    const session = useAppSession();
    useLayoutEffect(() => {
      current = session;
    }, [session]);
    return (
      <>
        <Text testID="rejoin-phase">{session.snapshot.phase}</Text>
        {session.snapshot.phase === "READY_NO_TRIP" ? (
          <HomeScreen
            rejoinUnavailable={session.snapshot.rejoinUnavailable === true}
            onCreateTrip={jest.fn()}
            onJoinTrip={jest.fn()}
          />
        ) : null}
      </>
    );
  }
  const mount = () =>
    render(
      <QueryClientProvider client={client}>
        <AppSessionProvider
          auth={{
            isLoaded: true,
            isSignedIn: true,
            userId: scope.clerkSubject,
            sessionId: "test-session",
          }}
          fontsReady
          provisionInput={{
            apiBaseUrl: "https://api.example",
            appVersion: "1.0.6",
            platform: "ios",
          }}
          queryClient={client}
          runtime={runtime}
        >
          <Probe />
        </AppSessionProvider>
      </QueryClientProvider>,
    );
  return {
    mount,
    client,
    commands,
    fetcher,
    current: () => current,
    mode(value: typeof mode) {
      mode = value;
    },
    load: () => store.load(scope),
    reopenStore() {
      store = makeStore();
    },
  };
}

async function leave(f: Awaited<ReturnType<typeof fixture>>) {
  await waitFor(() => expect(f.current().snapshot.phase).toBe("READY_LOBBY"));
  await act(async () => {
    await f.current().actions!.changeTripLifecycle(tripId, {
      action: "LEAVE",
      expectedVersion: 1,
    });
  });
  await act(() => f.current().retry());
  await waitFor(() => expect(f.current().snapshot.phase).toBe("READY_NO_TRIP"));
  await expect(f.load()).resolves.toBeNull();
}

it.each(["immediate", "after interrupted response"] as const)(
  "keeps a left-trip refusal terminal across relaunch and Retry (%s)",
  async (when) => {
    const f = await fixture();
    let view = await f.mount();
    try {
      await leave(f);
      if (when === "after interrupted response") f.mode("ambiguous");
      await act(async () => {
        await expect(
          f.current().actions!.join("ABCD2345"),
        ).rejects.toBeInstanceOf(
          when === "immediate" ? JoinTripTerminalProblem : Error,
        );
      });
      if (when === "after interrupted response") {
        await expect(f.load()).resolves.toMatchObject({
          state: "UNKNOWN_JOIN",
          commandId: f.commands[0],
        });
      } else await expect(f.load()).resolves.toBeNull();
      await view.unmount();
      f.reopenStore();
      f.mode("terminal");
      view = await f.mount();
      await waitFor(() =>
        expect(f.current().snapshot.phase).toBe("READY_NO_TRIP"),
      );
      if (when === "after interrupted response") {
        expect(f.commands).toHaveLength(2);
        expect(f.commands[1]).toBe(f.commands[0]);
        expect(
          screen.getByText(
            "You can’t rejoin this trip. You can join a different trip.",
          ),
        ).toBeOnTheScreen();
      }
      await expect(f.load()).resolves.toBeNull();
      const requests = f.commands.length;
      await act(() => f.current().retry());
      await waitFor(() =>
        expect(f.current().snapshot.phase).toBe("READY_NO_TRIP"),
      );
      expect(f.commands).toHaveLength(requests);
      expect(
        screen.getByRole("button", { name: "Enter invite code" }),
      ).toBeEnabled();
    } finally {
      await view.unmount();
      f.client.clear();
    }
  },
);

it("keeps a legitimate fresh pre-Start rejoin pending until fresh host approval", async () => {
  jest.useFakeTimers();
  const oldAppState = AppState.currentState;
  AppState.currentState = "active";
  const f = await fixture();
  let view = await f.mount();
  try {
    await leave(f);
    f.mode("pending");
    await act(async () => {
      await expect(f.current().actions!.join("ABCD2345")).resolves.toEqual({
        kind: "PENDING_APPROVAL",
      });
    });
    expect(f.current().snapshot.phase).toBe("READY_PENDING_APPROVAL");
    await expect(f.load()).resolves.toMatchObject({
      state: "UNKNOWN_JOIN",
      commandId: f.commands[0],
    });
    await view.unmount();
    f.reopenStore();
    view = await f.mount();
    await waitFor(() =>
      expect(f.current().snapshot.phase).toBe("READY_PENDING_APPROVAL"),
    );
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1]).toBe(f.commands[0]);
    f.mode("active");
    await act(() => jest.advanceTimersByTimeAsync(5_000));
    expect(f.current().snapshot.phase).toBe("READY_LOBBY");
    await expect(f.load()).resolves.toEqual({
      state: "CONFIRMED",
      tripId,
      membershipId: newMember,
    });
    expect(new Set(f.commands).size).toBe(1);
  } finally {
    await view.unmount();
    f.client.clear();
    AppState.currentState = oldAppState;
    jest.useRealTimers();
  }
});
