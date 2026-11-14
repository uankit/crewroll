import { Stack, useRouter } from "expo-router";

import { useCrewRollTheme } from "../design-system";
import { AccountScreen } from "../features/auth/AccountScreen";
import { useAccountAuthentication } from "../infrastructure/auth/useAccountAuthentication";
import { useAppSession } from "./AppSessionProvider";
import { useAccountSetup } from "./AccountSetup";
import { isSessionTeardown } from "./sessionRouting";

export function AppNavigator() {
  const { snapshot } = useAppSession();
  const setup = useAccountSetup();
  const theme = useCrewRollTheme();
  const phase = snapshot.phase;
  const setupRequired = setup.required && !isSessionTeardown(snapshot);

  return (
    <Stack
      screenOptions={{
        animation: theme.motion.navigation === 0 ? "none" : "fade",
        animationDuration: theme.motion.transition,
        contentStyle: { backgroundColor: theme.background },
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" options={{ animation: "none" }} />
      <Stack.Protected guard={phase === "SIGNED_OUT" && !setupRequired}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={setupRequired}>
        <Stack.Screen name="setup" options={{ gestureEnabled: false }} />
      </Stack.Protected>
      <Stack.Protected
        guard={
          !setupRequired &&
          (phase === "PROVISIONING_DEVICE" ||
            phase === "SIGNING_OUT" ||
            phase === "RECOVERABLE_FAILURE")
        }
      >
        <Stack.Screen
          name="provision"
          options={{ animation: "none", gestureEnabled: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!setupRequired && phase.startsWith("READY_")}>
        <Stack.Screen name="(app)" options={{ gestureEnabled: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export function AppSignInSurface() {
  const flow = useAccountAuthentication();
  const router = useRouter();
  return <AccountScreen flow={flow} onBack={() => router.dismissTo("/")} />;
}
