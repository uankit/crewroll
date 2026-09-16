import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";
import { CrewRollThemeProvider, darkColors } from "../../design-system";
import type { TripInvitePreview } from "../../domain/trips/model";
import { JoinTripScreen, type JoinTripScreenProps } from "./index";

const preview: TripInvitePreview = {
  tripId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
  name: "Goa with friends",
  startsAt: null,
  endsAt: "2026-09-20T18:00:00Z",
  hostDisplayName: "Riya",
  members: [
    { displayName: "Riya", role: "OWNER" },
    { displayName: "Arjun", role: "MEMBER" },
  ],
};
const lookup = () => jest.fn().mockResolvedValue(preview);
const renderJoin = (props: Partial<JoinTripScreenProps> = {}) =>
  render(
    <JoinTripScreen
      onLookup={lookup()}
      onCancel={jest.fn()}
      onJoin={jest.fn()}
      {...props}
    />,
  );

describe("JoinTripScreen", () => {
  test("looks up a normalized code and shows real host and crew before joining once", async () => {
    const onLookup = lookup();
    const onJoin = jest.fn();
    const screen = await renderJoin({
      initialCode: " abcd 2345 ",
      onLookup,
      onJoin,
    });
    expect(screen.getByLabelText("Invite code").props.value).toBe("ABCD2345");
    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await waitFor(() => screen.getByRole("header", { name: preview.name }));
    expect(onLookup).toHaveBeenCalledWith("ABCD2345");
    expect(onJoin).not.toHaveBeenCalled();
    screen.getByText("Arjun");
    screen.getByText("Host");
    screen.getByText("Crew · 2 joined");
    const submit = screen.getByRole("button", { name: "Request to join" });
    await fireEvent.press(submit);
    await fireEvent.press(submit);
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledWith("ABCD2345");
  });
  test("rejects malformed codes before any network operation", async () => {
    const onLookup = lookup();
    const onJoin = jest.fn();
    const screen = await renderJoin({ onLookup, onJoin });
    await fireEvent.changeText(
      screen.getByLabelText("Invite code"),
      "ABCI2345",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    screen.getByRole("alert", {
      name: "Enter the complete 8-character invite code.",
    });
    expect(onLookup).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });
  test("coalesces rapid lookup presses without issuing a join", async () => {
    let resolve!: (value: TripInvitePreview) => void;
    const onLookup = jest.fn(
      () =>
        new Promise<TripInvitePreview>((done) => {
          resolve = done;
        }),
    );
    const onJoin = jest.fn();
    const screen = await renderJoin({
      initialCode: "ABCD2345",
      onLookup,
      onJoin,
    });
    const button = screen.getByRole("button", { name: "Find trip" });
    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(onLookup).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
    await act(async () => resolve(preview));
  });
  test("allows returning to the code without joining", async () => {
    const onJoin = jest.fn();
    const onCancel = jest.fn();
    const screen = await renderJoin({
      initialCode: "ABCD2345",
      onJoin,
      onCancel,
    });
    await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
    await waitFor(() => screen.getByText("Arjun"));
    await fireEvent.press(
      screen.getByRole("button", { name: "Not this trip" }),
    );
    screen.getByLabelText("Invite code");
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
  });
  test.each(["INVITE_INVALID", "NETWORK_ERROR"])(
    "shows safe lookup errors for %s",
    async (code) => {
      const onLookup = jest
        .fn()
        .mockRejectedValue({ code, detail: "private token key stack" });
      const onJoin = jest.fn();
      const screen = await renderJoin({
        initialCode: "ABCD2345",
        onLookup,
        onJoin,
      });
      await fireEvent.press(screen.getByRole("button", { name: "Find trip" }));
      await waitFor(() => screen.getByRole("alert"));
      expect(screen.queryByText(/private token/)).toBeNull();
      expect(onJoin).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Find trip" }).props
          .accessibilityState.busy,
      ).toBe(false);
    },
  );
  test.each(["invalid", "rejected"] as const)(
    "offers another code only for a terminal %s result",
    async (kind) => {
      const onUseAnotherCode = jest.fn();
      const screen = await renderJoin({ state: { kind, onUseAnotherCode } });
      await fireEvent.press(
        screen.getByRole("button", { name: "Use another code" }),
      );
      expect(onUseAnotherCode).toHaveBeenCalledTimes(1);
    },
  );
  test("keeps an unknown join recoverable without clearing or replacing it", async () => {
    const onRetry = jest.fn();
    const screen = await renderJoin({ state: { kind: "unknown", onRetry } });
    screen.getByRole("header", { name: "Checking your request." });
    expect(
      screen.queryByRole("button", { name: /clear|reset|another|back/i }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Check join request" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  test("retains scalable copy and a scrollable dark RTL form", async () => {
    const screen = await render(
      <CrewRollThemeProvider reduceMotion scheme="dark">
        <View style={{ direction: "rtl" }}>
          <JoinTripScreen
            onLookup={lookup()}
            onCancel={jest.fn()}
            onJoin={jest.fn()}
          />
        </View>
      </CrewRollThemeProvider>,
    );
    const heading = screen.getByRole("header", { name: "Enter your code." });
    expect(heading.props.allowFontScaling).toBe(true);
    expect(heading.props.maxFontSizeMultiplier).toBe(2);
    expect(
      StyleSheet.flatten(screen.getByTestId("join-trip-screen").props.style)
        .backgroundColor,
    ).toBe(darkColors.background);
    const button = screen.getByRole("button", { name: "Find trip" });
    expect(StyleSheet.flatten(button.props.style).minHeight).toBe(56);
  });
});
