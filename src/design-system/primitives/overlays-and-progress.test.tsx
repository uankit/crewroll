import { fireEvent, render, within } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";

import {
  AppText,
  CrewRollThemeProvider,
  Dialog,
  ProgressBar,
  ProgressRing,
  Sheet,
  Skeleton,
} from "../index";
import { lightColors } from "../tokens/color";

type ThemeHarnessProps = PropsWithChildren<{
  readonly reduceMotion?: boolean;
}>;

function ThemeHarness({ children, reduceMotion = false }: ThemeHarnessProps) {
  return (
    <CrewRollThemeProvider scheme="light" reduceMotion={reduceMotion}>
      {children}
    </CrewRollThemeProvider>
  );
}

describe("overlay and progress primitives", () => {
  test("Sheet exposes modal content and a labeled close action", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <Sheet onDismiss={onDismiss} title="Trip settings" visible>
          <AppText>Settings content</AppText>
        </Sheet>
      </ThemeHarness>,
    );

    expect(screen.getByTestId("sheet-modal").props.animationType).toBe("slide");
    expect(
      screen.getByTestId("sheet-content").props.accessibilityViewIsModal,
    ).toBe(true);
    screen.getByRole("header", { name: "Trip settings" });

    fireEvent.press(
      screen.getByRole("button", { name: "Close Trip settings" }),
    );

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Dialog and Sheet remove nonessential transitions under Reduce Motion", async () => {
    const screen = await render(
      <ThemeHarness reduceMotion>
        <Sheet onDismiss={jest.fn()} title="Members" visible>
          <AppText>Member content</AppText>
        </Sheet>
        <Dialog onDismiss={jest.fn()} title="End trip?" visible>
          <AppText>Everyone will receive the remaining photos.</AppText>
        </Dialog>
      </ThemeHarness>,
    );

    expect(screen.getByTestId("sheet-modal").props.animationType).toBe("none");
    expect(screen.getByTestId("dialog-modal").props.animationType).toBe("none");
    expect(
      screen.getByTestId("dialog-content").props.accessibilityViewIsModal,
    ).toBe(true);
  });

  test("Sheet and Dialog dismiss through the accessibility escape gesture", async () => {
    const onSheetDismiss = jest.fn();
    const onDialogDismiss = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <Sheet onDismiss={onSheetDismiss} title="Members" visible>
          <AppText>Member content</AppText>
        </Sheet>
        <Dialog onDismiss={onDialogDismiss} title="End trip?" visible>
          <AppText>Trip content</AppText>
        </Dialog>
      </ThemeHarness>,
    );
    const sheetContent = screen.getByTestId("sheet-content");
    const dialogContent = screen.getByTestId("dialog-content");

    expect(sheetContent.props.onAccessibilityEscape).toBe(onSheetDismiss);
    expect(dialogContent.props.onAccessibilityEscape).toBe(onDialogDismiss);

    sheetContent.props.onAccessibilityEscape();
    dialogContent.props.onAccessibilityEscape();

    expect(onSheetDismiss).toHaveBeenCalledTimes(1);
    expect(onDialogDismiss).toHaveBeenCalledTimes(1);
  });

  test("Sheet and Dialog keep long 200-percent text scrollable while modal actions remain outside the scroll body", async () => {
    const longItems = Array.from({ length: 24 }, (_, index) => (
      <AppText key={index}>{`Long item ${index + 1}`}</AppText>
    ));
    const screen = await render(
      <ThemeHarness>
        <Sheet onDismiss={jest.fn()} title="Long sheet" visible>
          {longItems}
        </Sheet>
        <Dialog onDismiss={jest.fn()} title="Long dialog" visible>
          {longItems}
        </Dialog>
      </ThemeHarness>,
    );
    const sheetBody = screen.getByTestId("sheet-scroll-body");
    const dialogBody = screen.getByTestId("dialog-scroll-body");

    expect(StyleSheet.flatten(sheetBody.props.style)).toEqual(
      expect.objectContaining({ flexShrink: 1 }),
    );
    expect(StyleSheet.flatten(dialogBody.props.style)).toEqual(
      expect.objectContaining({ flexShrink: 1 }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("sheet-content").props.style),
    ).toEqual(expect.objectContaining({ maxHeight: "90%" }));
    expect(
      StyleSheet.flatten(screen.getByTestId("dialog-content").props.style),
    ).toEqual(expect.objectContaining({ maxHeight: "90%" }));
    expect(
      within(sheetBody).queryByRole("button", { name: "Close Long sheet" }),
    ).toBeNull();
    expect(
      within(dialogBody).queryByRole("button", {
        name: "Close Long dialog",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Close Long sheet" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close Long dialog" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Long item 24", { includeHiddenElements: true }),
    ).toHaveLength(2);
    expect(
      screen.getAllByText("Long item 24", { includeHiddenElements: true })[0]
        ?.props.maxFontSizeMultiplier,
    ).toBe(2);
  });

  test("Skeleton becomes a static, hidden loading shape under Reduce Motion", async () => {
    const screen = await render(
      <ThemeHarness reduceMotion>
        <Skeleton height="lg" testID="skeleton" width="full" />
      </ThemeHarness>,
    );
    const skeleton = screen.getByTestId("skeleton", {
      includeHiddenElements: true,
    });

    expect(skeleton.props.accessible).toBe(false);
    expect(skeleton.props.accessibilityElementsHidden).toBe(true);
    expect(StyleSheet.flatten(skeleton.props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: lightColors.surfaceMuted,
        opacity: 1,
      }),
    );
  });

  test("ProgressBar clamps visual and assistive values to 100 percent", async () => {
    const screen = await render(
      <ThemeHarness>
        <ProgressBar label="Delivery" value={1.4} />
      </ThemeHarness>,
    );
    const progress = screen.getByRole("progressbar", { name: "Delivery" });

    expect(progress.props.accessibilityValue).toEqual({
      max: 100,
      min: 0,
      now: 100,
      text: "100%",
    });
    expect(
      StyleSheet.flatten(
        screen.getByTestId("progress-bar-fill", {
          includeHiddenElements: true,
        }).props.style,
      ),
    ).toEqual(expect.objectContaining({ width: "100%" }));
  });

  test("ProgressRing renders determinate segments plus text and one progressbar node", async () => {
    const screen = await render(
      <ThemeHarness>
        <ProgressRing label="Trip coverage" value={0.75} />
      </ThemeHarness>,
    );
    const progress = screen.getByRole("progressbar", {
      name: "Trip coverage",
    });

    expect(progress.props.accessibilityValue).toEqual({
      max: 100,
      min: 0,
      now: 75,
      text: "75%",
    });
    expect(
      screen.getByText("75%", { includeHiddenElements: true }),
    ).toBeTruthy();

    const activeSegments = Array.from({ length: 8 }, (_, index) =>
      StyleSheet.flatten(
        screen.getByTestId(`progress-ring-segment-${index}`, {
          includeHiddenElements: true,
        }).props.style,
      ),
    ).filter((style) => style.backgroundColor === lightColors.action);

    expect(activeSegments).toHaveLength(6);
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });
});
