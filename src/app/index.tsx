import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import type { TripRecord } from '@/data';
import { AppButton, BrandWordmark, InlineNotice } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

const HOME_IMAGE = require('../../assets/brand/onboarding-shared-roll.png');

export default function HomeScreen() {
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const theme = themeForScheme(useColorScheme());
  const [savedTrips, setSavedTrips] = useState<TripRecord[]>([]);

  useFocusEffect(useCallback(() => {
    let mounted = true;
    void runtime.listSavedTrips()
      .then((trips) => {
        if (mounted) setSavedTrips(trips);
      })
      .catch(() => {
        if (mounted) setSavedTrips([]);
      });
    return () => {
      mounted = false;
    };
  }, [runtime]));

  if (snapshot.session) {
    return <Redirect href={{ pathname: '/trip/[tripId]', params: { tripId: snapshot.session.trip.id } }} />;
  }
  if (snapshot.phase === 'ready' && !snapshot.hasCompletedOnboarding) {
    return <Redirect href="/onboarding" />;
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <StatusBar style="light" />
      <Animated.View entering={FadeIn.duration(500)} style={styles.hero}>
        <Image source={HOME_IMAGE} style={StyleSheet.absoluteFill} contentFit="cover" transition={220} />
        <LinearGradient
          colors={['rgba(1,7,14,0.16)', 'rgba(1,7,14,0.36)', 'rgba(1,7,14,0.98)']}
          locations={[0, 0.46, 1]}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView edges={['top']} style={styles.heroSafe}>
          <BrandWordmark />
          <View style={styles.heroCopy}>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>Nearby photo sharing</Text>
            </View>
            <Text style={styles.headline}>Everyone’s photos. One shared roll.</Text>
            <Text style={styles.subhead}>Keep using your Camera. CrewRoll brings the trip together whenever friends are connected.</Text>
          </View>
        </SafeAreaView>
      </Animated.View>

      <SafeAreaView edges={['bottom']} style={styles.bottomSafe}>
        <Animated.View entering={FadeInDown.delay(100).duration(420)} style={styles.actions}>
          {snapshot.phase === 'failed' && snapshot.fatalError ? (
            <InlineNotice title="CrewRoll could not start" body={snapshot.fatalError} tone="warning" />
          ) : null}
          <AppButton
            label="Start a trip"
            icon="sparkles-outline"
            onPress={() => router.push('/create')}
            disabled={snapshot.phase !== 'ready'}
          />
          <AppButton
            label="Join a friend’s trip"
            icon="enter-outline"
            variant="secondary"
            onPress={() => router.push('/join')}
            disabled={snapshot.phase !== 'ready'}
          />
          {savedTrips.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${savedTrips.length} saved ${savedTrips.length === 1 ? 'trip' : 'trips'}`}
              onPress={() => router.push('/history')}
              style={({ pressed }) => [
                styles.savedRolls,
                { backgroundColor: theme.surface, borderColor: theme.border },
                pressed ? styles.savedRollsPressed : null,
              ]}
            >
              <View style={[styles.savedIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name="albums-outline" size={19} color={theme.accent} />
              </View>
              <View style={styles.savedCopy}>
                <Text style={[styles.savedTitle, { color: theme.text }]}>Saved rolls</Text>
                <Text numberOfLines={1} style={[styles.savedMeta, { color: theme.textMuted }]}>
                  {savedTrips.length === 1 ? savedTrips[0].name : `${savedTrips[0].name} and ${savedTrips.length - 1} more`}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </Pressable>
          ) : null}
          <View style={styles.privateRow}>
            <Ionicons name="shield-checkmark" size={16} color={theme.textMuted} />
            <Text style={[styles.privateText, { color: theme.textMuted }]}>No account. No cloud photo library.</Text>
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hero: { flex: 1.22, minHeight: 420, overflow: 'hidden' },
  heroSafe: { flex: 1, paddingHorizontal: 22, paddingTop: 8 },
  heroCopy: { marginTop: 'auto', paddingBottom: 32 },
  liveBadge: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: 'rgba(2,9,18,0.7)', borderRadius: 999, flexDirection: 'row', gap: 8, marginBottom: 16, paddingHorizontal: 12, paddingVertical: 8 },
  liveDot: { backgroundColor: '#38E6B4', borderRadius: 5, height: 9, width: 9 },
  liveText: { color: '#FFFFFF', fontFamily: typography.semibold, fontSize: 12 },
  headline: { color: '#FFFFFF', fontFamily: typography.extraBold, fontSize: 39, letterSpacing: -1.6, lineHeight: 44, maxWidth: 360 },
  subhead: { color: 'rgba(255,255,255,0.76)', fontFamily: typography.regular, fontSize: 15, lineHeight: 22, marginTop: 12, maxWidth: 350 },
  bottomSafe: { flex: 0.78 },
  actions: { flex: 1, gap: 11, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 18 },
  privateRow: { alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', marginTop: 5 },
  privateText: { fontFamily: typography.medium, fontSize: 12 },
  savedRolls: { alignItems: 'center', borderRadius: 17, borderWidth: 1, flexDirection: 'row', gap: 11, minHeight: 58, paddingHorizontal: 12, paddingVertical: 9 },
  savedRollsPressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  savedIcon: { alignItems: 'center', borderRadius: 13, height: 38, justifyContent: 'center', width: 38 },
  savedCopy: { flex: 1 },
  savedTitle: { fontFamily: typography.bold, fontSize: 13 },
  savedMeta: { fontFamily: typography.medium, fontSize: 11, marginTop: 2 },
});
