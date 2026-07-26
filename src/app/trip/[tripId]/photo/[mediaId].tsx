import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AirMeshRuntime, PhotoView } from '@/application/runtime/AirMeshRuntime';
import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { filterPhotos } from '@/features/airmesh/filters';
import {
  latestDownloadTransfer,
  originalTransferPresentation,
  photoDisplayUri,
  photoPreviewUri,
  type OriginalTransferPhase,
  type OriginalTransferPresentation,
} from '@/features/airmesh/photoPresentation';
import {
  appendSavedPhotoPagesUntilVisible,
  loadSavedPhotoSequenceThrough,
  shouldPrefetchPhotoPage,
  type SavedPhotoSequence,
} from '@/features/airmesh/savedPhotoPagination';
import { AppButton, IconButton } from '@/ui/components';
import { type AppTheme, themeForScheme, typography } from '@/ui/theme';

interface BusyAction {
  mediaId: string;
  kind: 'request' | 'save';
}

export default function PhotoDetailScreen() {
  const {
    tripId,
    mediaId,
    memberId = '',
    localDate = '',
  } = useLocalSearchParams<{
    tripId: string;
    mediaId: string;
    memberId?: string;
    localDate?: string;
  }>();
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const theme = themeForScheme(useColorScheme());
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const pagerRef = useRef<FlatList<PhotoView>>(null);
  const prefetchRequestKeyRef = useRef<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [optimisticRequests, setOptimisticRequests] = useState<Record<string, number>>({});
  const [currentMediaId, setCurrentMediaId] = useState(mediaId);
  const session = snapshot.session;
  const isActiveTrip = session?.trip.id === tripId;
  const selectedMemberId = memberId || null;
  const selectedLocalDate = localDate || null;
  const savedPager = useSavedTripPager({
    enabled: !isActiveTrip,
    tripId,
    targetMediaId: mediaId,
    memberId: selectedMemberId,
    localDate: selectedLocalDate,
    runtime,
  });
  const loadMoreSavedPhotos = savedPager.loadMore;

  const activePhotos = useMemo(() => {
    if (!isActiveTrip) return [];
    const filtered = filterPhotos(snapshot.photos, {
      memberId: selectedMemberId,
      localDate: selectedLocalDate,
    });
    if (filtered.some((candidate) => candidate.media.id === currentMediaId)) return filtered;
    return filterPhotos(snapshot.photos, { memberId: null, localDate: null });
  }, [currentMediaId, isActiveTrip, selectedLocalDate, selectedMemberId, snapshot.photos]);
  const savedPhotos = useMemo(() => {
    if (isActiveTrip) return [];
    const filtered = filterPhotos(savedPager.photos, {
      memberId: selectedMemberId,
      localDate: selectedLocalDate,
    });
    if (filtered.some((candidate) => candidate.media.id === currentMediaId)) return filtered;
    return filterPhotos(savedPager.photos, { memberId: null, localDate: null });
  }, [currentMediaId, isActiveTrip, savedPager.photos, selectedLocalDate, selectedMemberId]);
  const pagerPhotos = isActiveTrip ? activePhotos : savedPhotos;
  const locatedIndex = pagerPhotos.findIndex((candidate) => candidate.media.id === currentMediaId);
  const currentIndex = Math.max(0, locatedIndex);
  const photo = locatedIndex >= 0 ? pagerPhotos[locatedIndex] ?? null : null;
  const hasMorePagerPhotos = isActiveTrip ? snapshot.hasMorePhotos : savedPager.hasMore;
  const isLoadingMorePagerPhotos = isActiveTrip
    ? snapshot.isLoadingMorePhotos
    : savedPager.isLoadingMore;
  const loadMorePagerPhotos = useCallback(
    () => isActiveTrip ? runtime.loadMorePhotos() : loadMoreSavedPhotos(),
    [isActiveTrip, loadMoreSavedPhotos, runtime],
  );

  useEffect(() => {
    if (pagerPhotos.length < 2) return;
    const adjacentUris = [pagerPhotos[currentIndex - 1], pagerPhotos[currentIndex + 1]]
      .map((candidate) => candidate ? photoPreviewUri(candidate) : null)
      .filter((uri): uri is string => Boolean(uri));
    if (adjacentUris.length === 0) return;
    void Image.prefetch(adjacentUris, { cachePolicy: 'memory-disk' }).catch(() => undefined);
  }, [currentIndex, pagerPhotos]);

  useEffect(() => {
    if (
      !shouldPrefetchPhotoPage(currentIndex, pagerPhotos.length, hasMorePagerPhotos) ||
      isLoadingMorePagerPhotos ||
      (!isActiveTrip && savedPager.error)
    ) return;
    const requestKey = `${tripId}:${isActiveTrip ? 'active' : 'saved'}:${pagerPhotos.length}:${currentIndex}`;
    if (prefetchRequestKeyRef.current === requestKey) return;
    prefetchRequestKeyRef.current = requestKey;
    void loadMorePagerPhotos();
  }, [
    currentIndex,
    hasMorePagerPhotos,
    isActiveTrip,
    isLoadingMorePagerPhotos,
    loadMorePagerPhotos,
    pagerPhotos.length,
    savedPager.error,
    tripId,
  ]);

  const setCurrentPage = useCallback((index: number) => {
    const next = pagerPhotos[index];
    if (!next || next.media.id === currentMediaId) return;
    setCurrentMediaId(next.media.id);
    router.setParams({ mediaId: next.media.id });
    void AccessibilityInfo.announceForAccessibility(
      `${photoPositionAnnouncement(index + 1, pagerPhotos.length, hasMorePagerPhotos)}, by ${next.contributorName}`,
    );
  }, [currentMediaId, hasMorePagerPhotos, pagerPhotos, router]);

  const onPagerSettled = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const index = Math.max(0, Math.min(pagerPhotos.length - 1, Math.round(event.nativeEvent.contentOffset.x / width)));
    setCurrentPage(index);
  }, [pagerPhotos.length, setCurrentPage, width]);

  if (isActiveTrip && !photo) {
    return <Redirect href={{ pathname: '/trip/[tripId]', params: { tripId } }} />;
  }
  if (!isActiveTrip && savedPager.isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.background }]}> 
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }
  if (!photo) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.background }]}> 
        <IconButton icon="chevron-back" label="Go back" onPress={() => router.back()} />
        <Text style={[styles.missingTitle, { color: theme.text }]}>Photo unavailable</Text>
        <Text style={[styles.missingBody, { color: theme.textMuted }]}>{savedPager.error ?? 'This photo could not be opened.'}</Text>
      </View>
    );
  }

  const latestTransfer = latestDownloadTransfer(snapshot.transfers, photo.original?.id);
  const optimisticRequestAt = optimisticRequests[photo.media.id];
  const optimisticQueued = optimisticRequestAt !== undefined
    && (!latestTransfer || latestTransfer.updatedAt < optimisticRequestAt);
  const presentation = originalTransferPresentation(
    photo,
    snapshot.transfers,
    Boolean(isActiveTrip),
    optimisticQueued,
  );
  const originalReady = presentation.phase === 'ready';
  const previewReady = Boolean(photoDisplayUri(photo));
  const sheetHeight = Math.min(390, Math.max(256, Math.round(height * 0.4)));
  const pageCount = pagerPhotos.length;
  const pagePosition = currentIndex + 1;
  const pageCountText = hasMorePagerPhotos ? `${pageCount}+` : String(pageCount);
  const pageAnnouncement = photoPositionAnnouncement(
    pagePosition,
    pageCount,
    hasMorePagerPhotos,
  );
  const actionBusy = busyAction?.mediaId === photo.media.id;

  const requestOriginal = async (target: PhotoView) => {
    if (!isActiveTrip) return;
    const requestedAt = Date.now();
    setBusyAction({ mediaId: target.media.id, kind: 'request' });
    try {
      await runtime.requestOriginal(target);
      setOptimisticRequests((current) => ({ ...current, [target.media.id]: requestedAt }));
    } catch (error) {
      Alert.alert('Original unavailable', error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction((current) => current?.mediaId === target.media.id ? null : current);
    }
  };
  const save = async (target: PhotoView) => {
    if (target.original?.availability !== 'available' || !target.original.localUri) return;
    setBusyAction({ mediaId: target.media.id, kind: 'save' });
    try {
      await runtime.saveOriginalToLibrary(target);
      Alert.alert('Saved', 'The exact original was added to your photo library.');
    } catch (error) {
      Alert.alert('Could not save photo', error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction((current) => current?.mediaId === target.media.id ? null : current);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}> 
      <StatusBar style="light" />
      <View style={styles.preview}>
        <FlatList
          ref={pagerRef}
          key={`photo-pager-${tripId}-${Math.round(width)}`}
          accessibilityLabel={`${isActiveTrip ? 'Trip' : 'Saved trip'} photos. ${pageAnnouncement}. Swipe horizontally for more.`}
          data={pagerPhotos}
          horizontal
          pagingEnabled
          disableIntervalMomentum
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={currentIndex}
          initialNumToRender={Math.min(3, pagerPhotos.length)}
          maxToRenderPerBatch={3}
          windowSize={3}
          removeClippedSubviews
          keyExtractor={(item) => item.media.id}
          getItemLayout={(_, index) => ({ index, length: width, offset: width * index })}
          onEndReached={() => void loadMorePagerPhotos()}
          onEndReachedThreshold={3}
          onMomentumScrollEnd={onPagerSettled}
          renderItem={({ item }) => (
            <PhotoPage photo={item} width={width} isActiveTrip={isActiveTrip} theme={theme} />
          )}
        />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(1,7,14,0.46)', 'transparent', 'rgba(1,7,14,0.74)']}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView edges={['top']} style={styles.photoTopbar}>
          <IconButton icon="chevron-back" label="Back to trip" inverse onPress={() => router.back()} />
          <View style={styles.topbarPills}>
            {pageCount > 1 || hasMorePagerPhotos ? (
              <View style={styles.positionPill} accessibilityLabel={pageAnnouncement}> 
                {isLoadingMorePagerPhotos ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
                <Text style={styles.positionText}>{pagePosition} of {pageCountText}</Text>
              </View>
            ) : null}
            <View style={styles.verifiedPill}>
              <Ionicons
                name={originalReady ? 'checkmark-circle' : presentation.phase === 'failed' ? 'alert-circle' : 'image-outline'}
                size={16}
                color={originalReady ? '#38E6B4' : presentation.phase === 'failed' ? '#FFBD66' : '#FFFFFF'}
              />
              <Text style={styles.verifiedText}>
                {originalReady
                  ? 'Original ready'
                  : presentation.phase === 'failed'
                    ? 'Retry available'
                    : isActiveTrip
                      ? 'Preview'
                      : previewReady
                        ? 'Saved preview'
                        : 'Not stored'}
              </Text>
            </View>
          </View>
        </SafeAreaView>
      </View>

      <Animated.View
        entering={FadeInDown.duration(400)}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.background,
            height: sheetHeight,
            paddingBottom: Math.max(insets.bottom, 12),
          },
        ]}
      >
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View style={styles.headingRow}>
            <View style={styles.headingCopy}>
              <Text numberOfLines={1} style={[styles.contributor, { color: theme.text }]}>{photo.contributorName}</Text>
              <Text style={[styles.captured, { color: theme.textMuted }]}>{formatCaptureTime(photo.media.capturedAtMs)}</Text>
            </View>
            <View style={[styles.sizePill, { backgroundColor: theme.surfaceMuted }]}> 
              <Text style={[styles.sizeText, { color: theme.textMuted }]}>
                {photo.original ? formatBytes(photo.original.byteLength) : 'Original pending'}
              </Text>
            </View>
          </View>
          <OriginalStatus presentation={presentation} theme={theme} />
        </ScrollView>

        <View style={styles.actions}>
          {originalReady ? (
            <AppButton
              label="Save exact original"
              icon="download-outline"
              onPress={() => void save(photo)}
              loading={actionBusy && busyAction?.kind === 'save'}
            />
          ) : isActiveTrip && presentation.canRequest ? (
            <AppButton
              label={presentation.actionLabel ?? 'Get exact original'}
              icon={presentation.phase === 'failed' ? 'refresh' : 'arrow-down-circle-outline'}
              onPress={() => void requestOriginal(photo)}
              loading={actionBusy && busyAction?.kind === 'request'}
            />
          ) : (
            <AppButton
              label={pendingActionLabel(presentation.phase, Boolean(isActiveTrip))}
              icon={pendingActionIcon(presentation.phase)}
              variant="secondary"
              disabled
              onPress={() => undefined}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}

interface SavedTripPagerOptions {
  enabled: boolean;
  tripId: string;
  targetMediaId: string;
  memberId: string | null;
  localDate: string | null;
  runtime: Pick<AirMeshRuntime, 'loadSavedTripPage'>;
}

interface SavedTripPagerResult {
  photos: PhotoView[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  loadMore(): Promise<void>;
}

const EMPTY_SAVED_SEQUENCE: SavedPhotoSequence = { photos: [], nextCursor: null };

function useSavedTripPager({
  enabled,
  tripId,
  targetMediaId,
  memberId,
  localDate,
  runtime,
}: SavedTripPagerOptions): SavedTripPagerResult {
  const [sequence, setSequence] = useState<SavedPhotoSequence>(EMPTY_SAVED_SEQUENCE);
  const [sequenceTripId, setSequenceTripId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef<SavedPhotoSequence>(EMPTY_SAVED_SEQUENCE);
  const loadedTripIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const loadMoreRequestRef = useRef<{
    generation: number;
    promise: Promise<void>;
  } | null>(null);

  const publishSequence = useCallback((next: SavedPhotoSequence) => {
    sequenceRef.current = next;
    setSequence(next);
  }, []);

  useEffect(() => () => {
    generationRef.current += 1;
  }, []);

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      loadedTripIdRef.current = null;
      loadMoreRequestRef.current = null;
      return;
    }

    const sameTrip = loadedTripIdRef.current === tripId;
    const current = sameTrip ? sequenceRef.current : EMPTY_SAVED_SEQUENCE;
    if (current.photos.some((photo) => photo.media.id === targetMediaId)) {
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadedTripIdRef.current = tripId;
    loadMoreRequestRef.current = null;
    sequenceRef.current = current;

    void Promise.resolve()
      .then(() => {
        if (generationRef.current !== generation || loadedTripIdRef.current !== tripId) {
          return null;
        }
        setSequenceTripId(tripId);
        publishSequence(current);
        setIsLoading(true);
        setIsLoadingMore(false);
        setError(null);
        return loadSavedPhotoSequenceThrough(
          (cursor) => runtime.loadSavedTripPage(tripId, cursor),
          targetMediaId,
          current,
        );
      })
      .then((next) => {
        if (
          !next ||
          generationRef.current !== generation ||
          loadedTripIdRef.current !== tripId
        ) return;
        publishSequence(next);
        setError(next.found ? null : 'This photo is no longer stored on this phone.');
      })
      .catch((reason) => {
        if (generationRef.current !== generation || loadedTripIdRef.current !== tripId) return;
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (generationRef.current === generation && loadedTripIdRef.current === tripId) {
          setIsLoading(false);
        }
      });
  }, [enabled, publishSequence, runtime, targetMediaId, tripId]);

  const loadMore = useCallback((): Promise<void> => {
    if (!enabled || loadedTripIdRef.current !== tripId) return Promise.resolve();
    const generation = generationRef.current;
    const existing = loadMoreRequestRef.current;
    if (existing?.generation === generation) return existing.promise;

    const current = sequenceRef.current;
    if (!current.nextCursor) return Promise.resolve();
    const matchesSelectedFilters = (photo: PhotoView) => filterPhotos(
      [photo],
      { memberId, localDate },
    ).length === 1;
    const targetMatchesSelectedFilters = current.photos.some(
      (photo) => photo.media.id === targetMediaId && matchesSelectedFilters(photo),
    );
    const isVisible = targetMatchesSelectedFilters
      ? matchesSelectedFilters
      : (photo: PhotoView) => filterPhotos(
          [photo],
          { memberId: null, localDate: null },
        ).length === 1;

    setError(null);
    setIsLoadingMore(true);
    const task = appendSavedPhotoPagesUntilVisible(
      current,
      (cursor) => runtime.loadSavedTripPage(tripId, cursor),
      isVisible,
    )
      .then((next) => {
        if (generationRef.current !== generation || loadedTripIdRef.current !== tripId) return;
        publishSequence(next);
      })
      .catch((reason) => {
        if (generationRef.current !== generation || loadedTripIdRef.current !== tripId) return;
        setError(`Could not load more saved photos: ${errorMessage(reason)}`);
      });
    const tracked = task.finally(() => {
      if (loadMoreRequestRef.current?.promise === tracked) {
        loadMoreRequestRef.current = null;
      }
      if (generationRef.current === generation && loadedTripIdRef.current === tripId) {
        setIsLoadingMore(false);
      }
    });
    loadMoreRequestRef.current = { generation, promise: tracked };
    return tracked;
  }, [enabled, localDate, memberId, publishSequence, runtime, targetMediaId, tripId]);

  const stateBelongsToTrip = enabled && sequenceTripId === tripId;
  const visibleSequence = stateBelongsToTrip ? sequence : EMPTY_SAVED_SEQUENCE;
  const visibleError = stateBelongsToTrip ? error : null;
  const targetIsLoaded = visibleSequence.photos.some(
    (photo) => photo.media.id === targetMediaId,
  );

  return {
    photos: visibleSequence.photos,
    hasMore: visibleSequence.nextCursor !== null,
    isLoading: isLoading || (enabled && !targetIsLoaded && visibleError === null),
    isLoadingMore: stateBelongsToTrip && isLoadingMore,
    error: visibleError,
    loadMore,
  };
}

function photoPositionAnnouncement(
  position: number,
  loadedCount: number,
  hasMore: boolean,
): string {
  return hasMore
    ? `Photo ${position} of at least ${loadedCount}`
    : `Photo ${position} of ${loadedCount}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PhotoPage({
  photo,
  width,
  isActiveTrip,
  theme,
}: {
  photo: PhotoView;
  width: number;
  isActiveTrip: boolean;
  theme: AppTheme;
}) {
  const displayUri = photoDisplayUri(photo);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const imageFailed = Boolean(displayUri && failedUri === displayUri);

  return (
    <View style={[styles.photoPage, { width }]}> 
      {displayUri && !imageFailed ? (
        <Image
          source={displayUri}
          placeholder={photo.thumbnail?.localUri ?? undefined}
          placeholderContentFit="cover"
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          priority="high"
          recyclingKey={photo.media.id}
          transition={180}
          alt={`Photo by ${photo.contributorName}`}
          onError={() => setFailedUri(displayUri)}
        />
      ) : (
        <View style={[styles.waiting, { backgroundColor: theme.surfaceMuted }]}> 
          <Ionicons name={imageFailed ? 'alert-circle-outline' : 'image-outline'} size={36} color={theme.textMuted} />
          <Text style={[styles.waitingText, { color: theme.textMuted }]}> 
            {imageFailed
              ? 'This local photo could not be displayed.'
              : isActiveTrip
                ? 'Preview is waiting for a connected holder.'
                : 'This photo is catalogued, but its preview is not stored on this phone.'}
          </Text>
        </View>
      )}
    </View>
  );
}

function OriginalStatus({
  presentation,
  theme,
}: {
  presentation: OriginalTransferPresentation;
  theme: AppTheme;
}) {
  const showsProgress = presentation.phase === 'queued'
    || presentation.phase === 'transferring'
    || presentation.phase === 'verifying'
    || presentation.phase === 'paused';
  const percent = Math.round((presentation.progress ?? 0) * 100);

  if (showsProgress) {
    return (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: percent, text: presentation.label }}
        style={styles.transferBlock}
      >
        <View style={styles.transferRow}>
          <Text accessibilityLiveRegion="polite" style={[styles.transferLabel, { color: theme.text }]}> 
            {presentation.label}
          </Text>
          <View style={styles.transferValueWrap}>
            {presentation.phase === 'verifying' ? <ActivityIndicator color={theme.accent} size="small" /> : null}
            <Text style={[styles.transferValue, { color: theme.textMuted }]}> 
              {presentation.phase === 'queued' ? 'Queued' : presentation.phase === 'verifying' ? 'Checking' : `${percent}%`}
            </Text>
          </View>
        </View>
        <View style={[styles.progressTrack, { backgroundColor: theme.surfaceStrong }]}> 
          <View style={[styles.progressFill, { backgroundColor: theme.accent, width: `${percent}%` }]} />
        </View>
        <Text style={[styles.statusDetail, { color: theme.textMuted }]}>{presentation.detail}</Text>
      </View>
    );
  }

  const failed = presentation.phase === 'failed';
  const ready = presentation.phase === 'ready';
  return (
    <View accessibilityLiveRegion="polite" style={styles.truthRow}>
      <Ionicons
        name={ready ? 'shield-checkmark' : failed ? 'alert-circle-outline' : 'phone-portrait-outline'}
        size={20}
        color={ready ? theme.success : failed ? theme.danger : theme.textMuted}
      />
      <View style={styles.truthCopy}>
        <Text style={[styles.truthTitle, { color: failed ? theme.danger : theme.text }]}>{presentation.label}</Text>
        <Text style={[styles.truthText, { color: theme.textMuted }]}>{presentation.detail}</Text>
      </View>
    </View>
  );
}

function pendingActionLabel(phase: OriginalTransferPhase, isActiveTrip: boolean): string {
  if (!isActiveTrip) return 'Original not stored';
  if (phase === 'preparing') return 'Preparing exact original';
  if (phase === 'queued') return 'Waiting for connected holder';
  if (phase === 'transferring') return 'Receiving original';
  if (phase === 'verifying') return 'Verifying original';
  if (phase === 'paused') return 'Waiting to resume';
  return 'Original unavailable';
}

function pendingActionIcon(phase: OriginalTransferPhase): React.ComponentProps<typeof Ionicons>['name'] {
  if (phase === 'preparing') return 'sync-outline';
  if (phase === 'queued') return 'time-outline';
  if (phase === 'transferring') return 'arrow-down-circle-outline';
  if (phase === 'verifying') return 'shield-checkmark-outline';
  if (phase === 'paused') return 'pause-circle-outline';
  return 'cloud-offline-outline';
}

function formatCaptureTime(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

function formatBytes(value: number): string {
  if (value <= 0) return 'Original';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, overflow: 'hidden' },
  loading: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 30 },
  missingTitle: { fontFamily: typography.bold, fontSize: 20, marginTop: 28 },
  missingBody: { fontFamily: typography.regular, fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  preview: { flex: 1, minHeight: 0 },
  photoPage: { flex: 1 },
  waiting: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', padding: 44 },
  waitingText: { fontFamily: typography.medium, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  photoTopbar: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between', left: 0, paddingHorizontal: 18, paddingTop: 6, position: 'absolute', right: 0, top: 0 },
  topbarPills: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  positionPill: { alignItems: 'center', backgroundColor: 'rgba(2,9,18,0.62)', borderRadius: 999, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  positionText: { color: '#FFFFFF', fontFamily: typography.bold, fontSize: 11 },
  verifiedPill: { alignItems: 'center', backgroundColor: 'rgba(2,9,18,0.62)', borderRadius: 999, flexDirection: 'row', gap: 7, minHeight: 40, paddingHorizontal: 13 },
  verifiedText: { color: '#FFFFFF', fontFamily: typography.semibold, fontSize: 12 },
  sheet: { borderTopLeftRadius: 30, borderTopRightRadius: 30, flexShrink: 0, marginTop: -28, overflow: 'hidden' },
  sheetScroll: { flex: 1 },
  sheetContent: { gap: 18, paddingBottom: 8, paddingHorizontal: 20, paddingTop: 24 },
  headingRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  headingCopy: { flex: 1, paddingRight: 14 },
  contributor: { fontFamily: typography.extraBold, fontSize: 26, letterSpacing: -0.8 },
  captured: { fontFamily: typography.medium, fontSize: 12, marginTop: 4 },
  sizePill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  sizeText: { fontFamily: typography.bold, fontSize: 11 },
  truthRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  truthCopy: { flex: 1, gap: 3 },
  truthTitle: { fontFamily: typography.semibold, fontSize: 13 },
  truthText: { fontFamily: typography.regular, fontSize: 12, lineHeight: 18 },
  transferBlock: { gap: 9 },
  transferRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  transferLabel: { flex: 1, fontFamily: typography.semibold, fontSize: 13 },
  transferValueWrap: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  transferValue: { fontFamily: typography.bold, fontSize: 12 },
  progressTrack: { borderRadius: 4, height: 7, overflow: 'hidden' },
  progressFill: { borderRadius: 4, height: 7 },
  statusDetail: { fontFamily: typography.regular, fontSize: 12, lineHeight: 18 },
  actions: { paddingHorizontal: 20, paddingTop: 12 },
});
