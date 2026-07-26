import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PhotoView } from '@/application/runtime/AirMeshRuntime';
import type { MemberRecord, TransferRecord } from '@/data';
import { LanDiagnosticsPanel } from '@/features/diagnostics/LanDiagnosticsPanel';
import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { currentLocalDate, filterPhotos } from '@/features/airmesh/filters';
import {
  countMissingPreviews,
  photoPreviewUri,
  previewPresentation,
} from '@/features/airmesh/photoPresentation';
import { AppButton, IconButton } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

export default function TripRollScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const theme = themeForScheme(colorScheme);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [todayOnly, setTodayOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [lanRetrying, setLanRetrying] = useState(false);
  const session = snapshot.session;
  const tileSize = Math.floor((width - 30) / 3);
  const activeLocalDate = todayOnly ? currentLocalDate() : null;
  const filtered = useMemo(
    () => filterPhotos(snapshot.photos, {
      memberId: memberFilter,
      localDate: activeLocalDate,
    }),
    [activeLocalDate, memberFilter, snapshot.photos],
  );

  if (!session || session.trip.id !== tripId) return <Redirect href="/" />;

  const connected = snapshot.sync.state === 'connected';
  const connectedPeerCount = connected ? snapshot.sync.peerDeviceIds.length : 0;
  const holderConnected = connectedPeerCount > 0;
  const selectedMember = snapshot.members.find((member) => member.id === memberFilter);
  const filterLabel = selectedMember?.displayName ?? 'Everyone';
  const photoCountLabel = filtered.length === 1 ? '1 photo' : `${filtered.length} photos`;
  const missingPreviewCount = countMissingPreviews(filtered);
  const hasSyncError = Boolean(snapshot.sync.lastError && !connected);
  const interruptedPreviewCount = filtered.reduce((count, photo) => {
    const phase = previewPresentation(photo, snapshot.transfers, { connected, hasSyncError }).phase;
    return count + (phase === 'failed' || phase === 'paused' ? 1 : 0);
  }, 0);
  const galleryStatus = connected
    ? connectedGalleryLabel(
        connectedPeerCount,
        photoCountLabel,
        missingPreviewCount,
        interruptedPreviewCount,
        snapshot.sync.pendingOutbox,
      )
    : `${connectionLabel(snapshot.sync.state)} · ${photoCountLabel}`;
  const hasOperationalMessage = session.trip.status === 'DRAFT'
    || !snapshot.permission?.granted
    || snapshot.permission?.access === 'limited'
    || Boolean(snapshot.sync.lastError && !connected)
    || Boolean(snapshot.notice);

  const enablePhotoAccess = async () => {
    try {
      await runtime.enablePhotoAccess();
    } catch (error) {
      Alert.alert('Photo access failed', error instanceof Error ? error.message : String(error));
    }
  };
  const chooseMorePhotos = async () => {
    try {
      await runtime.chooseMorePhotos();
    } catch (error) {
      Alert.alert('Could not update photo access', error instanceof Error ? error.message : String(error));
    }
  };
  const retryLocalSync = async () => {
    if (lanRetrying) return;
    setLanRetrying(true);
    try {
      await runtime.retryLocalSync();
    } finally {
      setLanRetrying(false);
    }
  };

  return (
    <View style={[styles.safe, { backgroundColor: theme.background }]}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.media.id}
        numColumns={3}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        columnWrapperStyle={styles.row}
        refreshing={snapshot.isScanning}
        onRefresh={() => void runtime.scanNow()}
        onEndReached={() => void runtime.loadMorePhotos()}
        onEndReachedThreshold={0.6}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
            <Animated.View
              entering={FadeIn.duration(320)}
              style={[
                styles.header,
                {
                  backgroundColor: theme.background,
                  borderBottomColor: theme.border,
                  paddingTop: insets.top + 10,
                },
              ]}
            >
              <View style={styles.headerTop}>
                <View style={styles.headerMain}>
                  <Text numberOfLines={1} style={[styles.tripTitle, { color: theme.text }]}>
                    {session.trip.name}
                  </Text>
                  <View style={styles.headerMeta}>
                    <View
                      style={[
                        styles.syncDot,
                        { backgroundColor: connectedPeerCount > 0 ? theme.live : theme.warning },
                      ]}
                    />
                    <Text numberOfLines={1} style={[styles.syncText, { color: theme.textMuted }]}> 
                      {galleryStatus}
                    </Text>
                  </View>
                </View>
                <View style={styles.headerActions}>
                  {session.isCoordinator && session.inviteLink ? (
                    <IconButton
                      icon="person-add-outline"
                      label="Invite friends"
                      onPress={() => router.push({ pathname: '/trip/[tripId]/invite', params: { tripId } })}
                    />
                  ) : null}
                  <IconButton
                    icon="ellipsis-horizontal"
                    label="Trip options"
                    onPress={() => setActionsOpen(true)}
                  />
                </View>
              </View>
              <ScrollView
                horizontal
                bounces={false}
                showsHorizontalScrollIndicator={false}
                style={styles.filtersScroller}
                contentContainerStyle={styles.headerFilters}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Filter photos"
                  onPress={() => setFilterOpen(true)}
                  style={[styles.filterButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                >
                  <Ionicons name="people-outline" size={18} color={theme.text} />
                  <Text numberOfLines={1} style={[styles.filterText, { color: theme.text }]}>{filterLabel}</Text>
                  <Ionicons name="chevron-down" size={16} color={theme.textMuted} />
                </Pressable>
                <DatePill label="All days" selected={!todayOnly} onPress={() => setTodayOnly(false)} />
                <DatePill label="Today" selected={todayOnly} onPress={() => setTodayOnly(true)} />
              </ScrollView>
            </Animated.View>

            {hasOperationalMessage ? <View style={styles.contentHeader}>
              {session.trip.status === 'DRAFT' ? (
                <CompactBanner
                  icon="lock-closed"
                  title="Joining securely"
                  body="Waiting for the trip creator to confirm the shared history."
                  action={<AppButton compact label="Diagnose" variant="secondary" onPress={() => setDiagnosticsOpen(true)} />}
                />
              ) : null}
              {snapshot.sync.lastError && !connected ? (
                <CompactBanner
                  icon="wifi-outline"
                  title="Sharing connection paused"
                  body="Your photos stay safe on this phone. CrewRoll will catch up when the connection resumes."
                  action={<AppButton compact label="Retry" loading={lanRetrying} variant="secondary" onPress={() => void retryLocalSync()} />}
                />
              ) : null}
              {!snapshot.permission?.granted ? (
                <CompactBanner
                  icon="images-outline"
                  title="Turn on Live Share"
                  body="Use your normal Camera. CrewRoll notices new library images while the trip is active."
                  action={<AppButton compact label="Allow photos" onPress={() => void enablePhotoAccess()} />}
                />
              ) : snapshot.permission.access === 'limited' ? (
                <CompactBanner
                  icon="albums-outline"
                  title="Selected photos only"
                  body="Choose more after shooting, or grant full access for automatic catch-up."
                  action={<AppButton compact label="Choose more" onPress={() => void chooseMorePhotos()} />}
                />
              ) : null}
              {snapshot.notice ? (
                <Pressable onPress={() => runtime.clearNotice()} style={[styles.notice, { backgroundColor: theme.surfaceMuted }]}>
                  <Ionicons name="information-circle" size={19} color={theme.warning} />
                  <Text numberOfLines={2} style={[styles.noticeText, { color: theme.text }]}>{snapshot.notice}</Text>
                  <Ionicons name="close" size={18} color={theme.textMuted} />
                </Pressable>
              ) : null}
            </View> : null}
          </View>
        }
        renderItem={({ item }) => (
          <PhotoTile
            photo={item}
            size={tileSize}
            transfers={snapshot.transfers}
            connected={holderConnected}
            hasSyncError={hasSyncError}
            retrying={lanRetrying}
            onRetry={() => void retryLocalSync()}
            onPress={() => router.push({
              pathname: '/trip/[tripId]/photo/[mediaId]',
              params: {
                tripId,
                mediaId: item.media.id,
                memberId: memberFilter ?? '',
                localDate: activeLocalDate ?? '',
              },
            })}
          />
        )}
        ListEmptyComponent={
          <Animated.View entering={FadeIn.duration(320)} style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: theme.accentSoft }]}>
              <Ionicons name="images-outline" size={27} color={theme.accent} />
            </View>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>{snapshot.photos.length > 0 ? 'No matching photos yet' : 'The roll starts with your next photo'}</Text>
            <Text style={[styles.emptyBody, { color: theme.textMuted }]}>{snapshot.photos.length > 0 ? 'Try another filter or search the older pages.' : 'Take it with the normal Camera, then return here. CrewRoll will catch up automatically.'}</Text>
            {snapshot.hasMorePhotos ? (
              <AppButton compact label="Search older photos" variant="secondary" onPress={() => void runtime.loadMorePhotos()} style={styles.emptyLoadMore} />
            ) : null}
          </Animated.View>
        }
        ListFooterComponent={snapshot.isLoadingMorePhotos ? (
          <ActivityIndicator
            accessibilityLabel="Loading more photos"
            color={theme.accent}
            style={styles.galleryLoader}
          />
        ) : snapshot.hasMorePhotos && filtered.length > 0 ? (
          <View style={styles.loadMoreWrap}>
            <AppButton compact label="Load older photos" variant="secondary" onPress={() => void runtime.loadMorePhotos()} />
          </View>
        ) : null}
      />

      <FilterSheet
        visible={filterOpen}
        members={snapshot.members}
        selectedMemberId={memberFilter}
        todayOnly={todayOnly}
        onSelectMember={setMemberFilter}
        onSetToday={setTodayOnly}
        onClose={() => setFilterOpen(false)}
      />
      <ActionsSheet
        visible={actionsOpen}
        coordinator={session.isCoordinator}
        onClose={() => setActionsOpen(false)}
        onScan={() => {
          setActionsOpen(false);
          void runtime.scanNow();
        }}
        onHistory={() => {
          setActionsOpen(false);
          router.push('/history');
        }}
        onDiagnostics={() => {
          setActionsOpen(false);
          setDiagnosticsOpen(true);
        }}
        onEnd={() => {
          setActionsOpen(false);
          Alert.alert(
            session.isCoordinator ? 'End this trip?' : 'Leave this trip?',
            session.isCoordinator ? 'Everyone keeps their local photos and catalog.' : 'Your saved originals stay on this phone.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: session.isCoordinator ? 'End trip' : 'Leave', style: 'destructive', onPress: () => void runtime.endOrLeaveTrip() },
            ],
          );
        }}
      />
      <LanDiagnosticsPanel
        visible={diagnosticsOpen}
        tripId={session.trip.id}
        diagnostics={snapshot.sync.diagnostics}
        readyPeerCount={snapshot.sync.peerDeviceIds.length}
        onBuildTransferBenchmarkReport={() => runtime.buildTransferBenchmarkReport(session.trip.id)}
        onClose={() => setDiagnosticsOpen(false)}
        onRetry={() => runtime.retryLocalSync()}
      />
    </View>
  );
}

