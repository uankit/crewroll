import { Stack } from "expo-router";
import { SignOutControl } from "@/bootstrap";

import { useCrewRollTheme } from "@/design-system";

export default function ProtectedAppLayout() {
  const theme = useCrewRollTheme();
  return (
    <Stack
      screenOptions={{
        animation: theme.motion.navigation === 0 ? "none" : "default",
        headerShown: true,
        headerTitle: "CrewRoll",
        headerRight: () => <SignOutControl />,
      }}
    />
  );
}
