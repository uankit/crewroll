import { JoinTripTerminalProblem } from "../src/application/trips/JoinTrip";
import { createTripGalleryCache } from "../src/bootstrap/tripGalleryCache";
import {
  act,
  fireEvent,
  renderRouter,
  screen,
  waitFor,
} from "expo-router/testing-library";
import { type PropsWithChildren, useSyncExternalStore } from "react";
import * as SplashScreen from "expo-splash-screen";
import * as Clipboard from "expo-clipboard";
import { View } from "react-native";

import type { AppSessionSnapshot } from "../src/bootstrap/AppSessionProvider";
import {
  startupFailed,
  startupReady,
  startupWorking,
  type AppSessionCapabilities,
  type AppStartupState,
} from "../src/bootstrap/startupState";
import type { TripInvitePreview, TripView } from "../src/domain/trips/model";

jest.mock("@clerk/expo", () => ({
  useUser: () => ({ user: { fullName: "Test Member", firstName: "Test" } }),
}));
jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("../src/bootstrap/useTripContinuity", () => ({
  useTripContinuity: () => ({
    data: { approvalRequests: [], status: "LOBBY", onThisDevice: false },
    refetch: jest.fn(),
  }),
}));

const tripId = "018f22c4-6e80-7000-8000-000000000001";
const deviceId = "10000000-0000-4000-8000-000000000001";
const ownerMembershipId = "20000000-0000-4000-8000-000000000001";
const memberMembershipId = "20000000-0000-4000-8000-000000000002";

function ownerTrip(overrides: Partial<TripView> = {}): TripView {
  return {
    id: tripId,
    version: 1,
    name: "Kyoto",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt: "2030-01-02T00:00:00.000Z",
    ownerDeviceId: deviceId,
    currentMembershipId: ownerMembershipId,
    members: [
      {
        membershipId: ownerMembershipId,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        fullPhotoLibraryAccess: true,
        deviceState: "AVAILABLE",
        isCurrentMember: true,
      },
    ],
    ...overrides,
  };
}

function pendingOwnerTrip(): TripView {
  return ownerTrip({
    version: 2,
    members: [
      ownerTrip().members[0]!,
      {
        membershipId: memberMembershipId,
        role: "MEMBER",
        displayName: "Grace Hopper",
        status: "PENDING_KEY",
        fullPhotoLibraryAccess: true,
        deviceState: "AVAILABLE",
        isCurrentMember: false,
      },
    ],
  });
}

function approvedOwnerTrip(overrides: Partial<TripView> = {}): TripView {
  return ownerTrip({
    version: 3,
    members: pendingOwnerTrip().members.map((member) =>
      member.membershipId === memberMembershipId
        ? { ...member, status: "ACTIVE" as const }
        : member,
    ),
    ...overrides,
  });
}

function pendingMemberTrip(): TripView {
  return {
    ...pendingOwnerTrip(),
    currentMembershipId: memberMembershipId,
    members: pendingOwnerTrip().members.map((member) => ({
      ...member,
      deviceState:
        member.membershipId === memberMembershipId
          ? member.deviceState
          : "NOT_DISCLOSED",
      isCurrentMember: member.membershipId === memberMembershipId,
    })),
  };
}

jest.mock("../src/infrastructure/auth/useAccountAuthentication", () => ({
  useAccountAuthentication: () => ({
    email: "",
    code: "",
    verifying: false,
    busy: false,
    error: null,
    resendSeconds: 0,
    setEmail: jest.fn(),
    setCode: jest.fn(),
    submitEmail: jest.fn(),
    verify: jest.fn(),
    resend: jest.fn(),
    editEmail: jest.fn(),
    social: jest.fn(),
  }),
}));

const invitePreview: TripInvitePreview = {
  tripId,
  name: "Kyoto",
  startsAt: null,
  endsAt: "2030-01-02T00:00:00.000Z",
  hostDisplayName: "Owner",
  members: [{ displayName: "Owner", role: "OWNER" }],
};
const mockActions = {
  ensureOwnerInvite: jest.fn(async () => ({ ownerInviteCode: null })),
  previewInvite: jest.fn(async () => invitePreview),
  approve: jest.fn(),
  reject: jest.fn(),
  create: jest.fn(),
  invalidatePhotoReadiness: jest.fn(),
  join: jest.fn(),
  openPhotoSettings: jest.fn(async () => undefined),
  publishPhotoReadiness: jest.fn(async () => ownerTrip()),
  retryActivation: jest.fn(),
  requestDeviceRecovery: jest.fn(async () => undefined),
  start: jest.fn(),
};
const mockRetry = jest.fn();
const mockSignOut = jest.fn(async () => setPhase("SIGNED_OUT"));
const mockCopyOwnerInvite = jest.fn(async () => undefined);
const mockRefresh = jest.fn(async () => undefined);
const mockReadyCapabilities: AppSessionCapabilities = Object.freeze({
  canUseAuthenticatedShell: true,
  canReadLibrary: true,
  canMutateTrip: true,
  canSharePhotos: false,
});
const mockClosedCapabilities: AppSessionCapabilities = Object.freeze({
  canUseAuthenticatedShell: false,
  canReadLibrary: false,
  canMutateTrip: false,
  canSharePhotos: false,
});

