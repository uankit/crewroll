import { Stack } from "expo-router";

import { useCrewRollTheme } from "@/design-system";

export default function ProtectedAppLayout() {
  const theme = useCrewRollTheme();
  return (
    <Stack
      screenOptions={{
        animation: theme.motion.navigation === 0 ? "none" : "slide_from_right",
        animationDuration: theme.motion.navigation,
        contentStyle: { backgroundColor: theme.background },
        headerShown: false,
      }}
    />
  );
}
