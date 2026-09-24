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
import { sessionUiStore } from "../src/bootstrap/state/sessionUiStore";
import type { TripView } from "../src/domain/trips/model";

jest.mock("@clerk/expo", () => ({
  useUser: () => ({ user: { fullName: "Test Member", firstName: "Test" } }),
}));
jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("../src/bootstrap/useTripContinuity", () => ({
  useTripContinuity: () => ({
    data: { approvalRequests: [] },
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

const mockActions = {
  ensureOwnerInvite: jest.fn(async () => ({ ownerInviteCode: null })),
  previewInvite: jest.fn(async () => ({
    tripId,
    name: "Kyoto",
    startsAt: null,
    endsAt: "2030-01-02T00:00:00.000Z",
    hostDisplayName: "Owner",
    members: [{ displayName: "Owner", role: "OWNER" }],
  })),
  approve: jest.fn(),
  reject: jest.fn(),
  create: jest.fn(),
  invalidatePhotoReadiness: jest.fn(),
  join: jest.fn(),
  openPhotoSettings: jest.fn(async () => undefined),
  publishPhotoReadiness: jest.fn(async () => ownerTrip()),
  retryActivation: jest.fn(),
  start: jest.fn(),
};
const mockRetry = jest.fn();
const mockSignOut = jest.fn(async () => setPhase("SIGNED_OUT"));
const mockConfirmPendingInvite = jest.fn();
const mockOpenOwnerInvite = jest.fn(async () => undefined);
const mockCopyOwnerInvite = jest.fn(async () => undefined);
const mockRefresh = jest.fn(async () => undefined);

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
  confirmPendingInvite: mockConfirmPendingInvite,
  openOwnerInvite: mockOpenOwnerInvite,
  ownerInviteCode: null as string | null,
  photoPermission: {
    kind: "FULL" as const,
    fullPhotoLibraryAccess: true as const,
    canAskAgain: true,
  },
  retry: mockRetry,
  signOut: mockSignOut,
  copyOwnerInvite: mockCopyOwnerInvite,
  snapshot: { phase: "READY_NO_TRIP", deviceId } as AppSessionSnapshot,
};
let mockRevision = 0;
let mockSetupRequired = false;
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
                onThisDevice: true,
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
  mockCurrentSession = { ...mockCurrentSession, snapshot };
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
      confirmPendingInvite: mockConfirmPendingInvite,
      openOwnerInvite: mockOpenOwnerInvite,
      ownerInviteCode: null,
      photoPermission: {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: true,
      },
      retry: mockRetry,
      signOut: mockSignOut,
      copyOwnerInvite: mockCopyOwnerInvite,
      snapshot: { phase: "READY_NO_TRIP", deviceId },
    };
    sessionUiStore.getState().clear();
  });

  it.each([
    "READY_NO_TRIP",
    "READY_ACTIVE",
    "READY_PENDING_APPROVAL",
    "READY_UNKNOWN_CREATE",
    "READY_UNKNOWN_JOIN",
  ] as const)("offers account sign-out from Home in %s", async (phase) => {
    setPhase(phase);
    await renderActualRouter("/");
    await fireEvent.press(screen.getByRole("button", { name: "Your account" }));
    screen.getByText("Test Member");
    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    expect(mockSignOut).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "Get started" });
    expect(screen.queryByTestId("account-sheet")).toBeNull();
    expect(screen.queryByTestId("trip-library-screen")).toBeNull();
    expect(screen.queryByRole("button", { name: "Your account" })).toBeNull();
  });

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

  it("preserves a guest's invite while photo setup is completed before joining", async () => {
    mockSetupRequired = true;
    const router = await renderActualRouter("/invite/ABCD2345");
    await waitFor(() => expect(router.getPathname()).toBe("/setup"));
    expect(sessionUiStore.getState().pendingInviteCode).toBe("ABCD2345");
    expect(mockActions.join).not.toHaveBeenCalled();
    await act(() => {
      mockSetupRequired = false;
      mockPublish();
    });
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(sessionUiStore.getState().pendingInviteCode).toBe("ABCD2345");
    expect(mockActions.join).not.toHaveBeenCalled();
  });

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

  it("uses only the public explicit invite route through auth continuation", async () => {
    setPhase("SIGNED_OUT");
    const router = await renderActualRouter("/invite/ABCD2345");

    await waitFor(() => expect(router.getPathname()).toBe("/invite/ABCD2345"));
    expect(screen.getByTestId("invite-auth-continuation")).toBeOnTheScreen();
  });

  it("clears a prior valid invite when an invalid explicit link arrives", async () => {
    sessionUiStore.getState().setPendingInvite("ABCD2345");
    setPhase("SIGNED_OUT");
    await renderActualRouter("/invite/not-valid");

    await waitFor(() =>
      expect(screen.getByTestId("invalid-invite")).toBeOnTheScreen(),
    );
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
  });

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

  it("does not retain a conclusive invalid invite through the actual route", async () => {
    setPhase("READY_NO_TRIP");
    mockActions.join.mockImplementationOnce(async () => {
      sessionUiStore.getState().clear();
      throw { kind: "API_PROBLEM", code: "INVITE_INVALID" };
    });
    await renderActualRouter("/invite/ABCD2345");
    await waitFor(() =>
      expect(screen.getByLabelText("Invite code").props.value).toBe("ABCD2345"),
    );

    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await fireEvent.press(
      screen.getByRole("button", { name: "Request to join" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Invite unavailable.")).toBeOnTheScreen(),
    );
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Use another code" }),
    );
    expect(screen.getByLabelText("Invite code").props.value).toBe("");
  });

  it("runs a deterministic owner-create and invitee-join journey through the actual screens", async () => {
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

    mockProjection = { ...mockProjection, trip: null };
    mockCurrentSession = {
      ...mockCurrentSession,
      ownerInviteCode: null,
      snapshot: { phase: "READY_NO_TRIP", deviceId },
    };
    mockActions.join.mockImplementationOnce(async (code) => {
      events.push(`join:${code}`);
      mockProjection = { ...mockProjection, trip: pendingMemberTrip() };
      mockCurrentSession = {
        ...mockCurrentSession,
        snapshot: { phase: "READY_LOBBY", deviceId, tripId },
      };
      mockPublish();
      return { kind: "READY", tripId };
    });

    const invitee = await renderActualRouter("/invite/ABCD2345");
    await waitFor(() => expect(invitee.getPathname()).toBe("/trips/join"));
    expect(screen.getByLabelText("Invite code").props.value).toBe("ABCD2345");
    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Request to join" }),
      ).toBeOnTheScreen(),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Request to join" }),
    );
    await waitFor(() => expect(invitee.getPathname()).toBe(`/trips/${tripId}`));
    expect(screen.getByTestId("lobby-screen")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Waiting for your host. Photos begin when the trip starts.",
      ),
    ).toBeOnTheScreen();
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
    jest
      .mocked(Clipboard.setStringAsync)
      .mockRejectedValueOnce(new Error("private clipboard payload"));
    await renderActualRouter(`/trips/${tripId}`);

    await fireEvent.press(screen.getByRole("button", { name: "Invite crew" }));
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    await act(async () => undefined);
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/private|payload/i);
  });
});
