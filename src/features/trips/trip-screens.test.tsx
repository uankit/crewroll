import { fireEvent, render } from "@testing-library/react-native";
import { Platform, StyleSheet, View } from "react-native";

import {
  TRIP_CREATE_DEFAULT_DURATION_MS,
  TRIP_CREATE_MAX_DURATION_MS,
} from "../../application/trips/tripCreateWindow";
import type { TripView } from "../../domain/trips/model";
import {
  CrewRollThemeProvider,
  darkColors,
  spacing,
} from "../../design-system";
import {
  CreateTripScreen,
  LobbyScreen,
  TripEndField,
  combineTripEndDate,
  combineTripEndTime,
  createDefaultTripEnd,
  tripEndValidationMessage,
  type CreateTripScreenProps,
  type LobbyScreenProps,
} from "./index";
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

jest.mock("@expo/ui/community/datetime-picker", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View: NativeView } =
    jest.requireActual<typeof import("react-native")>("react-native");

  function MockDateTimePicker(props: Record<string, unknown>) {
    return React.createElement(NativeView, {
      ...props,
      accessibilityValue: {
        text:
          props.testID === undefined ? "No native test ID" : "Native test ID",
      },
      testID: `mock-native-${String(props.mode)}-picker`,
    });
  }

  return {
    __esModule: true,
    DateTimePicker: MockDateTimePicker,
    default: MockDateTimePicker,
  };
});

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
    onCopy: jest.fn(async () => undefined),
    ...overrides,
  };
}

function renderLobby(overrides: Partial<LobbyScreenProps> = {}) {
  return render(
    <LobbyScreen
      endsLabel="2 September, 5:30 pm"
      photoPermission={{ kind: "FULL" }}
      trip={ownerTrip()}
      {...overrides}
    />,
  );
}

