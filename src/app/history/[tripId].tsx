import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PhotoView, SavedTripPage } from '@/application/runtime/AirMeshRuntime';
import type { GalleryCursor } from '@/data';
import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { currentLocalDate, filterPhotos } from '@/features/airmesh/filters';
import { IconButton } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

export default function SavedTripScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { runtime } = useAirMesh();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const theme = themeForScheme(colorScheme);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState<SavedTripPage | null>(null);
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [cursor, setCursor] = useState<GalleryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [todayOnly, setTodayOnly] = useState(false);
  const tileSize = Math.floor((width - 30) / 3);

  const loadInitial = useCallback(async () => {
    if (!tripId) return;
    try {
      const next = await runtime.loadSavedTripPage(tripId);
      setPage(next);
      setPhotos(next.photos);
      setCursor(next.nextCursor);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [runtime, tripId]);

  useFocusEffect(useCallback(() => {
    void loadInitial();
  }, [loadInitial]));

  const loadMore = useCallback(async () => {
    if (!tripId || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await runtime.loadSavedTripPage(tripId, cursor);
      setPage((current) => current ? { ...current, members: next.members, trip: next.trip } : next);
      setPhotos((current) => {
        const known = new Set(current.map((photo) => photo.media.id));
        return [...current, ...next.photos.filter((photo) => !known.has(photo.media.id))];
      });
      setCursor(next.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, runtime, tripId]);

  const filtered = useMemo(
    () => filterPhotos(photos, {
      memberId: memberFilter,
      localDate: todayOnly ? currentLocalDate() : null,
    }),
    [memberFilter, photos, todayOnly],
  );

  if (loading && !page) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (!page || error && photos.length === 0) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <IconButton icon="chevron-back" label="Back to saved rolls" onPress={() => router.back()} />
        <Ionicons name="alert-circle-outline" size={34} color={theme.textMuted} style={styles.errorIcon} />
        <Text style={[styles.errorTitle, { color: theme.text }]}>Could not open this roll</Text>
        <Text style={[styles.errorBody, { color: theme.textMuted }]}>{error ?? 'The saved trip is unavailable.'}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.safe, { backgroundColor: theme.background }]}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <FlatList
        data={filtered}
        keyExtractor={(photo) => photo.media.id}
        numColumns={3}
        columnWrapperStyle={styles.row}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={(
          <Animated.View entering={FadeIn.duration(280)} style={[styles.header, { borderBottomColor: theme.border, paddingTop: insets.top + 8 }]}>
            <View style={styles.topbar}>
              <IconButton icon="chevron-back" label="Back to saved rolls" onPress={() => router.back()} />
              <View style={[styles.savedBadge, { backgroundColor: theme.surfaceMuted }]}>
                <Ionicons name="checkmark-circle" size={15} color={theme.success} />
                <Text style={[styles.savedText, { color: theme.textMuted }]}>Saved locally</Text>
              </View>
            </View>
            <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>{page.trip.name}</Text>
            <Text style={[styles.meta, { color: theme.textMuted }]}>{photos.length} loaded · no connection needed</Text>
            <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              <FilterPill label="Everyone" selected={memberFilter === null} onPress={() => setMemberFilter(null)} />
              {page.members.map((member) => (
                <FilterPill
                  key={member.id}
                  label={member.displayName}
                  selected={memberFilter === member.id}
                  onPress={() => setMemberFilter(member.id)}
                />
              ))}
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <FilterPill label="All days" selected={!todayOnly} onPress={() => setTodayOnly(false)} />
              <FilterPill label="Today" selected={todayOnly} onPress={() => setTodayOnly(true)} />
            </ScrollView>
          </Animated.View>
        )}
        renderItem={({ item }) => (
          <PhotoTile
            photo={item}
            size={tileSize}
            onPress={() => router.push({
              pathname: '/trip/[tripId]/photo/[mediaId]',
              params: {
                tripId,
                mediaId: item.media.id,
                memberId: memberFilter ?? '',
                localDate: todayOnly ? currentLocalDate() : '',
              },
            })}
          />
        )}
        ListEmptyComponent={(
          <View style={styles.empty}>
            <Ionicons name="images-outline" size={30} color={theme.textMuted} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No matching photos</Text>
            <Text style={[styles.emptyBody, { color: theme.textMuted }]}>Try another friend or date filter.</Text>
            {cursor ? (
              <Pressable onPress={() => void loadMore()} style={[styles.loadMore, { backgroundColor: theme.surface }]}>
                <Text style={[styles.loadMoreText, { color: theme.accent }]}>Search older photos</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        ListFooterComponent={loadingMore ? (
          <ActivityIndicator color={theme.accent} style={styles.footerLoader} />
        ) : cursor && filtered.length > 0 ? (
          <Pressable onPress={() => void loadMore()} style={styles.footerButton}>
            <Text style={[styles.loadMoreText, { color: theme.accent }]}>Load older photos</Text>
          </Pressable>
        ) : null}
      />
    </View>
  );
}

function FilterPill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = themeForScheme(useColorScheme());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.filter, { backgroundColor: selected ? theme.accent : theme.surface, borderColor: selected ? theme.accent : theme.border }]}
    >
      <Text numberOfLines={1} style={[styles.filterText, { color: selected ? '#FFFFFF' : theme.text }]}>{label}</Text>
    </Pressable>
  );
}

