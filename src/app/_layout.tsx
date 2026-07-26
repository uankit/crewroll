import { Ionicons } from '@expo/vector-icons';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AirMeshProvider } from '@/features/airmesh/AirMeshProvider';
import { NativeInviteBridge } from '@/features/invites/NativeInviteBridge';
import { darkTheme, themeForScheme, typography } from '@/ui/theme';

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  if (!fontsLoaded) return <BootScreen loadingFonts />;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AirMeshProvider fallback={<BootScreen />} onBootstrapError={(message) => <BootError message={message} />}>
          <NativeInviteBridge />
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, animation: 'fade_from_bottom', animationDuration: 260 }}>
            <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
            <Stack.Screen name="index" options={{ animation: 'fade' }} />
            <Stack.Screen name="create" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="join" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="history/index" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="history/[tripId]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="trip/[tripId]" options={{ animation: 'fade' }} />
            <Stack.Screen name="trip/[tripId]/invite" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="trip/[tripId]/photo/[mediaId]" options={{ animation: 'fade' }} />
          </Stack>
        </AirMeshProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function BootScreen({ loadingFonts = false }: { loadingFonts?: boolean }) {
  return (
    <View style={[styles.center, { backgroundColor: darkTheme.background }]}>
      <View style={styles.brandIcon}>
        <Ionicons name="images" size={24} color="#FFFFFF" />
      </View>
      <Text style={styles.title}>CrewRoll</Text>
      <ActivityIndicator color={darkTheme.live} style={styles.spinner} />
      <Text style={styles.body}>{loadingFonts ? 'Setting the scene…' : 'Opening your shared roll…'}</Text>
    </View>
  );
}

function BootError({ message }: { message: string }) {
  const theme = themeForScheme(useColorScheme());
  return (
    <View style={[styles.center, { backgroundColor: theme.background }]}>
      <View style={[styles.brandIcon, { backgroundColor: theme.danger }]}>
        <Ionicons name="alert" size={24} color="#FFFFFF" />
      </View>
      <Text style={[styles.title, { color: theme.text }]}>CrewRoll could not start</Text>
      <Text selectable style={[styles.errorBody, { color: theme.textMuted }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 28 },
  brandIcon: {
    alignItems: 'center',
    backgroundColor: darkTheme.accent,
    borderRadius: 18,
    height: 52,
    justifyContent: 'center',
    marginBottom: 18,
    width: 52,
  },
  title: { color: '#FFFFFF', fontFamily: typography.extraBold, fontSize: 30, letterSpacing: -1.2 },
  spinner: { marginTop: 22 },
  body: { color: darkTheme.textMuted, fontFamily: typography.medium, fontSize: 13, marginTop: 12 },
  errorBody: { fontFamily: typography.regular, fontSize: 14, lineHeight: 21, marginTop: 12, textAlign: 'center' },
});