let mockProjection = {
  failed: false,
  loading: false,
  refresh: mockRefresh,
  trip: null as TripView | null,
};
let mockCurrentSession = {
  galleryCache: createTripGalleryCache(tripId),
  actions: mockActions,
  activationFailureTripId: null as string | null,
  ownerInviteCode: null as string | null,
  pendingTripPreview: null as TripInvitePreview | null,
  photoPermission: {
    kind: "FULL" as const,
    fullPhotoLibraryAccess: true as const,
    canAskAgain: true,
  },
  retry: mockRetry,
  signOut: mockSignOut,
  copyOwnerInvite: mockCopyOwnerInvite,
  snapshot: { phase: "READY_NO_TRIP", deviceId } as AppSessionSnapshot,
  startup: startupReady as AppStartupState,
  capabilities: mockReadyCapabilities,
};
let mockRevision = 0;
let mockSetupRequired = false;
let mockLibraryOnThisDevice = true;
const mockListeners = new Set<() => void>();

function mockPublish(): void {
  mockRevision += 1;
  for (const listener of mockListeners) listener();
}

function mockSubscribe(listener: () => void): () => void {
  mockListeners.add(listener);
  return () => mockListeners.delete(listener);
}

function mockGetRevision(): number {
  return mockRevision;
}

const mockUseAppSession = function useAppSession() {
  useSyncExternalStore(mockSubscribe, mockGetRevision, mockGetRevision);
  return mockCurrentSession;
};

const mockUseAccountSetup = function useAccountSetup() {
  useSyncExternalStore(mockSubscribe, mockGetRevision, mockGetRevision);
  return {
    required: mockSetupRequired,
    screen: <View testID="account-setup" />,
  };
};

jest.mock("../src/bootstrap/AccountSetup", () => ({
  useAccountSetup: mockUseAccountSetup,
}));

const mockUseTripProjection = function useTripProjection() {
  useSyncExternalStore(mockSubscribe, mockGetRevision, mockGetRevision);
  return mockProjection;
};

jest.mock("../src/bootstrap/useTripLibrary", () => ({
  useTripLibrary: () => {
    mockUseAppSession();
    const trip = mockProjection.trip;
    return {
      isPending: false,
      isError: false,
      refetch: mockRefresh,
      data: {
        items: trip
          ? [
              {
                id: trip.id,
                name: trip.name,
                status: trip.status,
                participation: [
                  "COMPLETE",
                  "INCOMPLETE_EXPIRED",
                  "CANCELLED",
                ].includes(trip.status)
                  ? "LEFT"
                  : "JOINED",
                role: "OWNER",
                sharingPaused: false,
                onThisDevice: mockLibraryOnThisDevice,
                memberCount: trip.members.length,
                savedPhotoCount: 0,
                startsAt: trip.startsAt,
                endsAt: trip.endsAt,
                leftAt: null,
              },
            ]
          : [],
      },
    };
  },
}));

jest.mock("../src/bootstrap/AppProviders", () => ({
  AppProviders: ({ children }: PropsWithChildren) => children,
}));

jest.mock("../src/bootstrap/AppSessionProvider", () => ({
  useAppSession: mockUseAppSession,
  useTripProjection: mockUseTripProjection,
  terminalJoinFailureReason: (error: unknown) =>
    jest
      .requireActual<typeof import("../src/bootstrap/AppSessionProvider")>(
        "../src/bootstrap/AppSessionProvider",
      )
      .terminalJoinFailureReason(error),
}));

jest.mock("@expo-google-fonts/manrope", () => ({
  Manrope_400Regular: "Manrope_400Regular",
  Manrope_500Medium: "Manrope_500Medium",
  Manrope_600SemiBold: "Manrope_600SemiBold",
  Manrope_700Bold: "Manrope_700Bold",
  Manrope_800ExtraBold: "Manrope_800ExtraBold",
  useFonts: () => [mockFontsLoaded, null],
}));

let mockFontsLoaded = true;

jest.mock("expo-splash-screen", () => ({
  hideAsync: jest.fn(async () => undefined),
  preventAutoHideAsync: jest.fn(async () => undefined),
}));

function setPhase(phase: AppSessionSnapshot["phase"]): void {
  let snapshot: AppSessionSnapshot;
  if (phase === "RECOVERABLE_FAILURE") {
    snapshot = { phase, publicErrorCode: "TRIP_RECOVERY_FAILED" };
  } else if (phase === "READY_LOBBY" || phase === "READY_ACTIVE") {
    snapshot = { phase, tripId, deviceId };
    mockProjection = {
      ...mockProjection,
      trip:
        phase === "READY_ACTIVE"
          ? ownerTrip({ status: "ACTIVE", startsAt: "2030-01-01T00:00:00Z" })
          : ownerTrip(),
    };
  } else if (
    phase === "READY_NO_TRIP" ||
    phase === "READY_UNKNOWN_CREATE" ||
    phase === "READY_UNKNOWN_JOIN" ||
    phase === "READY_PENDING_APPROVAL"
  ) {
    snapshot = { phase, deviceId };
  } else {
    snapshot = { phase };
  }
  let startup: AppStartupState = startupReady;
  let capabilities: AppSessionCapabilities = mockReadyCapabilities;
  switch (phase) {
    case "SIGNED_OUT":
    case "SIGNING_OUT":
    case "LOADING_FONTS_OR_CLERK":
      startup = startupWorking("account");
      capabilities = mockClosedCapabilities;
      break;
    case "PROVISIONING_DEVICE":
      startup = startupWorking("device");
      capabilities = mockClosedCapabilities;
      break;
    case "RECOVERABLE_FAILURE":
      startup = startupFailed("recovery", "TRIP_RECOVERY_FAILED", "trips");
      capabilities = mockClosedCapabilities;
      break;
    case "READY_UNKNOWN_CREATE":
    case "READY_UNKNOWN_JOIN":
      capabilities = { ...mockReadyCapabilities, canMutateTrip: false };
      break;
    case "READY_ACTIVE":
      capabilities = { ...mockReadyCapabilities, canSharePhotos: true };
      break;
    case "READY_NO_TRIP":
    case "READY_PENDING_APPROVAL":
    case "READY_LOBBY":
      break;
  }
  mockCurrentSession = {
    ...mockCurrentSession,
    snapshot,
    startup,
    capabilities,
  };
  mockPublish();
}

