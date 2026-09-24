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
import { useEffect, useState } from "react";

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
  const [fontDeadline, setFontDeadline] = useState(false);
  const fontsReady = loaded || error !== null || fontDeadline;

  useEffect(() => {
    if (loaded || error !== null) return;
    // A font asset must never hold the native splash indefinitely. The bundled
    // font can finish loading after the first usable screen appears.
    const timer = setTimeout(() => setFontDeadline(true), 2_000);
    return () => clearTimeout(timer);
  }, [loaded, error]);

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
