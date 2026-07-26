import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceIdentityService } from '@/application/identity/DeviceIdentityService';
import type {
  MediaIngestionService,
  ScanAndIngestRequest,
  ScanAndIngestResult,
} from '@/application/media/MediaIngestionService';
import type { TripLifecycleService, TripSession } from '@/application/trips/TripLifecycleService';
import type {
  AirMeshDataLayer,
  GalleryPage,
  MediaRecord,
  MemberRecord,
  ResourceRecord,
  TripRecord,
  TripStatus,
} from '@/data';
import type {
  MediaChangeSubscription,
  MediaGateway,
  MediaLibraryChange,
  MediaPermissionState,
} from '@/platform/media';

import {
  AirMeshRuntime,
  type AirMeshRuntimeDependencies,
  type PhotoView,
  type RuntimeSubscription,
  type SyncDriver,
  type SyncSnapshot,
} from './AirMeshRuntime';

const appStateMock = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    emit(state: string) {
      for (const listener of listeners) listener(state);
    },
    reset() {
      listeners.clear();
    },
  };
});

const networkStateMock = vi.hoisted(() => {
  const listeners = new Set<(state: { isConnected?: boolean }) => void>();
  return {
    addNetworkStateListener: vi.fn((listener: (state: { isConnected?: boolean }) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    emit(state: { isConnected?: boolean }) {
      for (const listener of listeners) listener(state);
    },
    reset() {
      listeners.clear();
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: appStateMock.addEventListener,
  },
}));

vi.mock('expo-network', () => ({
  addNetworkStateListener: networkStateMock.addNetworkStateListener,
}));

const TRIP_ID = 'trip:runtime-test';
const MEMBER_ID = 'member:runtime-test';
const DEVICE_ID = 'device:runtime-test';
const GRANTED_PERMISSION: MediaPermissionState = {
  access: 'full',
  canAskAgain: true,
  expires: 'never',
  granted: true,
};
const DENIED_PERMISSION: MediaPermissionState = {
  access: 'denied',
  canAskAgain: false,
  expires: 'never',
  granted: false,
};

afterEach(() => {
  appStateMock.reset();
  networkStateMock.reset();
  vi.clearAllMocks();
});

describe('AirMeshRuntime lifecycle coordination', () => {
  it('persists first-run onboarding completion as a non-secret device setting', async () => {
    const harness = createHarness({
      initialStatus: 'ACTIVE',
      permission: DENIED_PERMISSION,
      onboardingComplete: false,
    });
    await harness.runtime.initialize();

    expect(harness.runtime.getSnapshot().hasCompletedOnboarding).toBe(false);

    await harness.runtime.completeOnboarding();

    expect(harness.runtime.getSnapshot().hasCompletedOnboarding).toBe(true);
    expect(harness.repositories.deviceSettings.set).toHaveBeenCalledWith({
      key: 'app:onboarding:v1',
      value: true,
      updatedAt: expect.any(Number),
    });

    await harness.runtime.dispose();
  });

  it('starts the first library scan when a sync content revision activates a draft trip', async () => {
    const harness = createHarness({ initialStatus: 'DRAFT', permission: GRANTED_PERMISSION });
    await harness.runtime.initialize();

    expect(harness.media.scanAndIngest).not.toHaveBeenCalled();

    harness.setTripStatus('ACTIVE');
    harness.sync.emit({ contentRevision: 1 });

    await vi.waitFor(() => {
      expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(1);
      expect(harness.runtime.getSnapshot().session?.trip.status).toBe('ACTIVE');
    });
    expect(harness.media.scanAndIngest).toHaveBeenCalledWith({
      tripId: TRIP_ID,
      localMemberId: MEMBER_ID,
      localDeviceId: DEVICE_ID,
      batchSize: 1,
      maxPages: 1,
      onPreviewPublished: expect.any(Function),
    });

    await harness.runtime.dispose();
  });

  it('flushes a durable preview before ingestion finishes the original phase', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: GRANTED_PERMISSION });
    const order: string[] = [];
    harness.sync.flush.mockImplementation(async () => {
      order.push('flush');
    });
    harness.media.scanAndIngest.mockImplementationOnce(
      async (scanRequest: ScanAndIngestRequest) => {
        order.push('preview-committed');
        await scanRequest.onPreviewPublished?.({
          mediaId: 'media:preview-first',
          thumbnailResourceId: 'resource:preview-first',
        });
        order.push('original-finished');
        return emptyScanResult();
      },
    );

    await harness.runtime.initialize();
    await vi.waitFor(() => {
      expect(harness.runtime.getSnapshot().lastScan).not.toBeNull();
    });

    expect(order.indexOf('flush')).toBeGreaterThan(order.indexOf('preview-committed'));
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('original-finished'));
    expect(harness.sync.flush).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it('keeps local photo discovery running when TCP startup fails', async () => {
    const harness = createHarness({
      initialStatus: 'ACTIVE',
      permission: GRANTED_PERMISSION,
      syncStartError: new Error('Local TCP server could not start.'),
    });

    await harness.runtime.initialize();

    await vi.waitFor(() => {
      expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(1);
    });
    expect(harness.runtime.getSnapshot()).toMatchObject({
      sync: { state: 'error' },
      lastScan: { tripId: TRIP_ID },
    });

    await harness.runtime.dispose();
  });

  it('waits for and gates an in-flight scan before ending so stale scan work cannot restore the session', async () => {
    const scan = deferred<ScanAndIngestResult>();
    const harness = createHarness({
      initialStatus: 'ACTIVE',
      permission: GRANTED_PERMISSION,
      scanResult: scan.promise,
    });
    await harness.runtime.initialize();
    expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getSnapshot().isScanning).toBe(true);

    const ending = harness.runtime.endOrLeaveTrip();
    await Promise.resolve();

    expect(harness.trips.end).not.toHaveBeenCalled();
    expect(harness.sync.flush).not.toHaveBeenCalled();

    // A queued MediaLibrary notification cannot start another scan once end
    // has raised the scan gate and detached the live listener.
    harness.mediaGateway.emitChange();
    expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(1);

    scan.resolve(emptyScanResult());
    await ending;
    await Promise.resolve();

    expect(harness.trips.end).toHaveBeenCalledTimes(1);
    expect(harness.sync.flush).toHaveBeenCalledTimes(1);
    expect(harness.sync.stop).not.toHaveBeenCalled();
    expect(harness.trips.resumeResponder).toHaveBeenCalledTimes(1);
    expect(harness.repositories.trips.getById).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getSnapshot()).toMatchObject({
      session: null,
      members: [],
      photos: [],
      transfers: [],
      isScanning: false,
      lastScan: null,
    });
  });

  it('does not reload the database for progress snapshots whose content revision is unchanged', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();

    expect(harness.repositories.trips.getById).toHaveBeenCalledTimes(1);

    harness.sync.emit({ contentRevision: 1, pendingOutbox: 4 });
    await vi.waitFor(() => {
      expect(harness.repositories.trips.getById).toHaveBeenCalledTimes(2);
    });

    harness.sync.emit({ contentRevision: 1, pendingOutbox: 3 });
    harness.sync.emit({ contentRevision: 1, pendingOutbox: 2, peerDeviceIds: ['peer-a'] });
    harness.sync.emit({ contentRevision: 1, pendingOutbox: 1, state: 'reconnecting' });
    await vi.waitFor(() => {
      expect(harness.runtime.getSnapshot().sync).toMatchObject({
        contentRevision: 1,
        pendingOutbox: 1,
        state: 'reconnecting',
      });
    });

    expect(harness.repositories.trips.getById).toHaveBeenCalledTimes(2);
    expect(harness.repositories.members.listByTrip).toHaveBeenCalledTimes(2);
    expect(harness.repositories.gallery.listPage).toHaveBeenCalledTimes(2);
    expect(harness.repositories.transfers.listRecent).toHaveBeenCalledTimes(2);

    await harness.runtime.dispose();
  });

  it('reloads transfer presentation without rebuilding the gallery on progress', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();

    expect(harness.repositories.trips.getById).toHaveBeenCalledTimes(1);
    expect(harness.repositories.gallery.listPage).toHaveBeenCalledTimes(1);
    expect(harness.repositories.transfers.listRecent).toHaveBeenCalledTimes(1);

    harness.sync.emit({ transferRevision: 1 });

    await vi.waitFor(() => {
      expect(harness.repositories.transfers.listRecent).toHaveBeenCalledTimes(2);
    });
    expect(harness.repositories.trips.getById).toHaveBeenCalledTimes(1);
    expect(harness.repositories.members.listByTrip).toHaveBeenCalledTimes(1);
    expect(harness.repositories.gallery.listPage).toHaveBeenCalledTimes(1);

    await harness.runtime.dispose();
  });

  it('schedules exactly one follow-up scan when a bounded ingestion pass reports more pages', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: GRANTED_PERMISSION });
    harness.media.scanAndIngest
      .mockResolvedValueOnce({ ...emptyScanResult(), hasMore: true, pagesScanned: 20 })
      .mockResolvedValueOnce({ ...emptyScanResult(), hasMore: false, pagesScanned: 3 });

    await harness.runtime.initialize();

    await vi.waitFor(() => {
      expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(2);
      expect(harness.runtime.getSnapshot()).toMatchObject({
        isScanning: false,
        lastScan: { hasMore: false, pagesScanned: 3 },
      });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(2);
    expect(harness.sync.flush).toHaveBeenCalledTimes(2);

    await harness.runtime.dispose();
  });

  it('forwards incremental inserted asset IDs to the next priority ingestion pass', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: GRANTED_PERMISSION });
    await harness.runtime.initialize();
    await vi.waitFor(() => {
      expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(1);
      expect(harness.runtime.getSnapshot().isScanning).toBe(false);
    });

    harness.mediaGateway.emitChange({
      kind: 'incremental',
      insertedAssetIds: ['asset:new-capture'],
      deletedAssetIds: [],
      updatedAssetIds: [],
    });

    await vi.waitFor(() => {
      expect(harness.media.scanAndIngest).toHaveBeenCalledTimes(2);
    });
    expect(harness.media.scanAndIngest).toHaveBeenLastCalledWith({
      tripId: TRIP_ID,
      localMemberId: MEMBER_ID,
      localDeviceId: DEVICE_ID,
      insertedAssetIds: ['asset:new-capture'],
      batchSize: 1,
      maxPages: 1,
      onPreviewPublished: expect.any(Function),
    });

    await harness.runtime.dispose();
  });

  it('loads joined gallery pages on demand and preserves the loaded depth on refresh', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    const first = galleryPage('media:newer', 2_000, {
      capturedAtMs: 2_000,
      mediaId: 'media:newer',
    });
    const second = galleryPage('media:older', 1_000, null);
    harness.repositories.gallery.listPage.mockImplementation(
      async (
        _tripId: string,
        options?: { cursor?: { capturedAtMs: number; mediaId: string } | null },
      ) =>
        options?.cursor?.mediaId === 'media:newer' ? second : first,
    );

    await harness.runtime.initialize();
    expect(harness.runtime.getSnapshot().photos.map((photo) => photo.media.id)).toEqual([
      'media:newer',
    ]);
    expect(harness.runtime.getSnapshot().hasMorePhotos).toBe(true);

    await harness.runtime.loadMorePhotos();
    expect(harness.runtime.getSnapshot().photos.map((photo) => photo.media.id)).toEqual([
      'media:newer',
      'media:older',
    ]);
    expect(harness.runtime.getSnapshot().hasMorePhotos).toBe(false);

    await harness.runtime.refresh();
    expect(harness.runtime.getSnapshot().photos.map((photo) => photo.media.id)).toEqual([
      'media:newer',
      'media:older',
    ]);
    expect(harness.repositories.gallery.listPage).toHaveBeenLastCalledWith(TRIP_ID, {
      limit: 120,
      cursor: first.nextCursor,
    });

    await harness.runtime.dispose();
  });

  it('coalesces coordinator invite refreshes and publishes the latest endpoint', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();

    await Promise.all([
      harness.runtime.refreshCoordinatorInvite(),
      harness.runtime.refreshCoordinatorInvite(),
    ]);

    expect(harness.trips.refreshCoordinatorInvite).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getSnapshot().session?.endpoint).toBe('tcp://192.168.4.1:38457');

    await harness.runtime.dispose();
  });

  it('surfaces an invite refresh failure and clears it after a successful retry', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();
    harness.trips.refreshCoordinatorInvite.mockRejectedValueOnce(new Error('No LAN address'));

    await harness.runtime.refreshCoordinatorInvite();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      isRefreshingInvite: false,
      inviteRefreshError: 'No LAN address',
      notice: 'Invite could not refresh: No LAN address',
    });

    await harness.runtime.refreshCoordinatorInvite();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      isRefreshingInvite: false,
      inviteRefreshError: null,
      notice: null,
      session: { endpoint: 'tcp://192.168.4.1:38457' },
    });

    await harness.runtime.dispose();
  });

  it('keeps a failed invite blocked when an unrelated photo scan clears the general notice', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: GRANTED_PERMISSION });
    await harness.runtime.initialize();
    harness.trips.refreshCoordinatorInvite.mockRejectedValueOnce(new Error('No LAN address'));

    await harness.runtime.refreshCoordinatorInvite();
    await harness.runtime.scanNow();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      inviteRefreshError: 'No LAN address',
      notice: null,
    });

    await harness.runtime.dispose();
  });

  it('does not publish an in-flight refreshed QR after the coordinator disconnects', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();
    const pending = deferred<TripSession>();
    const originalSession = harness.runtime.getSnapshot().session!;
    harness.trips.refreshCoordinatorInvite.mockImplementationOnce(() => pending.promise);

    const refreshing = harness.runtime.refreshCoordinatorInvite();
    networkStateMock.emit({ isConnected: false });
    pending.resolve({
      ...originalSession,
      endpoint: 'tcp://10.0.0.99:38457',
      inviteLink: 'airmesh://join?stale-after-disconnect=1',
    });
    await refreshing;

    expect(harness.runtime.getSnapshot()).toMatchObject({
      isRefreshingInvite: false,
      inviteRefreshError: 'Connect this phone to a network, then try again.',
      session: { endpoint: 'tcp://192.168.1.2:38457' },
    });

    await harness.runtime.dispose();
  });

  it('refreshes the coordinator QR when Expo reports a connected network change', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();

    networkStateMock.emit({ isConnected: true });

    await vi.waitFor(() => {
      expect(harness.trips.refreshCoordinatorInvite).toHaveBeenCalledTimes(1);
      expect(harness.runtime.getSnapshot().session?.endpoint).toBe('tcp://192.168.4.1:38457');
    });

    await harness.runtime.dispose();
  });

  it('performs a trailing refresh when the network changes again during address discovery', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();
    const firstRefresh = deferred<TripSession>();
    harness.trips.refreshCoordinatorInvite.mockImplementationOnce(() => firstRefresh.promise);

    networkStateMock.emit({ isConnected: true });
    networkStateMock.emit({ isConnected: true });
    expect(harness.trips.refreshCoordinatorInvite).toHaveBeenCalledTimes(1);

    firstRefresh.resolve(harness.runtime.getSnapshot().session!);

    await vi.waitFor(() => {
      expect(harness.trips.refreshCoordinatorInvite).toHaveBeenCalledTimes(2);
      expect(harness.runtime.getSnapshot().isRefreshingInvite).toBe(false);
    });

    await harness.runtime.dispose();
  });

  it('hides sharing behind a visible warning when the coordinator loses its network', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();

    networkStateMock.emit({ isConnected: false });

    expect(harness.trips.refreshCoordinatorInvite).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot().inviteRefreshError).toMatch(/connect this phone to a network/i);
    expect(harness.runtime.getSnapshot().notice).toMatch(/^Invite could not refresh:/);

    await harness.runtime.dispose();
  });

  it('exposes an inactive trip as a paginated saved roll without starting sync', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();

    harness.setTripStatus('ENDED', false);
    harness.repositories.gallery.listPage.mockResolvedValueOnce(
      galleryPage('media:saved', 1_500, null),
    );
    const saved = await harness.runtime.listSavedTrips();
    const page = await harness.runtime.loadSavedTripPage(TRIP_ID);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: TRIP_ID, status: 'ENDED', isActive: false });
    expect(page.photos).toHaveLength(1);
    expect(page.photos[0]).toMatchObject({
      contributorName: 'Ankit',
      media: { id: 'media:saved' },
    });
    expect(harness.sync.start).toHaveBeenCalledTimes(1);

    await harness.runtime.dispose();
  });

  it('does not reshare an archived original into the currently active trip after saving it', async () => {
    const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
    await harness.runtime.initialize();
    const savedAsset = deferred<string>();
    harness.mediaGateway.saveImageToLibrary.mockImplementationOnce(() => savedAsset.promise);
    const archivedTripId = 'trip:archived';
    const media = {
      ...galleryPage('media:archived', 1_500, null).items[0]!.media,
      tripId: archivedTripId,
    };
    const original: ResourceRecord = {
      schemaVersion: 1,
      id: 'resource:archived:original',
      tripId: archivedTripId,
      mediaId: media.id,
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 1_024,
      sha256: 'a'.repeat(64),
      width: 1200,
      height: 800,
      createdAtMs: 1_500,
      availability: 'available',
      localUri: 'file:///archived-original.jpg',
      verifiedAtMs: 1_500,
      updatedAtMs: 1_500,
    };
    const photo = {
      media,
      contributorName: 'Atri',
      thumbnail: null,
      original,
    } satisfies PhotoView;

    const saving = harness.runtime.saveOriginalToLibrary(photo);
    await vi.waitFor(() => {
      expect(harness.mediaGateway.saveImageToLibrary).toHaveBeenCalledTimes(1);
    });
    const nextTripId = 'trip:next-active';
    await harness.runtime.endOrLeaveTrip();
    const nextSession = await harness.runtime.createTrip({
      name: 'Next active trip',
      displayName: 'Ankit',
    });
    expect(nextSession.trip.id).toBe(nextTripId);
    savedAsset.resolve('saved-asset');
    await saving;

    expect(harness.media.excludeSourceAsset).toHaveBeenCalledTimes(3);
    expect(harness.media.excludeSourceAsset).toHaveBeenCalledWith({
      tripId: archivedTripId,
      localDeviceId: DEVICE_ID,
      assetId: 'saved-asset',
    });
    expect(harness.media.excludeSourceAsset).toHaveBeenCalledWith({
      tripId: TRIP_ID,
      localDeviceId: DEVICE_ID,
      assetId: 'saved-asset',
    });
    expect(harness.media.excludeSourceAsset).toHaveBeenCalledWith({
      tripId: nextTripId,
      localDeviceId: DEVICE_ID,
      assetId: 'saved-asset',
    });

    await harness.runtime.dispose();
  });

  it('drains a persisted responder immediately when an already-running app returns to foreground', async () => {
    const harness = createHarness({ initialStatus: 'ENDED', permission: DENIED_PERMISSION });
    harness.trips.resumeActive.mockResolvedValue(null);

    await harness.runtime.initialize();

    expect(harness.runtime.getSnapshot().session).toBeNull();
    expect(harness.trips.resumeResponder).toHaveBeenCalledTimes(1);
    expect(harness.sync.start).toHaveBeenCalledTimes(1);

    harness.sync.emit({ state: 'connected', pendingOutbox: 3 });
    appStateMock.emit('active');

    await vi.waitFor(() => {
      expect(harness.sync.flush).toHaveBeenCalledTimes(1);
    });
    expect(harness.sync.start).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getSnapshot().session).toBeNull();

    await harness.runtime.dispose();
  });

  it.each<TripStatus>(['ENDED', 'ARCHIVED'])(
    'archives a %s trip and restarts only its saved-roll responder',
    async (terminalStatus) => {
      const harness = createHarness({ initialStatus: 'ACTIVE', permission: DENIED_PERMISSION });
      await harness.runtime.initialize();
      expect(harness.sync.start).toHaveBeenCalledTimes(1);

      harness.sync.emit({ state: 'stopped' });
      harness.setTripStatus(terminalStatus);
      appStateMock.emit('active');

      await vi.waitFor(() => {
        expect(harness.runtime.getSnapshot().session).toBeNull();
      });

      expect(harness.sync.start).toHaveBeenCalledTimes(2);
      expect(harness.trips.end).not.toHaveBeenCalled();
      expect(harness.trips.archiveEndedForResponder).toHaveBeenCalledTimes(1);

      await harness.runtime.dispose();
    },
  );
});

