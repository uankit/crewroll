import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { AppButton, FormField, PageHeader } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

export default function CreateTripScreen() {
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const theme = themeForScheme(useColorScheme());
  const [tripName, setTripName] = useState('');
  const [displayName, setDisplayName] = useState(snapshot.identity?.displayName ?? '');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const session = await runtime.createTrip({ name: tripName, displayName, defaultSharingMode: 'AUTO_SHARE' });
      router.replace({ pathname: '/trip/[tripId]', params: { tripId: session.trip.id } });
    } catch (error) {
      Alert.alert('Could not start trip', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <PageHeader
            title="Start the shared roll"
            body="Name the trip, invite your crew, and keep taking photos with the Camera you already use."
            onBack={() => router.back()}
          />

          <Animated.View entering={FadeInDown.delay(80).duration(380)} style={styles.form}>
            <FormField
              icon="location-outline"
              label="Trip name"
              placeholder="Goa weekend"
              value={tripName}
              onChangeText={setTripName}
              autoCorrect={false}
              maxLength={80}
              returnKeyType="next"
            />
            <FormField
              icon="person-outline"
              label="Your name"
              placeholder="Ankit"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
              maxLength={40}
            />

            <View style={[styles.promise, { backgroundColor: theme.surfaceMuted }]}>
              <View style={[styles.promiseIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name="flash" size={20} color={theme.accent} />
              </View>
              <View style={styles.promiseCopy}>
                <Text style={[styles.promiseTitle, { color: theme.text }]}>Live Share starts with the trip</Text>
                <Text style={[styles.promiseBody, { color: theme.textMuted }]}>CrewRoll asks for photo access after creation. Friends join through your secure QR; encrypted relay traffic is never stored as a cloud photo roll.</Text>
              </View>
            </View>
          </Animated.View>

          <View style={styles.footer}>
            <AppButton
              label="Create live trip"
              icon="arrow-forward"
              onPress={() => void create()}
              loading={busy}
              disabled={!tripName.trim() || !displayName.trim()}
            />
            <Text style={[styles.footnote, { color: theme.textMuted }]}>New library images can include downloads or edits. Exact originals may retain EXIF/GPS.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: 22, paddingHorizontal: 20, paddingTop: 8 },
  form: { gap: 20, marginTop: 34 },
  promise: { alignItems: 'flex-start', borderRadius: 18, flexDirection: 'row', gap: 12, padding: 15 },
  promiseIcon: { alignItems: 'center', borderRadius: 14, height: 42, justifyContent: 'center', width: 42 },
  promiseCopy: { flex: 1, gap: 4 },
  promiseTitle: { fontFamily: typography.bold, fontSize: 14 },
  promiseBody: { fontFamily: typography.regular, fontSize: 12, lineHeight: 18 },
  footer: { gap: 14, marginTop: 'auto', paddingTop: 36 },
  footnote: { fontFamily: typography.regular, fontSize: 11, lineHeight: 17, paddingHorizontal: 8, textAlign: 'center' },
});
