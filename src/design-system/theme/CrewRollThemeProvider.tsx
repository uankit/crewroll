import { createContext, useMemo, type PropsWithChildren } from "react";
import { useColorScheme } from "react-native";

import {
  createCrewRollTheme,
  type CrewRollColorScheme,
  type CrewRollTheme,
} from "./theme";
import { useSystemReducedMotion } from "./useSystemReducedMotion";

export const CrewRollThemeContext = createContext<CrewRollTheme | undefined>(
  undefined,
);

export type CrewRollThemeProviderProps = PropsWithChildren<{
  readonly scheme?: CrewRollColorScheme;
  readonly reduceMotion?: boolean;
}>;

export function CrewRollThemeProvider({
  children,
  scheme,
  reduceMotion,
}: CrewRollThemeProviderProps) {
  const systemScheme = useColorScheme();
  const systemReduceMotion = useSystemReducedMotion(reduceMotion === undefined);
  const resolvedScheme = scheme ?? (systemScheme === "dark" ? "dark" : "light");
  const resolvedReduceMotion = reduceMotion ?? systemReduceMotion;
  const theme = useMemo(
    () => createCrewRollTheme(resolvedScheme, resolvedReduceMotion),
    [resolvedReduceMotion, resolvedScheme],
  );

  return (
    <CrewRollThemeContext.Provider value={theme}>
      {children}
    </CrewRollThemeContext.Provider>
  );
}