function createHarness(options: {
  initialStatus: TripStatus;
  permission: MediaPermissionState;
  scanResult?: Promise<ScanAndIngestResult>;
  onboardingComplete?: boolean;
  syncStartError?: Error;
}) {
  let currentTrip = trip(options.initialStatus);
  let mediaListener: ((change: MediaLibraryChange) => void) | null = null;

  const member = localMember();
  const currentMember = (): MemberRecord => ({ ...member, tripId: currentTrip.id });
  const currentSession = (): TripSession => ({
    trip: { ...currentTrip },
    localMember: currentMember(),
    inviteLink: null,
    admissionInviteLink: null,
    endpoint: 'tcp://192.168.1.2:38457',
    isCoordinator: true,
    coordinatorDeviceId: DEVICE_ID,
    coordinatorIdentityPublicKey: currentMember().identityPublicKey,
  });
  const repositories = {
    trips: {
      getById: vi.fn(async () => ({ ...currentTrip })),
      list: vi.fn(async () => [{ ...currentTrip }]),
    },
    members: {
      listByTrip: vi.fn(async () => [currentMember()]),
    },
    gallery: {
      listPage: vi.fn(async (
        _tripId: string,
        _options?: { cursor?: { capturedAtMs: number; mediaId: string } | null },
      ): Promise<GalleryPage> => ({ items: [], nextCursor: null })),
    },
    transfers: {
      listRecent: vi.fn(async () => []),
    },
    deviceSettings: {
      get: vi.fn(async () => options.onboardingComplete === false
        ? null
        : { key: 'app:onboarding:v1', value: true, updatedAt: 1_000 }),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => false),
    },
  };
  const data = {
    repositories,
  } as unknown as AirMeshDataLayer;
  const identity = {
    load: vi.fn(async () => ({
      deviceId: DEVICE_ID,
      identityPublicKey: 'a'.repeat(64),
      displayName: 'Ankit',
    })),
  } as unknown as DeviceIdentityService;
  const trips = {
    resumeActive: vi.fn(async () => currentSession()),
    resumeResponder: vi.fn(async () => currentSession()),
    archiveEndedForResponder: vi.fn(async () => {
      currentTrip = { ...currentTrip, isActive: false };
      return currentSession();
    }),
    create: vi.fn(async () => {
      currentTrip = {
        ...trip('ACTIVE'),
        id: 'trip:next-active',
        name: 'Next active trip',
      };
      return currentSession();
    }),
    refreshCoordinatorInvite: vi.fn(async (session: TripSession) => ({
      ...session,
      endpoint: 'tcp://192.168.4.1:38457',
      inviteLink: 'airmesh://join?refreshed=1',
    })),
    end: vi.fn(async () => {
      currentTrip = { ...currentTrip, status: 'ENDED', isActive: false };
    }),
  } as unknown as TripLifecycleService & {
    resumeActive: ReturnType<typeof vi.fn>;
    resumeResponder: ReturnType<typeof vi.fn>;
    archiveEndedForResponder: ReturnType<typeof vi.fn>;
    refreshCoordinatorInvite: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  const media = {
    scanAndIngest: vi.fn(async () => options.scanResult ?? emptyScanResult()),
    excludeSourceAsset: vi.fn(async () => undefined),
  } as unknown as MediaIngestionService & {
    scanAndIngest: ReturnType<typeof vi.fn>;
    excludeSourceAsset: ReturnType<typeof vi.fn>;
  };
  const mediaGateway = {
    getPermissionState: vi.fn(async () => options.permission),
    requestPermission: vi.fn(async () => options.permission),
    presentLimitedLibraryPicker: vi.fn(async () => undefined),
    saveImageToLibrary: vi.fn(async () => 'saved-asset'),
    subscribe: vi.fn((listener: (change: MediaLibraryChange) => void): MediaChangeSubscription => {
      mediaListener = listener;
      return {
        remove: () => {
          if (mediaListener === listener) mediaListener = null;
        },
      };
    }),
    emitChange: (change: MediaLibraryChange = { kind: 'rescan-required' }) => {
      mediaListener?.(change);
    },
  } as unknown as MediaGateway & {
    emitChange(change?: MediaLibraryChange): void;
    saveImageToLibrary: ReturnType<typeof vi.fn>;
  };
  const sync = new FakeSyncDriver();
  if (options.syncStartError) {
    sync.start.mockImplementationOnce(async () => {
      sync.snapshot = {
        ...sync.snapshot,
        state: 'error',
        lastError: options.syncStartError!.message,
      };
      throw options.syncStartError;
    });
  }
  const dependencies: AirMeshRuntimeDependencies = {
    data,
    identity,
    trips,
    media,
    mediaGateway,
    sync,
  };
  const runtime = new AirMeshRuntime(dependencies);

  return {
    runtime,
    sync,
    trips,
    media,
    mediaGateway,
    repositories,
    setTripStatus(status: TripStatus, isActive = currentTrip.isActive) {
      currentTrip = { ...currentTrip, status, isActive };
    },
  };
}