function CompactBanner({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  const theme = themeForScheme(useColorScheme());
  return (
    <View style={[styles.banner, { backgroundColor: theme.surface }]}>
      <View style={[styles.bannerIcon, { backgroundColor: theme.accentSoft }]}>
        <Ionicons name={icon} size={20} color={theme.accent} />
      </View>
      <View style={styles.bannerCopy}>
        <Text style={[styles.bannerTitle, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.bannerBody, { color: theme.textMuted }]}>{body}</Text>
      </View>
      {action}
    </View>
  );
}

function DatePill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = themeForScheme(useColorScheme());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.datePill, { backgroundColor: selected ? theme.accent : theme.surface }]}
    >
      <Text style={[styles.dateText, { color: selected ? '#FFFFFF' : theme.text }]}>{label}</Text>
    </Pressable>
  );
}

function PhotoTile({
  photo,
  size,
  transfers,
  connected,
  hasSyncError,
  retrying,
  onPress,
  onRetry,
}: {
  photo: PhotoView;
  size: number;
  transfers: readonly TransferRecord[];
  connected: boolean;
  hasSyncError: boolean;
  retrying: boolean;
  onPress: () => void;
  onRetry: () => void;
}) {
  const theme = themeForScheme(useColorScheme());
  const uri = photoPreviewUri(photo);
  const presentation = previewPresentation(photo, transfers, { connected, hasSyncError });
  const placeholderIcon = presentation.phase === 'failed' || presentation.phase === 'paused'
    ? 'cloud-offline-outline'
    : presentation.phase === 'transferring'
      ? 'sync-outline'
      : presentation.phase === 'verifying'
        ? 'shield-checkmark-outline'
        : 'hourglass-outline';
  return (
    <Animated.View layout={LinearTransition.springify().damping(18)}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Photo by ${photo.contributorName}. ${presentation.label}`}
        accessibilityHint={presentation.canRetry && connected ? 'Open the photo, or use the retry button inside this tile.' : 'Open photo'}
        onPress={onPress}
        style={({ pressed }) => [
          styles.photo,
          { backgroundColor: theme.surfaceMuted, height: size, width: size },
          pressed ? styles.photoPressed : null,
        ]}
      >
        {uri ? (
          <Image
            source={uri}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={photo.media.id}
            transition={160}
          />
        ) : (
          <View style={styles.waitingWrap}>
            {retrying && presentation.canRetry ? (
              <ActivityIndicator color={theme.accent} size="small" />
            ) : (
              <Ionicons name={placeholderIcon} size={22} color={presentation.canRetry ? theme.warning : theme.textMuted} />
            )}
            <Text numberOfLines={2} style={[styles.waiting, { color: theme.textMuted }]}>{presentation.label}</Text>
            {presentation.progress !== null && presentation.phase !== 'queued' ? (
              <View style={[styles.waitingProgressTrack, { backgroundColor: theme.surfaceStrong }]}> 
                <View
                  style={[
                    styles.waitingProgressFill,
                    { backgroundColor: theme.accent, width: `${Math.round(presentation.progress * 100)}%` },
                  ]}
                />
              </View>
            ) : null}
          </View>
        )}
      </Pressable>
      {!uri && presentation.canRetry && connected ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry preview from ${photo.contributorName}`}
          disabled={retrying}
          onPress={onRetry}
          style={[styles.previewRetry, { backgroundColor: theme.surface }]}
        >
          <Ionicons name="refresh" size={13} color={theme.accent} />
          <Text style={[styles.previewRetryText, { color: theme.accent }]}>Retry</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

function FilterSheet({
  visible,
  members,
  selectedMemberId,
  todayOnly,
  onSelectMember,
  onSetToday,
  onClose,
}: {
  visible: boolean;
  members: readonly MemberRecord[];
  selectedMemberId: string | null;
  todayOnly: boolean;
  onSelectMember: (memberId: string | null) => void;
  onSetToday: (value: boolean) => void;
  onClose: () => void;
}) {
  const theme = themeForScheme(useColorScheme());
  const chooseMember = (memberId: string | null) => {
    onSelectMember(memberId);
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: theme.surface }]} onPress={() => undefined}>
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Filter the roll</Text>
          <Text style={[styles.sheetLabel, { color: theme.textMuted }]}>WHO</Text>
          <SheetOption label="Everyone" selected={selectedMemberId === null} onPress={() => chooseMember(null)} />
          {members.map((member) => (
            <SheetOption key={member.id} label={member.displayName} selected={selectedMemberId === member.id} onPress={() => chooseMember(member.id)} />
          ))}
          <Text style={[styles.sheetLabel, { color: theme.textMuted }]}>WHEN</Text>
          <View style={styles.sheetDates}>
            <DatePill label="All days" selected={!todayOnly} onPress={() => onSetToday(false)} />
            <DatePill label="Today" selected={todayOnly} onPress={() => onSetToday(true)} />
          </View>
          <AppButton label="Done" variant="secondary" onPress={onClose} style={styles.sheetDone} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetOption({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = themeForScheme(useColorScheme());
  return (
    <Pressable onPress={onPress} style={[styles.sheetOption, { borderBottomColor: theme.border }]}>
      <Text style={[styles.sheetOptionText, { color: theme.text }]}>{label}</Text>
      {selected ? <Ionicons name="checkmark-circle" size={22} color={theme.accent} /> : null}
    </Pressable>
  );
}

function ActionsSheet({
  visible,
  coordinator,
  onClose,
  onScan,
  onHistory,
  onDiagnostics,
  onEnd,
}: {
  visible: boolean;
  coordinator: boolean;
  onClose: () => void;
  onScan: () => void;
  onHistory: () => void;
  onDiagnostics: () => void;
  onEnd: () => void;
}) {
  const theme = themeForScheme(useColorScheme());
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: theme.surface }]} onPress={() => undefined}>
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Trip options</Text>
          <AppButton label="Scan for new photos" icon="refresh" variant="secondary" onPress={onScan} />
          <AppButton label="Connection diagnostics" icon="pulse-outline" variant="secondary" onPress={onDiagnostics} />
          <AppButton label="Saved rolls" icon="albums-outline" variant="secondary" onPress={onHistory} />
          <AppButton label={coordinator ? 'End trip' : 'Leave trip'} icon="exit-outline" variant="ghost" onPress={onEnd} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function connectionLabel(state: string): string {
  if (state === 'connecting') return 'Connecting…';
  if (state === 'reconnecting') return 'Reconnecting…';
  if (state === 'error') return 'Needs attention';
  return 'Waiting for connection';
}

