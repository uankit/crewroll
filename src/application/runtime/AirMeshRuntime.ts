import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import * as Network from 'expo-network';

import type { TransferBenchmarkRecorder } from '@/application/diagnostics/TransferBenchmarkRecorder';
import { DeviceIdentityService, type DeviceIdentity } from '@/application/identity/DeviceIdentityService';
import {
  MediaIngestionService,
  mediaScanCursorSettingKey,
  type ScanAndIngestResult,
} from '@/application/media/MediaIngestionService';
import type { TripSession, TripLifecycleService } from '@/application/trips/TripLifecycleService';
import type {
  AirMeshDataLayer,
  GalleryCursor,
  GalleryItemRecord,
  MediaRecord,
  MemberRecord,
  ResourceRecord,
  TransferRecord,
  TripRecord,
} from '@/data';
import type {
  MediaChangeSubscription,
  MediaGateway,
  MediaPermissionState,
} from '@/platform/media';

export type RuntimePhase = 'booting' | 'ready' | 'failed';

export interface PhotoView {
  media: MediaRecord;
  contributorName: string;
  thumbnail: ResourceRecord | null;
  original: ResourceRecord | null;
}

export interface SavedTripPage {
  trip: TripRecord;
  members: MemberRecord[];
  photos: PhotoView[];
  nextCursor: GalleryCursor | null;
}

export interface SyncSnapshot {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'error';
  peerDeviceIds: string[];
  pendingOutbox: number;
  /** Changes only when catalog/resource data needs a new read model. */
  contentRevision: number;
  /** Changes when transfer progress or state needs a fresh presentation read. */
  transferRevision: number;
  lastError: string | null;
  diagnostics: LanDiagnosticsSnapshot;
}

export interface LanDiagnosticsSnapshot {
  role: 'coordinator' | 'member' | null;
  advertisedEndpoint: string | null;
  transportState: 'idle' | 'connecting' | 'handshaking' | 'connected' | 'reconnecting' | 'stopped';
  transportPeerDeviceIds: string[];
  reconnectAttempt: number;
  pendingOutbox: number;
  pendingTransfers: number;
  lastError: {
    source: 'socket' | 'protocol' | 'relay' | 'state' | 'sync';
    code: string;
    message: string;
    atMs: number;
  } | null;
}

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  hasCompletedOnboarding: boolean;
  identity: DeviceIdentity | null;
  session: TripSession | null;
  permission: MediaPermissionState | null;
  members: MemberRecord[];
  photos: PhotoView[];
  hasMorePhotos: boolean;
  isLoadingMorePhotos: boolean;
  transfers: TransferRecord[];
  sync: SyncSnapshot;
  isScanning: boolean;
  isRefreshingInvite: boolean;
  inviteRefreshError: string | null;
  lastScan: ScanAndIngestResult | null;
  notice: string | null;
  fatalError: string | null;
}

export interface RuntimeSubscription {
  remove(): void;
}

export interface SyncDriver {
  readonly snapshot: SyncSnapshot;
  start(session: TripSession): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  requestResource(resource: ResourceRecord): Promise<void>;
  subscribe(listener: (snapshot: SyncSnapshot) => void): RuntimeSubscription;
}

export interface AirMeshRuntimeDependencies {
  data: AirMeshDataLayer;
  identity: DeviceIdentityService;
  trips: TripLifecycleService;
  media: MediaIngestionService;
  mediaGateway: MediaGateway;
  sync: SyncDriver;
  transferBenchmarks?: TransferBenchmarkRecorder;
}

