import { render } from "@testing-library/react-native";
import type { ComponentType, PropsWithChildren } from "react";
import { Text } from "react-native";

import * as designSystem from "../index";
import { useCrewRollTheme } from "./useCrewRollTheme";

type ThemeSnapshot = {
  readonly action: string;
  readonly colors: { readonly action: string };
  readonly motion: { readonly navigation: number };
  readonly scheme: "light" | "dark";
  readonly spacing: { readonly gutter: number };
};

type ThemeExports = {
  readonly createCrewRollTheme: (
    scheme: "light" | "dark",
    reduceMotion?: boolean,
  ) => ThemeSnapshot;
  readonly CrewRollThemeProvider: ComponentType<
    PropsWithChildren<{
      readonly reduceMotion?: boolean;
      readonly scheme?: "light" | "dark";
    }>
  >;
};

const themeExports = designSystem as unknown as Partial<ThemeExports>;

function ThemeProbe() {
  const theme = useCrewRollTheme() as unknown as ThemeSnapshot;

  return (
    <Text>
      {theme.scheme}|{theme.action}|{theme.colors.action}|{theme.spacing.gutter}
      |{theme.motion.navigation}
    </Text>
  );
}

describe("CrewRoll theme", () => {
  test("creates a complete typed theme while preserving direct color access", () => {
    expect(themeExports.createCrewRollTheme).toEqual(expect.any(Function));

    if (!themeExports.createCrewRollTheme) {
      return;
    }

    const theme = themeExports.createCrewRollTheme("dark");

    expect(theme).toMatchObject({
      scheme: "dark",
      action: "#F3836D",
      colors: { action: "#F3836D" },
      spacing: { gutter: 24 },
      motion: { navigation: 320 },
    });
  });

  test("zeros all motion durations when reduced motion is enabled", () => {
    expect(themeExports.createCrewRollTheme).toEqual(expect.any(Function));

    if (!themeExports.createCrewRollTheme) {
      return;
    }

    expect(themeExports.createCrewRollTheme("light", true).motion).toEqual({
      direct: 0,
      transition: 0,
      navigation: 0,
    });
  });

  test("lets a provider select the theme without breaking existing consumers", async () => {
    expect(themeExports.CrewRollThemeProvider).toEqual(expect.any(Function));

    if (!themeExports.CrewRollThemeProvider) {
      return;
    }

    const Provider = themeExports.CrewRollThemeProvider;
    const view = await render(
      <Provider scheme="dark" reduceMotion>
        <ThemeProbe />
      </Provider>,
    );

    expect(view.getByText("dark|#F3836D|#F3836D|24|0")).toBeTruthy();
  });
});
