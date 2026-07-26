import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';

import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { AppButton, IconButton, InlineNotice } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

export default function InviteScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const theme = themeForScheme(useColorScheme());
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const [completedFocusRefresh, setCompletedFocusRefresh] = useState(false);
  const session = snapshot.session;
  const activeMemberCount = snapshot.members.filter(
    (member) => member.status === 'ACTIVE' || member.status === 'LEAVING',
  ).length;

  useFocusEffect(useCallback(() => {
    let focused = true;
    setCompletedFocusRefresh(false);
    void runtime.refreshCoordinatorInvite().finally(() => {
      if (focused) setCompletedFocusRefresh(true);
    });
    return () => {
      focused = false;
    };
  }, [runtime]));

  if (!session || session.trip.id !== tripId || !session.inviteLink) return <Redirect href="/" />;

  const refreshFailure = snapshot.inviteRefreshError;
  const inviteUnavailable =
    !completedFocusRefresh || snapshot.isRefreshingInvite || Boolean(refreshFailure);
  const qrSize = Math.min(width - 108, 246);

  const copy = async () => {
    if (inviteUnavailable) return;
    await Clipboard.setStringAsync(session.inviteLink!);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_800);
  };
  const share = async () => {
    if (inviteUnavailable) return;
    await Share.share({
      title: `Join ${session.trip.name} on CrewRoll`,
      message: `Join ${session.trip.name} on CrewRoll with this secure invite:\n${session.inviteLink}`,
    });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={styles.topbar}>
        <IconButton icon="chevron-back" label="Back to trip" onPress={() => router.back()} />
        <Text style={[styles.topTitle, { color: theme.text }]}>Invite friends</Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

      <Animated.View entering={FadeInDown.duration(400)} style={styles.heading}>
        <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>{session.trip.name}</Text>
        <Text style={[styles.body, { color: theme.textMuted }]}>Scan with the normal Camera. The secure invite opens CrewRoll directly.</Text>
      </Animated.View>

      {refreshFailure ? (
        <View style={styles.noticeWrap}>
          <InlineNotice
            title="QR needs a network refresh"
            body={`${refreshFailure} Connect this phone to a network, then reopen this screen.`}
            tone="warning"
          />
        </View>
      ) : null}

      <Animated.View entering={ZoomIn.delay(100).duration(420)} style={[styles.qrCard, { backgroundColor: theme.surface }]}>
        <View style={styles.qrBackground}>
          {inviteUnavailable ? (
            <View style={[styles.qrPending, { height: qrSize, width: qrSize }]}>
              {refreshFailure ? (
                <Ionicons name="warning-outline" size={25} color={theme.warning} />
              ) : (
                <ActivityIndicator color={theme.accent} />
              )}
              <Text style={[styles.qrPendingText, { color: theme.textMuted }]}>
                {refreshFailure ? 'QR hidden until the secure invite is ready.' : 'Refreshing the secure invite…'}
              </Text>
            </View>
          ) : (
            <QRCode value={session.inviteLink} size={qrSize} color="#07111F" backgroundColor="#FFFFFF" />
          )}
        </View>
        <View style={styles.metaRow}>
          <View style={[styles.peoplePill, { backgroundColor: theme.surfaceMuted }]}>
            <Ionicons name="people" size={17} color={theme.textMuted} />
            <Text style={[styles.peopleText, { color: theme.textMuted }]}>{activeMemberCount}/10</Text>
          </View>
        </View>
      </Animated.View>

      <View style={styles.securityRow}>
        <Ionicons name="lock-closed" size={16} color={theme.textMuted} />
        <Text style={[styles.securityText, { color: theme.textMuted }]}>The QR contains the encryption secret. Share it only with this group.</Text>
      </View>

      <View style={styles.actions}>
        <AppButton
          label="Share invite"
          icon="share-outline"
          onPress={() => void share()}
          loading={!completedFocusRefresh || snapshot.isRefreshingInvite}
          disabled={Boolean(refreshFailure)}
        />
        <AppButton
          label={copied ? 'Copied to clipboard' : 'Copy secure link'}
          icon={copied ? 'checkmark' : 'copy-outline'}
          variant="secondary"
          onPress={() => void copy()}
          disabled={inviteUnavailable}
        />
      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 20 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6 },
  topTitle: { fontFamily: typography.bold, fontSize: 15 },
  topSpacer: { width: 46 },
  content: { flexGrow: 1, paddingBottom: 10 },
  heading: { marginTop: 28 },
  title: { fontFamily: typography.extraBold, fontSize: 34, letterSpacing: -1.2, lineHeight: 40 },
  body: { fontFamily: typography.regular, fontSize: 14, lineHeight: 21, marginTop: 8, maxWidth: 340 },
  qrCard: { borderRadius: 28, marginTop: 26, padding: 18 },
  qrBackground: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 21, padding: 16 },
  qrPending: { alignItems: 'center', gap: 10, justifyContent: 'center' },
  qrPendingText: { fontFamily: typography.medium, fontSize: 12 },
  noticeWrap: { marginTop: 18 },
  metaRow: { alignItems: 'center', paddingTop: 17 },
  peoplePill: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 9 },
  peopleText: { fontFamily: typography.bold, fontSize: 12 },
  securityRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 8, marginTop: 15, paddingHorizontal: 6 },
  securityText: { flex: 1, fontFamily: typography.regular, fontSize: 11, lineHeight: 17 },
  actions: { gap: 10, marginTop: 'auto', paddingBottom: 10, paddingTop: 22 },
});