const INITIAL_SYNC: SyncSnapshot = {
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

const GALLERY_PAGE_SIZE = 120;
// Persist and flush one newly discovered image at a time. A large foreground
// catch-up therefore cannot hold the newest preview behind an entire page of
// exact-original copies and hashes.
const LIVE_SCAN_BATCH_SIZE = 1;
const LIVE_SCAN_MAX_PAGES = 1;
const LIVE_INSERTED_ASSET_BATCH_SIZE = 50;
const MAX_PENDING_INSERTED_ASSET_IDS = 500;
const MIN_DEFERRED_RETRY_TIMER_MS = 1_000;
const MAX_DEFERRED_RETRY_TIMER_MS = 5 * 60_000;

export const ONBOARDING_COMPLETE_SETTING_KEY = 'app:onboarding:v1';

export class AirMeshRuntime {
  private current: RuntimeSnapshot = {
    phase: 'booting',
    hasCompletedOnboarding: false,
    identity: null,
    session: null,
    permission: null,
    members: [],
    photos: [],
    hasMorePhotos: false,
    isLoadingMorePhotos: false,
    transfers: [],
    sync: INITIAL_SYNC,
    isScanning: false,
    isRefreshingInvite: false,
    inviteRefreshError: null,
    lastScan: null,
    notice: null,
    fatalError: null,
  };
  private readonly listeners = new Set<() => void>();
  private mediaSubscription: MediaChangeSubscription | null = null;
  private appStateSubscription: NativeEventSubscription | null = null;
  private networkSubscription: RuntimeSubscription | null = null;
  private syncSubscription: RuntimeSubscription | null = null;
  private scanPromise: Promise<ScanAndIngestResult | null> | null = null;
  private scanAgainRequested = false;
  private readonly pendingInsertedAssetIds = new Set<string>();
  private deferredRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private scansPaused = false;
  private sessionGeneration = 0;
  private syncRefreshPromise: Promise<void> | null = null;
  private syncRefreshAgainRequested = false;
  private transferRefreshPromise: Promise<void> | null = null;
  private transferRefreshAgainRequested = false;
  private sessionTransitionInProgress = false;
  private mediaLibraryMutationDepth = 0;
  private readonly mediaLibraryMutationTripIds = new Set<string>();
  private rescanAfterLibraryMutation = false;
  private galleryTripId: string | null = null;
  private galleryCursor: GalleryCursor | null = null;
  private galleryPagesLoaded = 1;
  private galleryLoadPromise: Promise<void> | null = null;
  private inviteRefreshPromise: Promise<TripSession | null> | null = null;
  private inviteRefreshAgainRequested = false;
  private inviteRefreshGeneration = 0;
  private latestNetworkConnected: boolean | null = null;
  private responderSession: TripSession | null = null;

  constructor(private readonly dependencies: AirMeshRuntimeDependencies) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RuntimeSnapshot => this.current;

  async initialize(): Promise<void> {
    try {
      const [identity, permission, session, onboardingSetting] = await Promise.all([
        this.dependencies.identity.load(),
        this.dependencies.mediaGateway.getPermissionState(),
        this.dependencies.trips.resumeActive(),
        this.dependencies.data.repositories.deviceSettings.get<boolean>(
          ONBOARDING_COMPLETE_SETTING_KEY,
        ),
      ]);
      const responder = session
        ? null
        : (await this.dependencies.trips.resumeResponder?.()) ?? null;
      if (session && session.localMember.deviceId !== identity.deviceId) {
        throw new Error('The active trip belongs to a different local device identity.');
      }
      if (responder && responder.localMember.deviceId !== identity.deviceId) {
        throw new Error('The saved-roll responder belongs to a different local device identity.');
      }
      if (session) this.sessionGeneration += 1;
      this.patch({
        phase: 'ready',
        hasCompletedOnboarding: onboardingSetting?.value === true,
        identity,
        permission,
        session,
        fatalError: null,
      });
      this.attachLifecycleListeners();
      if (session) {
        await this.activateSession(session);
      } else if (responder) {
        await this.activateResponder(responder);
      }
    } catch (error) {
      this.patch({ phase: 'failed', fatalError: errorMessage(error) });
    }
  }

  async createTrip(input: {
    name: string;
    displayName: string;
    defaultSharingMode?: 'AUTO_SHARE' | 'REVIEW_FIRST';
  }): Promise<TripSession> {
    return this.withSessionTransition(async () => {
      const session = await this.dependencies.trips.create(input);
      this.responderSession = null;
      this.sessionGeneration += 1;
      this.scanAgainRequested = false;
      this.pendingInsertedAssetIds.clear();
      this.clearDeferredRetryTimer();
      this.resetGalleryState();
      this.patch({
        session,
        photos: [],
        hasMorePhotos: false,
        isLoadingMorePhotos: false,
        inviteRefreshError: null,
        isRefreshingInvite: false,
        notice: null,
      });
      await this.activateSession(session);
      await this.rememberOnboardingAfterTripAction();
      return session;
    });
  }

  async joinTrip(input: { inviteLink: string; displayName: string }): Promise<TripSession> {
    return this.withSessionTransition(async () => {
      const session = await this.dependencies.trips.join(input);
      this.responderSession = null;
      this.sessionGeneration += 1;
      this.scanAgainRequested = false;
      this.pendingInsertedAssetIds.clear();
      this.clearDeferredRetryTimer();
      this.resetGalleryState();
      this.patch({
        session,
        photos: [],
        hasMorePhotos: false,
        isLoadingMorePhotos: false,
        inviteRefreshError: null,
        isRefreshingInvite: false,
        notice: 'Joining the encrypted trip…',
      });
      await this.activateSession(session);
      await this.rememberOnboardingAfterTripAction();
      return session;
    });
  }

  async completeOnboarding(): Promise<void> {
    if (this.current.hasCompletedOnboarding) return;
    await this.dependencies.data.repositories.deviceSettings.set({
      key: ONBOARDING_COMPLETE_SETTING_KEY,
      value: true,
      updatedAt: Date.now(),
    });
    this.patch({ hasCompletedOnboarding: true });
  }

  async enablePhotoAccess(): Promise<MediaPermissionState> {
    const permission = await this.dependencies.mediaGateway.requestPermission();
    this.patch({ permission });
    this.attachMediaListener();
    if (permission.granted) await this.scanNow();
    return permission;
  }

  async chooseMorePhotos(): Promise<void> {
    const session = this.current.session;
    if (!session) return;
    this.mediaLibraryMutationDepth += 1;
    try {
      await this.dependencies.mediaGateway.presentLimitedLibraryPicker();
      await this.scanPromise;
      await this.dependencies.data.repositories.deviceSettings.remove(
        mediaScanCursorSettingKey(session.trip.id, session.localMember.deviceId),
      );
      const permission = await this.dependencies.mediaGateway.getPermissionState();
      this.patch({ permission });
      this.rescanAfterLibraryMutation = true;
    } finally {
      this.mediaLibraryMutationDepth -= 1;
      if (this.mediaLibraryMutationDepth === 0 && this.rescanAfterLibraryMutation) {
        this.rescanAfterLibraryMutation = false;
        this.mediaLibraryMutationTripIds.clear();
        await this.scanNow();
      } else if (this.mediaLibraryMutationDepth === 0) {
        this.mediaLibraryMutationTripIds.clear();
      }
    }
  }

  scanNow(insertedAssetIds: readonly string[] = []): Promise<ScanAndIngestResult | null> {
    if (this.scansPaused) return Promise.resolve(null);
    if (this.mediaLibraryMutationDepth > 0) {
      if (this.current.session) {
        this.mediaLibraryMutationTripIds.add(this.current.session.trip.id);
      }
      this.rescanAfterLibraryMutation = true;
      return Promise.resolve(null);
    }
    this.enqueueInsertedAssetIds(insertedAssetIds);
    if (this.scanPromise) {
      this.scanAgainRequested = true;
      return this.scanPromise;
    }
    this.clearDeferredRetryTimer();
    const prioritizedAssetIds = this.takeInsertedAssetIds();
    if (this.pendingInsertedAssetIds.size > 0) this.scanAgainRequested = true;
    const generation = this.sessionGeneration;
    const tracked = this.runScan(generation, prioritizedAssetIds).finally(() => {
      if (this.scanPromise !== tracked) return;
      this.scanPromise = null;
      const shouldScanAgain = this.scanAgainRequested;
      this.scanAgainRequested = false;
      if (shouldScanAgain && !this.scansPaused && generation === this.sessionGeneration) {
        void Promise.resolve().then(() => this.scanNow());
      }
    });
    this.scanPromise = tracked;
    return tracked;
  }

  private enqueueInsertedAssetIds(assetIds: readonly string[]): void {
    for (const assetId of assetIds) {
      if (!assetId.trim() || this.pendingInsertedAssetIds.has(assetId)) continue;
      if (this.pendingInsertedAssetIds.size >= MAX_PENDING_INSERTED_ASSET_IDS) break;
      this.pendingInsertedAssetIds.add(assetId);
    }
  }

  private takeInsertedAssetIds(): string[] {
    const prioritized: string[] = [];
    for (const assetId of this.pendingInsertedAssetIds) {
      prioritized.push(assetId);
      this.pendingInsertedAssetIds.delete(assetId);
      if (prioritized.length >= LIVE_INSERTED_ASSET_BATCH_SIZE) break;
    }
    return prioritized;
  }

  private clearDeferredRetryTimer(): void {
    if (this.deferredRetryTimer === null) return;
    clearTimeout(this.deferredRetryTimer);
    this.deferredRetryTimer = null;
  }

  private scheduleDeferredRetry(
    retryAtMs: number | null,
    generation: number,
    tripId: string,
  ): void {
    this.clearDeferredRetryTimer();
    if (retryAtMs === null) return;
    const delayMs = Math.max(
      MIN_DEFERRED_RETRY_TIMER_MS,
      Math.min(MAX_DEFERRED_RETRY_TIMER_MS, retryAtMs - Date.now()),
    );
    this.deferredRetryTimer = setTimeout(() => {
      this.deferredRetryTimer = null;
      if (
        generation !== this.sessionGeneration ||
        this.scansPaused ||
        this.current.session?.trip.id !== tripId
      ) return;
      void this.scanNow();
    }, delayMs);
  }

  async refresh(): Promise<void> {
    const generation = this.sessionGeneration;
    const session = await this.dependencies.trips.resumeActive();
    if (generation !== this.sessionGeneration) return;
    if (!session) {
      this.pendingInsertedAssetIds.clear();
      this.clearDeferredRetryTimer();
      this.resetGalleryState();
      this.patch({
        session: null,
        members: [],
        photos: [],
        hasMorePhotos: false,
        isLoadingMorePhotos: false,
        transfers: [],
        inviteRefreshError: null,
        isRefreshingInvite: false,
      });
      return;
    }
    await this.loadSessionContent(session, generation);
  }

  refreshCoordinatorInvite(): Promise<TripSession | null> {
    if (this.inviteRefreshPromise) return this.inviteRefreshPromise;
    const session = this.current.session;
    if (!session?.isCoordinator) return Promise.resolve(session);
    if (this.latestNetworkConnected === false) {
      const message = 'Connect this phone to a network, then try again.';
      this.patch({
        inviteRefreshError: message,
        isRefreshingInvite: false,
        notice: `Invite could not refresh: ${message}`,
      });
      return Promise.resolve(session);
    }

    const refreshGeneration = ++this.inviteRefreshGeneration;
    this.patch({ isRefreshingInvite: true });
    const tracked = this.dependencies.trips.refreshCoordinatorInvite(session)
      .then((updated) => {
        if (
          refreshGeneration === this.inviteRefreshGeneration &&
          this.current.session?.trip.id === session.trip.id
        ) {
          this.patch({
            session: updated,
            inviteRefreshError: null,
            notice: this.current.notice?.startsWith('Invite could not refresh:')
              ? null
              : this.current.notice,
          });
          return updated;
        }
        return session;
      })
      .catch((error) => {
        if (
          refreshGeneration === this.inviteRefreshGeneration &&
          this.current.session?.trip.id === session.trip.id
        ) {
          const message = errorMessage(error);
          this.patch({
            inviteRefreshError: message,
            notice: `Invite could not refresh: ${message}`,
          });
        }
        return session;
      })
      .finally(() => {
        if (this.inviteRefreshPromise !== tracked) return;
        this.inviteRefreshPromise = null;
        if (
          this.inviteRefreshAgainRequested &&
          this.latestNetworkConnected !== false &&
          this.current.session?.trip.id === session.trip.id &&
          this.current.session.isCoordinator
        ) {
          this.inviteRefreshAgainRequested = false;
          void this.refreshCoordinatorInvite();
          return;
        }
        this.inviteRefreshAgainRequested = false;
        this.patch({ isRefreshingInvite: false });
      });
    this.inviteRefreshPromise = tracked;
    return tracked;
  }

  loadMorePhotos(): Promise<void> {
    if (this.galleryLoadPromise) return this.galleryLoadPromise;
    const session = this.current.session;
    const cursor = this.galleryCursor;
    if (!session || !this.current.hasMorePhotos || !cursor) return Promise.resolve();

    const generation = this.sessionGeneration;
    const tripId = session.trip.id;
    this.patch({ isLoadingMorePhotos: true });
    const tracked = this.dependencies.data.repositories.gallery.listPage(tripId, {
      limit: GALLERY_PAGE_SIZE,
      cursor,
    })
      .then((page) => {
        if (
          generation !== this.sessionGeneration ||
          this.current.session?.trip.id !== tripId
        ) return;
        const memberNames = new Map(
          this.current.members.map((member) => [member.id, member.displayName]),
        );
        const knownIds = new Set(this.current.photos.map((photo) => photo.media.id));
        const additions = toPhotoViews(page.items, memberNames)
          .filter((photo) => !knownIds.has(photo.media.id));
        this.galleryCursor = page.nextCursor;
        this.galleryPagesLoaded += 1;
        this.patch({
          photos: [...this.current.photos, ...additions],
          hasMorePhotos: page.nextCursor !== null,
        });
      })
      .catch((error) => {
        if (generation === this.sessionGeneration) this.patch({ notice: errorMessage(error) });
      })
      .finally(() => {
        if (this.galleryLoadPromise !== tracked) return;
        this.galleryLoadPromise = null;
        if (generation === this.sessionGeneration) this.patch({ isLoadingMorePhotos: false });
      });
    this.galleryLoadPromise = tracked;
    return tracked;
  }

  async listSavedTrips(): Promise<TripRecord[]> {
    const trips = await this.dependencies.data.repositories.trips.list();
    return trips.filter((trip) => !trip.isActive && trip.status !== 'DRAFT');
  }

  async loadSavedTripPage(
    tripId: string,
    cursor: GalleryCursor | null = null,
  ): Promise<SavedTripPage> {
    const trip = await this.dependencies.data.repositories.trips.getById(tripId);
    if (!trip || trip.isActive) {
      throw new Error('This saved trip is no longer available for offline browsing.');
    }
    const [members, gallery] = await Promise.all([
      this.dependencies.data.repositories.members.listByTrip(tripId),
      this.dependencies.data.repositories.gallery.listPage(tripId, {
        limit: GALLERY_PAGE_SIZE,
        cursor,
      }),
    ]);
    const memberNames = new Map(members.map((member) => [member.id, member.displayName]));
    return {
      trip,
      members,
      photos: toPhotoViews(gallery.items, memberNames),
      nextCursor: gallery.nextCursor,
    };
  }

  async loadStoredPhoto(tripId: string, mediaId: string): Promise<PhotoView | null> {
    const [trip, media, members, resources] = await Promise.all([
      this.dependencies.data.repositories.trips.getById(tripId),
      this.dependencies.data.repositories.media.getById(tripId, mediaId),
      this.dependencies.data.repositories.members.listByTrip(tripId),
      this.dependencies.data.repositories.resources.listByMedia(tripId, mediaId),
    ]);
    if (!trip || trip.isActive || !media) return null;
    const contributor = members.find((member) => member.id === media.originMemberId);
    return {
      media,
      contributorName: contributor?.displayName ?? 'Unknown friend',
      thumbnail: resources.find((resource) => resource.kind === 'THUMBNAIL') ?? null,
      original: resources.find((resource) => resource.kind === 'ORIGINAL') ?? null,
    };
  }

  async requestOriginal(photo: PhotoView): Promise<void> {
    if (!photo.original) throw new Error('This photo has no original resource metadata.');
    if (photo.original.availability === 'available') return;
    await this.dependencies.sync.requestResource(photo.original);
    this.patch({ notice: 'Original queued. Keep CrewRoll open while a connected holder sends it.' });
  }

  async saveOriginalToLibrary(photo: PhotoView): Promise<void> {
    const session = this.current.session;
    const localDeviceId = session?.localMember.deviceId ?? this.current.identity?.deviceId;
    const original = photo.original;
    if (!original?.localUri || original.availability !== 'available') {
      throw new Error('The exact original is not available on this phone.');
    }
    if (!localDeviceId) {
      throw new Error('The local device identity is unavailable. Reopen CrewRoll and try again.');
    }
    this.mediaLibraryMutationTripIds.add(photo.media.tripId);
    if (session) this.mediaLibraryMutationTripIds.add(session.trip.id);

    // Raise the gate before waiting so no listener/foreground scan can start
    // between the last pre-save scan and Asset.create().
    this.mediaLibraryMutationDepth += 1;
    try {
      await this.scanPromise;
      const assetId = await this.dependencies.mediaGateway.saveImageToLibrary(original.localUri);
      const excludedTripIds = new Set<string>();
      while (true) {
        if (this.current.session) {
          this.mediaLibraryMutationTripIds.add(this.current.session.trip.id);
        }
        const pendingTripIds = [...this.mediaLibraryMutationTripIds].filter(
          (tripId) => !excludedTripIds.has(tripId),
        );
        if (pendingTripIds.length === 0) break;
        await Promise.all(
          pendingTripIds.map((tripId) =>
            this.dependencies.media.excludeSourceAsset({ tripId, localDeviceId, assetId }),
          ),
        );
        for (const tripId of pendingTripIds) excludedTripIds.add(tripId);
      }
      this.patch({ notice: 'Exact original saved to your photo library.' });
    } finally {
      this.mediaLibraryMutationDepth -= 1;
      if (this.mediaLibraryMutationDepth === 0 && this.rescanAfterLibraryMutation) {
        this.rescanAfterLibraryMutation = false;
        this.mediaLibraryMutationTripIds.clear();
        void this.scanNow();
      } else if (this.mediaLibraryMutationDepth === 0) {
        this.mediaLibraryMutationTripIds.clear();
      }
    }
  }

  async endOrLeaveTrip(): Promise<void> {
    try {
      await this.withSessionTransition(async () => {
        const session = this.current.session;
        if (!session) return;

        this.scansPaused = true;
        this.scanAgainRequested = false;
        this.pendingInsertedAssetIds.clear();
        this.clearDeferredRetryTimer();
        this.detachMediaListener();
        let committed = false;
        let keepResponderRunning = false;
        let teardownError: string | null = null;
        try {
          await this.scanPromise;
          if (this.current.session?.trip.id !== session.trip.id) return;
          await this.dependencies.trips.end(session);
          committed = true;
          keepResponderRunning = session.isCoordinator;
          try {
            await this.dependencies.sync.flush();
          } catch (error) {
            teardownError = errorMessage(error);
          }
          if (keepResponderRunning) {
            try {
              this.responderSession =
                (await this.dependencies.trips.resumeResponder?.()) ?? session;
            } catch (error) {
              this.responderSession = session;
              teardownError ??= errorMessage(error);
            }
          } else {
            try {
              await this.dependencies.sync.stop();
            } catch (error) {
              teardownError ??= errorMessage(error);
            }
            this.responderSession = null;
          }
        } finally {
          this.scansPaused = false;
          if (committed) {
            this.sessionGeneration += 1;
            this.syncRefreshAgainRequested = false;
            this.inviteRefreshGeneration += 1;
            this.inviteRefreshAgainRequested = false;
            this.resetGalleryState();
            this.patch({
              session: null,
              members: [],
              photos: [],
              hasMorePhotos: false,
              isLoadingMorePhotos: false,
              transfers: [],
              isScanning: false,
              inviteRefreshError: null,
              isRefreshingInvite: false,
              notice:
                teardownError ??
                (keepResponderRunning
                  ? 'Trip ended. This phone will quietly help finish pending copies.'
                  : null),
            });
          } else {
            this.attachMediaListener();
          }
        }
      });
    } catch (error) {
      this.patch({ notice: errorMessage(error) });
    }
  }

  clearNotice(): void {
    this.patch({ notice: null });
  }

  buildTransferBenchmarkReport(tripId: string): Promise<string> {
    return this.dependencies.transferBenchmarks?.buildExport(tripId)
      ?? Promise.resolve('CrewRoll transfer benchmark (redacted)\nstatus=recorder unavailable');
  }

  async retryLocalSync(): Promise<void> {
    const session = this.current.session;
    if (!session) return;
    this.patch({ notice: null });
    try {
      await this.dependencies.sync.stop();
      if (this.current.session?.trip.id !== session.trip.id) return;
      await this.dependencies.sync.start(this.current.session);
      this.patch({ sync: this.dependencies.sync.snapshot });
      await this.dependencies.sync.flush();
    } catch (error) {
      this.patch({
        sync: this.dependencies.sync.snapshot,
        notice: `Connection restart failed: ${errorMessage(error)}`,
      });
    }
  }

  async dispose(): Promise<void> {
    this.scansPaused = true;
    this.scanAgainRequested = false;
    this.pendingInsertedAssetIds.clear();
    this.clearDeferredRetryTimer();
    this.sessionGeneration += 1;
    this.inviteRefreshGeneration += 1;
    this.inviteRefreshAgainRequested = false;
    this.detachMediaListener();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.networkSubscription?.remove();
    this.networkSubscription = null;
    this.syncSubscription?.remove();
    this.syncSubscription = null;
    this.resetGalleryState();
    await this.scanPromise?.catch(() => undefined);
    await this.dependencies.sync.stop();
  }

  private async activateSession(session: TripSession): Promise<void> {
    const generation = this.sessionGeneration;
    await this.loadSessionContent(session, generation);
    this.attachMediaListener();
    this.attachSyncSubscription();
    this.responderSession = null;
    try {
      await this.dependencies.sync.start(session);
    } catch (error) {
      this.patch({
        sync: this.dependencies.sync.snapshot,
        notice: `Trip saved locally. Local sync will retry when CrewRoll becomes active: ${errorMessage(error)}`,
      });
      // Photo discovery is local-first and must not depend on live transport startup.
      // Outbox rows will remain durable until a peer becomes reachable.
    }
    this.patch({ sync: this.dependencies.sync.snapshot });
    if (
      this.current.permission?.granted &&
      this.current.session?.trip.status === 'ACTIVE' &&
      this.current.session.localMember.status === 'ACTIVE'
    ) {
      void this.scanNow();
    }
  }

  private attachSyncSubscription(): void {
    this.syncSubscription?.remove();
    this.syncSubscription = this.dependencies.sync.subscribe((sync) => {
      this.handleSyncSnapshot(sync);
    });
  }

  private async activateResponder(session: TripSession): Promise<void> {
    this.responderSession = session;
    this.attachSyncSubscription();
    try {
      await this.dependencies.sync.start(session);
    } catch (error) {
      this.patch({
        sync: this.dependencies.sync.snapshot,
        notice: `Saved-roll repair will retry when CrewRoll becomes active: ${errorMessage(error)}`,
      });
    }
    this.patch({ sync: this.dependencies.sync.snapshot });
  }

  private async loadSessionContent(
    session: TripSession,
    generation = this.sessionGeneration,
  ): Promise<void> {
    await this.galleryLoadPromise;
    const requestedPageCount = this.galleryTripId === session.trip.id
      ? this.galleryPagesLoaded
      : 1;
    const [trip, members, gallery, transfers] = await Promise.all([
      this.requireTrip(session.trip.id),
      this.dependencies.data.repositories.members.listByTrip(session.trip.id),
      this.loadGalleryPages(session.trip.id, requestedPageCount),
      this.dependencies.data.repositories.transfers.listRecent(session.trip.id),
    ]);
    if (
      generation !== this.sessionGeneration ||
      this.current.session?.trip.id !== session.trip.id
    ) {
      return;
    }
    const localMember = members.find((member) => member.id === session.localMember.id);
    if (!localMember || localMember.deviceId !== session.localMember.deviceId) {
      throw new Error('The local trip membership no longer matches this device.');
    }
    const memberNames = new Map(members.map((member) => [member.id, member.displayName]));
    const photos = toPhotoViews(gallery.items, memberNames);
    if (
      generation !== this.sessionGeneration ||
      this.current.session?.trip.id !== session.trip.id
    ) {
      return;
    }
    this.galleryTripId = session.trip.id;
    this.galleryCursor = gallery.nextCursor;
    this.galleryPagesLoaded = gallery.pagesLoaded;
    this.patch({
      session: { ...session, trip, localMember },
      members,
      photos,
      hasMorePhotos: gallery.nextCursor !== null,
      isLoadingMorePhotos: false,
      transfers,
    });
  }

  private async loadGalleryPages(tripId: string, requestedPageCount: number) {
    const items: GalleryItemRecord[] = [];
    let cursor: GalleryCursor | null = null;
    let pagesLoaded = 0;
    do {
      const page = await this.dependencies.data.repositories.gallery.listPage(tripId, {
        limit: GALLERY_PAGE_SIZE,
        cursor,
      });
      items.push(...page.items);
      cursor = page.nextCursor;
      pagesLoaded += 1;
    } while (cursor && pagesLoaded < requestedPageCount);
    return { items, nextCursor: cursor, pagesLoaded };
  }

  private resetGalleryState(): void {
    this.galleryTripId = null;
    this.galleryCursor = null;
    this.galleryPagesLoaded = 1;
    this.galleryLoadPromise = null;
  }

  private async requireTrip(tripId: string) {
    const trip = await this.dependencies.data.repositories.trips.getById(tripId);
    if (!trip) throw new Error('The active trip record disappeared.');
    return trip;
  }

  private async runScan(
    generation: number,
    insertedAssetIds: readonly string[],
  ): Promise<ScanAndIngestResult | null> {
    const session = this.current.session;
    const permission = this.current.permission;
    if (
      !session ||
      !permission?.granted ||
      session.trip.status !== 'ACTIVE' ||
      session.localMember.status !== 'ACTIVE'
    ) return null;

    this.patch({ isScanning: true, notice: null });
    try {
      const result = await this.dependencies.media.scanAndIngest({
        tripId: session.trip.id,
        localMemberId: session.localMember.id,
        localDeviceId: session.localMember.deviceId,
        ...(insertedAssetIds.length > 0 ? { insertedAssetIds } : {}),
        batchSize: LIVE_SCAN_BATCH_SIZE,
        maxPages: LIVE_SCAN_MAX_PAGES,
        onPreviewPublished: async () => {
          if (
            generation !== this.sessionGeneration ||
            this.scansPaused ||
            this.current.session?.trip.id !== session.trip.id
          ) return;
          await this.loadSessionContent(session, generation);
          if (generation !== this.sessionGeneration || this.scansPaused) return;
          await this.dependencies.sync.flush();
        },
      });
      if (
        generation !== this.sessionGeneration ||
        this.scansPaused ||
        this.current.session?.trip.id !== session.trip.id
      ) {
        return result;
      }
      if (result.hasMore) this.scanAgainRequested = true;
      this.scheduleDeferredRetry(
        result.nextDeferredRetryAtMs,
        generation,
        session.trip.id,
      );
      const retrying = result.failures.filter((failure) => failure.retryable).length;
      const skipped = result.failures.length - retrying;
      const status = [
        retrying > 0 ? `${retrying} photo${retrying === 1 ? '' : 's'} waiting to retry` : null,
        skipped > 0 ? `${skipped} unsupported photo${skipped === 1 ? '' : 's'} skipped` : null,
      ].filter((part): part is string => part !== null).join('; ');
      this.patch({
        lastScan: result,
        notice: status ? `${status}.` : null,
      });
      await this.loadSessionContent(session, generation);
      if (generation !== this.sessionGeneration || this.scansPaused) return result;
      await this.dependencies.sync.flush();
      return result;
    } catch (error) {
      if (generation === this.sessionGeneration) this.patch({ notice: errorMessage(error) });
      return null;
    } finally {
      if (generation === this.sessionGeneration) this.patch({ isScanning: false });
    }
  }

  private attachLifecycleListeners(): void {
    if (!this.appStateSubscription) {
      this.appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (state !== 'active') return;
        void this.onForeground();
      });
    }
    if (!this.networkSubscription) {
      this.networkSubscription = Network.addNetworkStateListener((state) => {
        if (!this.current.session?.isCoordinator) return;
        this.latestNetworkConnected = state.isConnected ?? null;
        if (state.isConnected === false) {
          const message = 'Connect this phone to a network, then try again.';
          this.inviteRefreshGeneration += 1;
          this.inviteRefreshAgainRequested = false;
          this.patch({
            inviteRefreshError: message,
            isRefreshingInvite: false,
            notice: `Invite could not refresh: ${message}`,
          });
          return;
        }
        if (this.inviteRefreshPromise) {
          this.inviteRefreshAgainRequested = true;
          this.patch({ isRefreshingInvite: true });
          return;
        }
        void this.refreshCoordinatorInvite();
      });
    }
  }

  private async onForeground(): Promise<void> {
    try {
      const permission = await this.dependencies.mediaGateway.getPermissionState();
      this.patch({ permission });
      await this.refresh();
      const session = this.current.session;
      if (session?.trip.status === 'ENDED' || session?.trip.status === 'ARCHIVED') {
        await this.archiveEndedTripAsResponder(session);
        return;
      }
      if (
        session &&
        (session.trip.status === 'DRAFT' || session.trip.status === 'ACTIVE') &&
        (this.current.sync.state === 'idle' ||
          this.current.sync.state === 'stopped' ||
          this.current.sync.state === 'error')
      ) {
        try {
          await this.dependencies.sync.start(session);
          this.patch({ sync: this.dependencies.sync.snapshot });
        } catch (error) {
          this.patch({ sync: this.dependencies.sync.snapshot, notice: errorMessage(error) });
        }
      }
      if (
        !session &&
        this.responderSession &&
        (this.current.sync.state === 'idle' ||
          this.current.sync.state === 'stopped' ||
          this.current.sync.state === 'error')
      ) {
        try {
          await this.dependencies.sync.start(this.responderSession);
          this.patch({ sync: this.dependencies.sync.snapshot });
        } catch (error) {
          this.patch({ sync: this.dependencies.sync.snapshot, notice: errorMessage(error) });
        }
      }
      if (
        permission.granted &&
        session?.trip.status === 'ACTIVE' &&
        session.localMember.status === 'ACTIVE'
      ) await this.scanNow();
      if (session || this.responderSession) await this.dependencies.sync.flush();
    } catch (error) {
      this.patch({ notice: errorMessage(error) });
    }
  }

  private attachMediaListener(): void {
    if (this.mediaSubscription || !this.current.permission?.granted) return;
    this.mediaSubscription = this.dependencies.mediaGateway.subscribe((change) => {
      if (this.mediaLibraryMutationDepth > 0) {
        this.rescanAfterLibraryMutation = true;
        return;
      }
      void this.scanNow(change.kind === 'incremental' ? change.insertedAssetIds : []);
    });
  }

  private detachMediaListener(): void {
    this.mediaSubscription?.remove();
    this.mediaSubscription = null;
  }

  private handleSyncSnapshot(sync: SyncSnapshot): void {
    const contentChanged = sync.contentRevision !== this.current.sync.contentRevision;
    const transfersChanged = sync.transferRevision !== this.current.sync.transferRevision;
    this.patch({ sync });
    if (contentChanged) {
      this.scheduleSyncRefresh();
    } else if (transfersChanged) {
      this.scheduleTransferRefresh();
    }
  }

  private scheduleTransferRefresh(): void {
    if (this.transferRefreshPromise) {
      this.transferRefreshAgainRequested = true;
      return;
    }
    const generation = this.sessionGeneration;
    const tripId = this.current.session?.trip.id;
    if (!tripId) return;
    this.transferRefreshPromise = this.dependencies.data.repositories.transfers.listRecent(tripId)
      .then((transfers) => {
        if (
          generation === this.sessionGeneration &&
          this.current.session?.trip.id === tripId
        ) {
          this.patch({ transfers });
        }
      })
      .catch((error) => {
        if (generation === this.sessionGeneration) this.patch({ notice: errorMessage(error) });
      })
      .finally(() => {
        this.transferRefreshPromise = null;
        const shouldRefreshAgain = this.transferRefreshAgainRequested;
        this.transferRefreshAgainRequested = false;
        if (shouldRefreshAgain && generation === this.sessionGeneration) {
          this.scheduleTransferRefresh();
        }
      });
  }

  private scheduleSyncRefresh(): void {
    if (this.syncRefreshPromise) {
      this.syncRefreshAgainRequested = true;
      return;
    }
    const generation = this.sessionGeneration;
    this.syncRefreshPromise = this.refreshAfterSync(generation)
      .catch((error) => {
        if (generation === this.sessionGeneration) this.patch({ notice: errorMessage(error) });
      })
      .finally(() => {
        this.syncRefreshPromise = null;
        const shouldRefreshAgain = this.syncRefreshAgainRequested;
        this.syncRefreshAgainRequested = false;
        if (shouldRefreshAgain && generation === this.sessionGeneration) {
          this.scheduleSyncRefresh();
        }
      });
  }

  private async refreshAfterSync(generation: number): Promise<void> {
    const before = this.current.session;
    await this.refresh();
    if (generation !== this.sessionGeneration) return;
    const after = this.current.session;
    if (!before || !after || before.trip.id !== after.trip.id) return;

    if (
      before.trip.status !== 'ACTIVE' &&
      after.trip.status === 'ACTIVE' &&
      this.current.permission?.granted
    ) {
      await this.scanNow();
    }
    if (
      !after.isCoordinator &&
      (after.trip.status === 'ENDED' || after.trip.status === 'ARCHIVED')
    ) {
      await this.archiveEndedTripAsResponder(after);
    }
  }

  private async archiveEndedTripAsResponder(session: TripSession): Promise<void> {
    await this.withSessionTransition(async () => {
      if (this.current.session?.trip.id !== session.trip.id) return;
      this.scansPaused = true;
      this.scanAgainRequested = false;
      this.pendingInsertedAssetIds.clear();
      this.clearDeferredRetryTimer();
      this.detachMediaListener();
      let notice: string | null = null;
      try {
        await this.scanPromise;
        const responder =
          (await this.dependencies.trips.archiveEndedForResponder?.(session)) ?? session;
        this.responderSession = responder;
        if (
          this.current.sync.state === 'idle' ||
          this.current.sync.state === 'stopped' ||
          this.current.sync.state === 'error'
        ) {
          await this.dependencies.sync.start(responder);
        }
        await this.dependencies.sync.flush();
      } catch (error) {
        notice = errorMessage(error);
        this.responderSession = session;
      } finally {
        this.scansPaused = false;
        this.sessionGeneration += 1;
        this.syncRefreshAgainRequested = false;
        this.inviteRefreshGeneration += 1;
        this.inviteRefreshAgainRequested = false;
        this.resetGalleryState();
        this.patch({
          session: null,
          members: [],
          photos: [],
          hasMorePhotos: false,
          isLoadingMorePhotos: false,
          transfers: [],
          isScanning: false,
          inviteRefreshError: null,
          isRefreshingInvite: false,
          notice:
            notice ??
            'Trip saved. This keeper remains available for pending encrypted copies.',
        });
      }
    });
  }

  private async withSessionTransition<T>(task: () => Promise<T>): Promise<T> {
    if (this.sessionTransitionInProgress) {
      throw new Error('Another trip change is already in progress.');
    }
    this.sessionTransitionInProgress = true;
    try {
      return await task();
    } finally {
      this.sessionTransitionInProgress = false;
    }
  }

  private async rememberOnboardingAfterTripAction(): Promise<void> {
    try {
      await this.completeOnboarding();
    } catch (error) {
      this.patch({ notice: `Trip is ready, but onboarding status could not be saved: ${errorMessage(error)}` });
    }
  }

  private patch(patch: Partial<RuntimeSnapshot>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPhotoViews(
  items: readonly GalleryItemRecord[],
  memberNames: ReadonlyMap<string, string>,
): PhotoView[] {
  return items.map((item) => ({
    media: item.media,
    contributorName: memberNames.get(item.media.originMemberId) ?? 'Unknown friend',
    thumbnail: item.thumbnail,
    original: item.original,
  }));
}