async function renderActualRouter(initialUrl: string) {
  const router = renderRouter("./app", { initialUrl });
  const completed = (await (router as ReturnType<typeof renderRouter> &
    PromiseLike<object>)) as Readonly<{ unmount(): Promise<void> }>;
  const routeState = {
    getPathname: () => router.getPathname(),
    unmount: async () => completed.unmount(),
  };
  await act(async () => undefined);
  return routeState;
}

describe("Expo Router mobile journey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFontsLoaded = true;
    mockSetupRequired = false;
    mockLibraryOnThisDevice = true;
    mockProjection = {
      failed: false,
      loading: false,
      refresh: mockRefresh,
      trip: null,
    };
    mockCurrentSession = {
      galleryCache: createTripGalleryCache(tripId),
      actions: mockActions,
      activationFailureTripId: null,
      ownerInviteCode: null,
      pendingTripPreview: null,
      photoPermission: {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: true,
      },
      retry: mockRetry,
      signOut: mockSignOut,
      copyOwnerInvite: mockCopyOwnerInvite,
      snapshot: { phase: "READY_NO_TRIP", deviceId },
      startup: startupReady,
      capabilities: mockReadyCapabilities,
    };
  });

  it("opens a useful authenticated shell while the phone is restoring and keeps mutation controls disabled", async () => {
    setPhase("PROVISIONING_DEVICE");
    mockCurrentSession = {
      ...mockCurrentSession,
      capabilities: {
        ...mockClosedCapabilities,
        canUseAuthenticatedShell: true,
      },
      startup: startupWorking("device"),
    };
    const router = await renderActualRouter("/");
    screen.getByTestId("trip-library-screen");
    screen.getByLabelText(/^Restoring this phone:/);
    const create = screen.getByRole("button", { name: "Start a new trip" });
    const join = screen.getByRole("button", { name: "Enter invite code" });
    expect(create).toBeDisabled();
    expect(join).toBeDisabled();
    await fireEvent.press(create);
    await fireEvent.press(join);
    expect(router.getPathname()).toBe("/");
    expect(mockActions.create).not.toHaveBeenCalled();
    expect(mockActions.join).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Your account" }));
    screen.getByTestId("account-sheet");
    screen.getByRole("button", { name: "Sign out" });
  });

  it("shows authorized trip metadata before sharing preparation finishes without declaring the phone live", async () => {
    setPhase("PROVISIONING_DEVICE");
    mockProjection = {
      ...mockProjection,
      trip: ownerTrip({ status: "ACTIVE", startsAt: "2030-01-01T00:00:00Z" }),
    };
    mockCurrentSession = {
      ...mockCurrentSession,
      startup: startupWorking("transfer"),
      capabilities: {
        ...mockReadyCapabilities,
        canMutateTrip: false,
        canSharePhotos: false,
      },
    };
    await renderActualRouter("/");
    screen.getByText("Kyoto");
    screen.getByLabelText(/^Preparing photo sharing:/);
    expect(screen.getByRole("button", { name: "Open Kyoto" })).toBeDisabled();
    expect(screen.queryByText("Live")).toBeNull();
    expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalled();
  });

  it("keeps a trip refresh failure inside Home with account access and a targeted retry", async () => {
    setPhase("RECOVERABLE_FAILURE");
    mockProjection = { ...mockProjection, trip: ownerTrip() };
    mockCurrentSession = {
      ...mockCurrentSession,
      startup: startupFailed("trips", "TRIP_LIST_FAILED", "trips"),
      capabilities: {
        ...mockReadyCapabilities,
        canMutateTrip: false,
      },
    };
    const router = await renderActualRouter("/");
    screen.getByTestId("trip-library-screen");
    screen.getByText("Kyoto");
    screen.getByRole("alert", {
      name: "Your trips couldn’t refresh. Try again.",
    });
    expect(screen.queryByText(/could not connect this phone/i)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(router.getPathname()).toBe("/");
    await fireEvent.press(screen.getByRole("button", { name: "Your account" }));
    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Get started" });
    expect(screen.queryByText("Kyoto")).toBeNull();
  });

  it("keeps one recovery action for an uncertain trip request and marks it busy only during real recovery", async () => {
    setPhase("READY_UNKNOWN_JOIN");
    mockCurrentSession = {
      ...mockCurrentSession,
      startup: startupFailed("recovery", "TRIP_RECOVERY_FAILED", "trips"),
    };
    await renderActualRouter("/");
    screen.getByRole("alert", {
      name: "Saved trip state couldn’t be restored. Try again to continue safely.",
    });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    const check = screen.getByRole("button", { name: "Check request" });
    expect(check).toBeEnabled();
    await fireEvent.press(check);
    expect(mockRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      mockCurrentSession = {
        ...mockCurrentSession,
        startup: startupWorking("recovery"),
      };
      mockPublish();
    });
    expect(
      screen.getByRole("button", { name: "Check request" }),
    ).toBeDisabled();
    screen.getByLabelText(/^Checking saved trip state:/);
    await fireEvent.press(
      screen.getByRole("button", { name: "Check request" }),
    );
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["PROVISIONING_DEVICE", "RECOVERABLE_FAILURE"] as const)(
    "routes sign-out from %s through session teardown while the shell is unavailable",
    async (phase) => {
      setPhase(phase);
      await renderActualRouter("/");
      await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      await screen.findByRole("button", { name: "Get started" });
    },
  );

  it.each(["/trips/create", "/trips/join", `/trips/${tripId}`])(
    "keeps direct entry %s on the truthful shell until its capabilities are ready",
    async (path) => {
      setPhase("PROVISIONING_DEVICE");
      mockCurrentSession = {
        ...mockCurrentSession,
        startup: startupWorking("recovery"),
        capabilities: {
          ...mockReadyCapabilities,
          canMutateTrip: false,
        },
      };
      const router = await renderActualRouter(path);
      await waitFor(() => expect(router.getPathname()).toBe("/"));
      screen.getByTestId("trip-library-screen");
      screen.getByLabelText(/^Checking saved trip state:/);
      expect(mockActions.create).not.toHaveBeenCalled();
      expect(mockActions.join).not.toHaveBeenCalled();
      expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalled();
    },
  );

  it("keeps an already open matching trip in place while its startup authority recovers", async () => {
    setPhase("READY_LOBBY");
    mockProjection = { ...mockProjection, trip: ownerTrip() };
    const router = await renderActualRouter(`/trips/${tripId}`);
    screen.getByTestId("lobby-screen");
    mockActions.ensureOwnerInvite.mockClear();
    mockActions.publishPhotoReadiness.mockClear();
    await act(async () => {
      mockCurrentSession = {
        ...mockCurrentSession,
        startup: startupWorking("recovery"),
        capabilities: { ...mockReadyCapabilities, canMutateTrip: false },
      };
      mockPublish();
    });
    expect(router.getPathname()).toBe(`/trips/${tripId}`);
    screen.getByTestId("lobby-screen");
    screen.getByLabelText(/^Checking saved trip state:/);
    expect(screen.getByRole("button", { name: "Invite crew" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start trip" })).toBeDisabled();
    expect(mockActions.ensureOwnerInvite).not.toHaveBeenCalled();
    expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalled();
  });

  it("hides a selected phone recovery request until startup mutation authority returns", async () => {
    setPhase("READY_LOBBY");
    mockLibraryOnThisDevice = false;
    const router = await renderActualRouter("/");
    await fireEvent.press(screen.getByRole("button", { name: "Open Kyoto" }));
    expect(
      screen.getByRole("button", { name: "Request device approval" }),
    ).toBeEnabled();

    await act(async () => {
      mockCurrentSession = {
        ...mockCurrentSession,
        startup: startupWorking("recovery"),
        capabilities: { ...mockReadyCapabilities, canMutateTrip: false },
      };
      mockPublish();
    });
    expect(router.getPathname()).toBe("/");
    screen.getByTestId("trip-library-screen");
    screen.getByLabelText(/^Checking saved trip state:/);
    expect(
      screen.queryByRole("button", { name: "Request device approval" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Open Kyoto" })).toBeDisabled();
    expect(mockActions.requestDeviceRecovery).not.toHaveBeenCalled();

    await act(async () => {
      mockCurrentSession = {
        ...mockCurrentSession,
        startup: startupFailed("recovery", "TRIP_RECOVERY_FAILED", "trips"),
      };
      mockPublish();
    });
    screen.getByRole("alert", {
      name: "Saved trip state couldn’t be restored. Try again to continue safely.",
    });
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(mockActions.requestDeviceRecovery).not.toHaveBeenCalled();

    await act(async () => {
      mockCurrentSession = {
        ...mockCurrentSession,
        startup: startupReady,
        capabilities: mockReadyCapabilities,
      };
      mockPublish();
    });
    // Selection survives the status screen; only confirmed authority exposes
    // the actual recovery flow and its mutation again.
    await fireEvent.press(
      screen.getByRole("button", { name: "Request device approval" }),
    );
    await waitFor(() =>
      expect(mockActions.requestDeviceRecovery).toHaveBeenCalledWith(tripId),
    );
    expect(mockActions.requestDeviceRecovery).toHaveBeenCalledTimes(1);
    expect(router.getPathname()).toBe("/");
  });

  it.each([
    "READY_NO_TRIP",
    "READY_ACTIVE",
    "READY_PENDING_APPROVAL",
    "READY_UNKNOWN_CREATE",
    "READY_UNKNOWN_JOIN",
  ] as const)(
    "offers account sign-out from Home in %s",
    async (phase) => {
      setPhase(phase);
      await renderActualRouter("/");
      await fireEvent.press(
        screen.getByRole("button", { name: "Your account" }),
      );
      screen.getByText("Test Member");
      await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
      expect(mockSignOut).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      await screen.findByRole("button", { name: "Get started" });
      expect(screen.queryByTestId("account-sheet")).toBeNull();
      expect(screen.queryByTestId("trip-library-screen")).toBeNull();
      expect(screen.queryByRole("button", { name: "Your account" })).toBeNull();
    },
    // The first case includes cold real-router rendering on CI; query deadlines stay unchanged.
    15_000,
  );

  it("keeps sign-out available when all trips are past trips", async () => {
    mockProjection = {
      ...mockProjection,
      trip: ownerTrip({ status: "COMPLETE" }),
    };
    await renderActualRouter("/");
    screen.getByText("PAST TRIPS");
    await fireEvent.press(screen.getByRole("button", { name: "Your account" }));
    screen.getByRole("button", { name: "Sign out" });
  });

  it.each(["/", "/trips/create", "/trips/join"])(
    "completes account setup before opening %s, even when device registration is already ready",
    async (path) => {
      mockSetupRequired = true;
      const router = await renderActualRouter(path);
      await waitFor(() => expect(router.getPathname()).toBe("/setup"));
      screen.getByTestId("account-setup");
      expect(screen.queryByTestId("create-trip-screen")).toBeNull();
      expect(screen.queryByTestId("join-trip-screen")).toBeNull();
      await act(() => {
        mockSetupRequired = false;
        mockPublish();
      });
      await waitFor(() => expect(router.getPathname()).toBe("/"));
      expect(screen.queryByTestId("account-setup")).toBeNull();
    },
  );

  it("restores the selected person and gallery scroll after returning through Home", async () => {
    setPhase("READY_ACTIVE");
    await renderActualRouter(`/trips/${tripId}`);
    await fireEvent.press(screen.getByRole("button", { name: "Filters" }));
    await fireEvent.press(screen.getByRole("radio", { name: "You" }));
    await fireEvent.press(screen.getByRole("button", { name: "Show photos" }));
    expect(
      mockCurrentSession.galleryCache.getSnapshot().filters.sourceMembershipId,
    ).toBe(ownerMembershipId);
    await fireEvent.scroll(screen.getByTestId("lobby-screen-scroll"), {
      nativeEvent: { contentOffset: { x: 0, y: 375 } },
    });
    expect(mockCurrentSession.galleryCache.getScrollY()).toBe(375);
    await fireEvent.press(screen.getByRole("button", { name: "Back to Home" }));
    await fireEvent.press(
      await screen.findByRole("button", { name: "Open Kyoto" }),
    );
    screen.getByRole("button", { name: "Filters · 1" });
    expect(
      screen.getByTestId("lobby-screen-scroll").props.contentOffset.y,
    ).toBe(375);
    await fireEvent.press(screen.getByRole("button", { name: "Filters · 1" }));
    expect(
      screen.getByRole("radio", { name: "You" }).props.accessibilityState
        .checked,
    ).toBe(true);
  });

  it("reveals the startup recovery screen without waiting for network authentication", async () => {
    setPhase("LOADING_FONTS_OR_CLERK");
    const router = await renderActualRouter("/");

    expect(screen.getByTestId("launch-busy")).toBeOnTheScreen();
    expect(SplashScreen.hideAsync).toHaveBeenCalled();
    await router.unmount();
  });

  it("does not leave a stalled font download covering the app with the native logo", async () => {
    jest.useFakeTimers();
    mockFontsLoaded = false;
    setPhase("LOADING_FONTS_OR_CLERK");
    const router = await renderActualRouter("/");
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(SplashScreen.hideAsync).toHaveBeenCalled();
    await router.unmount();
    jest.useRealTimers();
  });

  it.each([
    ["LOADING_FONTS_OR_CLERK", "/"],
    ["SIGNED_OUT", "/"],
    ["PROVISIONING_DEVICE", "/provision"],
    ["RECOVERABLE_FAILURE", "/provision"],
    ["READY_NO_TRIP", "/"],
    ["READY_UNKNOWN_CREATE", "/"],
    ["READY_UNKNOWN_JOIN", "/"],
    ["READY_PENDING_APPROVAL", "/"],
    ["READY_LOBBY", "/"],
    ["READY_ACTIVE", "/"],
  ] as const)(
    "keeps %s on its public or protected anchor",
    async (phase, expected) => {
      setPhase(phase);
      const router = await renderActualRouter("/");

      await waitFor(() => expect(router.getPathname()).toBe(expected));
      expect(router.getPathname()).not.toMatch(/^\/invite\//);
    },
  );

  it.each([
    ["LOADING_FONTS_OR_CLERK", "/trips/create", "/"],
    ["SIGNED_OUT", "/trips/create", "/"],
    ["PROVISIONING_DEVICE", "/trips/create", "/provision"],
    ["RECOVERABLE_FAILURE", "/trips/create", "/provision"],
    ["READY_NO_TRIP", "/sign-in", "/"],
    ["READY_UNKNOWN_CREATE", "/sign-in", "/"],
    ["READY_UNKNOWN_JOIN", "/sign-in", "/"],
    ["READY_PENDING_APPROVAL", "/sign-in", "/"],
    ["READY_LOBBY", "/sign-in", "/"],
    ["READY_ACTIVE", "/sign-in", "/"],
  ] as const)(
    "falls back from a denied route in %s through the static anchor",
    async (phase, deniedUrl, expected) => {
      setPhase(phase);
      const router = await renderActualRouter(deniedUrl);

      await waitFor(() => expect(router.getPathname()).toBe(expected));
      expect(router.getPathname()).not.toMatch(/^\/invite\//);
    },
  );

  it("renders a fixed retry state when the first trip Query fails", async () => {
    setPhase("READY_LOBBY");
    mockProjection = { ...mockProjection, failed: true, trip: null };
    await renderActualRouter(`/trips/${tripId}`);

    expect(screen.getByTestId("trip-load-failed")).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        "Trip unavailable: CrewRoll could not refresh this trip.",
      ),
    ).toBeOnTheScreen();
  });

  it("opens a trip from Home and returns without ending sharing", async () => {
    setPhase("READY_LOBBY");
    mockProjection = { ...mockProjection, trip: ownerTrip() };
    const router = await renderActualRouter("/");

    expect(screen.getByTestId("trip-library-screen")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Open Kyoto" }));
    await waitFor(() => expect(router.getPathname()).toBe(`/trips/${tripId}`));
    await fireEvent.press(screen.getByRole("button", { name: "Back to Home" }));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(
      screen.getByRole("button", { name: "Open Kyoto" }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Start a new trip" }),
    ).toBeDisabled();
  });

  it("opens the existing create flow after a past trip and skips already granted photo access", async () => {
    setPhase("READY_NO_TRIP");
    mockProjection = {
      ...mockProjection,
      trip: ownerTrip({
        id: "018f22c4-6e80-7000-8000-000000000002",
        status: "COMPLETE",
      }),
    };
    mockActions.create.mockImplementationOnce(async () => {
      mockProjection = { ...mockProjection, trip: ownerTrip() };
      mockCurrentSession = {
        ...mockCurrentSession,
        snapshot: { phase: "READY_LOBBY", deviceId, tripId },
      };
      mockPublish();
      return { kind: "READY", tripId };
    });
    const router = await renderActualRouter("/");
    screen.getByText("PAST TRIPS");
    await fireEvent.press(
      screen.getByRole("button", { name: "Start a new trip" }),
    );
    await waitFor(() => expect(router.getPathname()).toBe("/trips/create"));
    await fireEvent.changeText(screen.getByLabelText("Trip name"), "Next trip");
    await fireEvent.press(screen.getByRole("button", { name: "Create trip" }));
    await waitFor(() => expect(router.getPathname()).toBe(`/trips/${tripId}`));
    await waitFor(() =>
      expect(mockActions.publishPhotoReadiness).toHaveBeenCalledWith(
        tripId,
        false,
      ),
    );
    expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalledWith(
      tripId,
      true,
    );
    expect(screen.queryByTestId("photo-access-screen")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Invite crew" }),
    ).toBeOnTheScreen();
  });

  it("starts manual joining empty and ignores a code supplied in a URL", async () => {
    setPhase("READY_NO_TRIP");
    await renderActualRouter("/trips/join?code=ABCD2345");
    expect(screen.getByLabelText("Invite code").props.value).toBe("");
    expect(mockActions.previewInvite).not.toHaveBeenCalled();
    expect(mockActions.join).not.toHaveBeenCalled();
  });

  it("lets a guest replace a conclusively invalid manually entered code", async () => {
    setPhase("READY_NO_TRIP");
    mockActions.join.mockImplementationOnce(async () => {
      throw new JoinTripTerminalProblem();
    });
    await renderActualRouter("/trips/join");
    await fireEvent.changeText(
      screen.getByLabelText("Invite code"),
      "ABCD2345",
    );

    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await fireEvent.press(
      screen.getByRole("button", { name: "Request to join" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Invite unavailable.")).toBeOnTheScreen(),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Use another code" }),
    );
    expect(screen.getByLabelText("Invite code").props.value).toBe("");
  });

  it.each(["INVITE_INVALID", "TRIP_REJOIN_UNAVAILABLE", "CONFLICT"])(
    "keeps an unproven %s join failure on the same-request recovery screen",
    async (code) => {
      setPhase("READY_NO_TRIP");
      mockActions.join.mockImplementationOnce(async () => {
        throw { kind: "API_PROBLEM", code, serverStatus: 409 };
      });
      await renderActualRouter("/trips/join");
      await fireEvent.changeText(
        screen.getByLabelText("Invite code"),
        "ABCD2345",
      );
      await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
      await fireEvent.press(
        screen.getByRole("button", { name: "Request to join" }),
      );
      await waitFor(() =>
        expect(screen.getByText("Checking your request.")).toBeOnTheScreen(),
      );
      expect(
        screen.queryByRole("button", {
          name: /Use another code|Back to your trips/,
        }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Check join request" }),
      ).toBeOnTheScreen();
    },
  );

  it("returns a proven rejoin refusal to usable Home through the real router", async () => {
    setPhase("READY_NO_TRIP");
    mockActions.join.mockImplementationOnce(async () => {
      throw new JoinTripTerminalProblem("TRIP_REJOIN_UNAVAILABLE");
    });
    const router = await renderActualRouter("/trips/join");
    await fireEvent.changeText(
      screen.getByLabelText("Invite code"),
      "ABCD2345",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await fireEvent.press(
      screen.getByRole("button", { name: "Request to join" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Can’t rejoin this trip.")).toBeOnTheScreen(),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Back to your trips" }),
    );
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(
      screen.getByRole("button", { name: "Enter invite code" }),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Checking your request.")).toBeNull();
  });

  it("wires manual create and join screens through pending approval before opening the approved trip", async () => {
    const events: string[] = [];
    mockActions.create.mockImplementationOnce(async (input) => {
      events.push(`create:${input.name}`);
      mockProjection = { ...mockProjection, trip: ownerTrip() };
      mockCurrentSession = {
        ...mockCurrentSession,
        ownerInviteCode: "ABCD2345",
        snapshot: { phase: "READY_LOBBY", deviceId, tripId },
      };
      mockPublish();
      return { kind: "READY", tripId };
    });

    const owner = await renderActualRouter("/");
    await fireEvent.press(screen.getByRole("button", { name: "Start a trip" }));
    await waitFor(() => expect(owner.getPathname()).toBe("/trips/create"));
    await fireEvent.changeText(screen.getByLabelText("Trip name"), "Kyoto");
    await fireEvent.press(screen.getByRole("button", { name: "Create trip" }));
    await waitFor(() => expect(mockActions.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(owner.getPathname()).toBe(`/trips/${tripId}`));
    await fireEvent.press(screen.getByRole("button", { name: "Invite crew" }));
    expect(screen.getByText("ABCD 2345")).toBeOnTheScreen();
    await owner.unmount();
    mockActions.publishPhotoReadiness.mockClear();

    mockProjection = { ...mockProjection, trip: null };
    mockCurrentSession = {
      ...mockCurrentSession,
      ownerInviteCode: null,
      snapshot: { phase: "READY_NO_TRIP", deviceId },
    };
    mockActions.join.mockImplementationOnce(async (code) => {
      events.push(`join:${code}`);
      mockCurrentSession = {
        ...mockCurrentSession,
        pendingTripPreview: invitePreview,
        snapshot: { phase: "READY_PENDING_APPROVAL", deviceId },
      };
      mockPublish();
      return { kind: "PENDING_APPROVAL" };
    });

    const invitee = await renderActualRouter("/trips/join");
    expect(screen.getByLabelText("Invite code").props.value).toBe("");
    await fireEvent.changeText(
      screen.getByLabelText("Invite code"),
      "ABCD2345",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Request to join" }),
      ).toBeOnTheScreen(),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Request to join" }),
    );
    await waitFor(() => expect(invitee.getPathname()).toBe("/"));
    screen.getByRole("header", { name: "Waiting for Owner." });
    screen.getByText("No photos are shared until you’re approved.");
    expect(screen.queryByTestId("lobby-screen")).toBeNull();
    expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalled();
    await act(async () => {
      mockProjection = {
        ...mockProjection,
        trip: {
          ...pendingMemberTrip(),
          version: 3,
          members: pendingMemberTrip().members.map((member) => ({
            ...member,
            status: "ACTIVE",
          })),
        },
      };
      mockCurrentSession = {
        ...mockCurrentSession,
        pendingTripPreview: null,
        snapshot: { phase: "READY_LOBBY", deviceId, tripId },
      };
      mockPublish();
    });
    await waitFor(() => expect(invitee.getPathname()).toBe(`/trips/${tripId}`));
    expect(screen.getByTestId("lobby-screen")).toBeOnTheScreen();
    expect(mockActions.join).toHaveBeenCalledTimes(1);
    expect(mockActions.publishPhotoReadiness).toHaveBeenCalledWith(
      tripId,
      false,
    );
    expect(events).toEqual(["create:Kyoto", "join:ABCD2345"]);
    expect(JSON.stringify(mockProjection.trip)).not.toMatch(
      /wrapped|envelope|commandId|authenticationPublicKey|e2eePublicKey/i,
    );
  });

  it("wires owner copy, approval, Start, and safe active projection updates", async () => {
    setPhase("READY_LOBBY");
    mockProjection = { ...mockProjection, trip: pendingOwnerTrip() };
    mockCurrentSession = {
      ...mockCurrentSession,
      ownerInviteCode: "ABCD2345",
    };
    mockActions.approve.mockImplementationOnce(async () => {
      mockProjection = { ...mockProjection, trip: approvedOwnerTrip() };
      mockPublish();
      return { kind: "READY", tripId };
    });
    mockActions.start.mockImplementationOnce(async () => {
      mockProjection = {
        ...mockProjection,
        trip: approvedOwnerTrip({
          status: "ACTIVE",
          startsAt: "2030-01-01T00:00:00.000Z",
          version: 4,
        }),
      };
      mockCurrentSession = {
        ...mockCurrentSession,
        snapshot: { phase: "READY_ACTIVE", deviceId, tripId },
      };
      mockPublish();
      return { kind: "READY", tripId };
    });
    await renderActualRouter(`/trips/${tripId}`);

    await fireEvent.press(screen.getByRole("button", { name: "Invite crew" }));
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("ABCD2345");
    await fireEvent.press(
      screen.getByRole("button", { name: "Close Invite your crew" }),
    );

    expect(screen.queryByRole("button", { name: /Notifications/ })).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Approve Grace Hopper" }),
    );
    await waitFor(() =>
      expect(mockActions.approve).toHaveBeenCalledWith(
        tripId,
        memberMembershipId,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start trip" })).toBeEnabled(),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Start trip" }));
    await waitFor(() => expect(mockActions.start).toHaveBeenCalledWith(tripId));
    await waitFor(() =>
      expect(screen.queryByText("Start trip")).not.toBeOnTheScreen(),
    );
  });

  it("opens the approved guest trip and publishes an existing grant without reopening the app", async () => {
    setPhase("READY_PENDING_APPROVAL");
    const router = await renderActualRouter("/");
    expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalled();
    await act(async () => {
      setPhase("READY_LOBBY");
      mockProjection = {
        ...mockProjection,
        trip: {
          ...pendingMemberTrip(),
          members: pendingMemberTrip().members.map((member) => ({
            ...member,
            status: "ACTIVE" as const,
          })),
        },
      };
      mockPublish();
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/trips/${tripId}`));
    await waitFor(() =>
      expect(mockActions.publishPhotoReadiness).toHaveBeenCalledWith(
        tripId,
        false,
      ),
    );
    expect(screen.queryByTestId("photo-access-screen")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Back to Home" }));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(mockActions.join).not.toHaveBeenCalled();
  });

  it("publishes an existing grant when approval arrives in the already visible lobby", async () => {
    setPhase("READY_LOBBY");
    mockProjection = { ...mockProjection, trip: pendingMemberTrip() };
    const router = await renderActualRouter(`/trips/${tripId}`);
    expect(mockActions.publishPhotoReadiness).not.toHaveBeenCalled();

    await act(async () => {
      mockProjection = {
        ...mockProjection,
        trip: {
          ...pendingMemberTrip(),
          version: 3,
          members: pendingMemberTrip().members.map((member) =>
            member.isCurrentMember
              ? { ...member, status: "ACTIVE", fullPhotoLibraryAccess: false }
              : member,
          ),
        },
      };
      mockPublish();
    });
    await waitFor(() =>
      expect(mockActions.publishPhotoReadiness).toHaveBeenCalledWith(
        tripId,
        false,
      ),
    );
    expect(router.getPathname()).toBe(`/trips/${tripId}`);
    expect(mockCurrentSession.snapshot.phase).toBe("READY_LOBBY");
    expect(mockActions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    expect(mockActions.openPhotoSettings).not.toHaveBeenCalled();
    expect(mockActions.join).not.toHaveBeenCalled();
    expect(screen.queryByTestId("photo-access-screen")).toBeNull();

    await act(async () => {
      mockProjection = {
        ...mockProjection,
        trip: { ...mockProjection.trip!, version: 4 },
      };
      mockPublish();
    });
    expect(mockActions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
  });

  it("enables Start when polling observes the guest's photo readiness without reopening the host", async () => {
    setPhase("READY_LOBBY");
    mockProjection = {
      ...mockProjection,
      trip: approvedOwnerTrip({
        members: approvedOwnerTrip().members.map((member) =>
          member.role === "MEMBER"
            ? { ...member, fullPhotoLibraryAccess: false }
            : member,
        ),
      }),
    };
    const router = await renderActualRouter(`/trips/${tripId}`);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start trip" })).toBeDisabled(),
    );
    await act(async () => {
      mockProjection = {
        ...mockProjection,
        trip: approvedOwnerTrip({ version: 4 }),
      };
      mockPublish();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start trip" })).toBeEnabled(),
    );
    expect(router.getPathname()).toBe(`/trips/${tripId}`);
    expect(mockActions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    expect(mockActions.start).not.toHaveBeenCalled();
  });

  it("retries activation by hydration without issuing Start again", async () => {
    setPhase("READY_ACTIVE");
    mockProjection = {
      ...mockProjection,
      trip: ownerTrip({
        status: "ACTIVE",
        startsAt: "2030-01-01T00:00:00.000Z",
      }),
    };
    mockCurrentSession = {
      ...mockCurrentSession,
      activationFailureTripId: tripId,
    };
    mockActions.retryActivation.mockImplementationOnce(async () => {
      mockCurrentSession = {
        ...mockCurrentSession,
        activationFailureTripId: null,
      };
      mockPublish();
      return { kind: "READY", tripId };
    });
    await renderActualRouter(`/trips/${tripId}`);

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(mockActions.retryActivation).toHaveBeenCalledWith(tripId),
    );
    expect(mockActions.start).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText("Try again")).not.toBeOnTheScreen(),
    );
  });

  it("contains rejecting native invite actions without exposing their payload", async () => {
    setPhase("READY_LOBBY");
    mockProjection = { ...mockProjection, trip: ownerTrip() };
    mockCurrentSession = {
      ...mockCurrentSession,
      ownerInviteCode: "ABCD2345",
    };
    const privateFailure = "native-clipboard-secret-canary-981b8b42";
    jest
      .mocked(Clipboard.setStringAsync)
      .mockRejectedValueOnce(new Error(privateFailure));
    await renderActualRouter(`/trips/${tripId}`);

    await fireEvent.press(screen.getByRole("button", { name: "Invite crew" }));
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    await act(async () => undefined);
    // Match the injected secret, not asset paths such as /private/tmp/....
    expect(JSON.stringify(screen.toJSON())).not.toContain(privateFailure);
    screen.getByRole("alert", {
      name: "The code couldn’t be copied. Try again.",
    });
    const retry = screen.getByRole("button", { name: "Copy code" });
    expect(retry).toBeEnabled();
    await fireEvent.press(retry);
    await screen.findByRole("button", { name: "Code copied" });
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(2);
  });
});