describe("LobbyScreen", () => {
  test("explains the brief server update after the user grants full access", async () => {
    const solo = ownerTrip({
      members: [{ ...ownerTrip().members[0]!, fullPhotoLibraryAccess: false }],
    });
    const view = await renderLobby({
      trip: solo,
      photoPermission: { kind: "FULL" },
      onStart: jest.fn(),
    });
    view.getByText("Finishing setup…");
    view.getByText("Finishing photo setup on this phone…");
    expect(view.getByRole("button", { name: "Start trip" })).toBeDisabled();
  });
  test("uses local denied access immediately even while the server still says ready", async () => {
    const screen = await renderLobby({
      trip: eligibleOwnerTrip(),
      photoPermission: { kind: "SETTINGS_REQUIRED" },
      onStart: jest.fn(),
      actionError: "Settings couldn’t open. Open Settings manually.",
    });
    screen.getByText("Photo access needed");
    expect(screen.getAllByText("Ready")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Set up photo access" }),
    );
    screen.getByText("Settings couldn’t open. Open Settings manually.");
    screen.getByText(/Apps → CrewRoll → Photos/);
  });

  test("explains checking and unavailable Start actions without inventing a minimum crew size", async () => {
    const solo = ownerTrip({ members: [ownerTrip().members[0]!] });
    const screen = await renderLobby({
      trip: solo,
      photoPermission: { kind: "CHECKING" },
      onStart: jest.fn(),
    });
    screen.getByText("Checking photo access on this phone…");
    expect(screen.getByRole("button", { name: "Start trip" })).toBeDisabled();
    await screen.rerender(
      <LobbyScreen
        endsLabel="Tomorrow"
        trip={solo}
        photoPermission={{ kind: "FULL" }}
      />,
    );
    screen.getByText("Connecting to your trip…");
    await screen.rerender(
      <LobbyScreen
        endsLabel="Tomorrow"
        trip={solo}
        photoPermission={{ kind: "FULL" }}
        onStart={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Start trip" })).toBeEnabled();
    screen.getByText("Start whenever you’re ready. Others can join later.");
  });
  test.each(["LOBBY", "ACTIVE"] as const)(
    "keeps the %s trip visible while checking access, then handles the actual permission",
    async (status) => {
      const props = {
        endsLabel: "2 September, 5:30 pm",
        trip: eligibleOwnerTrip({ status }),
        onBack: jest.fn(),
        onOpenInfo: jest.fn(),
        onStart: jest.fn(),
        transferContent: <View testID="saved-trip-photos" />,
      };
      const screen = await renderLobby({
        ...props,
        photoPermission: { kind: "CHECKING" },
      });
      screen.getByText(
        status === "LOBBY" ? "Who’s coming along?" : "Weekend in Goa",
      );
      screen.getByRole("button", { name: "Back to Home" });
      expect(screen.queryByTestId("photo-access-screen")).toBeNull();
      expect(screen.queryByTestId("saved-trip-photos")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Set up photo access" }),
      ).toBeNull();
      if (status === "LOBBY") {
        expect(
          screen.getByRole("button", { name: "Start trip" }).props
            .accessibilityState.disabled,
        ).toBe(true);
      }

      await screen.rerender(
        <LobbyScreen {...props} photoPermission={{ kind: "FULL" }} />,
      );
      expect(screen.queryByTestId("photo-access-screen")).toBeNull();
      if (status === "ACTIVE") screen.getByTestId("saved-trip-photos");

      await screen.rerender(
        <LobbyScreen {...props} photoPermission={{ kind: "CHECKING" }} />,
      );
      expect(screen.queryByTestId("photo-access-screen")).toBeNull();
      if (status === "ACTIVE") screen.getByTestId("saved-trip-photos");

      await screen.rerender(
        <LobbyScreen
          {...props}
          photoPermission={{ kind: "SETTINGS_REQUIRED" }}
        />,
      );
      expect(screen.queryByTestId("photo-access-screen")).toBeNull();
      await fireEvent.press(
        screen.getByRole("button", { name: "Set up photo access" }),
      );
      screen.getByTestId("photo-access-screen");
      screen.getByRole("button", { name: "Open photo settings" });
      expect(screen.queryByTestId("saved-trip-photos")).toBeNull();
    },
  );

  test("makes mid-trip join and phone approvals discoverable from the gallery", async () => {
    const onOpenInfo = jest.fn();
    const onOpenNotifications = jest.fn();
    const screen = await renderLobby({
      trip: ownerTrip({ status: "ACTIVE" }),
      deviceRequestCount: 1,
      onOpenInfo,
      onOpenNotifications,
    });
    await fireEvent.press(
      screen.getByRole("button", { name: "Notifications, 2 pending requests" }),
    );
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    expect(onOpenInfo).not.toHaveBeenCalled();
    await fireEvent.press(
      screen.getByRole("button", { name: "Trip settings" }),
    );
    expect(onOpenInfo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Trip info")).toBeNull();
  });
  test("copies the code from the owner sheet and opens requests separately", async () => {
    const onCopy = jest.fn(async () => undefined);
    const onOpenNotifications = jest.fn();
    const screen = await renderLobby({
      invite: invite({ onCopy }),
      onOpenNotifications,
    });
    expect(screen.queryByText("ABCD 2345")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Invite crew" }));
    screen.getByText("ABCD 2345");
    expect(screen.queryByRole("link")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Code copied" });
    await fireEvent.press(
      screen.getByRole("button", { name: "Close Invite your crew" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Notifications, 1 pending request" }),
    );
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Start trip" }).props
        .accessibilityState.disabled,
    ).toBe(true);
  });

  test("keeps a skipped permission on the trip until the user explicitly reopens setup", async () => {
    const request = jest.fn();
    const screen = await renderLobby({
      photoPermission: { kind: "REQUESTABLE" },
      onRequestPhotoAccess: request,
      onStart: jest.fn(),
    });
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByTestId("photo-access-screen")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Set up photo access" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Allow photo access" }),
    );
    expect(request).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole("button", { name: "Set up later" }));
    screen.getByTestId("lobby-crew");
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Set up photo access" }),
    );
    screen.getByTestId("photo-access-screen");
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
    const onOpenNotifications = jest.fn();
    const onStart = jest.fn();
    const screen = await renderLobby({
      trip,
      invite: invite(),
      onOpenNotifications,
      onStart,
    });

    screen.getByText(
      "Waiting for your host. Photos begin when the trip starts.",
    );
    expect(screen.queryByText("ABCD2345")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    expect(screen.queryByText(/device.*missing/i)).toBeNull();
    expect(onOpenNotifications).not.toHaveBeenCalled();
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
    async (memberState, _readinessLabel, blockerCopy) => {
      const base = ownerTrip();
      const screen = await renderLobby({
        trip: ownerTrip({
          members: [base.members[0]!, { ...base.members[1]!, ...memberState }],
        }),
        onStart: jest.fn(),
      });

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

    const start = screen.getByRole("button", { name: "Start trip" });
    expect(start.props.accessibilityState).toEqual({
      busy: false,
      disabled: false,
    });

    await fireEvent.press(start);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("disables Start while join requests are pending and while Start is active", async () => {
    const pending = await renderLobby({ onStart: jest.fn() });
    expect(pending.getByRole("button", { name: "Start trip" })).toBeDisabled();
    expect(
      pending.queryByRole("button", { name: "Approve Grace Hopper" }),
    ).toBeNull();
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

    screen.getByText("Photo sharing needs to reconnect on this phone.");
    expect(
      screen.queryByText(/wrappedKey|native stack|trip-id-private/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    const retry = screen.getByRole("button", {
      name: "Try again",
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
            photoPermission={{ kind: "FULL" }}
            trip={eligibleOwnerTrip({
              name: "A very long family and friends weekend by the sea",
            })}
          />
        </View>
      </CrewRollThemeProvider>,
    );

    const heading = screen.getByRole("header", {
      name: "Who’s coming along?",
    });
    const share = screen.getByRole("button", { name: "Invite crew" });
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
        minHeight: 56,
        minWidth: spacing.xxxl,
      }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("lobby-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
  });

  test("keeps inviting primary as a real member joins and becomes ready", async () => {
    const solo = ownerTrip({ members: [ownerTrip().members[0]!] });
    const onStart = jest.fn();
    const view = await renderLobby({ trip: solo, onStart });
    view.getByText("Who’s coming along?");
    view.getByText("You · Host");
    expect(view.queryByText(solo.name)).toBeNull();
    view.getByTestId("crew-placeholders", { includeHiddenElements: true });
    expect(view.queryByTestId("trip-photo-gallery")).toBeNull();

    await view.rerender(
      <LobbyScreen
        endsLabel="Tomorrow"
        photoPermission={{ kind: "FULL" }}
        trip={ownerTrip()}
        onStart={onStart}
      />,
    );
    expect(
      view.queryByRole("button", { name: "Approve Grace Hopper" }),
    ).toBeNull();
    view.getByText("1 joined · 1 waiting");
    expect(
      view.getByRole("button", { name: "Start trip" }).props.accessibilityState
        .disabled,
    ).toBe(true);

    await view.rerender(
      <LobbyScreen
        endsLabel="Tomorrow"
        photoPermission={{ kind: "FULL" }}
        trip={eligibleOwnerTrip()}
        onStart={onStart}
      />,
    );
    view.getByText("2 joined");
    expect(
      view.queryByTestId("crew-placeholders", { includeHiddenElements: true }),
    ).toBeNull();
    expect(view.getAllByText("Ready")).toHaveLength(2);
    expect(
      view.queryByRole("button", { name: "Approve Grace Hopper" }),
    ).toBeNull();
    expect(
      view.getByRole("button", { name: "Start trip" }).props.accessibilityState
        .disabled,
    ).toBe(false);
    expect(
      StyleSheet.flatten(
        view.getByRole("button", { name: "Invite crew" }).props.style,
      ).backgroundColor,
    ).not.toBe("transparent");
  });

  test("keeps invite failures inside an accessible sheet with a retry", async () => {
    const onRetryInvite = jest.fn();
    const view = await renderLobby({ inviteStatus: "failed", onRetryInvite });
    expect(
      view.queryByText("The invite code couldn’t load. Your trip is saved."),
    ).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Invite crew" }));
    view.getByText("The invite code couldn’t load. Your trip is saved.");
    await fireEvent.press(view.getByRole("button", { name: "Try again" }));
    expect(onRetryInvite).toHaveBeenCalledTimes(1);
    await view.rerender(
      <LobbyScreen
        endsLabel="Tomorrow"
        photoPermission={{ kind: "FULL" }}
        trip={ownerTrip()}
        invite={invite()}
      />,
    );
    view.getByText("ABCD 2345");
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("Create trip screen exports", () => {
  test("publishes the create form and native end-time field", () => {
    expect(CreateTripScreen).toEqual(expect.any(Function));
    expect(TripEndField).toEqual(expect.any(Function));
  });
});

const fixedNow = new Date(2026, 7, 31, 10, 15);

function setPlatform(os: "android" | "ios") {
  Object.defineProperty(Platform, "OS", { configurable: true, value: os });
}

function mockLocalDateFields(
  value: Date,
  fields: Readonly<{
    year: number;
    month: number;
    date: number;
    hours: number;
    minutes: number;
    seconds: number;
  }>,
) {
  jest.spyOn(value, "getFullYear").mockReturnValue(fields.year);
  jest.spyOn(value, "getMonth").mockReturnValue(fields.month);
  jest.spyOn(value, "getDate").mockReturnValue(fields.date);
  jest.spyOn(value, "getHours").mockReturnValue(fields.hours);
  jest.spyOn(value, "getMinutes").mockReturnValue(fields.minutes);
  jest.spyOn(value, "getSeconds").mockReturnValue(fields.seconds);
}

function renderCreate(overrides: Partial<CreateTripScreenProps> = {}) {
  return render(
    <CreateTripScreen
      now={fixedNow}
      onCancel={jest.fn()}
      onCreate={jest.fn()}
      {...overrides}
    />,
  );
}

describe("TripEndField", () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: originalPlatform,
    });
  });

  test("uses the contract default and maximum while recombining local date and time", () => {
    expect(createDefaultTripEnd(fixedNow).getTime()).toBe(
      fixedNow.getTime() + TRIP_CREATE_DEFAULT_DURATION_MS,
    );
    expect(
      tripEndValidationMessage(
        new Date(fixedNow.getTime() + TRIP_CREATE_MAX_DURATION_MS),
        fixedNow,
      ),
    ).toBeUndefined();
    expect(
      tripEndValidationMessage(
        new Date(fixedNow.getTime() + TRIP_CREATE_MAX_DURATION_MS + 1),
        fixedNow,
      ),
    ).toBe("Trips can last up to 14 days. Choose an earlier end time.");
    expect(tripEndValidationMessage(fixedNow, fixedNow)).toBe(
      "Choose a valid future end time.",
    );
    expect(tripEndValidationMessage(new Date(Number.NaN), fixedNow)).toBe(
      "Choose a valid future end time.",
    );

    const current = new Date(2026, 7, 31, 10, 15, 23, 456);
    const chosenDate = new Date(2026, 8, 4, 21, 1);
    const chosenTime = new Date(2024, 2, 1, 17, 45);
    expect(combineTripEndDate(current, chosenDate)).toEqual(
      new Date(2026, 8, 4, 10, 15, 23, 456),
    );
    expect(combineTripEndTime(current, chosenTime)).toEqual(
      new Date(2026, 7, 31, 17, 45, 0, 0),
    );
  });

  test("shows separate localized end date and time fields", async () => {
    setPlatform("android");
    const value = new Date(2026, 8, 2, 17, 30);
    const screen = await render(
      <TripEndField
        locale="en-GB"
        now={fixedNow}
        onChange={jest.fn()}
        value={value}
      />,
    );
    screen.getByRole("button", { name: /^End date\./ });
    screen.getByRole("button", { name: /^End time\./ });
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
  });

  test("mounts one Android dialog at a time, recombines in JS, and unmounts on choose or cancel", async () => {
    setPlatform("android");
    const onChange = jest.fn();
    const value = new Date(2026, 8, 2, 17, 30);
    const screen = await render(
      <TripEndField now={fixedNow} onChange={onChange} value={value} />,
    );

    await fireEvent.press(screen.getByRole("button", { name: /^End date\./ }));
    const datePicker = screen.getByTestId("mock-native-date-picker");
    screen.getByTestId("trip-end-date-picker");
    expect(datePicker.props).toEqual(
      expect.objectContaining({
        mode: "date",
        presentation: "dialog",
      }),
    );
    expect(datePicker.props).not.toHaveProperty("disabled");
    expect(datePicker.props.accessibilityValue).toEqual({
      text: "No native test ID",
    });
    await fireEvent(datePicker, "dismiss");
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: /^End date\./ }));
    await fireEvent(
      screen.getByTestId("mock-native-date-picker"),
      "valueChange",
      { nativeEvent: { timestamp: 0, utcOffset: 0 } },
      new Date(Date.UTC(2026, 8, 4)),
    );
    expect(onChange).toHaveBeenCalledWith(new Date(2026, 8, 4, 17, 30));
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
  });

  test("keeps the intended Android calendar day in a negative UTC offset", async () => {
    setPlatform("android");
    const now = new Date(2026, 8, 1, 12);
    // Sep 2 at 23:30 in UTC-07 is already Sep 3 as an instant.
    const value = new Date("2026-09-03T06:30:45.678Z");
    mockLocalDateFields(value, {
      date: 2,
      hours: 23,
      minutes: 30,
      month: 8,
      seconds: 45,
      year: 2026,
    });
    const onChange = jest.fn();
    const screen = await render(
      <TripEndField now={now} onChange={onChange} value={value} />,
    );

    await fireEvent.press(screen.getByRole("button", { name: /^End date\./ }));
    const datePicker = screen.getByTestId("mock-native-date-picker");
    expect(datePicker.props.value).toEqual(new Date(Date.UTC(2026, 8, 2)));

    // Expo Android returns Sep 5 as UTC midnight, which is Sep 4 in UTC-07.
    const selectedUtcDay = new Date(Date.UTC(2026, 8, 5));
    mockLocalDateFields(selectedUtcDay, {
      date: 4,
      hours: 17,
      minutes: 0,
      month: 8,
      seconds: 0,
      year: 2026,
    });
    expect(selectedUtcDay.getDate()).toBe(4);
    await fireEvent(
      datePicker,
      "valueChange",
      { nativeEvent: { timestamp: selectedUtcDay.getTime(), utcOffset: 0 } },
      selectedUtcDay,
    );
    expect(onChange).toHaveBeenCalledWith(
      new Date(2026, 8, 5, 23, 30, 45, 678),
    );
  });

  test("edits end time without changing the selected calendar date", async () => {
    setPlatform("android");
    const onChange = jest.fn();
    const value = new Date(2026, 8, 2, 17, 30);
    const screen = await render(
      <TripEndField now={fixedNow} value={value} onChange={onChange} />,
    );
    await fireEvent.press(screen.getByRole("button", { name: /^End time\./ }));
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
    await fireEvent(
      screen.getByTestId("mock-native-time-picker"),
      "valueChange",
      { nativeEvent: { timestamp: 0, utcOffset: 0 } },
      new Date(2026, 8, 1, 19, 45),
    );
    expect(onChange).toHaveBeenCalledWith(new Date(2026, 8, 2, 19, 45));
    expect(screen.queryByTestId("mock-native-time-picker")).toBeNull();
  });

  test("never mounts an Android dialog while disabled", async () => {
    setPlatform("android");
    const screen = await render(
      <TripEndField
        disabled
        now={fixedNow}
        onChange={jest.fn()}
        value={createDefaultTripEnd(fixedNow)}
      />,
    );

    const date = screen.getByRole("button", { name: /^End date\./ });
    expect(date.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    await fireEvent.press(date);
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
    expect(screen.queryByTestId("mock-native-time-picker")).toBeNull();
  });

  test("unmounts an open Android dialog when disabled and does not reopen it", async () => {
    setPlatform("android");
    const value = createDefaultTripEnd(fixedNow);
    const onChange = jest.fn();
    const screen = await render(
      <TripEndField now={fixedNow} onChange={onChange} value={value} />,
    );

    await fireEvent.press(screen.getByRole("button", { name: /^End date\./ }));
    screen.getByTestId("mock-native-date-picker");
    await screen.rerender(
      <TripEndField
        disabled
        now={fixedNow}
        onChange={onChange}
        value={value}
      />,
    );
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
    await screen.rerender(
      <TripEndField now={fixedNow} onChange={onChange} value={value} />,
    );
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
  });

  test("does not open the iOS sheet while disabled", async () => {
    setPlatform("ios");
    const screen = await render(
      <TripEndField
        disabled
        now={fixedNow}
        onChange={jest.fn()}
        value={createDefaultTripEnd(fixedNow)}
      />,
    );
    await fireEvent.press(screen.getByRole("button", { name: /^End date\./ }));
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
  });

  test("keeps the iOS date value and local-field recombination unchanged", async () => {
    setPlatform("ios");
    const now = new Date(2026, 8, 1, 12);
    // Keep the same late UTC-07 instant as the Android regression.
    const value = new Date("2026-09-03T06:30:45.678Z");
    mockLocalDateFields(value, {
      date: 2,
      hours: 23,
      minutes: 30,
      month: 8,
      seconds: 45,
      year: 2026,
    });
    const onChange = jest.fn();
    const screen = await render(
      <TripEndField now={now} onChange={onChange} value={value} />,
    );
    await fireEvent.press(screen.getByRole("button", { name: /^End date\./ }));
    const datePicker = screen.getByTestId("mock-native-date-picker");

    expect(datePicker.props.value).toBe(value);
    const selectedLocalDate = new Date("2026-09-06T06:15:00.000Z");
    mockLocalDateFields(selectedLocalDate, {
      date: 5,
      hours: 23,
      minutes: 15,
      month: 8,
      seconds: 0,
      year: 2026,
    });
    await fireEvent(
      datePicker,
      "valueChange",
      {
        nativeEvent: {
          timestamp: selectedLocalDate.getTime(),
          utcOffset: -selectedLocalDate.getTimezoneOffset(),
        },
      },
      selectedLocalDate,
    );
    expect(onChange).toHaveBeenCalledWith(
      new Date(2026, 8, 5, 23, 30, 45, 678),
    );
  });
});

describe("CreateTripScreen", () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => setPlatform("android"));
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: originalPlatform,
    });
  });

  test("uses the default window without promising another photo permission step", async () => {
    const screen = await renderCreate({ locale: "en-GB" });
    screen.getByRole("header", { name: "Name your trip." });
    screen.getByRole("button", { name: /^End date\./ });
    expect(screen.queryByText("Photo access comes next.")).toBeNull();
    expect(screen.queryByText("Trip created")).toBeNull();
  });

  test("validates the name and safe future bounds before creating", async () => {
    const onCreate = jest.fn();
    const screen = await renderCreate({
      initialEndsAt: new Date(fixedNow.getTime() - 1),
      onCreate,
    });

    await fireEvent.press(screen.getByRole("button", { name: "Create trip" }));
    screen.getByText("Enter a trip name.");
    screen.getByText("Choose a valid future end time.");
    expect(onCreate).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByLabelText("Trip name"),
      "A".repeat(81),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Create trip" }));
    screen.getByText("Keep the trip name to 80 characters or fewer.");
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("trims the valid name and converts the chosen local instant to ISO once", async () => {
    const onCreate = jest.fn();
    const endsAt = new Date(fixedNow.getTime() + 60 * 60 * 1_000);
    const screen = await renderCreate({ initialEndsAt: endsAt, onCreate });

    await fireEvent.changeText(
      screen.getByLabelText("Trip name"),
      "  Weekend in Goa  ",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Create trip" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      endsAt: endsAt.toISOString(),
      name: "Weekend in Goa",
    });
    await fireEvent.press(screen.getByRole("button", { name: "Create trip" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test("cancels before create and blocks every mutation while submitting", async () => {
    const onCancel = jest.fn();
    const onCreate = jest.fn();
    const editing = await renderCreate({ onCancel, onCreate });
    await fireEvent.press(editing.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
    await editing.unmount();

    const submitting = await renderCreate({
      initialName: "Weekend in Goa",
      onCancel,
      onCreate,
      state: { kind: "submitting" },
    });
    expect(
      submitting.getByLabelText("Trip name").props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: true }));
    const create = submitting.getByRole("button", { name: "Create trip" });
    expect(submitting.queryByRole("button", { name: "Back" })).toBeNull();
    expect(create.props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
    await fireEvent.press(create);
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("offers only safe reconciliation for an unknown outcome", async () => {
    const onCheck = jest.fn();
    const state = {
      kind: "unknown",
      onCheck,
      checking: false,
      rawError: { detail: "do-not-render" },
    } as const;
    const screen = await renderCreate({ state });

    screen.getByRole("header", { name: "Checking your trip." });
    screen.getByText(
      "Your trip may already be created. Check the same request to continue.",
    );
    expect(screen.queryByText("do-not-render")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create trip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Check trip status" }),
    );
    expect(onCheck).toHaveBeenCalledTimes(1);
    await screen.rerender(
      <CreateTripScreen
        now={fixedNow}
        onCancel={jest.fn()}
        onCreate={jest.fn()}
        state={{ checking: true, kind: "unknown", onCheck }}
      />,
    );
    const check = screen.getByRole("button", { name: "Check trip status" });
    expect(check.props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
    await fireEvent.press(check);
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  test("keeps the primary action reachable at 200 percent under RTL, dark, and reduced motion", async () => {
    const screen = await render(
      <CrewRollThemeProvider reduceMotion scheme="dark">
        <View style={{ direction: "rtl" }}>
          <CreateTripScreen
            initialName="A very long family and friends weekend by the sea"
            now={fixedNow}
            onCancel={jest.fn()}
            onCreate={jest.fn()}
          />
        </View>
      </CrewRollThemeProvider>,
    );

    const heading = screen.getByRole("header", {
      name: "Name your trip.",
    });
    const create = screen.getByRole("button", { name: "Create trip" });
    expect(heading.props.allowFontScaling).toBe(true);
    expect(heading.props.maxFontSizeMultiplier).toBe(2);
    expect(isInsideScrollableScreen(create as unknown as HostElement)).toBe(
      true,
    );
    expect(StyleSheet.flatten(create.props.style)).toEqual(
      expect.objectContaining({
        minHeight: 56,
        minWidth: spacing.xxxl,
      }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("create-trip-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
  });
});
