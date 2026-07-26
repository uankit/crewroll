import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { decodeInviteDeepLink } from '@/core/invite';
import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { inviteLinkForJoinScreen } from '@/features/invites/routedInvite';
import { AppButton, FormField, PageHeader } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

export default function JoinTripScreen() {
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const rawUrl = Linking.useLinkingURL();
  const scannedInvite = useMemo(
    () => inviteLinkForJoinScreen(rawUrl, params),
    [params, rawUrl],
  );
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const theme = themeForScheme(useColorScheme());
  const [editedInviteLink, setEditedInviteLink] = useState<string | null>(null);
  const inviteLink = editedInviteLink ?? scannedInvite;
  const [scanValidation, setScanValidation] = useState<{
    link: string;
    result: ReturnType<typeof decodeInviteDeepLink>;
  } | null>(null);
  useEffect(() => {
    if (!scannedInvite) return;
    let mounted = true;
    void Promise.resolve()
      .then(() => decodeInviteDeepLink(scannedInvite, { nowMs: Date.now() }))
      .then((result) => {
        if (mounted) setScanValidation({ link: scannedInvite, result });
      });
    return () => {
      mounted = false;
    };
  }, [scannedInvite]);
  const scannedResult = scanValidation?.link === scannedInvite ? scanValidation.result : null;
  const isValidatingScan = Boolean(scannedInvite && !scannedResult);
  const scannedError = scannedResult && !scannedResult.ok
    ? scannedResult.issues[0]?.message ?? 'This invite is invalid.'
    : null;
  const isConnectionUpdate = Boolean(
    snapshot.session && scannedResult?.ok && scannedResult.value.tripId === snapshot.session.trip.id,
  );
  const [displayName, setDisplayName] = useState(snapshot.identity?.displayName ?? '');
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    try {
      const session = await runtime.joinTrip({ inviteLink, displayName });
      router.replace({ pathname: '/trip/[tripId]', params: { tripId: session.trip.id } });
    } catch (error) {
      Alert.alert(
        isConnectionUpdate ? 'Could not update connection' : 'Could not join trip',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <PageHeader
            title={isValidatingScan ? 'Checking your invite' : scannedError ? 'This invite cannot be used' : isConnectionUpdate ? 'Refresh the connection' : scannedInvite ? 'Your invite is ready' : 'Join the crew'}
            body={isValidatingScan ? 'Confirming that this QR is complete and still valid.' : scannedError ?? (isConnectionUpdate ? 'Use the trip admin’s latest secure invite.' : scannedInvite ? 'Add your name to join the encrypted trip.' : 'Open a CrewRoll QR with the normal Camera, or paste the secure invite below.')}
            onBack={() => router.back()}
          />

          <Animated.View entering={FadeInDown.delay(80).duration(380)} style={styles.form}>
            {scannedInvite ? (
              <View style={[styles.found, { backgroundColor: scannedError ? theme.surfaceMuted : theme.accentSoft }]}>
                <View style={[styles.foundIcon, scannedError || isValidatingScan ? { backgroundColor: theme.warning } : null]}><Ionicons name={scannedError ? 'alert' : isValidatingScan ? 'time-outline' : 'checkmark'} size={19} color="#FFFFFF" /></View>
                <View style={styles.foundCopy}>
                  <Text style={[styles.foundTitle, { color: theme.text }]}>{isValidatingScan ? 'Checking secure invite' : scannedError ? 'Invite rejected' : isConnectionUpdate ? 'Updated secure invite found' : 'Secure invite found'}</Text>
                  <Text style={[styles.foundBody, { color: theme.textMuted }]}>{isValidatingScan ? 'This takes only a moment.' : scannedError ?? (isConnectionUpdate ? 'Your existing trip key stays the same; only the local connection is refreshed.' : 'The encrypted trip details were filled in from the link.')}</Text>
                </View>
              </View>
            ) : (
              <FormField
                icon="link-outline"
                label="Secure invite link"
                placeholder="airmesh://join?…"
                value={inviteLink}
                onChangeText={setEditedInviteLink}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                numberOfLines={3}
                help="The invite contains the trip secret. Keep it inside your group."
              />
            )}
            <FormField
              icon="person-outline"
              label="Your name in this trip"
              placeholder="Atri"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
              maxLength={40}
            />
          </Animated.View>

          <View style={styles.footer}>
            <AppButton
              label={isConnectionUpdate ? 'Update connection' : 'Join trip'}
              icon="arrow-forward"
              onPress={() => void join()}
              loading={busy}
              disabled={!inviteLink.trim() || !displayName.trim() || isValidatingScan || Boolean(scannedError)}
            />
            <View style={styles.localRow}>
              <Ionicons name="wifi-outline" size={16} color={theme.textMuted} />
              <Text style={[styles.localText, { color: theme.textMuted }]}>Photos stay end-to-end encrypted while the relay routes live traffic</Text>
            </View>
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
  form: { gap: 22, marginTop: 34 },
  found: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 12, padding: 15 },
  foundIcon: { alignItems: 'center', backgroundColor: '#1675FF', borderRadius: 13, height: 40, justifyContent: 'center', width: 40 },
  foundCopy: { flex: 1, gap: 3 },
  foundTitle: { fontFamily: typography.bold, fontSize: 14 },
  foundBody: { fontFamily: typography.regular, fontSize: 12, lineHeight: 18 },
  footer: { gap: 14, marginTop: 'auto', paddingTop: 36 },
  localRow: { alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center' },
  localText: { fontFamily: typography.medium, fontSize: 12 },
});
