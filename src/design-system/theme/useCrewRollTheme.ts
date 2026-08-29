import { useContext, useMemo } from "react";
import { useColorScheme } from "react-native";

import { CrewRollThemeContext } from "./CrewRollThemeProvider";
import { createCrewRollTheme } from "./theme";
import { useSystemReducedMotion } from "./useSystemReducedMotion";

export function useCrewRollTheme() {
  const providedTheme = useContext(CrewRollThemeContext);
  const scheme = useColorScheme();
  const reduceMotion = useSystemReducedMotion(providedTheme === undefined);
  const fallbackTheme = useMemo(
    () =>
      createCrewRollTheme(scheme === "dark" ? "dark" : "light", reduceMotion),
    [reduceMotion, scheme],
  );

  return providedTheme ?? fallbackTheme;
}