class FakeSyncDriver implements SyncDriver {
  snapshot: SyncSnapshot = {
    state: 'idle',
    peerDeviceIds: [],
    pendingOutbox: 0,
    contentRevision: 0,
    transferRevision: 0,
    lastError: null,
    diagnostics: {
      role: null,
      advertisedEndpoint: null,
      transportState: 'idle',
      transportPeerDeviceIds: [],
      reconnectAttempt: 0,
      pendingOutbox: 0,
      pendingTransfers: 0,
      lastError: null,
    },
  };
  private readonly listeners = new Set<(snapshot: SyncSnapshot) => void>();

  readonly start = vi.fn(async () => {
    this.snapshot = { ...this.snapshot, state: 'connected' };
  });
  readonly stop = vi.fn(async () => {
    this.snapshot = { ...this.snapshot, state: 'stopped' };
  });
  readonly flush = vi.fn(async () => undefined);
  readonly requestResource = vi.fn(async () => undefined);

  subscribe(listener: (snapshot: SyncSnapshot) => void): RuntimeSubscription {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  emit(patch: Partial<SyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function trip(status: TripStatus): TripRecord {
  return {
    schemaVersion: 1,
    id: TRIP_ID,
    name: 'Runtime test trip',
    createdByMemberId: MEMBER_ID,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    startsAtMs: 1_000,
    endsAtMs: null,
    timeZone: 'UTC',
    status,
    defaultSharingMode: 'AUTO_SHARE',
    locationSharingMode: 'NONE',
    targetReplicaCount: 2,
    completeKeeperCount: 1,
    membershipEpoch: 1,
    isActive: true,
  };
}

function localMember(): MemberRecord {
  return {
    schemaVersion: 1,
    id: MEMBER_ID,
    tripId: TRIP_ID,
    deviceId: DEVICE_ID,
    displayName: 'Ankit',
    identityPublicKey: 'a'.repeat(64),
    role: 'ADMIN',
    status: 'ACTIVE',
    replicaRole: 'KEEPER_PRIMARY',
    joinedAtMs: 1_000,
    updatedAtMs: 1_000,
    leftAtMs: null,
    membershipEpoch: 1,
  };
}

function emptyScanResult(): ScanAndIngestResult {
  return {
    tripId: TRIP_ID,
    sharingMode: 'AUTO_SHARE',
    initialCursor: null,
    persistedCursor: null,
    pagesScanned: 0,
    excludedScreenshotCount: 0,
    outcomes: [],
    failures: [],
    warnings: [],
    hasMore: false,
    stoppedAtFailure: false,
    deferredAssetCount: 0,
    nextDeferredRetryAtMs: null,
  };
}

function galleryPage(
  id: string,
  capturedAtMs: number,
  nextCursor: GalleryPage['nextCursor'],
): GalleryPage {
  const media: MediaRecord = {
    schemaVersion: 1,
    id,
    tripId: TRIP_ID,
    originMemberId: MEMBER_ID,
    originDeviceId: DEVICE_ID,
    originSequence: capturedAtMs,
    sourceAssetId: null,
    source: 'SYSTEM_LIBRARY',
    mediaType: 'IMAGE',
    shareStatus: 'PUBLISHED',
    capturedAtMs,
    captureTimeZoneOffsetMinutes: 0,
    captureLocalDate: '2026-07-23',
    ingestedAtMs: capturedAtMs,
    publishedAtMs: capturedAtMs,
    tombstonedAtMs: null,
    location: null,
    originalResourceId: `resource:${id}:original`,
    thumbnailResourceId: null,
  };
  return {
    items: [{ media, original: null, thumbnail: null }],
    nextCursor,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
