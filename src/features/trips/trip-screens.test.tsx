import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";

import type { TripView } from "../../domain/trips/model";
import {
  CrewRollThemeProvider,
  darkColors,
  spacing,
} from "../../design-system";
import { LobbyScreen, type LobbyScreenProps } from "./index";

type HostElement = Readonly<{
  parent: HostElement | null;
  props: Readonly<Record<string, unknown>>;
}>;

function isInsideScrollableScreen(element: HostElement): boolean {
  let ancestor = element.parent;
  while (ancestor !== null) {
    if (ancestor.props.contentInsetAdjustmentBehavior === "automatic") {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

const ownerMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const memberMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";

function ownerTrip(overrides: Partial<TripView> = {}): TripView {
  return {
    id: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
    version: 3,
    name: "Weekend in Goa",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
    currentMembershipId: ownerMembershipId,
    members: [
      {
        membershipId: ownerMembershipId,
        role: "OWNER",
        displayName: "Ada Lovelace",
        status: "ACTIVE",
        fullPhotoLibraryAccess: true,
        deviceState: "AVAILABLE",
        isCurrentMember: true,
      },
      {
        membershipId: memberMembershipId,
        role: "MEMBER",
        displayName: "Grace Hopper",
        status: "PENDING_KEY",
        fullPhotoLibraryAccess: false,
        deviceState: "MISSING",
        isCurrentMember: false,
      },
    ],
    ...overrides,
  };
}

function eligibleOwnerTrip(overrides: Partial<TripView> = {}): TripView {
  const base = ownerTrip();
  return {
    ...base,
    members: [
      base.members[0]!,
      {
        ...base.members[1]!,
        status: "ACTIVE",
        fullPhotoLibraryAccess: true,
        deviceState: "AVAILABLE",
      },
    ],
    ...overrides,
  };
}

function invite(
  overrides: Partial<NonNullable<LobbyScreenProps["invite"]>> = {},
) {
  return {
    code: "ABCD2345",
    url: "airmesh://invite/ABCD2345",
    onOpenLink: jest.fn(),
    onShare: jest.fn(),
    ...overrides,
  };
}

function renderLobby(overrides: Partial<LobbyScreenProps> = {}) {
  return render(
    <LobbyScreen
      endsLabel="2 September, 5:30 pm"
      trip={ownerTrip()}
      {...overrides}
    />,
  );
}

describe("LobbyScreen", () => {
  test("lets only the owner share the readable invite and approve the nominated pending member", async () => {
    const onOpenLink = jest.fn();
    const onShare = jest.fn();
    const onApproveMember = jest.fn();
    const screen = await renderLobby({
      invite: invite({ onOpenLink, onShare }),
      onApproveMember,
    });

    screen.getByRole("header", { name: "Weekend in Goa" });
    screen.getByText("ABCD2345");
    const link = screen.getByRole("link", {
      name: "airmesh://invite/ABCD2345",
    });
    const share = screen.getByRole("button", { name: "Share invite" });
    const approve = screen.getByRole("button", {
      name: "Approve Grace Hopper",
    });

    await fireEvent.press(link);
    await fireEvent.press(share);
    await fireEvent.press(approve);

    expect(onOpenLink).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onApproveMember).toHaveBeenCalledWith(memberMembershipId);
    expect(screen.getByLabelText("Status: Waiting for approval")).toBeTruthy();
    screen.getByText("Approve every waiting member before starting.");
    expect(
      screen.getByRole("button", { name: "Start trip" }).props
        .accessibilityState,
    ).toEqual({ busy: false, disabled: true });
  });

  test("keeps invite, approval, and Start controls owner-only before inspecting redacted devices", async () => {
    const owner = ownerTrip().members[0]!;
    const member = ownerTrip().members[1]!;
    const trip = ownerTrip({
      currentMembershipId: memberMembershipId,
      members: [
        {
          ...owner,
          deviceState: "NOT_DISCLOSED",
          isCurrentMember: false,
        },
        {
          ...member,
          status: "PENDING_KEY",
          deviceState: "AVAILABLE",
          isCurrentMember: true,
        },
      ],
    });
    const onApproveMember = jest.fn();
    const onStart = jest.fn();
    const screen = await renderLobby({
      trip,
      invite: invite(),
      onApproveMember,
      onStart,
    });

    screen.getByText("Waiting for the owner");
    screen.getByText(
      "Your request is in. You can join once the owner approves this phone.",
    );
    expect(screen.queryByText("ABCD2345")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    expect(screen.queryByText(/device.*missing/i)).toBeNull();
    expect(onApproveMember).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  test.each([
    [
      {
        status: "PENDING_KEY",
        fullPhotoLibraryAccess: false,
        deviceState: "MISSING",
      },
      "Status: Waiting for approval",
      "Approve every waiting member before starting.",
    ],
    [
      {
        status: "ACTIVE",
        fullPhotoLibraryAccess: false,
        deviceState: "AVAILABLE",
      },
      "Status: Needs full photo access",
      "Everyone needs full photo access before the trip can start.",
    ],
    [
      {
        status: "ACTIVE",
        fullPhotoLibraryAccess: true,
        deviceState: "MISSING",
      },
      "Status: Secure access needed",
      "A member is still waiting for secure access.",
    ],
  ] as const)(
    "maps exact readiness to a disabled Start blocker",
    async (memberState, readinessLabel, blockerCopy) => {
      const base = ownerTrip();
      const screen = await renderLobby({
        trip: ownerTrip({
          members: [base.members[0]!, { ...base.members[1]!, ...memberState }],
        }),
        onStart: jest.fn(),
      });

      screen.getByLabelText(readinessLabel);
      screen.getByText(blockerCopy);
      expect(
        screen.getByRole("button", { name: "Start trip" }).props
          .accessibilityState,
      ).toEqual({ busy: false, disabled: true });
    },
  );

  test("enables one owner Start action only for the exact eligible projection", async () => {
    const onStart = jest.fn();
    const screen = await renderLobby({
      trip: eligibleOwnerTrip(),
      onStart,
    });

    screen.getByText("Everyone is approved and has full photo access.");
    const start = screen.getByRole("button", { name: "Start trip" });
    expect(start.props.accessibilityState).toEqual({
      busy: false,
      disabled: false,
    });

    await fireEvent.press(start);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("disables all repeat trip mutations while approval or Start is active", async () => {
    const onApproveMember = jest.fn();
    const pending = await renderLobby({
      approvingMembershipId: memberMembershipId,
      onApproveMember,
      onStart: jest.fn(),
    });

    const approve = pending.getByRole("button", {
      name: "Approve Grace Hopper",
    });
    const blockedStart = pending.getByRole("button", { name: "Start trip" });
    expect(approve.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(blockedStart.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(approve);
    expect(onApproveMember).not.toHaveBeenCalled();
    await pending.unmount();

    const onStart = jest.fn();
    const eligible = await renderLobby({
      trip: eligibleOwnerTrip(),
      onStart,
      starting: true,
    });
    const start = eligible.getByRole("button", { name: "Start trip" });
    expect(start.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    await fireEvent.press(start);
    expect(onStart).not.toHaveBeenCalled();
  });

  test("shows a safe actionable activation blocker without raw native detail", async () => {
    const onRetry = jest.fn();
    const activation = {
      kind: "failed",
      onRetry,
      retrying: true,
      error: new Error("wrappedKey native stack trip-id-private"),
    } as unknown as NonNullable<LobbyScreenProps["activation"]>;
    const screen = await renderLobby({
      trip: eligibleOwnerTrip({
        status: "ACTIVE",
        startsAt: "2026-09-01T12:00:00.000Z",
      }),
      activation,
    });

    screen.getByText("Trip started, but this phone needs attention");
    screen.getByText(
      "CrewRoll could not activate automatic photo delivery on this phone. Try again.",
    );
    expect(
      screen.queryByText(/wrappedKey|native stack|trip-id-private/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    const retry = screen.getByRole("button", {
      name: "Try activation again",
    });
    expect(retry.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    await fireEvent.press(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("keeps owner actions in the scroll tree at 200 percent under RTL, dark, reduced motion", async () => {
    const screen = await render(
      <CrewRollThemeProvider reduceMotion scheme="dark">
        <View style={{ direction: "rtl" }}>
          <LobbyScreen
            endsLabel="Wednesday, 2 September 2026 at 5:30 pm India Standard Time"
            invite={invite()}
            onStart={jest.fn()}
            trip={eligibleOwnerTrip({
              name: "A very long family and friends weekend by the sea",
            })}
          />
        </View>
      </CrewRollThemeProvider>,
    );

    const heading = screen.getByRole("header", {
      name: "A very long family and friends weekend by the sea",
    });
    const share = screen.getByRole("button", { name: "Share invite" });
    const start = screen.getByRole("button", { name: "Start trip" });
    expect(heading.props.allowFontScaling).toBe(true);
    expect(heading.props.maxFontSizeMultiplier).toBe(2);
    expect(isInsideScrollableScreen(share as unknown as HostElement)).toBe(
      true,
    );
    expect(isInsideScrollableScreen(start as unknown as HostElement)).toBe(
      true,
    );
    expect(StyleSheet.flatten(start.props.style)).toEqual(
      expect.objectContaining({
        minHeight: spacing.xxxl,
        minWidth: spacing.xxxl,
      }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("lobby-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
    expect(screen.getAllByLabelText("Status: Ready")).toHaveLength(2);
  });
});
