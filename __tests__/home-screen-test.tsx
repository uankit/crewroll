import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";

import { CrewRollThemeProvider, darkColors, spacing } from "@/design-system";
import {
  HomeScreen,
  type HomeScreenProps,
  type HomeScreenState,
} from "@/features/home";

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

function renderHome(
  state?: HomeScreenState,
  overrides: Partial<HomeScreenProps> = {},
) {
  const stateProps = state === undefined ? {} : { state };

  return render(
    <HomeScreen
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      {...stateProps}
      {...overrides}
    />,
  );
}

describe("HomeScreen", () => {
  test("explains the CrewRoll promise and exposes distinct no-trip actions", async () => {
    const onCreateTrip = jest.fn();
    const onJoinTrip = jest.fn();
    const screen = await renderHome(undefined, { onCreateTrip, onJoinTrip });

    screen.getByRole("header", {
      name: "Every trip photo. On every phone.",
    });
    screen.getByText(
      "Keep using your normal camera. CrewRoll privately delivers each eligible photo to everyone in the trip.",
    );
    screen.getByText("No active trip");
    screen.getByText(
      "Photos stay on your phones. Temporary encrypted copies are deleted.",
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "Create a trip" }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Join a trip" }));

    expect(onCreateTrip).toHaveBeenCalledTimes(1);
    expect(onJoinTrip).toHaveBeenCalledTimes(1);
  });

  test("announces loading without exposing actions that can race recovery", async () => {
    const screen = await renderHome({ kind: "loading" });

    expect(
      screen.getByRole("summary", { name: "Loading your CrewRoll trip" }).props
        .accessibilityState,
    ).toEqual({ busy: true });
    expect(screen.queryByRole("button")).toBeNull();
  });

  test.each([
    ["LOBBY", "Lobby", "2 people"],
    ["ACTIVE", "Active", "2 ready"],
  ] as const)(
    "renders an envelope-free %s trip summary and opens it",
    async (tripStatus, statusLabel, memberSummary) => {
      const onOpenTrip = jest.fn();
      const screen = await renderHome({
        kind: "trip",
        tripStatus,
        name: "Weekend in Goa",
        endsLabel: "2 September, 5:30 pm",
        memberSummary,
        onOpenTrip,
      });

      screen.getByText("Weekend in Goa");
      screen.getByLabelText(`Status: ${statusLabel}`);
      screen.getByText("2 September, 5:30 pm");
      screen.getByText(memberSummary);
      expect(
        screen.queryByRole("button", { name: "Create a trip" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Join a trip" })).toBeNull();

      await fireEvent.press(screen.getByRole("button", { name: "Open trip" }));
      expect(onOpenTrip).toHaveBeenCalledTimes(1);
    },
  );

  test("renders only fixed safe failure copy and disables repeat retry", async () => {
    const onRetry = jest.fn();
    const state = {
      kind: "failed",
      onRetry,
      retrying: true,
      error: new Error("provider response with private identifiers"),
    } as unknown as HomeScreenState;
    const screen = await renderHome(state);

    screen.getByText("CrewRoll could not load your trip");
    screen.getByText(
      "Check your connection and try again. Your trip has not been changed.",
    );
    expect(
      screen.queryByText(/provider response|private identifiers/i),
    ).toBeNull();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    await fireEvent.press(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test.each([
    [
      "unknown-create",
      "Checking your new trip",
      "CrewRoll is checking whether your trip was created. Keep this phone connected and check again.",
    ],
    [
      "unknown-join",
      "Checking your join request",
      "CrewRoll is checking whether your join request was received. Keep this phone connected and check again.",
    ],
  ] as const)(
    "keeps %s recovery non-destructive across restart",
    async (kind, title, body) => {
      const onRecover = jest.fn();
      const screen = await renderHome({ kind, onRecover });

      screen.getByText(title);
      screen.getByText(body);
      expect(
        screen.queryByRole("button", { name: /reset|clear|start over/i }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Create a trip" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Join a trip" })).toBeNull();

      await fireEvent.press(
        screen.getByRole("button", { name: "Check again" }),
      );
      expect(onRecover).toHaveBeenCalledTimes(1);
    },
  );

  test("keeps a long primary action reachable at 200 percent in RTL, dark, reduced-motion rendering", async () => {
    const onOpenTrip = jest.fn();
    const screen = await render(
      <CrewRollThemeProvider reduceMotion scheme="dark">
        <View style={{ direction: "rtl" }}>
          <HomeScreen
            onCreateTrip={jest.fn()}
            onJoinTrip={jest.fn()}
            state={{
              kind: "trip",
              tripStatus: "LOBBY",
              name: "A very long weekend trip name that still remains readable",
              endsLabel: "Wednesday, 2 September 2026 at 5:30 pm",
              memberSummary: "2 people waiting together",
              onOpenTrip,
            }}
          />
        </View>
      </CrewRollThemeProvider>,
    );

    const heading = screen.getByRole("header", {
      name: "Every trip photo. On every phone.",
    });
    const open = screen.getByRole("button", { name: "Open trip" });
    expect(heading.props.allowFontScaling).toBe(true);
    expect(heading.props.maxFontSizeMultiplier).toBe(2);
    expect(isInsideScrollableScreen(open as unknown as HostElement)).toBe(true);
    expect(StyleSheet.flatten(open.props.style)).toEqual(
      expect.objectContaining({
        minHeight: spacing.xxxl,
        minWidth: spacing.xxxl,
      }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("home-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
  });
});
