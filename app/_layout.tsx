import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/manrope";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";

import { AppNavigator, AppProviders } from "@/bootstrap";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });
  const fontsReady = loaded || error !== null;

  useEffect(() => {
    // Network authentication must not cover the actionable startup screen.
    if (fontsReady) void SplashScreen.hideAsync();
  }, [fontsReady]);

  return (
    <AppProviders fontsReady={fontsReady}>
      <StatusBar style="auto" />
      <AppNavigator />
    </AppProviders>
  );
}
