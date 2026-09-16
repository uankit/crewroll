import { Stack, useRouter } from "expo-router";

import { useCrewRollTheme } from "../design-system";
import { AccountScreen } from "../features/auth/AccountScreen";
import { useAccountAuthentication } from "../infrastructure/auth/useAccountAuthentication";
import { useAppSession } from "./AppSessionProvider";

export function AppNavigator() {
  const { snapshot } = useAppSession();
  const theme = useCrewRollTheme();
  const phase = snapshot.phase;

  return (
    <Stack
      screenOptions={{
        animation: theme.motion.navigation === 0 ? "none" : "default",
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="invite/[code]" />
      <Stack.Protected guard={phase === "SIGNED_OUT"}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected
        guard={
          phase === "PROVISIONING_DEVICE" || phase === "RECOVERABLE_FAILURE"
        }
      >
        <Stack.Screen name="provision" />
      </Stack.Protected>
      <Stack.Protected guard={phase.startsWith("READY_")}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

export function AppSignInSurface() {
  const flow = useAccountAuthentication();
  const router = useRouter();
  return <AccountScreen flow={flow} onBack={() => router.replace("/")} />;
}
