import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";

import {
  CrewRollThemeProvider,
  darkColors,
  spacing,
} from "../../design-system";
import {
  JoinTripScreen,
  type JoinTripScreenProps,
  type JoinTripScreenState,
} from "./index";

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

function renderJoin(overrides: Partial<JoinTripScreenProps> = {}) {
  return render(
    <JoinTripScreen onCancel={jest.fn()} onJoin={jest.fn()} {...overrides} />,
  );
}

describe("JoinTripScreen", () => {
  test("normalizes a prefilled route code and requires confirmation before mutation", async () => {
    const onJoin = jest.fn();
    const screen = await renderJoin({
      initialCode: "  abcd2345  ",
      onJoin,
    });

    const code = screen.getByLabelText("Invite code");
    expect(code.props.value).toBe("ABCD2345");
    expect(code.props.maxFontSizeMultiplier).toBe(2);

    await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
    expect(onJoin).not.toHaveBeenCalled();
    screen.getByRole("header", { name: "Join this trip?" });
    screen.getByText("Request access with invite code ABCD2345.");

    await fireEvent.press(
      screen.getByRole("button", { name: "Request to join" }),
    );
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledWith("ABCD2345");
  });

  test("rejects malformed local codes before confirmation or network callbacks", async () => {
    const onJoin = jest.fn();
    const screen = await renderJoin({ onJoin });
    const code = screen.getByLabelText("Invite code");

    await fireEvent.changeText(code, "ABCI2345");
    await fireEvent.press(screen.getByRole("button", { name: "Continue" }));

    screen.getByRole("alert", {
      name: "Enter the complete 8-character invite code.",
    });
    expect(
      screen.queryByRole("button", { name: "Request to join" }),
    ).toBeNull();
    expect(onJoin).not.toHaveBeenCalled();

    await fireEvent.changeText(code, "abcd2345");
    expect(screen.queryByRole("alert")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
    screen.getByRole("button", { name: "Request to join" });
  });

  test("lets editing and confirmation cancel without issuing a join", async () => {
    const onCancel = jest.fn();
    const onJoin = jest.fn();
    const editing = await renderJoin({
      initialCode: "ABCD2345",
      onCancel,
      onJoin,
    });

    await fireEvent.press(editing.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();

    await fireEvent.press(editing.getByRole("button", { name: "Continue" }));
    await fireEvent.press(editing.getByRole("button", { name: "Back" }));
    expect(editing.getByLabelText("Invite code")).toBeTruthy();
    expect(onJoin).not.toHaveBeenCalled();
  });

  test("shows the in-flight confirmation as busy and prevents a repeat request", async () => {
    const onJoin = jest.fn();
    const screen = await renderJoin({
      initialCode: "ABCD2345",
      onJoin,
      state: { kind: "submitting" },
    });

    const submit = screen.getByRole("button", { name: "Request to join" });
    expect(submit.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    await fireEvent.press(submit);
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  test("shows the pending-key result as waiting and routes only through its explicit action", async () => {
    const onOpenTrip = jest.fn();
    const screen = await renderJoin({
      state: { kind: "pending", onOpenTrip },
    });

    screen.getByRole("header", { name: "Waiting for the owner" });
    screen.getByText(
      "Your request is in. You can join once the owner approves this phone.",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Open trip lobby" }),
    );
    expect(onOpenTrip).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["invalid", "Invite unavailable", "That invite is invalid or has expired."],
    [
      "rejected",
      "Request not approved",
      "This join request was not approved. You can use a different invite.",
    ],
  ] as const)(
    "renders the safe %s terminal result and accepts a different code",
    async (kind, title, body) => {
      const onUseAnotherCode = jest.fn();
      const screen = await renderJoin({
        state: { kind, onUseAnotherCode },
      });

      screen.getByText(title);
      screen.getByText(body);
      await fireEvent.press(
        screen.getByRole("button", { name: "Use another code" }),
      );
      expect(onUseAnotherCode).toHaveBeenCalledTimes(1);
    },
  );

  test("offers a safe retry without rendering raw transport or server objects", async () => {
    const onRetry = jest.fn();
    const state = {
      kind: "failed",
      onRetry,
      retrying: true,
      response: { detail: "token stack wrappedKey request-id-private" },
    } as unknown as JoinTripScreenState;
    const screen = await renderJoin({ state });

    screen.getByText("CrewRoll could not check this invite");
    screen.getByText(
      "Your request may already have reached the owner. Check again to recover it safely.",
    );
    expect(
      screen.queryByText(/token stack|wrappedKey|request-id-private/i),
    ).toBeNull();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    await fireEvent.press(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("keeps UNKNOWN_JOIN recovery actionable but non-destructive after restart", async () => {
    const onRetry = jest.fn();
    const screen = await renderJoin({
      state: { kind: "unknown", onRetry },
    });

    screen.getByRole("header", { name: "Checking your join request" });
    screen.getByText(
      "CrewRoll is checking whether your request was received. Keep this phone connected and check again.",
    );
    expect(
      screen.queryByRole("button", {
        name: /reset|clear|start over|use another/i,
      }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Check join request" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("keeps controls in the scroll tree at 200 percent under RTL, dark, reduced motion", async () => {
    const screen = await render(
      <CrewRollThemeProvider reduceMotion scheme="dark">
        <View style={{ direction: "rtl" }}>
          <JoinTripScreen
            initialCode="ABCD2345"
            onCancel={jest.fn()}
            onJoin={jest.fn()}
          />
        </View>
      </CrewRollThemeProvider>,
    );

    const heading = screen.getByRole("header", { name: "Join a trip" });
    const continueAction = screen.getByRole("button", { name: "Continue" });
    expect(heading.props.allowFontScaling).toBe(true);
    expect(heading.props.maxFontSizeMultiplier).toBe(2);
    expect(
      isInsideScrollableScreen(continueAction as unknown as HostElement),
    ).toBe(true);
    expect(StyleSheet.flatten(continueAction.props.style)).toEqual(
      expect.objectContaining({
        minHeight: spacing.xxxl,
        minWidth: spacing.xxxl,
      }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("join-trip-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
  });
});
