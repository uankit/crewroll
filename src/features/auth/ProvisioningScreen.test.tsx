import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import {
  CrewRollThemeProvider,
  darkColors,
  lightColors,
  spacing,
} from "../../design-system";
import { ProvisioningScreen, type ProvisioningScreenProps } from "./index";

const safeFailure =
  "CrewRoll could not connect this phone. Check your connection and try again.";

function renderScreen(
  props: ProvisioningScreenProps,
  scheme: "dark" | "light" = "light",
) {
  return render(
    <CrewRollThemeProvider reduceMotion scheme={scheme}>
      <ProvisioningScreen {...props} />
    </CrewRollThemeProvider>,
  );
}

describe("ProvisioningScreen", () => {
  it("presents scalable, accessible progress without a retry action", async () => {
    const screen = await renderScreen({ status: "working" });

    const progress = screen.getByRole("summary", { name: "Getting ready" });
    expect(progress.props.accessibilityState).toEqual({ busy: true });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("exposes only fixed safe failure copy and a 48-point retry target", async () => {
    const onRetry = jest.fn();
    const screen = await renderScreen({ status: "failed", onRetry });

    const alert = screen.getByRole("alert", { name: safeFailure });
    const retry = screen.getByRole("button", { name: "Try again" });
    const failureCopy = screen.getByText(safeFailure, {
      includeHiddenElements: true,
    });

    expect(alert).toBeOnTheScreen();
    expect(failureCopy.props.allowFontScaling).toBe(true);
    expect(failureCopy.props.maxFontSizeMultiplier).toBe(2);
    expect(StyleSheet.flatten(retry.props.style)).toEqual(
      expect.objectContaining({
        minHeight: 56,
        minWidth: spacing.xxxl,
      }),
    );

    fireEvent.press(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables repeat retry while an attempt is active", async () => {
    const onRetry = jest.fn();
    const screen = await renderScreen({
      status: "failed",
      onRetry,
      retrying: true,
    });
    const retry = screen.getByRole("button", { name: "Try again" });

    expect(retry.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    fireEvent.press(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("uses semantic screen colors in light and dark themes", async () => {
    const light = await renderScreen({ status: "working" }, "light");
    expect(
      StyleSheet.flatten(light.getByTestId("provisioning-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: lightColors.background }),
    );
    await light.unmount();

    const dark = await renderScreen({ status: "working" }, "dark");
    expect(
      StyleSheet.flatten(dark.getByTestId("provisioning-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
  });

  it("ignores unexpected raw error payloads instead of rendering them", async () => {
    const props = {
      status: "failed",
      onRetry: jest.fn(),
      error: new Error("provider secret detail"),
    } as unknown as ProvisioningScreenProps;
    const screen = await renderScreen(props);

    expect(screen.queryByText(/provider secret detail/i)).toBeNull();
    expect(screen.getByRole("alert", { name: safeFailure })).toBeOnTheScreen();
  });
});
