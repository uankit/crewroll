import { Stack } from "expo-router";
import { Platform } from "react-native";

import { useCrewRollTheme } from "@/design-system";

export const unstable_settings = { initialRouteName: "index" };

export default function ProtectedAppLayout() {
  const theme = useCrewRollTheme();
  return (
    <Stack
      screenOptions={{
        animation:
          theme.motion.navigation === 0
            ? "none"
            : Platform.OS === "android"
              ? "default"
              : "slide_from_right",
        animationDuration: theme.motion.navigation,
        contentStyle: { backgroundColor: theme.background },
        headerShown: false,
      }}
    />
  );
}
