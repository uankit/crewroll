import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { TripRecord } from '@/data';
import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { PageHeader } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

export default function SavedRollsScreen() {
  const { runtime } = useAirMesh();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const theme = themeForScheme(colorScheme);
  const [trips, setTrips] = useState<TripRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTrips(await runtime.listSavedTrips());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]} edges={['top']}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <FlatList
        data={trips}
        keyExtractor={(trip) => trip.id}
        contentContainerStyle={styles.content}
        refreshing={loading && trips.length > 0}
        onRefresh={() => void load()}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={(
          <PageHeader
            title="Saved rolls"
            body="Trips stay on this phone, so you can revisit the photos you kept without reconnecting."
            onBack={() => router.back()}
          />
        )}
        renderItem={({ item, index }) => (
          <Animated.View entering={FadeInDown.delay(Math.min(index * 45, 220)).duration(340)}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() => router.push({
                pathname: '/history/[tripId]',
                params: { tripId: item.id },
              })}
              style={({ pressed }) => [
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.border },
                pressed ? styles.cardPressed : null,
              ]}
            >
              <View style={[styles.icon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name="images-outline" size={22} color={theme.accent} />
              </View>
              <View style={styles.copy}>
                <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>{item.name}</Text>
                <Text style={[styles.meta, { color: theme.textMuted }]}>{tripDate(item)}</Text>
              </View>
              <View style={styles.trailing}>
                <View style={[styles.badge, { backgroundColor: theme.surfaceMuted }]}>
                  <Text style={[styles.badgeText, { color: theme.textMuted }]}>
                    {item.status === 'ENDED' || item.status === 'ARCHIVED' ? 'Ended' : 'Saved'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
              </View>
            </Pressable>
          </Animated.View>
        )}
        ListEmptyComponent={loading ? (
          <ActivityIndicator color={theme.accent} style={styles.loader} />
        ) : (
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: theme.surfaceMuted }]}>
              <Ionicons name={error ? 'alert-circle-outline' : 'albums-outline'} size={28} color={theme.textMuted} />
            </View>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>{error ? 'Could not open saved rolls' : 'No saved rolls yet'}</Text>
            <Text style={[styles.emptyBody, { color: theme.textMuted }]}>{error ?? 'Trips you end or leave will appear here.'}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

function tripDate(trip: TripRecord): string {
  const start = new Date(trip.startsAtMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  if (trip.endsAtMs === null) return `Started ${start} · saved locally`;
  const end = new Date(trip.endsAtMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return start === end ? start : `${start} – ${end}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { flexGrow: 1, gap: 11, paddingBottom: 36, paddingHorizontal: 20, paddingTop: 8 },
  card: { alignItems: 'center', borderRadius: 21, borderWidth: 1, flexDirection: 'row', gap: 13, minHeight: 82, padding: 14 },
  cardPressed: { opacity: 0.75, transform: [{ scale: 0.99 }] },
  icon: { alignItems: 'center', borderRadius: 16, height: 50, justifyContent: 'center', width: 50 },
  copy: { flex: 1, minWidth: 0 },
  title: { fontFamily: typography.bold, fontSize: 16, letterSpacing: -0.25 },
  meta: { fontFamily: typography.medium, fontSize: 11, marginTop: 5 },
  trailing: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 6 },
  badgeText: { fontFamily: typography.bold, fontSize: 9, letterSpacing: 0.3, textTransform: 'uppercase' },
  loader: { marginTop: 60 },
  empty: { alignItems: 'center', marginTop: 62, paddingHorizontal: 34 },
  emptyIcon: { alignItems: 'center', borderRadius: 20, height: 58, justifyContent: 'center', width: 58 },
  emptyTitle: { fontFamily: typography.bold, fontSize: 18, marginTop: 16 },
  emptyBody: { fontFamily: typography.regular, fontSize: 13, lineHeight: 20, marginTop: 7, textAlign: 'center' },
});
