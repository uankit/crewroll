import { act, fireEvent, render } from "@testing-library/react-native";
import type { ComponentProps, PropsWithChildren } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";

import {
  BlockingCallout,
  EmptyState,
  InlineBanner,
  LiveStatus,
  PermissionCard,
  StatusBadge,
  Toast,
  type FeedbackTone,
} from "./index";
import {
  CrewRollThemeProvider,
  darkColors,
  lightColors,
  spacing,
} from "../index";

type ThemeHarnessProps = PropsWithChildren<{
  readonly scheme?: "light" | "dark";
}>;

function ThemeHarness({ children, scheme = "light" }: ThemeHarnessProps) {
  return (
    <CrewRollThemeProvider scheme={scheme}>{children}</CrewRollThemeProvider>
  );
}

type ForbiddenPropName = "error" | "payload" | "providerPayload" | "response";
type ForbiddenFeedbackProp = Extract<
  | keyof ComponentProps<typeof StatusBadge>
  | keyof ComponentProps<typeof LiveStatus>
  | keyof ComponentProps<typeof InlineBanner>
  | keyof ComponentProps<typeof BlockingCallout>
  | keyof ComponentProps<typeof Toast>
  | keyof ComponentProps<typeof EmptyState>
  | keyof ComponentProps<typeof PermissionCard>,
  ForbiddenPropName
>;

const feedbackPropsArePrivacySafe: [ForbiddenFeedbackProp] extends [never]
  ? true
  : never = true;
void feedbackPropsArePrivacySafe;

