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
      photoPermission={{ kind: "FULL" }}
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
            photoPermission={{ kind: "FULL" }}
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

  test("shows a localized value and exposes separate accessible controls", async () => {
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

    const display = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value);
    screen.getByText(display);
    screen.getByRole("button", { name: "Change end date" });
    screen.getByRole("button", { name: "Change end time" });
    expect(screen.queryByTestId("mock-native-date-picker")).toBeNull();
    expect(screen.queryByTestId("mock-native-time-picker")).toBeNull();
  });

  test("mounts one Android dialog at a time, recombines in JS, and unmounts on choose or cancel", async () => {
    setPlatform("android");
    const onChange = jest.fn();
    const value = new Date(2026, 8, 2, 17, 30);
    const screen = await render(
      <TripEndField now={fixedNow} onChange={onChange} value={value} />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "Change end date" }),
    );
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

    await fireEvent.press(
      screen.getByRole("button", { name: "Change end time" }),
    );
    const timePicker = screen.getByTestId("mock-native-time-picker");
    screen.getByTestId("trip-end-time-picker");
    await fireEvent(
      timePicker,
      "valueChange",
      { nativeEvent: { timestamp: 0, utcOffset: 0 } },
      new Date(2020, 0, 1, 8, 45),
    );
    expect(onChange).toHaveBeenCalledWith(new Date(2026, 8, 2, 8, 45));
    expect(screen.queryByTestId("mock-native-time-picker")).toBeNull();
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

    await fireEvent.press(
      screen.getByRole("button", { name: "Change end date" }),
    );
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

    const date = screen.getByRole("button", { name: "Change end date" });
    const time = screen.getByRole("button", { name: "Change end time" });
    expect(date.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(time.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    await fireEvent.press(date);
    await fireEvent.press(time);
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

    await fireEvent.press(
      screen.getByRole("button", { name: "Change end date" }),
    );
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

  test("keeps both iOS controls inline and passes the platform-supported disabled state", async () => {
    setPlatform("ios");
    const screen = await render(
      <TripEndField
        disabled
        now={fixedNow}
        onChange={jest.fn()}
        value={createDefaultTripEnd(fixedNow)}
      />,
    );

    expect(screen.getByTestId("mock-native-date-picker").props).toEqual(
      expect.objectContaining({ disabled: true, mode: "date" }),
    );
    expect(screen.getByTestId("mock-native-time-picker").props).toEqual(
      expect.objectContaining({ disabled: true, mode: "time" }),
    );
    screen.getByTestId("trip-end-date-picker");
    screen.getByTestId("trip-end-time-picker");
    screen.getByText("End date");
    screen.getByText("End time");
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

  test("defaults to the contract window and explains the read-only Immediate release", async () => {
    const screen = await renderCreate({ locale: "en-GB" });
    const expectedEnd = createDefaultTripEnd(fixedNow);
    const display = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(expectedEnd);

    screen.getByRole("header", { name: "Create an Immediate trip" });
    screen.getByText(display);
    screen.getByLabelText("Status: Immediate release");
    screen.getByText(
      "Eligible photos can arrive automatically after the owner starts the trip.",
    );
    expect(screen.queryByDisplayValue(expectedEnd.toISOString())).toBeNull();
    expect(screen.queryByText("Nightly")).toBeNull();
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
    await fireEvent.press(editing.getByRole("button", { name: "Cancel" }));
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
    const cancel = submitting.getByRole("button", { name: "Cancel" });
    expect(create.props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
    expect(cancel.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    await fireEvent.press(create);
    await fireEvent.press(cancel);
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

    screen.getByRole("header", { name: "Checking your new trip" });
    screen.getByText(
      "CrewRoll is checking whether your trip was created. Keep this phone connected and check again.",
    );
    expect(screen.queryByText("do-not-render")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create trip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
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

  test("navigates from the terminal success state", async () => {
    const onOpenTrip = jest.fn();
    const screen = await renderCreate({
      state: { kind: "success", onOpenTrip },
    });

    screen.getByRole("header", { name: "Trip created" });
    screen.getByText("Your Immediate trip is ready for its crew.");
    await fireEvent.press(screen.getByRole("button", { name: "Open trip" }));
    expect(onOpenTrip).toHaveBeenCalledTimes(1);
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
      name: "Create an Immediate trip",
    });
    const create = screen.getByRole("button", { name: "Create trip" });
    expect(heading.props.allowFontScaling).toBe(true);
    expect(heading.props.maxFontSizeMultiplier).toBe(2);
    expect(isInsideScrollableScreen(create as unknown as HostElement)).toBe(
      true,
    );
    expect(StyleSheet.flatten(create.props.style)).toEqual(
      expect.objectContaining({
        minHeight: spacing.xxxl,
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