function PhotoTile({ photo, size, onPress }: { photo: PhotoView; size: number; onPress: () => void }) {
  const theme = themeForScheme(useColorScheme());
  const uri = photo.thumbnail?.localUri ?? photo.original?.localUri;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Photo by ${photo.contributorName}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.photo,
        { backgroundColor: theme.surfaceMuted, height: size, width: size },
        pressed ? styles.photoPressed : null,
      ]}
    >
      {uri ? <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={140} /> : (
        <Ionicons name="image-outline" size={22} color={theme.textMuted} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 28 },
  list: { flexGrow: 1 },
  row: { gap: 3, paddingHorizontal: 12 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 3, paddingBottom: 14, paddingHorizontal: 18 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  savedBadge: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 7 },
  savedText: { fontFamily: typography.bold, fontSize: 10 },
  title: { fontFamily: typography.extraBold, fontSize: 34, letterSpacing: -1.2, lineHeight: 40, marginTop: 18 },
  meta: { fontFamily: typography.medium, fontSize: 12, marginTop: 5 },
  filters: { gap: 8, paddingTop: 18 },
  filter: { borderRadius: 999, borderWidth: 1, justifyContent: 'center', maxWidth: 150, minHeight: 40, paddingHorizontal: 14 },
  filterText: { fontFamily: typography.semibold, fontSize: 12 },
  divider: { alignSelf: 'center', height: 24, marginHorizontal: 3, width: StyleSheet.hairlineWidth },
  photo: { alignItems: 'center', borderRadius: 2, justifyContent: 'center', marginBottom: 3, overflow: 'hidden' },
  photoPressed: { opacity: 0.76 },
  empty: { alignItems: 'center', marginTop: 78, paddingHorizontal: 32 },
  emptyTitle: { fontFamily: typography.bold, fontSize: 17, marginTop: 13 },
  emptyBody: { fontFamily: typography.regular, fontSize: 12, marginTop: 6 },
  loadMore: { borderRadius: 999, marginTop: 18, paddingHorizontal: 16, paddingVertical: 11 },
  loadMoreText: { fontFamily: typography.bold, fontSize: 12 },
  footerLoader: { marginVertical: 24 },
  footerButton: { alignItems: 'center', marginVertical: 24, paddingVertical: 8 },
  errorIcon: { marginTop: 26 },
  errorTitle: { fontFamily: typography.bold, fontSize: 19, marginTop: 14 },
  errorBody: { fontFamily: typography.regular, fontSize: 13, lineHeight: 20, marginTop: 7, textAlign: 'center' },
});
