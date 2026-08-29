import { breakpoints } from "../tokens/breakpoints";
import { darkColors, lightColors, type CrewRollColors } from "../tokens/color";
import { elevation } from "../tokens/elevation";
import { motion, reducedMotion, type CrewRollMotion } from "../tokens/motion";
import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { typography } from "../tokens/typography";

export type CrewRollColorScheme = "light" | "dark";

export type CrewRollTheme = CrewRollColors & {
  readonly scheme: CrewRollColorScheme;
  readonly colors: CrewRollColors;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  readonly elevation: typeof elevation;
  readonly motion: CrewRollMotion;
  readonly breakpoints: typeof breakpoints;
};

export function createCrewRollTheme(
  scheme: CrewRollColorScheme,
  reduceMotion = false,
): CrewRollTheme {
  const colors: CrewRollColors = scheme === "dark" ? darkColors : lightColors;

  return {
    ...colors,
    scheme,
    colors,
    spacing,
    radius,
    typography,
    elevation,
    motion: reduceMotion ? reducedMotion : motion,
    breakpoints,
  };
}