function connectedGalleryLabel(
  connectedPeerCount: number,
  photoCountLabel: string,
  missingPreviewCount: number,
  interruptedPreviewCount: number,
  pendingOutbox: number,
): string {
  const connection = connectedPeerCount === 0
    ? 'Waiting for another member'
    : connectedPeerCount === 1
      ? '1 other member connected'
      : `${connectedPeerCount} other members connected`;
  if (interruptedPreviewCount > 0) {
    const previews = interruptedPreviewCount === 1 ? '1 preview retrying' : `${interruptedPreviewCount} previews retrying`;
    return `${connection} · ${previews} · ${photoCountLabel}`;
  }
  if (missingPreviewCount > 0) {
    const previews = missingPreviewCount === 1 ? '1 preview arriving' : `${missingPreviewCount} previews arriving`;
    return `${connection} · ${previews} · ${photoCountLabel}`;
  }
  if (pendingOutbox > 0) return `${connection} · Syncing changes · ${photoCountLabel}`;
  return `${connection} · ${photoCountLabel}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  list: { flexGrow: 1 },
  row: { gap: 3, paddingHorizontal: 12 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 14, paddingHorizontal: 16 },
  headerTop: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  headerMain: { flex: 1, gap: 5 },
  tripTitle: { fontFamily: typography.extraBold, fontSize: 28, letterSpacing: -1, lineHeight: 34 },
  headerMeta: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  syncDot: { borderRadius: 5, height: 9, width: 9 },
  syncText: { flexShrink: 1, fontFamily: typography.medium, fontSize: 12 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  filtersScroller: { marginHorizontal: -16, marginTop: 16 },
  headerFilters: { gap: 8, paddingHorizontal: 16 },
  contentHeader: { gap: 13, paddingBottom: 12, paddingHorizontal: 12, paddingTop: 12 },
  banner: { alignItems: 'center', borderRadius: 20, flexDirection: 'row', gap: 11, padding: 13 },
  bannerIcon: { alignItems: 'center', borderRadius: 14, height: 42, justifyContent: 'center', width: 42 },
  bannerCopy: { flex: 1, gap: 2 },
  bannerTitle: { fontFamily: typography.bold, fontSize: 13 },
  bannerBody: { fontFamily: typography.regular, fontSize: 11, lineHeight: 16 },
  notice: { alignItems: 'center', borderRadius: 16, flexDirection: 'row', gap: 9, padding: 12 },
  noticeText: { flex: 1, fontFamily: typography.medium, fontSize: 12, lineHeight: 17 },
  filterButton: { alignItems: 'center', borderRadius: 999, borderWidth: 1, flexDirection: 'row', gap: 7, maxWidth: 145, minHeight: 40, paddingHorizontal: 12 },
  filterText: { flexShrink: 1, fontFamily: typography.semibold, fontSize: 13 },
  datePill: { borderRadius: 999, minHeight: 40, justifyContent: 'center', paddingHorizontal: 15 },
  dateText: { fontFamily: typography.semibold, fontSize: 12 },
  photo: { borderRadius: 6, marginBottom: 3, overflow: 'hidden' },
  photoPressed: { opacity: 0.86, transform: [{ scale: 0.985 }] },
  waitingWrap: { alignItems: 'center', flex: 1, gap: 7, justifyContent: 'center' },
  waiting: { fontFamily: typography.medium, fontSize: 11, paddingHorizontal: 8, textAlign: 'center' },
  waitingProgressTrack: { borderRadius: 3, height: 4, overflow: 'hidden', width: 58 },
  waitingProgressFill: { borderRadius: 3, height: 4 },
  previewRetry: { alignItems: 'center', borderRadius: 999, bottom: 7, flexDirection: 'row', gap: 4, minHeight: 28, paddingHorizontal: 9, position: 'absolute', right: 7 },
  previewRetryText: { fontFamily: typography.bold, fontSize: 10 },
  empty: { alignItems: 'center', paddingHorizontal: 42, paddingVertical: 58 },
  emptyIcon: { alignItems: 'center', borderRadius: 22, height: 58, justifyContent: 'center', marginBottom: 16, width: 58 },
  emptyTitle: { fontFamily: typography.bold, fontSize: 18, letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { fontFamily: typography.regular, fontSize: 13, lineHeight: 20, marginTop: 7, textAlign: 'center' },
  emptyLoadMore: { marginTop: 18 },
  galleryLoader: { paddingVertical: 22 },
  loadMoreWrap: { alignItems: 'center', paddingVertical: 18 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 30, borderTopRightRadius: 30, gap: 10, maxHeight: '86%', paddingBottom: 30, paddingHorizontal: 20, paddingTop: 10 },
  handle: { alignSelf: 'center', borderRadius: 3, height: 5, marginBottom: 10, width: 42 },
  sheetTitle: { fontFamily: typography.extraBold, fontSize: 24, letterSpacing: -0.7, marginBottom: 7 },
  sheetLabel: { fontFamily: typography.bold, fontSize: 10, letterSpacing: 1.2, marginTop: 8 },
  sheetOption: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 },
  sheetOptionText: { fontFamily: typography.semibold, fontSize: 15 },
  sheetDates: { flexDirection: 'row', gap: 8 },
  sheetDone: { marginTop: 8 },
});
