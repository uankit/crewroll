import { useColorScheme } from "react-native";

import { darkColors, lightColors } from "../tokens/color";

export function useCrewRollTheme() {
  const scheme = useColorScheme();
  return scheme === "dark" ? darkColors : lightColors;
}
