import { act, fireEvent, render } from "@testing-library/react-native";
import { createRef, type PropsWithChildren, type ReactNode } from "react";
import { StyleSheet, type TextInput, View } from "react-native";

import {
  AppText,
  Button,
  CrewRollThemeProvider,
  Divider,
  IconButton,
  Inline,
  PressableRow,
  Screen,
  spacing,
  Stack,
  Surface,
  TextField,
} from "../index";
import { darkColors, lightColors } from "../tokens/color";

type ThemeHarnessProps = PropsWithChildren<{
  readonly scheme?: "light" | "dark";
  readonly reduceMotion?: boolean;
}>;

function ThemeHarness({
  children,
  scheme = "light",
  reduceMotion = false,
}: ThemeHarnessProps) {
  return (
    <CrewRollThemeProvider scheme={scheme} reduceMotion={reduceMotion}>
      {children}
    </CrewRollThemeProvider>
  );
}

function icon(glyph: string): ReactNode {
  return <AppText aria-hidden>{glyph}</AppText>;
}

describe("design-system primitives", () => {
  test("AppText scales through 200 percent and resolves semantic tones in both themes", async () => {
    const light = await render(
      <ThemeHarness scheme="light">
        <AppText tone="action">Light action</AppText>
      </ThemeHarness>,
    );
    const lightText = light.getByText("Light action");

    expect(lightText.props.allowFontScaling).toBe(true);
    expect(lightText.props.maxFontSizeMultiplier).toBe(2);
    expect(StyleSheet.flatten(lightText.props.style)).toEqual(
      expect.objectContaining({ color: lightColors.action }),
    );

    await light.unmount();

    const dark = await render(
      <ThemeHarness scheme="dark">
        <AppText tone="secondary">Dark secondary</AppText>
      </ThemeHarness>,
    );

    expect(
      StyleSheet.flatten(dark.getByText("Dark secondary").props.style),
    ).toEqual(expect.objectContaining({ color: darkColors.textSecondary }));
  });

  test("layout primitives expose token-backed spacing without changing child order", async () => {
    const screen = await render(
      <ThemeHarness>
        <Stack gap="lg" testID="stack">
          <AppText>First</AppText>
          <AppText>Second</AppText>
        </Stack>
        <Inline align="center" gap="xs" testID="inline" wrap>
          <AppText>Leading</AppText>
          <AppText>Trailing</AppText>
        </Inline>
        <Surface elevation="raised" testID="surface">
          <AppText>Surface content</AppText>
        </Surface>
        <Divider testID="divider" />
      </ThemeHarness>,
    );

    expect(StyleSheet.flatten(screen.getByTestId("stack").props.style)).toEqual(
      expect.objectContaining({ gap: spacing.lg }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("inline").props.style),
    ).toEqual(
      expect.objectContaining({
        alignItems: "center",
        flexDirection: "row",
        flexWrap: "wrap",
        gap: spacing.xs,
      }),
    );
    expect(
      screen.getAllByText(/First|Second/).map((node) => node.props.children),
    ).toEqual(["First", "Second"]);
    expect(
      StyleSheet.flatten(screen.getByTestId("surface").props.style),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: lightColors.surface,
        elevation: 2,
      }),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("divider").props.style),
    ).toEqual(expect.objectContaining({ backgroundColor: lightColors.border }));
  });

  test("Button and IconButton expose busy or disabled state and accessible targets", async () => {
    const onSave = jest.fn();
    const onMore = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <Button label="Save" loading onPress={onSave} />
        <IconButton icon={icon("+")} label="More" onPress={onMore} />
      </ThemeHarness>,
    );

    const save = screen.getByRole("button", { name: "Save" });
    const more = screen.getByRole("button", { name: "More" });

    expect(save.props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
    expect(StyleSheet.flatten(save.props.style)).toEqual(
      expect.objectContaining({
        minHeight: 56,
        minWidth: spacing.xxxl,
      }),
    );
    expect(StyleSheet.flatten(more.props.style)).toEqual(
      expect.objectContaining({
        minHeight: spacing.xxxl,
        minWidth: spacing.xxxl,
      }),
    );

    fireEvent.press(save);
    fireEvent.press(more);

    expect(onSave).not.toHaveBeenCalled();
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  test("every Button variant exposes a distinct semantic pressed surface", async () => {
    const screen = await render(
      <ThemeHarness>
        <Button label="Primary" onPress={jest.fn()} variant="primary" />
        <Button label="Secondary" onPress={jest.fn()} variant="secondary" />
        <Button label="Critical" onPress={jest.fn()} variant="critical" />
      </ThemeHarness>,
    );
    const cases = [
      {
        label: "Primary",
        normal: lightColors.action,
        pressed: lightColors.actionPressed,
      },
      {
        label: "Secondary",
        normal: lightColors.surface,
        pressed: lightColors.surfaceMuted,
      },
      {
        label: "Critical",
        normal: lightColors.criticalSurface,
        pressed: lightColors.surfaceMuted,
      },
    ] as const;

    for (const buttonCase of cases) {
      const button = screen.getByRole("button", { name: buttonCase.label });
      const event = {
        currentTarget: {
          measure: (
            callback: (
              x: number,
              y: number,
              width: number,
              height: number,
              pageX: number,
              pageY: number,
            ) => void,
          ) => callback(0, 0, 48, 48, 0, 0),
        },
        nativeEvent: {
          changedTouches: [],
          pageX: 0,
          pageY: 0,
          touches: [],
        },
        persist: jest.fn(),
      };

      expect(StyleSheet.flatten(button.props.style)).toEqual(
        expect.objectContaining({ backgroundColor: buttonCase.normal }),
      );

      await act(async () => {
        button.props.onResponderGrant(event);
      });

      expect(
        StyleSheet.flatten(
          screen.getByRole("button", { name: buttonCase.label }).props.style,
        ),
      ).toEqual(
        expect.objectContaining({ backgroundColor: buttonCase.pressed }),
      );

      await act(async () => {
        button.props.onResponderTerminate(event);
      });
    }
  });

  test("TextField binds visible help and validation copy to a scalable 56-point input", async () => {
    const onChangeText = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <TextField
          disabled
          errorMessage="Use at least two characters"
          label="Trip name"
          onChangeText={onChangeText}
          supportingText="Friends will see this name"
          value="Goa"
        />
      </ThemeHarness>,
    );

    const field = screen.getByLabelText("Trip name");

    expect(field.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(field.props["aria-invalid"]).toBe(true);
    expect(field.props.allowFontScaling).toBe(true);
    expect(field.props.maxFontSizeMultiplier).toBe(2);
    expect(field.props.editable).toBe(false);
    expect(StyleSheet.flatten(field.props.style)).toEqual(
      expect.objectContaining({ minHeight: 56 }),
    );
    screen.getByText("Friends will see this name");
    screen.getByText("Use at least two characters");
  });

  test("TextField forwards its typed ref to the native input", async () => {
    const inputRef = createRef<TextInput>();
    const screen = await render(
      <ThemeHarness>
        <TextField label="Invite code" ref={inputRef} value="ABCD1234" />
      </ThemeHarness>,
    );

    expect(inputRef.current).not.toBeNull();
    expect(inputRef.current?.focus).toEqual(expect.any(Function));
    expect(screen.getByLabelText("Invite code")).toBeTruthy();
  });

  test("PressableRow preserves radio semantics and interaction under an RTL parent", async () => {
    const onPress = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <View style={{ direction: "rtl" }}>
          <PressableRow
            checked
            label="Nightly"
            onPress={onPress}
            role="radio"
            supportingText="Photos arrive together each night"
            trailing={icon("✓")}
          />
        </View>
      </ThemeHarness>,
    );

    const row = screen.getByRole("radio", { name: "Nightly" });

    expect(row.props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true, disabled: false }),
    );
    expect(StyleSheet.flatten(row.props.style)).toEqual(
      expect.objectContaining({ minHeight: spacing.xxxl }),
    );

    fireEvent.press(row);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("PressableRow exposes supporting copy as its default hint without replacing an explicit hint", async () => {
    const screen = await render(
      <ThemeHarness>
        <PressableRow
          label="Immediate"
          onPress={jest.fn()}
          role="radio"
          supportingText="Photos arrive as soon as they are ready"
        />
        <PressableRow
          accessibilityHint="Double tap to choose nightly delivery"
          label="Nightly"
          onPress={jest.fn()}
          role="radio"
          supportingText="Photos arrive together each night"
        />
      </ThemeHarness>,
    );

    expect(
      screen.getByRole("radio", { name: "Immediate" }).props.accessibilityHint,
    ).toBe("Photos arrive as soon as they are ready");
    expect(
      screen.getByRole("radio", { name: "Nightly" }).props.accessibilityHint,
    ).toBe("Double tap to choose nightly delivery");
  });

  test("Screen supports scrollable and fixed compositions on the semantic background", async () => {
    const scrollable = await render(
      <ThemeHarness>
        <Screen testID="scroll-screen">
          <AppText>Scrollable</AppText>
        </Screen>
      </ThemeHarness>,
    );

    expect(
      StyleSheet.flatten(scrollable.getByTestId("scroll-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: lightColors.background }),
    );

    await scrollable.unmount();

    const fixed = await render(
      <ThemeHarness scheme="dark">
        <Screen scroll={false} testID="fixed-screen">
          <AppText>Fixed</AppText>
        </Screen>
      </ThemeHarness>,
    );

    expect(
      StyleSheet.flatten(fixed.getByTestId("fixed-screen").props.style),
    ).toEqual(
      expect.objectContaining({ backgroundColor: darkColors.background }),
    );
  });
});