const testOnIOS = Platform.OS === "ios" ? test : test.skip;
const testOnAndroid = Platform.OS === "android" ? test : test.skip;

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("design-system feedback", () => {
  test.each<
    readonly [FeedbackTone, keyof typeof lightColors, keyof typeof lightColors]
  >([
    ["neutral", "textSecondary", "surfaceMuted"],
    ["info", "info", "infoSurface"],
    ["success", "success", "successSurface"],
    ["warning", "warning", "warningSurface"],
    ["critical", "critical", "criticalSurface"],
  ])(
    "maps %s status to semantic text and surface colors with icon plus scalable label",
    async (tone, textKey, surfaceKey) => {
      const screen = await render(
        <ThemeHarness>
          <StatusBadge icon="✓" label={`${tone} status`} tone={tone} />
        </ThemeHarness>,
      );

      const status = screen.getByLabelText(`Status: ${tone} status`);
      const label = screen.getByText(`${tone} status`, {
        includeHiddenElements: true,
      });
      const icon = screen.getByText("✓", { includeHiddenElements: true });

      expect(StyleSheet.flatten(status.props.style)).toEqual(
        expect.objectContaining({ backgroundColor: lightColors[surfaceKey] }),
      );
      expect(StyleSheet.flatten(label.props.style)).toEqual(
        expect.objectContaining({ color: lightColors[textKey] }),
      );
      expect(StyleSheet.flatten(icon.props.style)).toEqual(
        expect.objectContaining({ color: lightColors[textKey] }),
      );
      expect(label.props.allowFontScaling).toBe(true);
      expect(label.props.maxFontSizeMultiplier).toBe(2);
    },
  );

  testOnIOS(
    "queues only the latest LiveStatus and Toast updates for iOS VoiceOver",
    async () => {
      jest.useFakeTimers();
      const announce = jest
        .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
        .mockImplementation(() => undefined);

      function feedbackUpdates(liveMessage: string, toastMessage: string) {
        return (
          <ThemeHarness>
            <LiveStatus
              icon="↑"
              label="Transfer status"
              message={liveMessage}
              tone="info"
            />
            <Toast
              icon="✓"
              label="Saved"
              message={toastMessage}
              tone="success"
            />
          </ThemeHarness>
        );
      }

      const screen = await render(
        feedbackUpdates("Sending photos", "Photo saved to your library"),
      );
      expect(announce).not.toHaveBeenCalled();

      await screen.rerender(
        feedbackUpdates("1 photo remaining", "First save finished"),
      );
      await screen.rerender(
        feedbackUpdates("Transfer complete", "All photos saved"),
      );
      await act(() => jest.runOnlyPendingTimers());

      expect(announce.mock.calls).toEqual([
        ["Transfer status: Transfer complete", { queue: true }],
        ["Saved: All photos saved", { queue: true }],
      ]);

      await screen.rerender(
        feedbackUpdates("Transfer complete", "All photos saved"),
      );
      await act(() => jest.runOnlyPendingTimers());
      expect(announce).toHaveBeenCalledTimes(2);

      await screen.rerender(
        feedbackUpdates("Stale after close", "Stale toast after close"),
      );
      await screen.unmount();
      await act(() => jest.runOnlyPendingTimers());
      expect(announce).toHaveBeenCalledTimes(2);
    },
  );

  testOnAndroid(
    "keeps Android update announcements on polite live regions",
    async () => {
      jest.useFakeTimers();
      const announce = jest
        .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
        .mockImplementation(() => undefined);
      const screen = await render(
        <ThemeHarness>
          <LiveStatus
            icon="↑"
            label="Transfer status"
            message="Sending photos"
            tone="info"
          />
          <Toast
            icon="✓"
            label="Saved"
            message="Photo saved to your library"
            tone="success"
          />
        </ThemeHarness>,
      );

      await screen.rerender(
        <ThemeHarness>
          <LiveStatus
            icon="↑"
            label="Transfer status"
            message="Transfer complete"
            tone="success"
          />
          <Toast
            icon="✓"
            label="Saved"
            message="All photos saved"
            tone="success"
          />
        </ThemeHarness>,
      );
      await act(() => jest.runOnlyPendingTimers());

      expect(announce).not.toHaveBeenCalled();
      expect(
        screen.getByLabelText("Transfer status: Transfer complete").props
          .accessibilityLiveRegion,
      ).toBe("polite");
      expect(
        screen.getByLabelText("Saved: All photos saved").props
          .accessibilityLiveRegion,
      ).toBe("polite");
    },
  );

  test("uses polite live regions for meaningful status and toast updates", async () => {
    const onUndo = jest.fn();
    const screen = await render(
      <ThemeHarness scheme="dark">
        <LiveStatus
          icon="↑"
          label="Transfer status"
          message="Sending photos"
          tone="info"
        />
        <Toast
          action={{ label: "Undo", onPress: onUndo }}
          icon="✓"
          label="Saved"
          message="Photo saved to your library"
          tone="success"
        />
      </ThemeHarness>,
    );

    const liveStatus = screen.getByLabelText("Transfer status: Sending photos");
    const toastAnnouncement = screen.getByLabelText(
      "Saved: Photo saved to your library",
    );

    expect(liveStatus.props.accessibilityLiveRegion).toBe("polite");
    expect(toastAnnouncement.props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByTestId("toast-surface").props.accessible).not.toBe(true);
    const undo = screen.getByRole("button", { name: "Undo" });
    await fireEvent.press(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(
      StyleSheet.flatten(screen.getByTestId("live-status-surface").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.infoSurface }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("toast-surface").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.successSurface }),
    );
  });

  test("renders inline, blocking, and empty feedback with safe direct actions", async () => {
    const onRetry = jest.fn();
    const onOpenSettings = jest.fn();
    const onCreate = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <InlineBanner
          action={{ disabled: true, label: "Try again", onPress: onRetry }}
          body="We'll keep checking automatically."
          icon="↻"
          title="Connection paused"
          tone="warning"
        />
        <BlockingCallout
          action={{ label: "Open Settings", onPress: onOpenSettings }}
          body="Allow full photo access to continue."
          icon="!"
          title="Permission needed"
        />
        <EmptyState
          action={{ label: "Create a trip", onPress: onCreate }}
          body="Start a trip to share photos automatically."
          icon="○"
          title="No active trip"
        />
      </ThemeHarness>,
    );

    expect(
      screen.getByRole("alert", { name: "Permission needed" }),
    ).toBeTruthy();

    const retry = screen.getByRole("button", { name: "Try again" });
    const settings = screen.getByRole("button", { name: "Open Settings" });
    const create = screen.getByRole("button", { name: "Create a trip" });

    expect(retry.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    for (const action of [retry, settings, create]) {
      expect(StyleSheet.flatten(action.props.style)).toEqual(
        expect.objectContaining({
          minHeight: spacing.xxxl,
          minWidth: spacing.xxxl,
        }),
      );
    }

    await fireEvent.press(retry);
    await fireEvent.press(settings);
    await fireEvent.press(create);

    expect(onRetry).not.toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test("PermissionCard exposes only the direct action for each closed readiness state", async () => {
    const onRequest = jest.fn();
    const onSettings = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <View style={{ direction: "rtl" }}>
          <PermissionCard
            readiness={{
              detail: "Full access is active.",
              kind: "READY",
              label: "Photo access ready",
            }}
            title="Photo library"
          />
          <PermissionCard
            readiness={{
              action: {
                label: "Allow full access",
                onPress: onRequest,
              },
              detail: "CrewRoll needs full access to share trip photos.",
              kind: "REQUEST_ACCESS",
              label: "Access not granted",
            }}
            title="Photo library request"
          />
          <PermissionCard
            readiness={{
              action: {
                disabled: true,
                label: "Open Settings",
                onPress: onSettings,
              },
              detail: "Change photo access in system settings.",
              kind: "OPEN_SETTINGS",
              label: "Access needs attention",
            }}
            title="Photo library settings"
          />
        </View>
      </ThemeHarness>,
    );

    expect(screen.queryByRole("button", { name: "Photo access ready" })).toBe(
      null,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);

    const request = screen.getByRole("button", { name: "Allow full access" });
    const settings = screen.getByRole("button", { name: "Open Settings" });

    await fireEvent.press(request);
    await fireEvent.press(settings);

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onSettings).not.toHaveBeenCalled();
    expect(settings.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(
      StyleSheet.flatten(
        screen.getByTestId("permission-card-REQUEST_ACCESS").props.style,
      ),
    ).toEqual(expect.objectContaining({ alignItems: "stretch" }));
  });
});
