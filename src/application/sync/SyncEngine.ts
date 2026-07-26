import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  DOMAIN_SCHEMA_VERSION,
  FRAME_SECURITY_VERSION,
  MAX_ACTIVE_TRANSFERS,
  MAX_OPERATION_BATCH_SIZE,
  MAX_TRIP_MEMBERS,
  PROTOCOL_VERSION,
} from '../../core/constants';
import {
  parseMediaResource,
  parseMember,
  parseReplicaReceipt,
  parseSyncOperation,
  type MediaItem,
  type MediaResource,
  type Member,
  type ReplicaReceipt,
  type SyncOperation,
  type Trip,
} from '../../core/domain';
import {
  parseDeviceId,
  parseMediaId,
  parseMessageId,
  parseOperationId,
  parseReplicaReceiptId,
  parseRequestId,
  parseResourceId,
  parseSha256Hex,
  parseTransferId,
  type DeviceId,
  type MemberId,
  type MessageId,
  type TransferId,
  type TripId,
} from '../../core/ids';
import {
  computeMissingRanges,
  createEmptyCatalogState,
  applySyncOperations,
  type CatalogState,
} from '../../core/reconciliation';
import {
  parseProtocolEnvelope,
  parseResourceRequestMessage,
  type AckMessage,
  type HelloMessage,
  type HighWaterVector,
  type ProtocolEnvelope,
  type ProtocolMessageType,
  type ResourceCompleteMessage,
  type ResourceOfferMessage,
  type ResourcePriority,
  type ResourceRequestMessage,
  type SyncRequestMessage,
} from '../../core/protocol';
import type {
  AuthenticatedFrameCrypto,
  SecureFrameHeader,
  SecureFrameReplayGuard,
  SessionKeyHandle,
} from '../../core/security';
import { assertParsed } from '../../core/validation';
import { sha256Hex } from '../media/contentIdentity';
import { hashFile as hashStoredFile } from '../media/hashFile';
import {
  signSecureFrame,
  verifySignedSecureFrame,
  type FrameIdentityAuthenticator,
  type SignedSecureFrame,
} from '../security/frameAuthenticity';
import {
  signSyncOperation,
  verifySyncOperation,
} from '../security/operationAuthenticity';
import type {
  AirMeshDataLayer,
  AirMeshRepositories,
  JsonValue,
  MediaRecord,
  MemberRecord,
  OutboxRecord,
  ReplicaReceiptRecord,
  ResourceRecord,
  SyncOperationRecord,
  TransferRecord,
  TripRecord,
} from '@/data';
import type { ChunkedFileStore } from '@/platform/files';
import {
  MAX_CONTROL_FRAME_BYTES,
  type InboundBinaryChunk,
  type InboundControlMessage,
  type Transport,
  type TransportEvent,
  type TransportSubscription,
} from '../../platform/transport/Transport';

import type { PersistentWireCounter } from './counters';
import {
  SECURE_CONTROL_TRANSPORT_TYPE,
  decodeControlEnvelopePlaintext,
  decodeResourceChunkPlaintext,
  encodeControlEnvelopePlaintext,
  encodeResourceChunkPlaintext,
  parseSignedSecureBinaryFrame,
  parseSerializedSignedSecureControlFrame,
  serializeSignedSecureBinaryFrame,
  serializeSignedSecureControlFrame,
} from './secureWire';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const OUTBOX_LEASE_MS = 15_000;
const OUTBOX_BATCH_SIZE = 8;
const MAX_OUTBOX_ATTEMPTS = 8;
const MAX_SYNC_OPERATIONS_PER_FRAME = 16;
const SECURE_FILE_CHUNK_BYTES = 192 * 1024;
const MAX_CONCURRENT_UPLOADS = 2;
const MAX_CONCURRENT_DOWNLOADS = 3;
const MAX_CONCURRENT_ORIGINAL_DOWNLOADS = 2;
const MAX_CONCURRENT_BACKGROUND_ORIGINAL_DOWNLOADS = 1;
const MAX_QUEUED_ORIGINAL_DOWNLOADS = 8;
const ORIGINAL_SEED_RECIPIENTS = 2;
const MAX_IN_FLIGHT_CHUNKS_PER_UPLOAD = 3;
// One relay socket carries controls, previews, and originals. Keeping at most
// two encrypted chunks queued globally bounds FIFO head-of-line delay to about
// 384 KiB while still filling ordinary mobile links across an RTT.
const MAX_GLOBAL_IN_FLIGHT_CHUNKS = 2;
const UPLOAD_CHECKPOINT_BYTES = 1024 * 1024;
const CHUNK_ACK_TIMEOUT_MS = 15_000;
const COMPLETION_WATCHDOG_MS = 12_000;
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 20_000;
const RESOURCE_RECONCILE_INTERVAL_MS = 5_000;
const RESOURCE_RETRY_BASE_MS = 2_000;
const QUEUED_TRANSFER_REOFFER_MS = 5_000;
const RESOURCE_PEER_COOLDOWN_MS = 15_000;
const MAX_RESOURCES_PER_RECONCILE = 32;
const TRANSFER_RECOVERY_YIELD_INTERVAL = 8;
const BACKGROUND_REQUEST_DELAY_MS = 300;
const MIN_FREE_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
const PROTOCOL_OUTBOX_PREFIX = 'PROTOCOL:';
const textEncoder = new TextEncoder();

interface PendingUpload {
  readonly peerDeviceId: string;
  readonly priority: ResourcePriority;
}

interface DownloadDemandUsage {
  thumbnails: number;
  userVisibleOriginals: number;
  backgroundOriginals: number;
}

interface PendingChunkAck {
  readonly transferId: string;
  readonly peerDeviceId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
  readonly reject: (error: SyncEngineError) => void;
}

interface PendingChunkPermit {
  readonly transferId: string;
  readonly priority: ResourcePriority;
  readonly sequence: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: SyncEngineError) => void;
}

export interface SyncSession {
  readonly tripId: TripId;
  readonly localMemberId: MemberId;
  readonly localDeviceId: DeviceId;
  /** Pinned from the authenticated invite; equal to localDeviceId for the coordinator. */
  readonly trustedCoordinatorDeviceId: DeviceId;
  readonly localIdentityPublicKey: string;
  readonly trustedCoordinatorIdentityPublicKey: string;
  /** Signed bearer ticket used only when this device has not been admitted yet. */
  readonly admissionInviteLink: string | null;
  readonly endpoint: string;
  readonly isCoordinator: boolean;
  readonly key: SessionKeyHandle;
}

export interface AdmissionRequest {
  readonly hello: HelloMessage;
  readonly transportPeerId: string;
  readonly trip: TripRecord;
  readonly currentMembers: readonly MemberRecord[];
  readonly isCoordinator: boolean;
}

export type AdmissionDecision =
  | { readonly accepted: false; readonly code: string; readonly message: string }
  | {
      readonly accepted: true;
      readonly member: Member;
      /** Required when the member is not already durably known. */
      readonly operation: Extract<SyncOperation, { readonly kind: 'MEMBER_JOINED' }>;
    };

export interface AdmissionController {
  decide(request: AdmissionRequest): Promise<AdmissionDecision>;
}

export interface PersistentOperationSequenceAllocator {
  allocate(request: {
    readonly tripId: string;
    readonly originDeviceId: string;
    readonly idempotencyKey: string;
  }): Promise<number>;
}

export interface SyncEngineClock {
  nowMs(): number;
}

export interface SyncEngineScheduler {
  setInterval(task: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SyncEngineIdFactory {
  create(kind: string, ...parts: readonly string[]): string;
}

export type SyncEngineEvent =
  | { readonly kind: 'state'; readonly state: SyncEngineState }
  | {
      readonly kind: 'catalog-changed';
      readonly source: 'admission' | 'inbound' | 'local-refresh';
      readonly appliedOperationCount: number;
    }
  | {
      readonly kind: 'outbox-changed';
      readonly messageId: string;
      readonly state: 'pending' | 'delivered' | 'dead_letter';
    }
  | { readonly kind: 'peer-admitted'; readonly memberId: string; readonly deviceId: string }
  | { readonly kind: 'peer-left'; readonly deviceId: string }
  | {
      readonly kind: 'resource-progress';
      readonly transferId: string;
      readonly resourceId: string;
      readonly direction: 'upload' | 'download';
      readonly state: TransferRecord['state'];
      readonly bytesTransferred: number;
      readonly totalBytes: number;
    }
  | { readonly kind: 'resource-available'; readonly resourceId: string; readonly localUri: string }
  | { readonly kind: 'error'; readonly error: SyncEngineError };

export type SyncEngineState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface SyncEngineDependencies {
  readonly session: SyncSession;
  readonly data: Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
  readonly transport: Transport;
  readonly fileStore: ChunkedFileStore;
  readonly crypto: AuthenticatedFrameCrypto;
  readonly identity: FrameIdentityAuthenticator;
  readonly wireCounter: PersistentWireCounter;
  readonly replayGuard: SecureFrameReplayGuard;
  readonly operationSequenceAllocator: PersistentOperationSequenceAllocator;
  readonly admission?: AdmissionController;
  readonly clock?: SyncEngineClock;
  readonly scheduler?: SyncEngineScheduler;
  readonly ids?: SyncEngineIdFactory;
  readonly availableStorageBytes?: () => Promise<number>;
  readonly canStoreOriginals?: () => boolean;
  readonly onEvent?: (event: SyncEngineEvent) => void;
  readonly heartbeatIntervalMs?: number;
}

export class SyncEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
    readonly context: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SyncEngineError';
  }
}

export class SyncEngine {
  private readonly session: SyncSession;
  private readonly data: Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
  private readonly transport: Transport;
  private readonly fileStore: ChunkedFileStore;
  private readonly crypto: AuthenticatedFrameCrypto;
  private readonly identity: FrameIdentityAuthenticator;
  private readonly wireCounter: PersistentWireCounter;
  private readonly replayGuard: SecureFrameReplayGuard;
  private readonly operationSequenceAllocator: PersistentOperationSequenceAllocator;
  private readonly admission?: AdmissionController;
  private readonly clock: SyncEngineClock;
  private readonly scheduler: SyncEngineScheduler;
  private readonly ids: SyncEngineIdFactory;
  private readonly availableStorageBytes: () => Promise<number>;
  private readonly canStoreOriginals: () => boolean;
  private readonly onEvent: (event: SyncEngineEvent) => void;
  private readonly heartbeatIntervalMs: number;

  private state: SyncEngineState = 'idle';
  private catalogState: CatalogState = createEmptyCatalogState();
  private subscription: TransportSubscription | null = null;
  private timer: unknown = null;
  private outboxWakeTimer: ReturnType<typeof setTimeout> | null = null;
  private eventChain: Promise<void> = Promise.resolve();
  private catalogMutationChain: Promise<void> = Promise.resolve();
  private flushPromise: Promise<void> | null = null;
  private readonly admittedDevices = new Set<string>();
  private readonly memberIdByDevice = new Map<string, string>();
  private readonly canStoreOriginalsByDevice = new Map<string, boolean>();
  private readonly availableStorageBytesByDevice = new Map<string, number>();
  private readonly activeUploads = new Map<string, Promise<void>>();
  private readonly pendingUploads = new Map<string, PendingUpload>();
  private readonly activeUploadPriorities = new Map<string, ResourcePriority>();
  private readonly uploadPriorities = new Map<string, ResourcePriority>();
  private readonly downloadPriorities = new Map<string, ResourcePriority>();
  private readonly uploadAttemptKeys = new Map<string, string>();
  private readonly pendingChunkAcks = new Map<string, PendingChunkAck>();
  private readonly pendingChunkPermits: PendingChunkPermit[] = [];
  private readonly uploadPreemptionRequests = new Set<string>();
  private activeChunkPermits = 0;
  private nextChunkPermitSequence = 0;
  private readonly completionWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly downloadInactivityWatchdogs = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly downloadFinalizations = new Map<string, Promise<void>>();
  private readonly activeDownloadRecoveries = new Map<string, Promise<void>>();
  private readonly recoveryRequestedOffsets = new Map<
    string,
    { readonly offset: number; readonly requestedAtMs: number }
  >();
  private readonly incomingReservations = new Map<string, number>();
  private readonly resourceRetryAfterMs = new Map<string, number>();
  private readonly resourceRetryCounts = new Map<string, number>();
  private readonly resourcePeerCooldownUntilMs = new Map<string, Map<string, number>>();
  private connectedPeerIds = new Set<string>();
  private lastHeartbeatAtMs = 0;
  private lastResourceReconcileAtMs = 0;
  private unavailableResourceCursor: Pick<
    ResourceRecord,
    'kind' | 'createdAtMs' | 'id'
  > | null = null;
  private resourceReconcilePromise: Promise<void> | null = null;
  private startupRecoveryPromise: Promise<void> | null = null;
  private localRequestNonce = 0;

  constructor(dependencies: SyncEngineDependencies) {
    this.session = dependencies.session;
    this.data = dependencies.data;
    this.transport = dependencies.transport;
    this.fileStore = dependencies.fileStore;
    this.crypto = dependencies.crypto;
    this.identity = dependencies.identity;
    this.wireCounter = dependencies.wireCounter;
    this.replayGuard = dependencies.replayGuard;
    this.operationSequenceAllocator = dependencies.operationSequenceAllocator;
    this.admission = dependencies.admission;
    this.clock = dependencies.clock ?? { nowMs: Date.now };
    this.scheduler = dependencies.scheduler ?? systemScheduler;
    this.ids = dependencies.ids ?? defaultSyncEngineIdFactory;
    this.availableStorageBytes = dependencies.availableStorageBytes ?? (async () => 0);
    this.canStoreOriginals = dependencies.canStoreOriginals ?? (() => true);
    this.onEvent = dependencies.onEvent ?? (() => undefined);
    this.heartbeatIntervalMs = positiveInterval(
      dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs',
    );
  }

  get snapshot(): SyncEngineState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    if (this.state === 'stopping') {
      throw new SyncEngineError('ENGINE_STOPPING', 'Cannot start while the engine is stopping.', true);
    }
    this.setState('starting');
    try {
      await this.validateLocalContext();
      await this.hydrateCatalog();
      this.subscription = this.transport.subscribe((event) => this.enqueueEvent(event));
      this.transport.connect({
        url: this.session.endpoint,
        sessionId: this.session.tripId,
        peerId: this.session.localDeviceId,
      });
      this.timer = this.scheduler.setInterval(() => {
        void this.tick();
      }, Math.min(this.heartbeatIntervalMs, RESOURCE_RECONCILE_INTERVAL_MS));
      this.setState('running');
      this.startupRecoveryPromise = this.reconcileRecoverableTransfers()
        .catch((error) => {
          this.report(this.asSyncError(error, 'STARTUP_TRANSFER_RECOVERY_FAILED', true));
        })
        .finally(() => {
          this.startupRecoveryPromise = null;
        });
      await this.reconcileUnavailableResources(true);
      await this.flushOutbox();
    } catch (error) {
      this.subscription?.remove();
      this.subscription = null;
      this.transport.disconnect();
      this.setState('stopped');
      throw this.asSyncError(error, 'START_FAILED', false);
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.setState('stopping');
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.clearOutboxWakeTimer();
    this.subscription?.remove();
    this.subscription = null;
    this.transport.disconnect();
    this.cancelAllChunkPermits('ENGINE_STOPPED');
    this.cancelAllChunkAcks('ENGINE_STOPPED');
    this.clearAllCompletionWatchdogs();
    this.clearAllDownloadInactivityWatchdogs();
    this.connectedPeerIds.clear();
    this.admittedDevices.clear();
    this.memberIdByDevice.clear();
    this.canStoreOriginalsByDevice.clear();
    this.availableStorageBytesByDevice.clear();
    await this.eventChain.catch(() => undefined);
    this.pendingUploads.clear();
    await Promise.allSettled(this.activeUploads.values());
    this.activeUploads.clear();
    this.activeUploadPriorities.clear();
    this.uploadPreemptionRequests.clear();
    await Promise.allSettled([
      ...(this.resourceReconcilePromise ? [this.resourceReconcilePromise] : []),
      ...(this.startupRecoveryPromise ? [this.startupRecoveryPromise] : []),
      ...this.downloadFinalizations.values(),
      ...this.activeDownloadRecoveries.values(),
    ]);
    this.downloadFinalizations.clear();
    this.activeDownloadRecoveries.clear();
    await this.pauseRecoverableTransfers('ENGINE_STOPPED');
    this.uploadPriorities.clear();
    this.downloadPriorities.clear();
    this.uploadAttemptKeys.clear();
    this.incomingReservations.clear();
    this.recoveryRequestedOffsets.clear();
    this.resourceRetryAfterMs.clear();
    this.resourceRetryCounts.clear();
    this.resourcePeerCooldownUntilMs.clear();
    this.unavailableResourceCursor = null;
    this.setState('stopped');
  }

  async flushOutbox(): Promise<void> {
    if (this.flushPromise !== null) return this.flushPromise;
    this.flushPromise = this.flushOutboxInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async requestOriginal(mediaIdValue: string, preferredPeerDeviceId?: string): Promise<void> {
    const mediaId = assertParsed(parseMediaId(mediaIdValue));
    const media = await this.data.repositories.media.getById(this.session.tripId, mediaId);
    if (!media) {
      throw new SyncEngineError('MEDIA_NOT_FOUND', `Media '${mediaId}' is not in this trip.`, false);
    }
    const resource = await this.data.repositories.resources.getById(
      this.session.tripId,
      media.originalResourceId,
    );
    if (!resource) {
      throw new SyncEngineError('RESOURCE_NOT_FOUND', 'Original resource manifest is missing.', false);
    }
    if (resource.availability === 'available' && resource.localUri) return;
    const active = await this.data.repositories.transfers.listActive(this.session.tripId);
    if (!active.some(
      (transfer) =>
        transfer.direction === 'download' && transfer.resourceId === resource.id,
    )) {
      const usage = await this.currentDownloadDemandUsage(active);
      if (
        usage.userVisibleOriginals + usage.backgroundOriginals >=
        MAX_QUEUED_ORIGINAL_DOWNLOADS
      ) {
        throw new SyncEngineError(
          'ORIGINAL_QUEUE_FULL',
          'Too many originals are already queued. This photo can be requested when one finishes.',
          true,
          { limit: MAX_QUEUED_ORIGINAL_DOWNLOADS },
        );
      }
    }
    const target = await this.resolveResourcePeer(resource, preferredPeerDeviceId);
    await this.queueResourceRequest(resource, target, 'USER_VISIBLE_ORIGINAL');
    await this.flushOutbox();
  }

  private async tick(): Promise<void> {
    if (this.state !== 'running') return;
    try {
      const now = checkedNow(this.clock);
      if (
        this.transport.state.state === 'connected' &&
        now - this.lastHeartbeatAtMs >= this.heartbeatIntervalMs
      ) {
        this.lastHeartbeatAtMs = now;
        await Promise.all(
          [...this.admittedDevices].map((peerId) => this.sendHeartbeat(peerId)),
        );
      }
      if (now - this.lastResourceReconcileAtMs >= RESOURCE_RECONCILE_INTERVAL_MS) {
        await this.reconcileUnavailableResources();
      }
    } catch (error) {
      this.report(this.asSyncError(error, 'TICK_FAILED', true));
    }
  }

  private enqueueEvent(event: TransportEvent): void {
    this.eventChain = this.eventChain
      .then(() => this.handleTransportEvent(event))
      .catch((error) => {
        this.report(this.asSyncError(error, 'TRANSPORT_EVENT_FAILED', true));
      });
  }

  private async handleTransportEvent(event: TransportEvent): Promise<void> {
    if (this.state !== 'running') return;
    switch (event.kind) {
      case 'state':
        if (event.snapshot.state === 'connected') await this.flushOutbox();
        return;
      case 'peers':
        {
        const nextPeerIds = new Set(
          event.peerIds.filter((peerId) => peerId !== this.session.localDeviceId),
        );
        const departed = [...this.connectedPeerIds].filter((peerId) => !nextPeerIds.has(peerId));
        this.connectedPeerIds = nextPeerIds;
        for (const peerId of departed) {
          this.admittedDevices.delete(peerId);
          this.memberIdByDevice.delete(peerId);
          this.canStoreOriginalsByDevice.delete(peerId);
          this.availableStorageBytesByDevice.delete(peerId);
          this.cancelChunkAcksForPeer(peerId, 'PEER_DISCONNECTED');
          await this.pauseInterruptedTransfers(peerId);
          this.onEvent({ kind: 'peer-left', deviceId: peerId });
        }
        await Promise.all([...this.connectedPeerIds].map((peerId) => this.sendHello(peerId)));
        if (departed.length > 0) await this.reconcileUnavailableResources(true);
        return;
        }
      case 'peer-joined':
        if (event.peerId !== this.session.localDeviceId) {
          this.connectedPeerIds.add(event.peerId);
          await this.sendHello(event.peerId);
        }
        return;
      case 'peer-left':
        this.connectedPeerIds.delete(event.peerId);
        this.admittedDevices.delete(event.peerId);
        this.memberIdByDevice.delete(event.peerId);
        this.canStoreOriginalsByDevice.delete(event.peerId);
        this.availableStorageBytesByDevice.delete(event.peerId);
        this.cancelChunkAcksForPeer(event.peerId, 'PEER_DISCONNECTED');
        await this.pauseInterruptedTransfers(event.peerId);
        this.onEvent({ kind: 'peer-left', deviceId: event.peerId });
        await this.reconcileUnavailableResources(true);
        return;
      case 'control':
        await this.handleInboundControl(event.message);
        return;
      case 'chunk':
        await this.handleInboundChunk(event.chunk);
        return;
      case 'error':
        {
          const transportError = new SyncEngineError(
            event.code,
            event.message,
            event.recoverable,
            {
              source: event.source,
              messageId: event.messageId ?? null,
            },
          );
          this.report(transportError);
          if (event.recoverable && event.messageId) {
            await this.handleRecoverableTransportError(event.messageId, event.code);
          }
          return;
        }
    }
  }

  private async validateLocalContext(): Promise<void> {
    if (this.session.key.tripId !== this.session.tripId) {
      throw new SyncEngineError('KEY_TRIP_MISMATCH', 'Session key belongs to another trip.', false);
    }
    if (
      (this.session.isCoordinator &&
        (this.session.trustedCoordinatorDeviceId !== this.session.localDeviceId ||
          this.session.trustedCoordinatorIdentityPublicKey !==
            this.session.localIdentityPublicKey)) ||
      (!this.session.isCoordinator &&
        this.session.trustedCoordinatorDeviceId === this.session.localDeviceId)
    ) {
      throw new SyncEngineError(
        'INVALID_COORDINATOR_PIN',
        'Session coordinator identity is inconsistent with the local role.',
        false,
      );
    }
    const [trip, member] = await Promise.all([
      this.data.repositories.trips.getById(this.session.tripId),
      this.data.repositories.members.getById(
        this.session.tripId,
        this.session.localMemberId,
      ),
    ]);
    if (!trip || !member) {
      throw new SyncEngineError('SESSION_NOT_FOUND', 'Trip or local member is missing.', false);
    }
    if (trip.membershipEpoch !== this.session.key.keyEpoch) {
      throw new SyncEngineError(
        'KEY_EPOCH_MISMATCH',
        'Session key epoch does not match the durable trip membership epoch.',
        false,
      );
    }
    if (
      member.deviceId !== this.session.localDeviceId ||
      member.identityPublicKey !== this.session.localIdentityPublicKey ||
      member.status === 'LEFT' ||
      member.status === 'REMOVED'
    ) {
      throw new SyncEngineError('INVALID_LOCAL_MEMBER', 'Local member/device is not active.', false);
    }
    if (
      this.session.isCoordinator &&
      (member.role !== 'ADMIN' || trip.createdByMemberId !== member.id)
    ) {
      throw new SyncEngineError(
        'INVALID_COORDINATOR_ROLE',
        'Only the trip creator ADMIN may run the coordinator session.',
        false,
      );
    }
    if (!this.session.isCoordinator) {
      const knownCoordinator = await this.data.repositories.members.getById(
        this.session.tripId,
        trip.createdByMemberId,
      );
      if (
        knownCoordinator &&
        (knownCoordinator.deviceId !== this.session.trustedCoordinatorDeviceId ||
          knownCoordinator.identityPublicKey !==
            this.session.trustedCoordinatorIdentityPublicKey)
      ) {
        throw new SyncEngineError(
          'COORDINATOR_PIN_MISMATCH',
          'Pinned coordinator device does not match the durable trip creator.',
          false,
        );
      }
    }
  }

  private async hydrateCatalog(): Promise<void> {
    const highWater = await this.data.repositories.syncOperations.getContiguousHighWaterMarks(
      this.session.tripId,
    );
    const operations: SyncOperation[] = [];
    for (const [deviceId, through] of Object.entries(highWater)) {
      let after = 0;
      while (after < through) {
        const records = await this.data.repositories.syncOperations.listRange(
          this.session.tripId,
          deviceId,
          after,
          through,
          MAX_OPERATION_BATCH_SIZE,
        );
        if (records.length === 0) break;
        for (const record of records) operations.push(parseOperationRecord(record));
        after = records.at(-1)!.originSequence;
      }
    }
    operations.sort(operationHydrationOrder);
    if (!(await this.areOperationOriginsAuthorized(operations, this.session.localDeviceId))) {
      throw new SyncEngineError(
        'INVALID_LOCAL_OPERATION_SIGNATURE',
        'Local operation history contains an unsigned operation or an invalid origin signature.',
        false,
      );
    }
    const result = applySyncOperations(createEmptyCatalogState(), operations);
    const rejected = result.results.find((entry) => entry.disposition === 'REJECTED');
    if (rejected) {
      throw new SyncEngineError(
        'INVALID_LOCAL_OPERATION_LOG',
        `Local operation log violates core invariants: ${rejected.issues
          .map((entry) => entry.code)
          .join(', ')}.`,
        false,
      );
    }
    this.catalogState = result.state;
  }

  private async flushOutboxInternal(): Promise<void> {
    if (this.state !== 'running') return;
    this.clearOutboxWakeTimer();
    if (this.transport.state.state !== 'connected' || this.admittedDevices.size === 0) return;
    try {
      await this.withCatalogMutation(() => this.refreshCatalogFromPersistence());
      const now = checkedNow(this.clock);
      const records = await this.data.repositories.outbox.claimDue(
        this.session.tripId,
        now,
        OUTBOX_BATCH_SIZE,
        this.session.localDeviceId,
        now + OUTBOX_LEASE_MS,
      );
      for (const record of records) {
        try {
          const envelope = await this.envelopeForOutbox(record);
          const targets = await this.targetsForOutbox(record);
          if (targets.length === 0) {
            await this.retryOutbox(record, 'NO_ADMITTED_PEER');
            continue;
          }
          for (const target of targets) await this.sendSecureControl(envelope, target);
          // A successful transport send is intentionally not delivery. The row
          // stays leased/in-flight until its protocol ACK arrives or the exact
          // lease-expiry wake makes it retryable.
        } catch (error) {
          const syncError = this.asSyncError(error, 'OUTBOX_SEND_FAILED', true);
          await this.retryOutbox(record, syncError.code);
          this.report(syncError);
        }
      }
    } finally {
      await this.scheduleNextOutboxWake();
    }
  }

  private async scheduleNextOutboxWake(): Promise<void> {
    this.clearOutboxWakeTimer();
    if (
      this.state !== 'running' ||
      this.transport.state.state !== 'connected' ||
      this.admittedDevices.size === 0
    ) return;
    const nextWakeAt = await this.data.repositories.outbox.getNextWakeAt(
      this.session.tripId,
    );
    if (nextWakeAt === null) return;
    const delay = Math.max(25, nextWakeAt - checkedNow(this.clock));
    this.outboxWakeTimer = setTimeout(() => {
      this.outboxWakeTimer = null;
      void this.flushOutbox().catch((error) => {
        this.report(this.asSyncError(error, 'OUTBOX_WAKE_FAILED', true));
      });
    }, delay);
  }

  private clearOutboxWakeTimer(): void {
    if (this.outboxWakeTimer !== null) clearTimeout(this.outboxWakeTimer);
    this.outboxWakeTimer = null;
  }

  private async retryOutbox(record: OutboxRecord, reason: string): Promise<void> {
    const now = checkedNow(this.clock);
    const indefinitelyRecoverable =
      reason === 'NO_ADMITTED_PEER' ||
      reason === 'TARGET_OFFLINE' ||
      reason === 'BACKPRESSURE' ||
      reason === 'TRANSPORT_BACKPRESSURE' ||
      reason === 'TRANSFER_LIMIT_REACHED' ||
      record.messageType === `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_REQUEST`;
    if (!indefinitelyRecoverable && record.attemptCount >= MAX_OUTBOX_ATTEMPTS) {
      await this.data.repositories.outbox.markDeadLetter(
        this.session.tripId,
        record.id,
        reason,
        now,
      );
      this.onEvent({ kind: 'outbox-changed', messageId: record.id, state: 'dead_letter' });
      this.report(
        new SyncEngineError('OUTBOX_DEAD_LETTER', `Message '${record.id}' exhausted retries.`, false, {
          messageId: record.id,
          reason,
        }),
      );
      return;
    }
    const delay = reason === 'TRANSFER_LIMIT_REACHED'
      ? Math.min(30_000, 2_000 * 2 ** Math.max(0, record.attemptCount - 1))
      : Math.min(60_000, 500 * 2 ** Math.max(0, record.attemptCount - 1));
    await this.data.repositories.outbox.reschedule(
      this.session.tripId,
      record.id,
      now + delay,
      reason,
      now,
    );
    this.onEvent({ kind: 'outbox-changed', messageId: record.id, state: 'pending' });
  }

  private async handleRecoverableTransportError(
    messageId: string,
    reason: string,
  ): Promise<void> {
    const pendingChunk = this.pendingChunkAcks.get(messageId);
    if (pendingChunk) {
      // Relay TARGET_OFFLINE/BACKPRESSURE is an authoritative negative send
      // result. Do not burn the full chunk ACK timeout before yielding the slot.
      this.rejectPendingChunkAck(messageId, pendingChunk, reason);
      return;
    }

    const record = await this.data.repositories.outbox
      .getById(this.session.tripId, messageId)
      .catch(() => null);
    if (!record || record.state === 'delivered' || record.state === 'dead_letter') return;
    await this.retryOutbox(record, reason);
    // Recomputes the durable wake from the new backoff instead of leaving this
    // row leased for OUTBOX_LEASE_MS after the relay already rejected it.
    await this.flushOutbox();
  }

  private async envelopeForOutbox(record: OutboxRecord): Promise<ProtocolEnvelope> {
    const messageId = assertParsed(parseMessageId(record.id));
    if (record.messageType === 'SYNC_OPERATION' || record.messageType === 'OPERATION') {
      const operation = parseOutboxOperation(record.payload);
      return this.createEnvelope(
        'OP_BATCH',
        {
          requestId: assertParsed(parseRequestId(this.ids.create('request', record.id))),
          batchSequence: 1,
          operations: [operation],
          senderHighWater: await this.localHighWater(),
          hasMore: false,
        },
        messageId,
      );
    }
    if (!record.messageType.startsWith(PROTOCOL_OUTBOX_PREFIX)) {
      throw new SyncEngineError(
        'UNSUPPORTED_OUTBOX_MESSAGE',
        `Unsupported outbox message type '${record.messageType}'.`,
        false,
      );
    }
    const type = record.messageType.slice(PROTOCOL_OUTBOX_PREFIX.length) as ProtocolMessageType;
    if (type === 'RESOURCE_CHUNK' || type === 'HELLO' || type === 'HEARTBEAT') {
      throw new SyncEngineError('INVALID_OUTBOX_MESSAGE', `${type} cannot use the durable control outbox.`, false);
    }
    return this.createEnvelope(type, record.payload, messageId);
  }

  private async targetsForOutbox(record: OutboxRecord): Promise<string[]> {
    if (record.recipientMemberId === null) return [...this.admittedDevices];
    const member = await this.data.repositories.members.getById(
      this.session.tripId,
      record.recipientMemberId,
    );
    return member && this.admittedDevices.has(member.deviceId) ? [member.deviceId] : [];
  }

  private async createEnvelope(
    type: ProtocolMessageType,
    payload: unknown,
    requestedMessageId?: MessageId,
  ): Promise<ProtocolEnvelope> {
    const counter = await this.wireCounter.next({
      tripId: this.session.tripId,
      senderDeviceId: this.session.localDeviceId,
      keyEpoch: this.session.key.keyEpoch,
    });
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      messageId:
        requestedMessageId ??
        assertParsed(parseMessageId(this.ids.create('message', String(counter), type))),
      tripId: this.session.tripId,
      senderMemberId: this.session.localMemberId,
      senderDeviceId: this.session.localDeviceId,
      // LocalSyncDriver pins the active trip key to this membership epoch before
      // constructing the engine. Avoid a SQLite trip lookup on every chunk.
      membershipEpoch: this.session.key.keyEpoch,
      senderMessageSequence: counter,
      sentAtMs: checkedNow(this.clock),
      type,
      payload,
    };
    return assertParsed(parseProtocolEnvelope(candidate));
  }

  private async sendSecureControl(envelope: ProtocolEnvelope, targetPeerId: string): Promise<void> {
    if (envelope.type === 'RESOURCE_CHUNK') {
      throw new SyncEngineError('BINARY_ON_CONTROL', 'Resource chunks require the binary channel.', false);
    }
    const plaintext = encodeControlEnvelopePlaintext(envelope);
    const frame = await this.crypto.seal({
      header: this.secureHeader(envelope.senderMessageSequence),
      plaintext,
      key: this.session.key,
    });
    const signedFrame = await signSecureFrame(
      frame,
      this.session.localIdentityPublicKey,
      this.identity,
    );
    const payload = serializeSignedSecureControlFrame(signedFrame);
    if (textEncoder.encode(JSON.stringify(payload)).byteLength > MAX_CONTROL_FRAME_BYTES) {
      throw new SyncEngineError('CONTROL_FRAME_TOO_LARGE', 'Encrypted control frame exceeds transport limit.', false);
    }
    this.transport.sendControl({
      messageId: envelope.messageId,
      type: SECURE_CONTROL_TRANSPORT_TYPE,
      payload,
      targetPeerId,
    });
  }

  private secureHeader(senderCounter: number): SecureFrameHeader {
    return {
      securityVersion: FRAME_SECURITY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId: this.session.tripId,
      senderDeviceId: this.session.localDeviceId,
      keyId: this.session.key.keyId,
      keyEpoch: this.session.key.keyEpoch,
      senderCounter,
      cipherSuite: this.session.key.cipherSuite,
    };
  }

  private async sendHello(targetPeerId: string): Promise<void> {
    if (!this.connectedPeerIds.has(targetPeerId)) return;
    const [member, highWater, availableStorageBytes] = await Promise.all([
      this.data.repositories.members.getById(this.session.tripId, this.session.localMemberId),
      this.shareableHighWater(targetPeerId),
      this.availableStorageBytes(),
    ]);
    if (!member) throw new SyncEngineError('LOCAL_MEMBER_NOT_FOUND', 'Local member is missing.', false);
    const envelope = await this.createEnvelope('HELLO', {
      memberId: this.session.localMemberId,
      deviceId: this.session.localDeviceId,
      displayName: member.displayName,
      identityPublicKey: member.identityPublicKey,
      admissionInviteLink: this.session.admissionInviteLink,
      supportedProtocolVersions: [PROTOCOL_VERSION],
      membershipEpoch: member.membershipEpoch,
      highWater,
      canStoreOriginals: this.canStoreOriginals(),
      availableStorageBytes,
      maxChunkBytes: SECURE_FILE_CHUNK_BYTES,
    });
    await this.sendSecureControl(envelope, targetPeerId);
  }

  private async sendHeartbeat(targetPeerId: string): Promise<void> {
    if (!this.admittedDevices.has(targetPeerId)) return;
    const envelope = await this.createEnvelope('HEARTBEAT', {
      highWater: await this.shareableHighWater(targetPeerId),
      peerState: 'READY',
      availableStorageBytes: await this.availableStorageBytes(),
      activeTransferCount: Math.min(
        MAX_ACTIVE_TRANSFERS,
        this.activeUploads.size + this.incomingReservations.size,
      ),
    });
    await this.sendSecureControl(envelope, targetPeerId);
  }

  private async handleInboundControl(message: InboundControlMessage): Promise<void> {
    if (
      message.sessionId !== this.session.tripId ||
      (message.targetPeerId !== null && message.targetPeerId !== this.session.localDeviceId)
    ) return;
    if (message.type !== SECURE_CONTROL_TRANSPORT_TYPE) {
      throw new SyncEngineError('PLAINTEXT_CONTROL_REJECTED', 'Only encrypted AirMesh control frames are accepted.', true);
    }
    const signedFrame = parseSerializedSignedSecureControlFrame(message.payload);
    const frame = signedFrame.frame;
    if (
      frame.tripId !== this.session.tripId ||
      frame.senderDeviceId !== message.senderPeerId ||
      frame.keyId !== this.session.key.keyId ||
      frame.keyEpoch !== this.session.key.keyEpoch
    ) {
      throw new SyncEngineError('SECURE_FRAME_CONTEXT_MISMATCH', 'Encrypted frame context does not match transport context.', true);
    }
    await this.requireAuthenticInboundFrame(signedFrame, message.senderPeerId, true);
    const plaintext = await this.crypto.open({ frame, key: this.session.key });
    const accepted = await this.replayGuard.accept({
      tripId: frame.tripId,
      senderDeviceId: frame.senderDeviceId,
      keyEpoch: frame.keyEpoch,
      senderCounter: frame.senderCounter,
    });
    if (!accepted) {
      throw new SyncEngineError('REPLAY_REJECTED', 'Repeated or stale secure frame was rejected.', true);
    }
    const envelope = decodeControlEnvelopePlaintext(plaintext);
    if (
      envelope.tripId !== this.session.tripId ||
      envelope.senderDeviceId !== message.senderPeerId ||
      envelope.messageId !== message.messageId ||
      envelope.senderMessageSequence !== frame.senderCounter
    ) {
      throw new SyncEngineError('ENVELOPE_CONTEXT_MISMATCH', 'Authenticated envelope does not match its transport frame.', true);
    }
    if (envelope.type === 'HELLO') {
      if (envelope.payload.identityPublicKey !== signedFrame.senderIdentityPublicKey) {
        throw new SyncEngineError(
          'HELLO_SIGNATURE_IDENTITY_MISMATCH',
          'HELLO identity does not match the signed frame identity.',
          false,
        );
      }
      await this.handleHello(envelope, message.senderPeerId);
      return;
    }
    await this.requireAdmittedEnvelope(envelope, message.senderPeerId);
    switch (envelope.type) {
      case 'SYNC_REQUEST':
        await this.handleSyncRequest(envelope, message.senderPeerId);
        return;
      case 'OP_BATCH':
        await this.handleOperationBatch(envelope, message.senderPeerId);
        return;
      case 'ACK':
        await this.handleAck(envelope.payload, message.senderPeerId);
        return;
      case 'RESOURCE_REQUEST':
        await this.handleResourceRequest(envelope, message.senderPeerId);
        return;
      case 'RESOURCE_OFFER':
        await this.handleResourceOffer(envelope, message.senderPeerId);
        return;
      case 'RESOURCE_COMPLETE':
        await this.handleResourceComplete(envelope, message.senderPeerId);
        return;
      case 'HEARTBEAT':
        {
          const availableStorageBytes = normalizeAvailableStorage(
            envelope.payload.availableStorageBytes,
          );
          const storageChanged =
            this.availableStorageBytesByDevice.get(message.senderPeerId) !==
            availableStorageBytes;
          this.availableStorageBytesByDevice.set(
            message.senderPeerId,
            availableStorageBytes,
          );
          if (
            computeMissingRanges(await this.localHighWater(), envelope.payload.highWater).length > 0
          ) {
            await this.sendSyncRequest(message.senderPeerId);
          }
          // Capacity changes can make a different deterministic original seed
          // eligible. The ordinary reconcile throttle coalesces simultaneous
          // heartbeats from a large room into one bounded pass.
          if (storageChanged) await this.reconcileUnavailableResources();
          return;
        }
      case 'RESOURCE_CHUNK':
        throw new SyncEngineError('BINARY_ON_CONTROL', 'Resource chunks are forbidden on control.', true);
    }
  }

  private async requireAdmittedEnvelope(
    envelope: ProtocolEnvelope,
    peerId: string,
  ): Promise<void> {
    if (!this.admittedDevices.has(peerId)) {
      throw new SyncEngineError('PEER_NOT_ADMITTED', 'Peer must complete HELLO admission first.', true);
    }
    const member = await this.data.repositories.members.getByDeviceId(this.session.tripId, peerId);
    const provisionalMemberId = this.memberIdByDevice.get(peerId);
    if (
      envelope.senderMemberId !== (member?.id ?? provisionalMemberId) ||
      (member && (member.status === 'LEFT' || member.status === 'REMOVED'))
    ) {
      throw new SyncEngineError('INVALID_PEER_MEMBERSHIP', 'Authenticated sender is not an active trip member.', true);
    }
  }

  /** Identity verification deliberately precedes AEAD open and replay mutation. */
  private async requireAuthenticInboundFrame(
    signedFrame: SignedSecureFrame,
    peerDeviceId: string,
    allowUnknownHelloCandidate: boolean,
  ): Promise<void> {
    if (!verifySignedSecureFrame(signedFrame, this.identity)) {
      throw new SyncEngineError(
        'FRAME_IDENTITY_SIGNATURE_INVALID',
        'Encrypted frame identity signature is invalid.',
        true,
      );
    }
    const member = await this.data.repositories.members.getByDeviceId(
      this.session.tripId,
      peerDeviceId,
    );
    const expectedPublicKey = member?.identityPublicKey ??
      (peerDeviceId === this.session.trustedCoordinatorDeviceId
        ? this.session.trustedCoordinatorIdentityPublicKey
        : null);
    if (expectedPublicKey !== null) {
      if (signedFrame.senderIdentityPublicKey !== expectedPublicKey) {
        throw new SyncEngineError(
          'FRAME_IDENTITY_MISMATCH',
          'Encrypted frame was not signed by the durable member identity.',
          true,
        );
      }
      return;
    }
    if (!allowUnknownHelloCandidate) {
      throw new SyncEngineError(
        'UNKNOWN_FRAME_IDENTITY',
        'Only a signed HELLO may introduce an unknown device identity.',
        true,
      );
    }
  }

  private async handleHello(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'HELLO' }>,
    peerId: string,
  ): Promise<void> {
    const hello = envelope.payload;
    const wasAdmitted = this.admittedDevices.has(peerId);
    if (hello.deviceId !== peerId || hello.memberId !== envelope.senderMemberId) {
      throw new SyncEngineError('HELLO_IDENTITY_MISMATCH', 'HELLO identity does not match the connection.', true);
    }
    const [trip, existing, members] = await Promise.all([
      this.data.repositories.trips.getById(this.session.tripId),
      this.data.repositories.members.getByDeviceId(this.session.tripId, hello.deviceId),
      this.data.repositories.members.listByTrip(this.session.tripId),
    ]);
    if (!trip) throw new SyncEngineError('TRIP_NOT_FOUND', 'Trip disappeared during admission.', false);
    const existingIsLive = existing?.status === 'ACTIVE' || existing?.status === 'LEAVING';
    if (existing?.status === 'REMOVED') {
      await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'MEMBER_REMOVED');
      return;
    }
    if (
      trip.status !== 'ACTIVE' &&
      trip.status !== 'DRAFT' &&
      !existingIsLive
    ) {
      await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'TRIP_CLOSED');
      return;
    }
    if (existingIsLive && existing) {
      if (
        existing.id !== hello.memberId ||
        existing.identityPublicKey !== hello.identityPublicKey
      ) {
        await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'IDENTITY_MISMATCH');
        return;
      }
    } else if (this.session.isCoordinator) {
      const activeCount = members.filter(
        (member) => member.status === 'ACTIVE' || member.status === 'LEAVING',
      ).length;
      if (activeCount >= MAX_TRIP_MEMBERS) {
        await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'TRIP_FULL');
        return;
      }
      if (!this.admission) {
        await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'ADMISSION_REQUIRED');
        return;
      }
      const decision = await this.admission.decide({
        hello,
        transportPeerId: peerId,
        trip,
        currentMembers: members,
        isCoordinator: true,
      });
      if (!decision.accepted) {
        await this.sendAck(envelope.messageId, peerId, 'REJECTED', decision.code);
        return;
      }
      await this.persistAdmission(decision, hello);
    } else if (peerId !== this.session.trustedCoordinatorDeviceId) {
      await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'UNTRUSTED_BOOTSTRAP_PEER');
      return;
    } else if (hello.memberId !== trip.createdByMemberId) {
      await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'COORDINATOR_MEMBER_MISMATCH');
      return;
    }
    // A non-coordinator may not yet have the coordinator catalog. Only the
    // coordinator device pinned by the authenticated invite may be admitted
    // provisionally; authoritative MEMBER_JOINED operations replace it.
    this.admittedDevices.add(peerId);
    this.memberIdByDevice.set(peerId, hello.memberId);
    this.canStoreOriginalsByDevice.set(peerId, hello.canStoreOriginals);
    this.availableStorageBytesByDevice.set(
      peerId,
      normalizeAvailableStorage(hello.availableStorageBytes),
    );
    this.onEvent({ kind: 'peer-admitted', memberId: hello.memberId, deviceId: peerId });
    await this.sendAck(envelope.messageId, peerId, 'ACCEPTED', null);
    if (!wasAdmitted && this.connectedPeerIds.has(peerId)) {
      // A late joiner's first HELLO can arrive before the coordinator's
      // authoritative MEMBER_JOINED operation. Once either side admits the
      // other, one reciprocal HELLO completes both directional admission
      // states without creating an endless HELLO echo.
      await this.sendHello(peerId);
    }
    await this.sendSyncRequest(peerId);
    if (computeMissingRanges(hello.highWater, await this.localHighWater()).length > 0) {
      await this.sendOperationsForHighWater(peerId, {
        requestId: assertParsed(parseRequestId(this.ids.create('request', envelope.messageId))),
        knownHighWater: hello.highWater,
        maxOperations: MAX_SYNC_OPERATIONS_PER_FRAME,
        includeCatalogSnapshot: false,
      });
    }
    await this.recoverTransfersForPeer(peerId);
    await this.reconcileUnavailableResources(true);
    await this.flushOutbox();
  }

  private async persistAdmission(decision: Extract<AdmissionDecision, { accepted: true }>, hello: HelloMessage): Promise<void> {
    const member = assertParsed(parseMember(decision.member));
    const operation = assertParsed(parseSyncOperation(decision.operation));
    if (
      operation.kind !== 'MEMBER_JOINED' ||
      member.id !== hello.memberId ||
      member.deviceId !== hello.deviceId ||
      member.identityPublicKey !== hello.identityPublicKey ||
      operation.payload.member.id !== member.id ||
      operation.originDeviceId !== this.session.localDeviceId ||
      operation.actorMemberId !== this.session.localMemberId ||
      !verifySyncOperation(
        operation,
        this.identity,
        this.session.localIdentityPublicKey,
      )
    ) {
      throw new SyncEngineError('INVALID_ADMISSION_DECISION', 'Admission controller returned inconsistent membership data.', false);
    }
    await this.withCatalogMutation(async () => {
      await this.refreshCatalogFromPersistence();
      const applied = applySyncOperations(this.catalogState, [operation]);
      if (applied.rejectedCount > 0) {
        throw new SyncEngineError('ADMISSION_OPERATION_REJECTED', 'Admission operation violates catalog invariants.', false);
      }
      const now = checkedNow(this.clock);
      await this.data.transaction(async (repositories) => {
        await repositories.members.upsert(toMemberRecord(member));
        await repositories.syncOperations.append(toOperationRecord(operation));
        await repositories.outbox.upsert(
          createOutboxRecord({
            id: this.ids.create('outbox', operation.operationId),
            tripId: this.session.tripId,
            recipientMemberId: null,
            messageType: 'SYNC_OPERATION',
            payload: operation as unknown as JsonValue,
            dedupeKey: `operation:${operation.operationId}`,
            now,
          }),
        );
      });
      this.catalogState = applied.state;
      this.onEvent({ kind: 'catalog-changed', source: 'admission', appliedOperationCount: 1 });
    });
  }

  private async sendSyncRequest(peerId: string): Promise<void> {
    const envelope = await this.createEnvelope('SYNC_REQUEST', {
      requestId: assertParsed(
        parseRequestId(this.ids.create('request', peerId, String(++this.localRequestNonce))),
      ),
      knownHighWater: await this.localHighWater(),
      maxOperations: MAX_SYNC_OPERATIONS_PER_FRAME,
      includeCatalogSnapshot: false,
    });
    await this.sendSecureControl(envelope, peerId);
  }

  private async handleSyncRequest(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'SYNC_REQUEST' }>,
    peerId: string,
  ): Promise<void> {
    await this.sendOperationsForHighWater(peerId, envelope.payload);
    await this.sendAck(envelope.messageId, peerId, 'ACCEPTED', null);
  }

  private async sendOperationsForHighWater(
    peerId: string,
    request: SyncRequestMessage,
  ): Promise<void> {
    const local = await this.shareableHighWater(peerId);
    const ranges = computeMissingRanges(request.knownHighWater, local);
    // Every member identity is introduced by a coordinator-signed MEMBER_JOINED
    // operation. Bring that origin fully current before relaying member-authored
    // history so a fresh device never receives an unverifiable dependency first.
    const coordinatorRange = ranges.find(
      (range) => range.originDeviceId === this.session.trustedCoordinatorDeviceId,
    );
    const eligibleRanges = coordinatorRange ? [coordinatorRange] : ranges;
    const selected: SyncOperation[] = [];
    const limit = Math.min(request.maxOperations, MAX_SYNC_OPERATIONS_PER_FRAME);
    let hasMore = false;
    for (const range of eligibleRanges) {
      if (selected.length >= limit) {
        hasMore = true;
        break;
      }
      const records = await this.data.repositories.syncOperations.listRange(
        this.session.tripId,
        range.originDeviceId,
        range.fromSequenceInclusive - 1,
        range.toSequenceInclusive,
        limit - selected.length + 1,
      );
      for (const record of records) {
        if (selected.length === limit) {
          hasMore = true;
          break;
        }
        selected.push(parseOperationRecord(record));
      }
      if (hasMore) break;
    }
    selected.sort(operationHydrationOrder);
    const response = await this.createEnvelope('OP_BATCH', {
      requestId: request.requestId,
      batchSequence: 1,
      operations: selected,
      senderHighWater: local,
      hasMore,
    });
    await this.sendSecureControl(response, peerId);
  }

  private async handleOperationBatch(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'OP_BATCH' }>,
    peerId: string,
  ): Promise<void> {
    if (!(await this.areOperationOriginsAuthorized(envelope.payload.operations, peerId))) {
      await this.sendAck(envelope.messageId, peerId, 'REJECTED', 'OPERATION_SIGNATURE_INVALID');
      return;
    }
    let rejectionCode: string | null = null;
    let appliedCount = 0;
    await this.withCatalogMutation(async () => {
      await this.refreshCatalogFromPersistence();
      const applied = applySyncOperations(this.catalogState, envelope.payload.operations);
      const rejection = applied.results.find((entry) => entry.disposition === 'REJECTED');
      if (rejection) {
        rejectionCode = rejection.issues[0]?.code ?? 'OPERATION_REJECTED';
        return;
      }
      await this.data.transaction(async (repositories) => {
        for (const [index, operation] of envelope.payload.operations.entries()) {
          if (applied.results[index]?.disposition !== 'APPLIED') continue;
          await repositories.syncOperations.append(toOperationRecord(operation));
          await this.persistOperationEntities(repositories, applied.state, operation);
        }
      });
      this.catalogState = applied.state;
      appliedCount = applied.appliedCount;
      if (appliedCount > 0) {
        this.onEvent({ kind: 'catalog-changed', source: 'inbound', appliedOperationCount: appliedCount });
      }
    });
    if (rejectionCode) {
      await this.sendAck(envelope.messageId, peerId, 'REJECTED', rejectionCode);
      return;
    }
    await this.sendAck(
      envelope.messageId,
      peerId,
      appliedCount === 0 ? 'DUPLICATE' : 'ACCEPTED',
      null,
    );
    await this.rehandshakeJoinedMembers(envelope.payload.operations);
    await this.requestPublishedResources(envelope.payload.operations, peerId);
    await this.reconcileUnavailableResources(true);
    const stillMissing = computeMissingRanges(
      await this.localHighWater(),
      envelope.payload.senderHighWater,
    ).length > 0;
    if (envelope.payload.hasMore || stillMissing) await this.sendSyncRequest(peerId);
  }

  private async rehandshakeJoinedMembers(operations: readonly SyncOperation[]): Promise<void> {
    const candidates = new Set<string>();
    for (const operation of operations) {
      if (
        operation.kind === 'MEMBER_JOINED' &&
        operation.payload.member.deviceId !== this.session.localDeviceId &&
        this.connectedPeerIds.has(operation.payload.member.deviceId) &&
        !this.admittedDevices.has(operation.payload.member.deviceId)
      ) {
        candidates.add(operation.payload.member.deviceId);
      }
    }
    await Promise.all([...candidates].map((peerId) => this.sendHello(peerId)));
  }

  private async areOperationOriginsAuthorized(
    operations: readonly SyncOperation[],
    _peerId: string,
  ): Promise<boolean> {
    const members = await this.data.repositories.members.listByTrip(this.session.tripId);
    const identityByDevice = new Map(
      members.map((member) => [member.deviceId, member.identityPublicKey] as const),
    );
    identityByDevice.set(
      this.session.trustedCoordinatorDeviceId,
      this.session.trustedCoordinatorIdentityPublicKey,
    );
    for (const operation of [...operations].sort(operationHydrationOrder)) {
      const expectedPublicKey = identityByDevice.get(operation.originDeviceId);
      if (
        expectedPublicKey === undefined ||
        !verifySyncOperation(operation, this.identity, expectedPublicKey)
      ) {
        return false;
      }
      if (operation.kind === 'MEMBER_JOINED') {
        const member = operation.payload.member;
        const existing = identityByDevice.get(member.deviceId);
        if (existing !== undefined && existing !== member.identityPublicKey) return false;
        identityByDevice.set(member.deviceId, member.identityPublicKey);
      }
    }
    return true;
  }

  private async persistOperationEntities(
    repositories: AirMeshRepositories,
    state: CatalogState,
    operation: SyncOperation,
  ): Promise<void> {
    switch (operation.kind) {
      case 'TRIP_CREATED':
      case 'TRIP_STATUS_CHANGED': {
        const trip = state.trips.get(operation.payload.trip.id);
        if (!trip) return;
        const existing = await repositories.trips.getById(trip.id);
        await repositories.trips.upsert(toTripRecord(trip, existing));
        return;
      }
      case 'MEMBER_JOINED':
      case 'MEMBER_STATUS_CHANGED': {
        const member = state.members.get(operation.payload.member.id);
        if (member) await repositories.members.upsert(toMemberRecord(member));
        return;
      }
      case 'MEDIA_PREVIEW_PUBLISHED':
      case 'MEDIA_PUBLISHED': {
        const item = state.mediaItems.get(operation.payload.item.id);
        if (!item) return;
        const existingMedia = await repositories.media.getById(item.tripId, item.id);
        await repositories.media.upsert(toMediaRecord(item, existingMedia?.sourceAssetId ?? null));
        for (const manifest of operation.payload.resources) {
          const effective = state.resources.get(manifest.id);
          if (!effective) continue;
          const existing = await repositories.resources.getById(effective.tripId, effective.id);
          await repositories.resources.upsert(toResourceRecord(effective, existing));
        }
        return;
      }
      case 'MEDIA_ORIGINAL_PUBLISHED': {
        const manifest = state.resources.get(operation.payload.resource.id);
        if (!manifest) return;
        const existing = await repositories.resources.getById(manifest.tripId, manifest.id);
        await repositories.resources.upsert(toResourceRecord(manifest, existing));
        return;
      }
      case 'MEDIA_TOMBSTONED': {
        const item = state.mediaItems.get(operation.payload.mediaId);
        if (!item) return;
        const existing = await repositories.media.getById(item.tripId, item.id);
        await repositories.media.upsert(toMediaRecord(item, existing?.sourceAssetId ?? null));
        return;
      }
      case 'REPLICA_RECORDED':
      case 'REPLICA_STATUS_CHANGED': {
        const receipt = state.replicaReceipts.get(operation.payload.receipt.id);
        if (receipt) await repositories.replicaReceipts.upsert(toReplicaReceiptRecord(receipt));
      }
    }
  }

  private async requestPublishedResources(
    operations: readonly SyncOperation[],
    peerDeviceId: string,
  ): Promise<void> {
    const demandUsage = await this.currentDownloadDemandUsage();
    const published = operations.filter(
      (operation): operation is Extract<
        SyncOperation,
        { readonly kind: 'MEDIA_PREVIEW_PUBLISHED' | 'MEDIA_PUBLISHED' }
      > =>
        operation.kind === 'MEDIA_PREVIEW_PUBLISHED' || operation.kind === 'MEDIA_PUBLISHED',
    );
    const candidates: {
      readonly operation: Extract<
        SyncOperation,
        { readonly kind: 'MEDIA_PREVIEW_PUBLISHED' | 'MEDIA_PUBLISHED' }
      >;
      readonly resource: ResourceRecord;
      readonly priority: ResourcePriority;
    }[] = [];
    // Collect every thumbnail before originals so a large operation batch can
    // never hide previews behind background downloads.
    for (const operation of published) {
      if (!operation.payload.item.thumbnailResourceId) continue;
      const thumbnail = await this.data.repositories.resources.getById(
        this.session.tripId,
        operation.payload.item.thumbnailResourceId,
      );
      if (thumbnail && thumbnail.availability !== 'available') {
        candidates.push({ operation, resource: thumbnail, priority: 'THUMBNAIL' });
      }
    }
    for (const operation of published) {
      if (!this.canStoreOriginals()) break;
      if (operation.payload.item.originDeviceId === this.session.localDeviceId) continue;
      const original = await this.data.repositories.resources.getById(
        this.session.tripId,
        operation.payload.item.originalResourceId,
      );
      if (original && original.availability !== 'available') {
        candidates.push({ operation, resource: original, priority: 'BACKGROUND_ORIGINAL' });
      }
    }
    for (const candidate of candidates) {
      if (this.availableAutomaticDownloadSlots(candidate.priority, demandUsage) <= 0) continue;
      let source = peerDeviceId;
      try {
        source = await this.resolvePublishedResourcePeer(
          candidate.operation,
          candidate.resource,
          peerDeviceId,
        );
        if (
          candidate.priority === 'BACKGROUND_ORIGINAL' &&
          !(await this.shouldAutomaticallyRequestOriginal(
            candidate.resource,
            candidate.operation.payload.item.originDeviceId,
          ))
        ) continue;
        if (await this.queueResourceRequest(candidate.resource, source, candidate.priority)) {
          recordDownloadDemand(demandUsage, candidate.priority);
        }
      } catch (error) {
        if (candidate.priority === 'THUMBNAIL') {
          this.report(this.asSyncError(error, 'THUMBNAIL_REQUEST_FAILED', true));
          continue;
        }
        try {
          const fallback = await this.resolveVerifiedResourcePeer(candidate.resource, source);
          if (await this.queueResourceRequest(candidate.resource, fallback, candidate.priority)) {
            recordDownloadDemand(demandUsage, candidate.priority);
          }
        } catch (fallbackError) {
          this.report(this.asSyncError(fallbackError, 'ORIGINAL_REQUEST_FAILED', true));
        }
      }
    }
    await this.flushOutbox();
  }

  private async currentDownloadDemandUsage(
    active?: readonly TransferRecord[],
  ): Promise<DownloadDemandUsage> {
    const transfers = active ??
      await this.data.repositories.transfers.listActive(this.session.tripId);
    return this.summarizeDownloadDemand(transfers.filter(
      (transfer) =>
        transfer.direction === 'download' &&
        (transfer.state === 'queued' ||
          transfer.state === 'transferring' ||
          transfer.state === 'verifying' ||
          (transfer.state === 'paused' && this.recoveryRequestedOffsets.has(transfer.id))),
    ));
  }

  private async summarizeDownloadDemand(
    transfers: readonly TransferRecord[],
  ): Promise<DownloadDemandUsage> {
    const usage: DownloadDemandUsage = {
      thumbnails: 0,
      userVisibleOriginals: 0,
      backgroundOriginals: 0,
    };
    const priorities = await Promise.all(
      transfers.map(async (transfer) => {
        const tracked = this.downloadPriorities.get(transfer.id);
        if (tracked) return tracked;
        const durableRequest = await this.data.repositories.outbox.getById(
          this.session.tripId,
          this.ids.create('message', transfer.id),
        );
        if (
          durableRequest?.messageType ===
          `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_REQUEST`
        ) {
          const parsedRequest = parseResourceRequestMessage(durableRequest.payload);
          if (parsedRequest.ok) {
            this.downloadPriorities.set(transfer.id, parsedRequest.value.priority);
            return parsedRequest.value.priority;
          }
        }
        const resource = await this.data.repositories.resources.getById(
          this.session.tripId,
          transfer.resourceId,
        );
        // An unknown persisted resource is treated conservatively as an
        // original until its manifest is recovered.
        return resource ? resourcePriority(resource) : 'BACKGROUND_ORIGINAL';
      }),
    );
    for (const priority of priorities) recordDownloadDemand(usage, priority);
    return usage;
  }

  private availableAutomaticDownloadSlots(
    priority: ResourcePriority,
    usage: DownloadDemandUsage,
  ): number {
    const originals = usage.userVisibleOriginals + usage.backgroundOriginals;
    const total = usage.thumbnails + originals;
    if (priority === 'THUMBNAIL') {
      // Only two original demands can consume active lanes, so extra explicit
      // original requests must never prevent a later thumbnail from queuing.
      return Math.max(
        0,
        MAX_CONCURRENT_DOWNLOADS -
          usage.thumbnails -
          Math.min(originals, MAX_CONCURRENT_ORIGINAL_DOWNLOADS),
      );
    }
    if (priority === 'BACKGROUND_ORIGINAL') {
      return Math.max(
        0,
        Math.min(
          MAX_CONCURRENT_BACKGROUND_ORIGINAL_DOWNLOADS - usage.backgroundOriginals,
          MAX_CONCURRENT_DOWNLOADS - total,
        ),
      );
    }
    return Math.max(
      0,
      Math.min(
        MAX_CONCURRENT_ORIGINAL_DOWNLOADS - originals,
        MAX_CONCURRENT_DOWNLOADS - total,
      ),
    );
  }

  private async sendAck(
    acknowledgedMessageId: MessageId,
    peerId: string,
    status: AckMessage['status'],
    errorCode: string | null,
  ): Promise<void> {
    const envelope = await this.createEnvelope('ACK', {
      acknowledgedMessageId,
      status,
      highWater: await this.shareableHighWater(peerId),
      errorCode,
    });
    await this.sendSecureControl(envelope, peerId);
  }

  private async handleAck(payload: AckMessage, peerId: string): Promise<void> {
    const chunkAck = this.pendingChunkAcks.get(payload.acknowledgedMessageId);
    if (chunkAck) {
      if (chunkAck.peerDeviceId !== peerId) {
        throw new SyncEngineError(
          'ACK_PEER_MISMATCH',
          'Resource chunk ACK came from a different peer.',
          true,
          { messageId: payload.acknowledgedMessageId, peerId },
        );
      }
      this.pendingChunkAcks.delete(payload.acknowledgedMessageId);
      clearTimeout(chunkAck.timer);
      if (payload.status === 'REJECTED') {
        chunkAck.reject(
          new SyncEngineError(
            payload.errorCode ?? 'REMOTE_CHUNK_REJECTED',
            `Peer rejected chunk '${payload.acknowledgedMessageId}'.`,
            true,
          ),
        );
      } else {
        chunkAck.resolve();
      }
      return;
    }
    const record = await this.data.repositories.outbox.getById(
      this.session.tripId,
      payload.acknowledgedMessageId,
    );
    if (!record || record.state === 'delivered' || record.state === 'dead_letter') return;
    if (record.recipientMemberId !== null) {
      const intendedRecipient = await this.data.repositories.members.getById(
        this.session.tripId,
        record.recipientMemberId,
      );
      if (!intendedRecipient || intendedRecipient.deviceId !== peerId) {
        throw new SyncEngineError(
          'ACK_PEER_MISMATCH',
          'Targeted message ACK came from a different peer.',
          true,
          { messageId: record.id, peerId },
        );
      }
    }
    if (payload.status === 'REJECTED') {
      await this.retryOutbox(record, payload.errorCode ?? 'REMOTE_REJECTED');
      await this.scheduleNextOutboxWake();
      return;
    }
    await this.data.repositories.outbox.markDelivered(
      this.session.tripId,
      record.id,
      checkedNow(this.clock),
    );
    this.onEvent({ kind: 'outbox-changed', messageId: record.id, state: 'delivered' });
    await this.scheduleNextOutboxWake();
    if (record.messageType === `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_OFFER`) {
      const transferId = acceptedOfferTransferId(record.payload);
      if (transferId) {
        this.startUpload(
          transferId,
          peerId,
          this.uploadPriorities.get(transferId) ?? 'BACKGROUND_ORIGINAL',
        );
      }
    }
  }

  private async localHighWater(): Promise<HighWaterVector> {
    return this.data.repositories.syncOperations.getContiguousHighWaterMarks(this.session.tripId);
  }

  private async shareableHighWater(_peerId: string): Promise<HighWaterVector> {
    return this.localHighWater();
  }

  private async withCatalogMutation<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.catalogMutationChain;
    let release!: () => void;
    this.catalogMutationChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /** Must run under withCatalogMutation. Persistence is the local source of truth. */
  private async refreshCatalogFromPersistence(): Promise<void> {
    const persistedHighWater = await this.localHighWater();
    const operations: SyncOperation[] = [];
    for (const [rawDeviceId, throughSequence] of Object.entries(persistedHighWater)) {
      const deviceId = assertParsed(parseDeviceId(rawDeviceId));
      let afterSequence = this.catalogState.highWater.get(deviceId) ?? 0;
      while (afterSequence < throughSequence) {
        const records = await this.data.repositories.syncOperations.listRange(
          this.session.tripId,
          deviceId,
          afterSequence,
          throughSequence,
          MAX_OPERATION_BATCH_SIZE,
        );
        if (records.length === 0) {
          throw new SyncEngineError(
            'LOCAL_OPERATION_GAP',
            'Persistent high-water mark references operations that cannot be loaded.',
            false,
            { deviceId, afterSequence, throughSequence },
          );
        }
        for (const record of records) operations.push(parseOperationRecord(record));
        const next = records.at(-1)!.originSequence;
        if (next <= afterSequence) {
          throw new SyncEngineError('LOCAL_OPERATION_ORDER_INVALID', 'Operation repository did not advance.', false);
        }
        afterSequence = next;
      }
    }
    if (operations.length === 0) return;
    operations.sort(operationHydrationOrder);
    if (!(await this.areOperationOriginsAuthorized(operations, this.session.localDeviceId))) {
      throw new SyncEngineError(
        'INVALID_LOCAL_OPERATION_SIGNATURE',
        'New local operation history contains an unsigned operation or an invalid origin signature.',
        false,
      );
    }
    const applied = applySyncOperations(this.catalogState, operations);
    const rejection = applied.results.find((entry) => entry.disposition === 'REJECTED');
    if (rejection) {
      throw new SyncEngineError(
        'INVALID_LOCAL_OPERATION_LOG',
        `New local operation violates core invariants: ${rejection.issues
          .map((entry) => entry.code)
          .join(', ')}.`,
        false,
      );
    }
    this.catalogState = applied.state;
    if (applied.appliedCount > 0) {
      this.onEvent({
        kind: 'catalog-changed',
        source: 'local-refresh',
        appliedOperationCount: applied.appliedCount,
      });
    }
  }

  private async resolveResourcePeer(
    resource: ResourceRecord,
    preferredPeerDeviceId?: string,
    knownOriginDeviceId?: string,
  ): Promise<string> {
    if (preferredPeerDeviceId) {
      if (!this.admittedDevices.has(preferredPeerDeviceId)) {
        throw new SyncEngineError('PREFERRED_PEER_UNAVAILABLE', 'Preferred peer is not connected and admitted.', true);
      }
      return preferredPeerDeviceId;
    }
    const receipts = await this.data.repositories.replicaReceipts.listByResource(
      this.session.tripId,
      resource.id,
    );
    const verifiedHolders = receipts
      .filter(
        (receipt) =>
          receipt.status === 'VERIFIED' &&
          this.admittedDevices.has(receipt.holderDeviceId) &&
          !this.isResourcePeerCoolingDown(resource.id, receipt.holderDeviceId),
      )
      .map((receipt) => receipt.holderDeviceId);
    const selectedHolder = selectRendezvousPeer(
      resource.id,
      this.session.localDeviceId,
      verifiedHolders,
    );
    if (selectedHolder) return selectedHolder;
    const media = knownOriginDeviceId
      ? { originDeviceId: knownOriginDeviceId }
      : await this.data.repositories.media.getById(this.session.tripId, resource.mediaId);
    if (
      media &&
      this.admittedDevices.has(media.originDeviceId) &&
      !this.isResourcePeerCoolingDown(resource.id, media.originDeviceId)
    ) return media.originDeviceId;
    throw new SyncEngineError(
      'RESOURCE_PEER_UNAVAILABLE',
      'No admitted origin or verified holder can provide this resource.',
      true,
    );
  }

  private async resolvePublishedResourcePeer(
    operation: Extract<
      SyncOperation,
      { readonly kind: 'MEDIA_PREVIEW_PUBLISHED' | 'MEDIA_PUBLISHED' }
    >,
    resource: ResourceRecord,
    _batchPeerDeviceId: string,
  ): Promise<string> {
    return this.resolveResourcePeer(
      resource,
      undefined,
      operation.payload.item.originDeviceId,
    );
  }

  private async shouldAutomaticallyRequestOriginal(
    resource: ResourceRecord,
    knownOriginDeviceId?: string,
  ): Promise<boolean> {
    if (resource.kind !== 'ORIGINAL' || !this.canStoreOriginals()) return false;
    const media = knownOriginDeviceId
      ? { originDeviceId: knownOriginDeviceId }
      : await this.data.repositories.media.getById(
          this.session.tripId,
          resource.mediaId,
        );
    if (!media || media.originDeviceId === this.session.localDeviceId) return false;
    const localAvailableStorageBytes = normalizeAvailableStorage(
      await this.availableStorageBytes(),
    );
    const eligible = [
      ...(hasOriginalStorageCapacity(localAvailableStorageBytes, resource.byteLength)
        ? [this.session.localDeviceId]
        : []),
      ...[...this.admittedDevices].filter(
        (deviceId) =>
          this.canStoreOriginalsByDevice.get(deviceId) === true &&
          hasOriginalStorageCapacity(
            this.availableStorageBytesByDevice.get(deviceId) ?? 0,
            resource.byteLength,
          ),
      ),
    ].filter((deviceId) => deviceId !== media.originDeviceId);
    const uniqueEligible = [...new Set(eligible)];
    const requiredSeeds = Math.min(ORIGINAL_SEED_RECIPIENTS, uniqueEligible.length);
    if (requiredSeeds === 0) return false;
    const receipts = await this.data.repositories.replicaReceipts.listByResource(
      this.session.tripId,
      resource.id,
    );
    const liveSecondaryHolders = new Set(
      receipts
        .filter(
          (receipt) =>
            receipt.status === 'VERIFIED' &&
            receipt.holderDeviceId !== media.originDeviceId &&
            (receipt.holderDeviceId === this.session.localDeviceId ||
              this.admittedDevices.has(receipt.holderDeviceId)),
        )
        .map((receipt) => receipt.holderDeviceId),
    );
    if (liveSecondaryHolders.size >= requiredSeeds) return true;
    const seedRecipients = uniqueEligible
      .map((deviceId) => ({
        deviceId,
        score: sha256Hex(
          textEncoder.encode(`seed\u0000${resource.id}\u0000${deviceId}`),
        ),
      }))
      .sort(
        (left, right) =>
          right.score.localeCompare(left.score) || left.deviceId.localeCompare(right.deviceId),
      )
      .slice(0, requiredSeeds)
      .map((candidate) => candidate.deviceId);
    return seedRecipients.includes(this.session.localDeviceId);
  }

  private async resolveVerifiedResourcePeer(
    resource: ResourceRecord,
    excludedDeviceId: string,
  ): Promise<string> {
    const receipts = await this.data.repositories.replicaReceipts.listByResource(
      this.session.tripId,
      resource.id,
    );
    const verifiedHolders = receipts
      .filter(
        (receipt) =>
          receipt.status === 'VERIFIED' &&
          receipt.holderDeviceId !== excludedDeviceId &&
          this.admittedDevices.has(receipt.holderDeviceId) &&
          !this.isResourcePeerCoolingDown(resource.id, receipt.holderDeviceId),
      )
      .map((receipt) => receipt.holderDeviceId);
    const selectedHolder = selectRendezvousPeer(
      resource.id,
      this.session.localDeviceId,
      verifiedHolders,
    );
    if (selectedHolder) return selectedHolder;
    const media = await this.data.repositories.media.getById(this.session.tripId, resource.mediaId);
    if (
      media &&
      media.originDeviceId !== excludedDeviceId &&
      this.admittedDevices.has(media.originDeviceId) &&
      !this.isResourcePeerCoolingDown(resource.id, media.originDeviceId)
    ) {
      return media.originDeviceId;
    }
    throw new SyncEngineError(
      'RESOURCE_FALLBACK_UNAVAILABLE',
      'No other verified holder is available for this resource.',
      true,
    );
  }

  private reconcileUnavailableResources(force = false): Promise<void> {
    if (this.resourceReconcilePromise) return this.resourceReconcilePromise;
    const now = checkedNow(this.clock);
    if (
      !force &&
      now - this.lastResourceReconcileAtMs < RESOURCE_RECONCILE_INTERVAL_MS
    ) return Promise.resolve();
    this.lastResourceReconcileAtMs = now;
    const task = this.reconcileUnavailableResourcesInternal(now).finally(() => {
      if (this.resourceReconcilePromise === task) this.resourceReconcilePromise = null;
    });
    this.resourceReconcilePromise = task;
    return task;
  }

  private async reconcileUnavailableResourcesInternal(now: number): Promise<void> {
    if (
      (this.state !== 'running' && this.state !== 'starting') ||
      this.admittedDevices.size === 0
    ) return;
    const [resources, active] = await Promise.all([
      this.listNextUnavailableResources(),
      this.data.repositories.transfers.listActive(this.session.tripId),
    ]);
    const demandUsage = await this.currentDownloadDemandUsage(active);
    let outboxChanged = false;
    for (const resource of resources) {
      const priority = resourcePriority(resource);
      if ((this.resourceRetryAfterMs.get(resource.id) ?? 0) > now) continue;
      if (
        resource.kind === 'ORIGINAL' &&
        !(await this.shouldAutomaticallyRequestOriginal(resource))
      ) continue;
      const attempts = active.filter(
        (transfer) => transfer.direction === 'download' && transfer.resourceId === resource.id,
      );
      const inactiveAttemptIds = new Set<string>();
      try {
        let locallyAvailable = false;
        for (const transfer of attempts) {
          if (
            transfer.bytesTransferred === transfer.totalBytes &&
            (transfer.state === 'verifying' || transfer.state === 'paused')
          ) {
            await this.ensureDownloadFinalized(
              transfer,
              `resource-reconcile:${transfer.id}:${transfer.bytesTransferred}`,
            );
            const refreshed = await this.data.repositories.resources.getById(
              this.session.tripId,
              resource.id,
            );
            if (refreshed?.availability === 'available' && refreshed.localUri) {
              locallyAvailable = true;
              break;
            }
            inactiveAttemptIds.add(transfer.id);
          }
          if (transfer.state === 'transferring') {
            this.armDownloadInactivityWatchdog(transfer.id, false);
          }
        }
        if (locallyAvailable) continue;

        const peerDeviceId = await this.resolveResourcePeer(resource);
        const peer = await this.data.repositories.members.getByDeviceId(
          this.session.tripId,
          peerDeviceId,
        );
        if (!peer) throw new SyncEngineError('RESOURCE_PEER_UNKNOWN', 'Resource peer is unknown.', true);
        const existing = attempts.find(
          (transfer) =>
            !inactiveAttemptIds.has(transfer.id) && transfer.peerMemberId === peer.id,
        );
        if (existing) {
          if (existing.state === 'paused') {
            if (this.availableAutomaticDownloadSlots(priority, demandUsage) <= 0) continue;
            const reconciled = await this.reconcileDownloadCheckpoint(
              existing,
              'RESOURCE_RECONCILE',
            );
            if (reconciled.state === 'failed') {
              this.scheduleResourceRetry(resource.id);
              continue;
            }
            if (reconciled.bytesTransferred === reconciled.totalBytes) {
              await this.ensureDownloadFinalized(
                reconciled,
                `resource-reconcile:${reconciled.id}:${reconciled.bytesTransferred}`,
              );
            } else {
              if (await this.queueResumeRequest(
                reconciled,
                resource,
                peer,
                this.downloadPriorities.get(reconciled.id) ?? priority,
              )) {
                outboxChanged = true;
                recordDownloadDemand(demandUsage, priority);
              }
            }
          } else if (
            existing.state === 'queued' &&
            now - existing.updatedAt >= QUEUED_TRANSFER_REOFFER_MS
          ) {
            const existingPriority =
              this.downloadPriorities.get(existing.id) ?? priority;
            if (
              this.availableAutomaticDownloadSlots(
                existingPriority,
                withoutDownloadDemand(demandUsage, existingPriority),
              ) <= 0
            ) continue;
            if (await this.queueResumeRequest(
              existing,
              resource,
              peer,
              existingPriority,
            )) outboxChanged = true;
          }
          this.clearResourceRetry(resource.id);
          continue;
        }
        if (
          attempts.some(
            (transfer) =>
              !inactiveAttemptIds.has(transfer.id) &&
              (transfer.state === 'transferring' || transfer.state === 'verifying'),
          )
        ) continue;
        if (this.availableAutomaticDownloadSlots(priority, demandUsage) <= 0) continue;
        if (await this.queueResourceRequest(resource, peerDeviceId, priority)) {
          outboxChanged = true;
          recordDownloadDemand(demandUsage, priority);
        }
        this.clearResourceRetry(resource.id);
      } catch (error) {
        this.scheduleResourceRetry(resource.id);
        this.report(this.asSyncError(error, 'RESOURCE_RECONCILE_FAILED', true));
      }
    }
    // Reconciliation runs from timers, receipt convergence, and peer recovery.
    // None of those paths is guaranteed to perform another outbox flush, so a
    // newly durable request must install its send/lease wake before returning.
    // Batch the kick once per bounded reconciliation pass rather than once per
    // resource.
    if (outboxChanged) await this.flushOutbox();
  }

  private async listNextUnavailableResources(): Promise<ResourceRecord[]> {
    let resources = this.unavailableResourceCursor
      ? await this.data.repositories.resources.listUnavailable(
          this.session.tripId,
          MAX_RESOURCES_PER_RECONCILE,
          this.unavailableResourceCursor,
        )
      : await this.data.repositories.resources.listUnavailable(
          this.session.tripId,
          MAX_RESOURCES_PER_RECONCILE,
        );
    if (resources.length === 0 && this.unavailableResourceCursor) {
      // Keyset scans wrap, so permanently unavailable early rows cannot pin
      // every pass while newer photos wait forever behind the fixed limit.
      this.unavailableResourceCursor = null;
      resources = await this.data.repositories.resources.listUnavailable(
        this.session.tripId,
        MAX_RESOURCES_PER_RECONCILE,
      );
    }
    const last = resources.at(-1);
    this.unavailableResourceCursor =
      resources.length === MAX_RESOURCES_PER_RECONCILE && last
        ? { kind: last.kind, createdAtMs: last.createdAtMs, id: last.id }
        : null;
    return resources;
  }

  private scheduleResourceRetry(resourceId: string): void {
    const attempt = (this.resourceRetryCounts.get(resourceId) ?? 0) + 1;
    this.resourceRetryCounts.set(resourceId, attempt);
    const delay = Math.min(60_000, RESOURCE_RETRY_BASE_MS * 2 ** Math.min(5, attempt - 1));
    this.resourceRetryAfterMs.set(resourceId, checkedNow(this.clock) + delay);
  }

  private clearResourceRetry(resourceId: string): void {
    this.resourceRetryAfterMs.delete(resourceId);
    this.resourceRetryCounts.delete(resourceId);
  }

  private coolDownResourcePeer(resourceId: string, peerDeviceId: string): void {
    const peers = this.resourcePeerCooldownUntilMs.get(resourceId) ?? new Map<string, number>();
    peers.set(peerDeviceId, checkedNow(this.clock) + RESOURCE_PEER_COOLDOWN_MS);
    this.resourcePeerCooldownUntilMs.set(resourceId, peers);
  }

  private isResourcePeerCoolingDown(resourceId: string, peerDeviceId: string): boolean {
    const peers = this.resourcePeerCooldownUntilMs.get(resourceId);
    if (!peers) return false;
    const until = peers.get(peerDeviceId) ?? 0;
    if (until <= checkedNow(this.clock)) {
      peers.delete(peerDeviceId);
      if (peers.size === 0) this.resourcePeerCooldownUntilMs.delete(resourceId);
      return false;
    }
    return true;
  }

  private async reconcileRecoverableTransfers(): Promise<void> {
    const active = await this.data.repositories.transfers.listActive(this.session.tripId);
    const prioritized = [...active].sort((left, right) => {
      const rank = (transfer: TransferRecord): number =>
        transfer.direction === 'download' && transfer.bytesTransferred === transfer.totalBytes
          ? 0
          : transfer.direction === 'download'
            ? 1
            : 2;
      return rank(left) - rank(right) || left.updatedAt - right.updatedAt;
    });
    for (const [index, transfer] of prioritized.entries()) {
      try {
        if (transfer.direction === 'download') {
          const reconciled = await this.reconcileDownloadCheckpoint(transfer, 'ENGINE_RESTARTED');
          if (
            reconciled.state === 'verifying' &&
            reconciled.bytesTransferred === reconciled.totalBytes
          ) {
            await this.ensureDownloadFinalized(
              reconciled,
              `restart:${reconciled.id}:${reconciled.bytesTransferred}`,
            );
          }
        } else {
          await this.data.repositories.transfers.markPaused(
            this.session.tripId,
            transfer.id,
            'ENGINE_RESTARTED',
            checkedNow(this.clock),
          );
          this.emitTransferProgress({ ...transfer, state: 'paused' });
        }
      } catch (error) {
        this.report(this.asSyncError(error, 'RESTART_TRANSFER_RECOVERY_FAILED', true));
      }
      if ((index + 1) % TRANSFER_RECOVERY_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  private async reconcileDownloadCheckpoint(
    transfer: TransferRecord,
    reason: string,
  ): Promise<TransferRecord> {
    const resource = await this.data.repositories.resources.getById(
      this.session.tripId,
      transfer.resourceId,
    );
    if (!resource) {
      await this.data.repositories.transfers.markFailed(
        this.session.tripId,
        transfer.id,
        'RESOURCE_NOT_FOUND',
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'failed' });
      return { ...transfer, state: 'failed' };
    }
    if (resource.availability === 'available' && resource.localUri) {
      const completed: TransferRecord = {
        ...transfer,
        state: 'completed',
        bytesTransferred: resource.byteLength,
        nextChunkIndex: Math.ceil(resource.byteLength / transfer.chunkSize),
        lastError: null,
        completedAt: transfer.completedAt ?? checkedNow(this.clock),
        updatedAt: checkedNow(this.clock),
      };
      await this.data.repositories.transfers.updateProgress(
        this.session.tripId,
        transfer.id,
        completed.bytesTransferred,
        completed.nextChunkIndex,
        'completed',
        completed.updatedAt,
      );
      this.emitTransferProgress(completed);
      return completed;
    }
    const incoming = this.fileStore.getIncoming?.(transfer.id) ?? null;
    let finalized = incoming
      ? null
      : this.fileStore.getOriginal?.(resource.id, resource.fileExtension) ?? null;
    if (finalized && finalized.byteSize !== resource.byteLength) {
      await this.fileStore.deleteStoredFile(finalized.uri).catch(() => undefined);
      finalized = null;
    }
    const bytesTransferred = incoming?.byteSize ?? finalized?.byteSize ?? 0;
    const checkpointIsValid =
      bytesTransferred <= resource.byteLength &&
      (bytesTransferred === resource.byteLength || bytesTransferred % transfer.chunkSize === 0);
    if (!checkpointIsValid) {
      await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
      if (finalized?.uri) {
        await this.fileStore.deleteStoredFile(finalized.uri).catch(() => undefined);
      }
      await this.data.repositories.transfers.markFailed(
        this.session.tripId,
        transfer.id,
        'INVALID_LOCAL_CHECKPOINT',
        checkedNow(this.clock),
      );
      const failed = { ...transfer, state: 'failed' as const, lastError: 'INVALID_LOCAL_CHECKPOINT' };
      this.emitTransferProgress(failed);
      return failed;
    }
    if (bytesTransferred < transfer.bytesTransferred) {
      // A sender's upload checkpoint is allowed to be behind the receiver, but
      // a receiver must never claim bytes that no longer exist durably. Start a
      // fresh transfer id instead of rewinding the matching upload attempt.
      await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
      if (finalized?.uri) {
        await this.fileStore.deleteStoredFile(finalized.uri).catch(() => undefined);
      }
      await this.data.repositories.transfers.markFailed(
        this.session.tripId,
        transfer.id,
        'LOCAL_CHECKPOINT_REGRESSED',
        checkedNow(this.clock),
      );
      const failed = { ...transfer, state: 'failed' as const, lastError: 'LOCAL_CHECKPOINT_REGRESSED' };
      this.emitTransferProgress(failed);
      return failed;
    }
    const state = bytesTransferred === resource.byteLength ? 'verifying' : 'paused';
    const reconciled: TransferRecord = {
      ...transfer,
      state,
      bytesTransferred,
      totalBytes: resource.byteLength,
      nextChunkIndex: Math.ceil(bytesTransferred / transfer.chunkSize),
      lastError: reason,
      updatedAt: checkedNow(this.clock),
    };
    await this.data.repositories.transfers.upsert(reconciled);
    this.emitTransferProgress(reconciled);
    return reconciled;
  }

  private async recoverTransfersForPeer(peerDeviceId: string): Promise<void> {
    const peer = await this.data.repositories.members.getByDeviceId(
      this.session.tripId,
      peerDeviceId,
    );
    if (!peer) return;
    const active = await this.data.repositories.transfers.listActive(this.session.tripId);
    const downloads = active.filter(
      (transfer) =>
        transfer.direction === 'download' &&
        transfer.peerMemberId === peer.id,
    );
    const demandUsage = await this.currentDownloadDemandUsage(active);
    for (const transfer of downloads) {
      const reconciled = await this.reconcileDownloadCheckpoint(
        transfer,
        'WAITING_FOR_RESUME',
      );
      if (reconciled.state === 'failed') continue;
      if (
        reconciled.state === 'verifying' &&
        reconciled.bytesTransferred === reconciled.totalBytes
      ) {
        await this.ensureDownloadFinalized(
          reconciled,
          `peer-recovery:${reconciled.id}:${reconciled.bytesTransferred}`,
        );
        continue;
      }
      const resource = await this.data.repositories.resources.getById(
        this.session.tripId,
        reconciled.resourceId,
      );
      if (!resource || (resource.availability === 'available' && resource.localUri)) continue;
      const priority = this.downloadPriorities.get(reconciled.id) ?? resourcePriority(resource);
      if (this.availableAutomaticDownloadSlots(priority, demandUsage) <= 0) continue;
      if (await this.queueResumeRequest(
        reconciled,
        resource,
        peer,
        priority,
      )) recordDownloadDemand(demandUsage, priority);
    }
  }

  private async pauseInterruptedTransfers(peerDeviceId: string): Promise<void> {
    const peer = await this.data.repositories.members.getByDeviceId(
      this.session.tripId,
      peerDeviceId,
    );
    if (!peer) return;
    for (const [transferId, pending] of this.pendingUploads) {
      if (pending.peerDeviceId === peerDeviceId) this.pendingUploads.delete(transferId);
    }
    const active = await this.data.repositories.transfers.listActive(this.session.tripId);
    for (const transfer of active) {
      if (transfer.peerMemberId !== peer.id) continue;
      this.clearCompletionWatchdog(transfer.id);
      this.clearDownloadInactivityWatchdog(transfer.id);
      this.recoveryRequestedOffsets.delete(transfer.id);
      if (transfer.direction === 'download') this.incomingReservations.delete(transfer.id);
      await this.data.repositories.transfers.markPaused(
        this.session.tripId,
        transfer.id,
        'PEER_DISCONNECTED',
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'paused' });
    }
  }

  private async pauseRecoverableTransfers(reason: string): Promise<void> {
    const active = await this.data.repositories.transfers.listActive(this.session.tripId);
    for (const transfer of active) {
      await this.data.repositories.transfers.markPaused(
        this.session.tripId,
        transfer.id,
        reason,
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'paused' });
    }
  }

  private async queueResourceRequest(
    resource: ResourceRecord,
    peerDeviceId: string,
    priority: ResourcePriority,
  ): Promise<boolean> {
    if (!this.admittedDevices.has(peerDeviceId)) {
      throw new SyncEngineError('RESOURCE_PEER_UNAVAILABLE', 'Resource peer is not admitted.', true);
    }
    const peer = await this.data.repositories.members.getByDeviceId(
      this.session.tripId,
      peerDeviceId,
    );
    if (!peer) {
      throw new SyncEngineError('RESOURCE_PEER_UNKNOWN', 'Resource peer is not yet in the durable member catalog.', true);
    }
    const active = await this.data.repositories.transfers.listActive(this.session.tripId);
    const existing = active.find(
      (transfer) =>
        transfer.direction === 'download' &&
        transfer.resourceId === resource.id &&
        transfer.peerMemberId === peer.id,
    );
    if (existing) {
      const previous = this.downloadPriorities.get(existing.id) ?? resourcePriority(resource);
      const effectivePriority = priorityRank(priority) < priorityRank(previous)
        ? priority
        : previous;
      this.downloadPriorities.set(existing.id, effectivePriority);
      if (existing.state === 'paused') {
        return this.queueResumeRequest(existing, resource, peer, effectivePriority);
      }
      return false;
    }

    await this.assertIncomingCapacity(resource, resource.byteLength);

    const now = checkedNow(this.clock);
    const requestId = assertParsed(
      parseRequestId(
        this.ids.create(
          'request',
          resource.id,
          peerDeviceId,
          String(now),
          String(++this.localRequestNonce),
        ),
      ),
    );
    const transferId = assertParsed(parseTransferId(requestId));
    const messageId = assertParsed(parseMessageId(this.ids.create('message', requestId)));
    const transfer: TransferRecord = {
      id: transferId,
      tripId: this.session.tripId,
      resourceId: resource.id,
      peerMemberId: peer.id,
      direction: 'download',
      state: 'queued',
      bytesTransferred: 0,
      totalBytes: resource.byteLength,
      chunkSize: SECURE_FILE_CHUNK_BYTES,
      nextChunkIndex: 0,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.downloadPriorities.set(transfer.id, priority);
    const payload: ResourceRequestMessage = {
      requestId,
      mediaId: assertParsed(parseMediaId(resource.mediaId)),
      resourceId: assertResourceId(resource.id),
      expectedSha256: assertSha256(resource.sha256),
      startOffset: 0,
      priority,
    };
    await this.data.transaction(async (repositories) => {
      await repositories.transfers.upsert(transfer);
      await repositories.outbox.upsert(
        createOutboxRecord({
          id: messageId,
          tripId: this.session.tripId,
          recipientMemberId: peer.id,
          messageType: `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_REQUEST`,
          payload: payload as unknown as JsonValue,
          dedupeKey: `resource-request:${requestId}`,
          now,
          availableAt:
            priority === 'BACKGROUND_ORIGINAL' ? now + BACKGROUND_REQUEST_DELAY_MS : now,
        }),
      );
    });
    this.emitTransferProgress(transfer);
    return true;
  }

  private async queueResumeRequest(
    transfer: TransferRecord,
    resource: ResourceRecord,
    peer: MemberRecord,
    priority: ResourcePriority,
  ): Promise<boolean> {
    if (!this.admittedDevices.has(peer.deviceId)) return false;
    const now = checkedNow(this.clock);
    const previousRequest = this.recoveryRequestedOffsets.get(transfer.id);
    if (
      previousRequest?.offset === transfer.bytesTransferred &&
      now - previousRequest.requestedAtMs < DOWNLOAD_INACTIVITY_TIMEOUT_MS
    ) return false;
    const payload: ResourceRequestMessage = {
      requestId: assertParsed(parseRequestId(transfer.id)),
      mediaId: assertParsed(parseMediaId(resource.mediaId)),
      resourceId: assertResourceId(resource.id),
      expectedSha256: assertSha256(resource.sha256),
      startOffset: transfer.bytesTransferred,
      priority,
    };
    const messageId = this.ids.create(
      'message',
      'resume',
      transfer.id,
      String(transfer.bytesTransferred),
    );
    const existingIntent = await this.data.repositories.outbox.getById(
      this.session.tripId,
      messageId,
    );
    if (existingIntent) {
      await this.data.repositories.outbox.reschedule(
        this.session.tripId,
        messageId,
        now,
        'RESUME_REQUESTED',
        now,
      );
    } else {
      await this.data.repositories.outbox.upsert(
        createOutboxRecord({
          id: messageId,
          tripId: this.session.tripId,
          recipientMemberId: peer.id,
          messageType: `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_REQUEST`,
          payload: payload as unknown as JsonValue,
          dedupeKey: `resource-request:resume:${transfer.id}:${transfer.bytesTransferred}`,
          now,
        }),
      );
    }
    this.downloadPriorities.set(transfer.id, priority);
    this.recoveryRequestedOffsets.set(transfer.id, {
      offset: transfer.bytesTransferred,
      requestedAtMs: now,
    });
    return true;
  }

  private async handleResourceRequest(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_REQUEST' }>,
    peerDeviceId: string,
  ): Promise<void> {
    const request = envelope.payload;
    const [resource, peer, existing] = await Promise.all([
      this.data.repositories.resources.getById(this.session.tripId, request.resourceId),
      this.data.repositories.members.getByDeviceId(this.session.tripId, peerDeviceId),
      this.data.repositories.transfers.getById(this.session.tripId, request.requestId),
    ]);
    const resumeOffsetIsValid = Boolean(
      resource &&
        request.startOffset <= resource.byteLength &&
        (request.startOffset === resource.byteLength ||
          request.startOffset % SECURE_FILE_CHUNK_BYTES === 0),
    );
    const existingMatches =
      !existing ||
      (existing.direction === 'upload' &&
        existing.resourceId === request.resourceId &&
        existing.peerMemberId === peer?.id);
    const existingIsTerminal = Boolean(
      existingMatches &&
        existing &&
        (existing.state === 'completed' ||
          existing.state === 'failed' ||
          existing.state === 'cancelled'),
    );
    const accepted = Boolean(
      resource &&
        peer &&
        resource.mediaId === request.mediaId &&
        resource.sha256 === request.expectedSha256 &&
        resource.availability === 'available' &&
        resource.localUri &&
        resumeOffsetIsValid &&
        existingMatches &&
        !existingIsTerminal,
    );
    const transferId = accepted ? assertParsed(parseTransferId(request.requestId)) : null;
    const manifest = accepted && resource ? toDomainResource(resource) : null;
    const offer: ResourceOfferMessage = accepted
      ? {
          requestId: request.requestId,
          accepted: true,
          transferId,
          resource: manifest,
          chunkSize: SECURE_FILE_CHUNK_BYTES,
          rejectionCode: null,
        }
      : {
          requestId: request.requestId,
          accepted: false,
          transferId: null,
          resource: null,
          chunkSize: null,
          rejectionCode: !resource
            ? 'RESOURCE_NOT_FOUND'
            : !existingMatches
              ? 'TRANSFER_CONTEXT_MISMATCH'
              : existingIsTerminal
                ? existing?.state === 'completed'
                  ? 'TRANSFER_ALREADY_COMPLETED'
                  : 'TRANSFER_TERMINAL'
              : !resumeOffsetIsValid
                ? 'INVALID_RESUME_OFFSET'
                : 'RESOURCE_UNAVAILABLE',
        };
    const now = checkedNow(this.clock);
    await this.data.transaction(async (repositories) => {
      if (accepted && resource && peer && transferId) {
        if (!existing) {
          await repositories.transfers.upsert({
            id: transferId,
            tripId: this.session.tripId,
            resourceId: resource.id,
            peerMemberId: peer.id,
            direction: 'upload',
            state: 'queued',
            bytesTransferred: request.startOffset,
            totalBytes: resource.byteLength,
            chunkSize: SECURE_FILE_CHUNK_BYTES,
            nextChunkIndex: Math.ceil(request.startOffset / SECURE_FILE_CHUNK_BYTES),
            attemptCount: 0,
            lastError: null,
            startedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        } else if (
          request.startOffset > existing.bytesTransferred &&
          !this.activeUploads.has(existing.id)
        ) {
          // The receiver's request describes its durable checkpoint. It may
          // advance a dormant sender attempt after an ACK was lost, but an old
          // or duplicate request can never rewind bytes or transfer state.
          await repositories.transfers.upsert({
            ...existing,
            state: 'queued',
            bytesTransferred: request.startOffset,
            nextChunkIndex: Math.ceil(request.startOffset / SECURE_FILE_CHUNK_BYTES),
            lastError: null,
            completedAt: null,
            updatedAt: now,
          });
        }
        this.uploadPriorities.set(transferId, request.priority);
        this.uploadAttemptKeys.set(transferId, envelope.messageId);
      }
      await repositories.outbox.upsert(
        createOutboxRecord({
          id: this.ids.create('message', 'offer', request.requestId, envelope.messageId),
          tripId: this.session.tripId,
          recipientMemberId: peer?.id ?? envelope.senderMemberId,
          messageType: `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_OFFER`,
          payload: offer as unknown as JsonValue,
          dedupeKey: `resource-offer:${request.requestId}:${envelope.messageId}`,
          now,
        }),
      );
    });
    await this.sendAck(envelope.messageId, peerDeviceId, 'ACCEPTED', null);
    await this.flushOutbox();
  }

  private async handleResourceOffer(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_OFFER' }>,
    peerDeviceId: string,
  ): Promise<void> {
    const offer = envelope.payload;
    const transfer = await this.data.repositories.transfers.getById(
      this.session.tripId,
      offer.requestId,
    );
    if (!transfer || transfer.direction !== 'download') {
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'UNKNOWN_TRANSFER');
      return;
    }
    this.recoveryRequestedOffsets.delete(transfer.id);
    if (transfer.state === 'completed') {
      this.clearDownloadInactivityWatchdog(transfer.id);
      await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
      return;
    }
    const peer = await this.data.repositories.members.getByDeviceId(this.session.tripId, peerDeviceId);
    if (!peer || peer.id !== transfer.peerMemberId) {
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'TRANSFER_PEER_MISMATCH');
      return;
    }
    if (transfer.state === 'failed' || transfer.state === 'cancelled') {
      await this.sendAck(
        envelope.messageId,
        peerDeviceId,
        'REJECTED',
        'TRANSFER_TERMINAL',
      );
      return;
    }
    const expected = await this.data.repositories.resources.getById(
      this.session.tripId,
      transfer.resourceId,
    );
    if (!offer.accepted || !offer.transferId || !offer.resource || !offer.chunkSize) {
      this.clearDownloadInactivityWatchdog(transfer.id);
      this.incomingReservations.delete(transfer.id);
      const rejectionCode = offer.rejectionCode ?? 'REMOTE_REJECTED';
      const remoteAttemptIsTerminal =
        rejectionCode === 'TRANSFER_ALREADY_COMPLETED' ||
        rejectionCode === 'TRANSFER_TERMINAL';
      if (remoteAttemptIsTerminal) {
        await this.data.repositories.transfers.markFailed(
          this.session.tripId,
          transfer.id,
          rejectionCode,
          checkedNow(this.clock),
        );
        await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
        this.emitTransferProgress({ ...transfer, state: 'failed', lastError: rejectionCode });
      } else {
        await this.data.repositories.transfers.markPaused(
          this.session.tripId,
          transfer.id,
          rejectionCode,
          checkedNow(this.clock),
        );
        this.emitTransferProgress({ ...transfer, state: 'paused', lastError: rejectionCode });
      }
      this.coolDownResourcePeer(transfer.resourceId, peerDeviceId);
      this.scheduleResourceRetry(transfer.resourceId);
      await this.sendAck(envelope.messageId, peerDeviceId, 'ACCEPTED', null);
      if (expected) {
        try {
          const fallback = await this.resolveVerifiedResourcePeer(expected, peerDeviceId);
          await this.queueResourceRequest(
            expected,
            fallback,
            this.downloadPriorities.get(transfer.id) ?? resourcePriority(expected),
          );
          await this.flushOutbox();
        } catch (error) {
          this.report(this.asSyncError(error, 'RESOURCE_FALLBACK_FAILED', true));
        }
      }
      return;
    }
    if (
      offer.transferId !== transfer.id ||
      !expected ||
      !sameResourceManifest(expected, offer.resource) ||
      offer.chunkSize > SECURE_FILE_CHUNK_BYTES
    ) {
      await this.failDownload(transfer, 'INVALID_RESOURCE_OFFER');
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'INVALID_RESOURCE_OFFER');
      return;
    }
    const activeTransfers = await this.data.repositories.transfers.listActive(this.session.tripId);
    const otherActiveDownloads = activeTransfers.filter(
      (candidate) =>
        candidate.id !== transfer.id &&
        candidate.direction === 'download' &&
        (candidate.state === 'transferring' || candidate.state === 'verifying'),
    );
    const activeUsage = await this.summarizeDownloadDemand(otherActiveDownloads);
    const activeOriginals =
      activeUsage.userVisibleOriginals + activeUsage.backgroundOriginals;
    const priority = this.downloadPriorities.get(transfer.id) ?? resourcePriority(expected);
    if (
      otherActiveDownloads.length >= MAX_CONCURRENT_DOWNLOADS ||
      (expected.kind === 'ORIGINAL' &&
        activeOriginals >= MAX_CONCURRENT_ORIGINAL_DOWNLOADS) ||
      (priority === 'BACKGROUND_ORIGINAL' &&
        activeUsage.backgroundOriginals >= MAX_CONCURRENT_BACKGROUND_ORIGINAL_DOWNLOADS)
    ) {
      await this.sendAck(
        envelope.messageId,
        peerDeviceId,
        'REJECTED',
        'TRANSFER_LIMIT_REACHED',
      );
      return;
    }
    try {
      await this.reserveIncomingCapacity(transfer, expected);
      await this.fileStore.prepareIncoming(transfer.id, transfer.bytesTransferred === 0);
    } catch (error) {
      this.incomingReservations.delete(transfer.id);
      const syncError = this.asSyncError(error, 'INCOMING_PREPARE_FAILED', true);
      await this.data.repositories.transfers.markPaused(
        this.session.tripId,
        transfer.id,
        syncError.code,
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'paused' });
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', syncError.code);
      this.report(syncError);
      return;
    }
    const now = checkedNow(this.clock);
    const state = transfer.bytesTransferred === transfer.totalBytes
      ? 'verifying'
      : 'transferring';
    await this.data.transaction(async (repositories) => {
      await repositories.transfers.upsert({
        ...transfer,
        state,
        chunkSize: offer.chunkSize!,
        startedAt: transfer.startedAt ?? now,
        updatedAt: now,
      });
      await repositories.resources.setLocalAvailability(
        this.session.tripId,
        expected.id,
        'partial',
        null,
        null,
        now,
      );
    });
    const [persistedTransfer, persistedResource] = await Promise.all([
      this.data.repositories.transfers.getById(this.session.tripId, transfer.id),
      this.data.repositories.resources.getById(this.session.tripId, expected.id),
    ]);
    if (persistedResource?.availability === 'available' && persistedResource.localUri) {
      this.incomingReservations.delete(transfer.id);
      const cancelled = persistedTransfer
        ? await this.data.repositories.transfers.markCancelled(
            this.session.tripId,
            transfer.id,
            'RESOURCE_ALREADY_AVAILABLE',
            now,
          )
        : false;
      if (cancelled) {
        await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
        await this.queueProtocolMessage(
          peer.id,
          'RESOURCE_COMPLETE',
          {
            transferId: assertParsed(parseTransferId(transfer.id)),
            resourceId: assertResourceId(expected.id),
            status: 'RECEIVER_REJECTED',
            byteLength: transfer.bytesTransferred,
            sha256: assertSha256(expected.sha256),
            errorCode: 'RESOURCE_ALREADY_AVAILABLE',
          } satisfies ResourceCompleteMessage,
          `resource-complete:already-available:${transfer.id}`,
        );
      }
      await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
      await this.flushOutbox();
      return;
    }
    if (!persistedTransfer || !isRecoverableTransferState(persistedTransfer.state)) {
      this.incomingReservations.delete(transfer.id);
      await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'TRANSFER_TERMINAL');
      return;
    }
    await this.sendAck(envelope.messageId, peerDeviceId, 'ACCEPTED', null);
    this.emitTransferProgress(persistedTransfer);
    if (state === 'verifying') {
      this.startDownloadFinalization(
        persistedTransfer,
        `offer:${transfer.id}:${envelope.messageId}`,
      );
    } else {
      this.armDownloadInactivityWatchdog(transfer.id);
    }
  }

  private startUpload(
    transferIdValue: string,
    peerDeviceId: string,
    priority: ResourcePriority = 'BACKGROUND_ORIGINAL',
  ): void {
    if (this.activeUploads.has(transferIdValue)) return;
    const pending = this.pendingUploads.get(transferIdValue);
    if (pending && priorityRank(pending.priority) <= priorityRank(priority)) return;
    this.pendingUploads.set(transferIdValue, { peerDeviceId, priority });
    if (priority !== 'BACKGROUND_ORIGINAL') this.requestForegroundUploadCapacity();
    this.pumpUploads();
  }

  private requestForegroundUploadCapacity(): void {
    const pendingForeground = [...this.pendingUploads.values()].filter(
      (pending) => pending.priority !== 'BACKGROUND_ORIGINAL',
    ).length;
    const openSlots = Math.max(0, MAX_CONCURRENT_UPLOADS - this.activeUploads.size);
    let preemptionsNeeded = Math.max(0, pendingForeground - openSlots);
    if (preemptionsNeeded === 0) return;

    for (const [transferId, priority] of this.activeUploadPriorities) {
      if (
        preemptionsNeeded === 0 ||
        priority !== 'BACKGROUND_ORIGINAL' ||
        this.uploadPreemptionRequests.has(transferId)
      ) continue;
      this.uploadPreemptionRequests.add(transferId);
      this.cancelChunkPermitsForTransfer(transferId, 'UPLOAD_PREEMPTED');
      this.cancelChunkAcksForTransfer(transferId, 'UPLOAD_PREEMPTED');
      preemptionsNeeded -= 1;
    }
  }

  private pumpUploads(): void {
    while (
      this.state === 'running' &&
      this.activeUploads.size < MAX_CONCURRENT_UPLOADS &&
      this.pendingUploads.size > 0
    ) {
      const next = [...this.pendingUploads.entries()]
        .sort((left, right) =>
          priorityRank(left[1].priority) - priorityRank(right[1].priority) ||
          left[0].localeCompare(right[0]))
        .at(0);
      if (!next) return;
      const [transferIdValue, pending] = next;
      this.pendingUploads.delete(transferIdValue);
      this.activeUploadPriorities.set(transferIdValue, pending.priority);
      const task = this.uploadResource(transferIdValue, pending.peerDeviceId)
        .catch(async (error) => {
          const syncError = this.asSyncError(error, 'UPLOAD_FAILED', true);
          this.cancelChunkAcksForTransfer(transferIdValue, syncError.code);
          if (syncError.code === 'UPLOAD_PREEMPTED') {
            if (this.state === 'running' && this.admittedDevices.has(pending.peerDeviceId)) {
              this.pendingUploads.set(transferIdValue, pending);
            }
            return;
          }
          const transfer = await this.data.repositories.transfers
            .getById(this.session.tripId, transferIdValue)
            .catch(() => null);
          let sourceInvalid = syncError.code === 'UPLOAD_SOURCE_INTEGRITY_FAILED';
          if (
            transfer &&
            (syncError.code === 'UPLOAD_FAILED' ||
              syncError.code === 'UPLOAD_SIZE_MISMATCH' ||
              syncError.code === 'NON_CONTIGUOUS_UPLOAD')
          ) {
            sourceInvalid = await this.verifyAndQuarantineInvalidLocalResource(
              transfer.resourceId,
            ).catch((verificationError) => {
              this.report(
                this.asSyncError(
                  verificationError,
                  'UPLOAD_SOURCE_RECHECK_FAILED',
                  true,
                ),
              );
              return false;
            });
          }
          if (transfer && isRecoverableTransferState(transfer.state)) {
            if (syncError.recoverable && !sourceInvalid) {
              await this.data.repositories.transfers
                .markPaused(
                  this.session.tripId,
                  transferIdValue,
                  syncError.code,
                  checkedNow(this.clock),
                )
                .catch(() => undefined);
              this.emitTransferProgress({ ...transfer, state: 'paused' });
            } else {
              await this.data.repositories.transfers
                .markFailed(
                  this.session.tripId,
                  transferIdValue,
                  syncError.code,
                  checkedNow(this.clock),
                )
                .catch(() => undefined);
              this.emitTransferProgress({ ...transfer, state: 'failed' });
            }
          }
          if (transfer && sourceInvalid) {
            try {
              const resource = await this.data.repositories.resources.getById(
                this.session.tripId,
                transfer.resourceId,
              );
              if (resource) {
                await this.queueProtocolMessage(
                  transfer.peerMemberId,
                  'RESOURCE_COMPLETE',
                  {
                    transferId: assertParsed(parseTransferId(transfer.id)),
                    resourceId: assertResourceId(resource.id),
                    status: 'SENDER_REJECTED',
                    byteLength: resource.byteLength,
                    sha256: assertSha256(resource.sha256),
                    errorCode: 'UPLOAD_SOURCE_INTEGRITY_FAILED',
                  } satisfies ResourceCompleteMessage,
                  `resource-complete:source-rejected:${transfer.id}`,
                );
                await this.flushOutbox();
              }
            } catch (notificationError) {
              this.report(
                this.asSyncError(
                  notificationError,
                  'UPLOAD_SOURCE_REJECTION_SEND_FAILED',
                  true,
                ),
              );
            }
          }
          this.report(syncError);
        })
        .finally(() => {
          this.activeUploads.delete(transferIdValue);
          this.activeUploadPriorities.delete(transferIdValue);
          this.uploadPreemptionRequests.delete(transferIdValue);
          this.pumpUploads();
        });
      this.activeUploads.set(transferIdValue, task);
    }
  }

  private async uploadResource(transferIdValue: string, peerDeviceId: string): Promise<void> {
    const transferId = assertParsed(parseTransferId(transferIdValue));
    const transfer = await this.data.repositories.transfers.getById(this.session.tripId, transferId);
    if (!transfer || transfer.direction !== 'upload') {
      throw new SyncEngineError('UNKNOWN_UPLOAD', 'Upload transfer no longer exists.', false);
    }
    const [resource, peer] = await Promise.all([
      this.data.repositories.resources.getById(this.session.tripId, transfer.resourceId),
      this.data.repositories.members.getById(this.session.tripId, transfer.peerMemberId),
    ]);
    if (!resource || resource.availability !== 'available' || !resource.localUri) {
      throw new SyncEngineError('UPLOAD_RESOURCE_UNAVAILABLE', 'Upload resource is not locally available.', true);
    }
    if (!peer || peer.deviceId !== peerDeviceId || !this.admittedDevices.has(peerDeviceId)) {
      throw new SyncEngineError('UPLOAD_PEER_UNAVAILABLE', 'Upload peer is no longer admitted.', true);
    }
    let nextChunkIndexToSend = transfer.nextChunkIndex;
    let nextOffsetToSend = transfer.bytesTransferred;
    let bytesTransferred = transfer.bytesTransferred;
    let lastPersistedOffset = transfer.bytesTransferred;
    let persistedTransferStart =
      transfer.startedAt !== null || transfer.state === 'transferring';
    const sourceHasher = transfer.bytesTransferred === 0 ? sha256.create() : null;
    let sourceBytesRead = 0;
    const inFlight: {
      readonly endOffset: number;
      readonly nextChunkIndex: number;
      readonly acknowledged: Promise<void>;
    }[] = [];
    const acknowledgeOldest = async (): Promise<void> => {
      const sent = inFlight.shift();
      if (!sent) return;
      await sent.acknowledged;
      bytesTransferred = sent.endOffset;
      // Persist the first ACK, each MiB checkpoint, and the final ACK. The
      // receiver remains the resume authority, so a crash between checkpoints
      // can only resend already-verified bytes; it cannot skip bytes.
      if (
        !persistedTransferStart ||
        bytesTransferred === resource.byteLength ||
        bytesTransferred - lastPersistedOffset >= UPLOAD_CHECKPOINT_BYTES
      ) {
        await this.data.repositories.transfers.updateProgress(
          this.session.tripId,
          transfer.id,
          bytesTransferred,
          sent.nextChunkIndex,
          'transferring',
          checkedNow(this.clock),
        );
        lastPersistedOffset = bytesTransferred;
        persistedTransferStart = true;
      }
      this.emitTransferProgress({
        ...transfer,
        state: 'transferring',
        bytesTransferred,
        nextChunkIndex: sent.nextChunkIndex,
      });
    };
    for await (const chunk of this.fileStore.readChunks({
      uri: resource.localUri,
      offset: nextOffsetToSend,
      endOffsetExclusive: resource.byteLength,
      chunkSize: SECURE_FILE_CHUNK_BYTES,
    })) {
      if (this.state !== 'running' || !this.admittedDevices.has(peerDeviceId)) {
        throw new SyncEngineError('UPLOAD_INTERRUPTED', 'Upload paused because its session ended.', true);
      }
      if (this.uploadPreemptionRequests.has(transfer.id)) {
        throw new SyncEngineError(
          'UPLOAD_PREEMPTED',
          'Background upload yielded to a user-visible transfer.',
          true,
        );
      }
      if (chunk.offset !== nextOffsetToSend || chunk.bytes.byteLength > SECURE_FILE_CHUNK_BYTES) {
        throw new SyncEngineError('NON_CONTIGUOUS_UPLOAD', 'File store returned an invalid upload chunk.', false);
      }
      sourceHasher?.update(chunk.bytes);
      sourceBytesRead += chunk.bytes.byteLength;
      const envelope = await this.createEnvelope('RESOURCE_CHUNK', {
        transferId,
        resourceId: assertResourceId(resource.id),
        chunkIndex: nextChunkIndexToSend,
        offset: chunk.offset,
        bytes: chunk.bytes,
        chunkSha256: assertSha256(sha256Hex(chunk.bytes)),
      });
      if (envelope.type !== 'RESOURCE_CHUNK') throw new Error('Resource chunk envelope changed type.');
      if (this.uploadPreemptionRequests.has(transfer.id)) {
        throw new SyncEngineError(
          'UPLOAD_PREEMPTED',
          'Background upload yielded to a user-visible transfer.',
          true,
        );
      }
      const endOffset = nextOffsetToSend + chunk.bytes.byteLength;
      const acknowledged = this.sendSecureChunk(envelope, peerDeviceId);
      // Other window entries are cancelled if an earlier chunk fails. Attach
      // a handler immediately so that cancellation cannot surface as an
      // unhandled rejection before the contiguous head is awaited.
      void acknowledged.catch(() => undefined);
      inFlight.push({
        endOffset,
        nextChunkIndex: nextChunkIndexToSend + 1,
        acknowledged,
      });
      nextOffsetToSend = endOffset;
      nextChunkIndexToSend += 1;
      if (inFlight.length >= MAX_IN_FLIGHT_CHUNKS_PER_UPLOAD) {
        await acknowledgeOldest();
      }
    }
    while (inFlight.length > 0) await acknowledgeOldest();
    if (
      sourceHasher &&
      (sourceBytesRead !== resource.byteLength ||
        bytesToHex(sourceHasher.digest()) !== resource.sha256)
    ) {
      await this.quarantineInvalidLocalResource(resource, 'UPLOAD_SOURCE_INTEGRITY_FAILED');
      throw new SyncEngineError(
        'UPLOAD_SOURCE_INTEGRITY_FAILED',
        'The local source no longer matches its published content hash.',
        false,
      );
    }
    if (bytesTransferred !== resource.byteLength) {
      throw new SyncEngineError('UPLOAD_SIZE_MISMATCH', 'Upload did not cover the resource byte length.', false);
    }
    await this.data.repositories.transfers.updateProgress(
      this.session.tripId,
      transfer.id,
      bytesTransferred,
      nextChunkIndexToSend,
      'verifying',
      checkedNow(this.clock),
    );
    this.emitTransferProgress({
      ...transfer,
      state: 'verifying',
      bytesTransferred,
      nextChunkIndex: nextChunkIndexToSend,
    });
    const completionAttempt =
      this.uploadAttemptKeys.get(transfer.id) ??
      `${checkedNow(this.clock)}:${++this.localRequestNonce}`;
    await this.queueProtocolMessage(
      peer.id,
      'RESOURCE_COMPLETE',
      {
        transferId,
        resourceId: assertResourceId(resource.id),
        status: 'SENDER_FINISHED',
        byteLength: resource.byteLength,
        sha256: assertSha256(resource.sha256),
        errorCode: null,
      } satisfies ResourceCompleteMessage,
      `resource-complete:sender:${transferId}:${completionAttempt}`,
    );
    await this.flushOutbox();
  }

  private async verifyAndQuarantineInvalidLocalResource(resourceId: string): Promise<boolean> {
    const resource = await this.data.repositories.resources.getById(
      this.session.tripId,
      resourceId,
    );
    if (!resource || resource.availability !== 'available' || !resource.localUri) return false;
    try {
      const digest = await hashStoredFile(
        this.fileStore,
        resource.localUri,
        SECURE_FILE_CHUNK_BYTES,
      );
      if (digest.byteLength === resource.byteLength && digest.sha256 === resource.sha256) {
        return false;
      }
    } catch {
      // A missing/unreadable path is also a lost verified local replica.
    }
    return this.quarantineInvalidLocalResource(resource, 'LOCAL_RESOURCE_VERIFICATION_FAILED');
  }

  private async quarantineInvalidLocalResource(
    resource: ResourceRecord,
    reason: string,
  ): Promise<boolean> {
    if (
      resource.availability !== 'available' ||
      !resource.localUri ||
      resource.verifiedAtMs === null
    ) return false;
    const receipts = await this.data.repositories.replicaReceipts.listByResource(
      this.session.tripId,
      resource.id,
    );
    const verifiedReceipt = receipts.find(
      (receipt) =>
        receipt.holderDeviceId === this.session.localDeviceId &&
        receipt.holderMemberId === this.session.localMemberId &&
        receipt.status === 'VERIFIED',
    );
    const now = Math.max(checkedNow(this.clock), resource.updatedAtMs);
    if (!verifiedReceipt) {
      return this.data.repositories.resources.markVerifiedLocalCopyLost(
        this.session.tripId,
        resource.id,
        resource.localUri,
        resource.verifiedAtMs,
        resource.updatedAtMs,
        now,
      );
    }
    const receipt = assertParsed(
      parseReplicaReceipt({
        ...verifiedReceipt,
        status: 'LOST',
        updatedAtMs: now,
      }),
    );
    const sequence = await this.operationSequenceAllocator.allocate({
      tripId: this.session.tripId,
      originDeviceId: this.session.localDeviceId,
      idempotencyKey: `REPLICA_STATUS_CHANGED:${verifiedReceipt.id}:LOST:${resource.updatedAtMs}`,
    });
    const unsignedOperation = assertParsed(
      parseSyncOperation({
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        operationId: assertParsed(
          parseOperationId(
            this.ids.create(
              'operation',
              'replica-lost',
              verifiedReceipt.id,
              String(resource.updatedAtMs),
            ),
          ),
        ),
        tripId: this.session.tripId,
        originDeviceId: this.session.localDeviceId,
        originSequence: sequence,
        actorMemberId: this.session.localMemberId,
        membershipEpoch: (await this.requireTrip()).membershipEpoch,
        createdAtMs: now,
        kind: 'REPLICA_STATUS_CHANGED',
        payload: { receipt },
      }),
    );
    const operation = await signSyncOperation(
      unsignedOperation,
      this.session.localIdentityPublicKey,
      this.identity,
    );
    const changed = await this.withCatalogMutation(async () => {
      await this.refreshCatalogFromPersistence();
      const applied = applySyncOperations(this.catalogState, [operation]);
      if (applied.rejectedCount > 0) {
        throw new SyncEngineError(
          'REPLICA_LOST_OPERATION_REJECTED',
          'The local replica-loss operation violated catalog invariants.',
          false,
          { resourceId: resource.id, reason },
        );
      }
      let cleared = false;
      await this.data.transaction(async (repositories) => {
        cleared = await repositories.resources.markVerifiedLocalCopyLost(
          this.session.tripId,
          resource.id,
          resource.localUri!,
          resource.verifiedAtMs!,
          resource.updatedAtMs,
          now,
        );
        if (!cleared) return;
        await repositories.replicaReceipts.upsert(toReplicaReceiptRecord(receipt));
        await repositories.syncOperations.append(toOperationRecord(operation));
        await repositories.outbox.upsert(
          createOutboxRecord({
            id: this.ids.create('message', 'replica-lost', operation.operationId),
            tripId: this.session.tripId,
            recipientMemberId: null,
            messageType: 'SYNC_OPERATION',
            payload: operation as unknown as JsonValue,
            dedupeKey: `operation:${operation.operationId}`,
            now,
          }),
        );
      });
      if (cleared) {
        this.catalogState = applied.state;
        this.onEvent({
          kind: 'catalog-changed',
          source: 'local-refresh',
          appliedOperationCount: 1,
        });
      }
      return cleared;
    });
    if (changed) await this.flushOutbox();
    return changed;
  }

  private async sendSecureChunk(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_CHUNK' }>,
    targetPeerId: string,
  ): Promise<void> {
    const releasePermit = await this.acquireChunkPermit(envelope.payload.transferId);
    try {
      const plaintext = encodeResourceChunkPlaintext(envelope);
      const frame = await this.crypto.seal({
        header: this.secureHeader(envelope.senderMessageSequence),
        plaintext,
        key: this.session.key,
      });
      const signedFrame = await signSecureFrame(
        frame,
        this.session.localIdentityPublicKey,
        this.identity,
      );
      const packet = serializeSignedSecureBinaryFrame(signedFrame);
      if (
        this.uploadPreemptionRequests.has(envelope.payload.transferId) ||
        this.state === 'stopping' ||
        this.state === 'stopped'
      ) {
        throw new SyncEngineError(
          'UPLOAD_PREEMPTED',
          'Upload yielded before its encrypted chunk entered the shared socket.',
          true,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingChunkAcks.delete(envelope.messageId);
          reject(
            new SyncEngineError(
              'CHUNK_ACK_TIMEOUT',
              `Peer did not durably acknowledge chunk ${envelope.payload.chunkIndex}.`,
              true,
              { transferId: envelope.payload.transferId, targetPeerId },
            ),
          );
        }, CHUNK_ACK_TIMEOUT_MS);
        this.pendingChunkAcks.set(envelope.messageId, {
          transferId: envelope.payload.transferId,
          peerDeviceId: targetPeerId,
          timer,
          resolve,
          reject,
        });
        try {
          this.transport.sendChunk({
            messageId: envelope.messageId,
            transferId: envelope.payload.transferId,
            resourceId: envelope.payload.resourceId,
            chunkIndex: envelope.payload.chunkIndex,
            // The transport validates each encrypted packet as an opaque,
            // complete binary unit. Authenticated plaintext carries the offset.
            offset: 0,
            totalBytes: packet.byteLength,
            isLast: true,
            bytes: packet,
            targetPeerId,
          });
        } catch (error) {
          clearTimeout(timer);
          this.pendingChunkAcks.delete(envelope.messageId);
          reject(this.asSyncError(error, 'CHUNK_SEND_FAILED', true));
        }
      });
    } finally {
      releasePermit();
    }
  }

  private async handleInboundChunk(chunk: InboundBinaryChunk): Promise<void> {
    if (
      chunk.sessionId !== this.session.tripId ||
      (chunk.targetPeerId !== null && chunk.targetPeerId !== this.session.localDeviceId)
    ) return;
    if (!this.admittedDevices.has(chunk.senderPeerId)) {
      throw new SyncEngineError('PEER_NOT_ADMITTED', 'Binary sender is not admitted.', true);
    }
    const senderDeviceId = assertParsed(parseDeviceId(chunk.senderPeerId));
    const signedFrame = parseSignedSecureBinaryFrame(chunk.bytes, {
      tripId: this.session.tripId,
      senderDeviceId,
      key: this.session.key,
    });
    const frame = signedFrame.frame;
    await this.requireAuthenticInboundFrame(signedFrame, chunk.senderPeerId, false);
    const plaintext = await this.crypto.open({ frame, key: this.session.key });
    const envelope = decodeResourceChunkPlaintext(plaintext);
    const accepted = await this.replayGuard.accept({
      tripId: frame.tripId,
      senderDeviceId: frame.senderDeviceId,
      keyEpoch: frame.keyEpoch,
      senderCounter: frame.senderCounter,
    });
    if (
      envelope.senderDeviceId !== chunk.senderPeerId ||
      envelope.senderMessageSequence !== frame.senderCounter ||
      envelope.payload.transferId !== chunk.transferId ||
      envelope.payload.resourceId !== chunk.resourceId ||
      envelope.payload.chunkIndex !== chunk.chunkIndex
    ) {
      throw new SyncEngineError('CHUNK_CONTEXT_MISMATCH', 'Encrypted chunk metadata does not match transport metadata.', true);
    }
    await this.requireAdmittedEnvelope(envelope, chunk.senderPeerId);
    if (!accepted) {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'DUPLICATE', null);
      return;
    }
    const transfer = await this.data.repositories.transfers.getById(
      this.session.tripId,
      envelope.payload.transferId,
    );
    const resource = await this.data.repositories.resources.getById(
      this.session.tripId,
      envelope.payload.resourceId,
    );
    if (!transfer || transfer.direction !== 'download' || !resource || transfer.resourceId !== resource.id) {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'REJECTED', 'UNKNOWN_DOWNLOAD');
      return;
    }
    if (transfer.state === 'completed') {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'DUPLICATE', null);
      return;
    }
    if (transfer.state === 'failed' || transfer.state === 'cancelled') {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'REJECTED', 'TRANSFER_TERMINAL');
      return;
    }
    const peer = await this.data.repositories.members.getByDeviceId(
      this.session.tripId,
      chunk.senderPeerId,
    );
    if (!peer || peer.id !== transfer.peerMemberId) {
      await this.sendAck(
        envelope.messageId,
        chunk.senderPeerId,
        'REJECTED',
        'TRANSFER_PEER_MISMATCH',
      );
      return;
    }
    const payload = envelope.payload;
    if (sha256Hex(payload.bytes) !== payload.chunkSha256) {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'REJECTED', 'CHUNK_HASH_MISMATCH');
      await this.failDownload(transfer, 'CHUNK_HASH_MISMATCH');
      return;
    }
    const endOffset = payload.offset + payload.bytes.byteLength;
    if (endOffset > resource.byteLength) {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'REJECTED', 'CHUNK_OUT_OF_BOUNDS');
      await this.failDownload(transfer, 'CHUNK_OUT_OF_BOUNDS');
      return;
    }
    if (endOffset <= transfer.bytesTransferred) {
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'DUPLICATE', null);
      return;
    }
    if (
      payload.offset !== transfer.bytesTransferred ||
      payload.chunkIndex !== transfer.nextChunkIndex
    ) {
      this.clearDownloadInactivityWatchdog(transfer.id);
      await this.data.repositories.transfers.markPaused(
        this.session.tripId,
        transfer.id,
        'CHUNK_GAP',
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'paused' });
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'REJECTED', 'CHUNK_GAP');
      await this.queueResumeRequest(
        { ...transfer, state: 'paused' },
        resource,
        peer,
        this.downloadPriorities.get(transfer.id) ?? resourcePriority(resource),
      );
      await this.flushOutbox();
      return;
    }
    let size: number;
    try {
      size = await this.fileStore.writeIncomingChunk({
        transferId: transfer.id,
        offset: payload.offset,
        bytes: payload.bytes,
      });
    } catch (error) {
      this.clearDownloadInactivityWatchdog(transfer.id);
      const syncError = this.asSyncError(error, 'INCOMING_WRITE_FAILED', true);
      await this.data.repositories.transfers.markPaused(
        this.session.tripId,
        transfer.id,
        syncError.code,
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'paused' });
      await this.sendAck(envelope.messageId, chunk.senderPeerId, 'REJECTED', syncError.code);
      this.scheduleResourceRetry(resource.id);
      this.report(syncError);
      return;
    }
    if (size !== endOffset) {
      await this.sendAck(
        envelope.messageId,
        chunk.senderPeerId,
        'REJECTED',
        'INCOMING_FILE_SIZE_MISMATCH',
      );
      await this.failDownload(transfer, 'INCOMING_FILE_SIZE_MISMATCH');
      return;
    }
    this.incomingReservations.set(transfer.id, resource.byteLength - endOffset);
    const now = checkedNow(this.clock);
    const nextState = endOffset === resource.byteLength ? 'verifying' : 'transferring';
    await this.data.repositories.transfers.updateProgress(
      this.session.tripId,
      transfer.id,
      endOffset,
      transfer.nextChunkIndex + 1,
      nextState,
      now,
    );
    this.emitTransferProgress({
      ...transfer,
      state: nextState,
      bytesTransferred: endOffset,
      nextChunkIndex: transfer.nextChunkIndex + 1,
    });
    this.clearResourceRetry(resource.id);
    await this.sendAck(envelope.messageId, chunk.senderPeerId, 'ACCEPTED', null);
    if (nextState === 'verifying') {
      this.clearDownloadInactivityWatchdog(transfer.id);
      this.startDownloadFinalization(
        {
          ...transfer,
          state: nextState,
          bytesTransferred: endOffset,
          nextChunkIndex: transfer.nextChunkIndex + 1,
          updatedAt: now,
        },
        `final-chunk:${transfer.id}:${envelope.messageId}`,
      );
    } else {
      this.armDownloadInactivityWatchdog(transfer.id);
    }
  }

  private async handleResourceComplete(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_COMPLETE' }>,
    peerDeviceId: string,
  ): Promise<void> {
    const complete = envelope.payload;
    const transfer = await this.data.repositories.transfers.getById(
      this.session.tripId,
      complete.transferId,
    );
    if (!transfer || transfer.resourceId !== complete.resourceId) {
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'UNKNOWN_TRANSFER');
      return;
    }
    const peer = await this.data.repositories.members.getByDeviceId(this.session.tripId, peerDeviceId);
    if (!peer || peer.id !== transfer.peerMemberId) {
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'TRANSFER_PEER_MISMATCH');
      return;
    }
    if (complete.status === 'SENDER_REJECTED') {
      if (transfer.direction !== 'download') {
        await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'DIRECTION_MISMATCH');
        return;
      }
      if (transfer.state === 'completed') {
        await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
        return;
      }
      if (transfer.state === 'failed') {
        await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
        this.coolDownResourcePeer(transfer.resourceId, peerDeviceId);
        this.clearResourceRetry(transfer.resourceId);
        await this.reconcileUnavailableResources(true);
        return;
      }
      if (transfer.state === 'cancelled') {
        await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
        return;
      }
      await this.failDownload(transfer, complete.errorCode ?? 'SENDER_REJECTED');
      await this.sendAck(envelope.messageId, peerDeviceId, 'ACCEPTED', null);
      this.clearResourceRetry(transfer.resourceId);
      await this.reconcileUnavailableResources(true);
      return;
    }
    if (complete.status === 'SENDER_FINISHED') {
      this.clearCompletionWatchdog(transfer.id);
    }
    if (complete.status === 'SENDER_FINISHED') {
      if (transfer.direction !== 'download') {
        await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'DIRECTION_MISMATCH');
        return;
      }
      if (transfer.state === 'failed' || transfer.state === 'cancelled') {
        await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'TRANSFER_TERMINAL');
        return;
      }
      if (transfer.state === 'completed') {
        const available = await this.data.repositories.resources.getById(
          this.session.tripId,
          transfer.resourceId,
        );
        if (
          available?.availability === 'available' &&
          available.localUri &&
          available.byteLength === complete.byteLength &&
          available.sha256 === complete.sha256
        ) {
          await this.queueReceiverVerified(
            transfer,
            available,
            peer,
            envelope.messageId,
          );
          await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
          await this.flushOutbox();
          return;
        }
        await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'COMPLETION_MISMATCH');
        return;
      }
      this.startSenderFinishedFinalization(
        transfer,
        complete,
        peerDeviceId,
        envelope.messageId,
      );
      return;
    }
    if (transfer.direction !== 'upload') {
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'DIRECTION_MISMATCH');
      return;
    }
    if (transfer.state === 'completed') {
      await this.sendAck(envelope.messageId, peerDeviceId, 'DUPLICATE', null);
      return;
    }
    if (transfer.state === 'failed' || transfer.state === 'cancelled') {
      await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'TRANSFER_TERMINAL');
      return;
    }
    if (complete.status === 'RECEIVER_VERIFIED') {
      const resource = await this.data.repositories.resources.getById(
        this.session.tripId,
        transfer.resourceId,
      );
      if (
        !resource ||
        complete.byteLength !== resource.byteLength ||
        complete.sha256 !== resource.sha256
      ) {
        await this.data.repositories.transfers.markFailed(
          this.session.tripId,
          transfer.id,
          'INVALID_RECEIVER_VERIFICATION',
          checkedNow(this.clock),
        );
        this.emitTransferProgress({ ...transfer, state: 'failed' });
        await this.sendAck(envelope.messageId, peerDeviceId, 'REJECTED', 'INVALID_RECEIVER_VERIFICATION');
        return;
      }
      await this.data.repositories.transfers.updateProgress(
        this.session.tripId,
        transfer.id,
        transfer.totalBytes,
        transfer.nextChunkIndex,
        'completed',
        checkedNow(this.clock),
      );
      this.emitTransferProgress({
        ...transfer,
        state: 'completed',
        bytesTransferred: transfer.totalBytes,
      });
    } else {
      this.pendingUploads.delete(transfer.id);
      this.cancelChunkAcksForTransfer(
        transfer.id,
        complete.errorCode ?? 'RECEIVER_REJECTED',
      );
      await this.data.repositories.transfers.markFailed(
        this.session.tripId,
        transfer.id,
        complete.errorCode ?? 'RECEIVER_REJECTED',
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'failed' });
    }
    await this.sendAck(envelope.messageId, peerDeviceId, 'ACCEPTED', null);
  }

  private ensureDownloadFinalized(
    transfer: TransferRecord,
    completionKey: string,
  ): Promise<void> {
    const existing = this.downloadFinalizations.get(transfer.id);
    if (existing) return existing;
    const task = this.finalizeFullDownload(transfer.id, completionKey).finally(() => {
      if (this.downloadFinalizations.get(transfer.id) === task) {
        this.downloadFinalizations.delete(transfer.id);
      }
    });
    this.downloadFinalizations.set(transfer.id, task);
    return task;
  }

  private startDownloadFinalization(
    transfer: TransferRecord,
    completionKey: string,
  ): void {
    // Whole-file hashing and atomic adoption can take seconds on older phones.
    // It is already deduplicated per transfer, so let the transport event queue
    // continue handling ACKs, heartbeats, and other photos while it runs.
    void this.ensureDownloadFinalized(transfer, completionKey).catch((error) => {
      this.report(this.asSyncError(error, 'DOWNLOAD_FINALIZATION_FAILED', true));
    });
  }

  private startSenderFinishedFinalization(
    transfer: TransferRecord,
    complete: ResourceCompleteMessage,
    peerDeviceId: string,
    messageId: MessageId,
  ): void {
    void (async () => {
      const resource = await this.data.repositories.resources.getById(
        this.session.tripId,
        transfer.resourceId,
      );
      if (
        resource &&
        transfer.bytesTransferred === transfer.totalBytes &&
        complete.byteLength === resource.byteLength &&
        complete.sha256 === resource.sha256
      ) {
        await this.ensureDownloadFinalized(transfer, messageId);
      } else {
        // Preserve the existing explicit rejection path for premature or
        // mismatched completion frames; only valid full-file verification is
        // detached from the transport queue.
        await this.finishDownload(transfer, complete, peerDeviceId, messageId);
      }
      await this.sendAck(messageId, peerDeviceId, 'ACCEPTED', null);
    })().catch((error) => {
      this.report(this.asSyncError(error, 'SENDER_FINISHED_FINALIZATION_FAILED', true));
    });
  }

  private async finalizeFullDownload(
    transferId: string,
    completionKey: string,
  ): Promise<void> {
    const transfer = await this.data.repositories.transfers.getById(
      this.session.tripId,
      transferId,
    );
    if (
      !transfer ||
      transfer.direction !== 'download' ||
      !isRecoverableTransferState(transfer.state)
    ) return;
    if (transfer.bytesTransferred !== transfer.totalBytes) return;
    const [resource, peer] = await Promise.all([
      this.data.repositories.resources.getById(this.session.tripId, transfer.resourceId),
      this.data.repositories.members.getById(this.session.tripId, transfer.peerMemberId),
    ]);
    if (!resource || !peer) {
      throw new SyncEngineError(
        'FINALIZATION_CONTEXT_MISSING',
        'A complete download is missing its resource or sender context.',
        true,
      );
    }
    await this.finishDownload(
      transfer,
      {
        transferId: assertParsed(parseTransferId(transfer.id)),
        resourceId: assertResourceId(resource.id),
        status: 'SENDER_FINISHED',
        byteLength: resource.byteLength,
        sha256: assertSha256(resource.sha256),
        errorCode: null,
      },
      peer.deviceId,
      completionKey,
    );
  }

  private async finishDownload(
    transfer: TransferRecord,
    complete: ResourceCompleteMessage,
    peerDeviceId: string,
    completionMessageId: string,
  ): Promise<void> {
    this.clearDownloadInactivityWatchdog(transfer.id);
    const resource = await this.data.repositories.resources.getById(
      this.session.tripId,
      transfer.resourceId,
    );
    if (
      !resource ||
      complete.byteLength !== resource.byteLength ||
      complete.sha256 !== resource.sha256 ||
      transfer.bytesTransferred !== resource.byteLength
    ) {
      await this.rejectCompletedDownload(transfer, resource, peerDeviceId, 'INCOMPLETE_RESOURCE');
      return;
    }
    try {
      const incoming = this.fileStore.getIncoming?.(transfer.id) ?? null;
      let verifiedBeforeAtomicMove = false;
      if (incoming) {
        const incomingDigest = await hashStoredFile(
          this.fileStore,
          incoming.uri,
          SECURE_FILE_CHUNK_BYTES,
        );
        if (
          incomingDigest.byteLength !== resource.byteLength ||
          incomingDigest.sha256 !== resource.sha256
        ) {
          await this.rejectCompletedDownload(
            transfer,
            resource,
            peerDeviceId,
            'WHOLE_FILE_HASH_MISMATCH',
          );
          return;
        }
        verifiedBeforeAtomicMove = true;
      }
      const stored = await this.fileStore.finalizeIncoming({
        transferId: transfer.id,
        storageKey: resource.id,
        extension: resource.fileExtension,
        expectedByteSize: resource.byteLength,
        // The source was verified immediately above. Overwrite also repairs a
        // stale deterministic target; if the prior move already completed,
        // ExpoFileStore adopts that target idempotently.
        overwrite: true,
      });
      if (!verifiedBeforeAtomicMove) {
        // Restart recovery can observe the deterministic target after the
        // move but before SQLite commit. Only that adoption path needs a
        // second read; the normal atomic rename preserves verified bytes.
        const storedDigest = await hashStoredFile(
          this.fileStore,
          stored.uri,
          SECURE_FILE_CHUNK_BYTES,
        );
        if (
          storedDigest.byteLength !== resource.byteLength ||
          storedDigest.sha256 !== resource.sha256
        ) {
          await this.fileStore.deleteStoredFile(stored.uri).catch(() => undefined);
          await this.rejectCompletedDownload(
            transfer,
            resource,
            peerDeviceId,
            'FINALIZED_FILE_HASH_MISMATCH',
          );
          return;
        }
      }
      const now = checkedNow(this.clock);
      const receipt = assertParsed(
        parseReplicaReceipt({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          id: assertParsed(
            parseReplicaReceiptId(
              this.ids.create('receipt', resource.id, this.session.localDeviceId),
            ),
          ),
          tripId: this.session.tripId,
          mediaId: assertParsed(parseMediaId(resource.mediaId)),
          resourceId: assertResourceId(resource.id),
          holderMemberId: this.session.localMemberId,
          holderDeviceId: this.session.localDeviceId,
          resourceSha256: assertSha256(resource.sha256),
          resourceByteLength: resource.byteLength,
          status: 'VERIFIED',
          verifiedAtMs: now,
          updatedAtMs: now,
        }),
      );
      const sequence = await this.operationSequenceAllocator.allocate({
        tripId: this.session.tripId,
        originDeviceId: this.session.localDeviceId,
        idempotencyKey: `REPLICA_RECORDED:${resource.id}:${this.session.localDeviceId}`,
      });
      const unsignedOperation = assertParsed(
        parseSyncOperation({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          operationId: assertParsed(
            parseOperationId(
              this.ids.create('operation', 'replica', receipt.id, this.session.localDeviceId),
            ),
          ),
          tripId: this.session.tripId,
          originDeviceId: this.session.localDeviceId,
          originSequence: sequence,
          actorMemberId: this.session.localMemberId,
          membershipEpoch: (await this.requireTrip()).membershipEpoch,
          createdAtMs: now,
          kind: 'REPLICA_RECORDED',
          payload: { receipt },
        }),
      );
      const operation = await signSyncOperation(
        unsignedOperation,
        this.session.localIdentityPublicKey,
        this.identity,
      );
      await this.withCatalogMutation(async () => {
        await this.refreshCatalogFromPersistence();
        const applied = applySyncOperations(this.catalogState, [operation]);
        if (applied.rejectedCount > 0) {
          throw new SyncEngineError('REPLICA_OPERATION_REJECTED', 'Verified replica operation was rejected.', false);
        }
        await this.data.transaction(async (repositories) => {
          await repositories.resources.setLocalAvailability(
            this.session.tripId,
            resource.id,
            'available',
            stored.uri,
            now,
            now,
          );
          await repositories.replicaReceipts.upsert(toReplicaReceiptRecord(receipt));
          await repositories.syncOperations.append(toOperationRecord(operation));
          await repositories.transfers.updateProgress(
            this.session.tripId,
            transfer.id,
            resource.byteLength,
            transfer.nextChunkIndex,
            'completed',
            now,
          );
          await repositories.outbox.upsert(
            createOutboxRecord({
              id: this.ids.create('message', 'replica', operation.operationId),
              tripId: this.session.tripId,
              recipientMemberId: null,
              messageType: 'SYNC_OPERATION',
              payload: operation as unknown as JsonValue,
              dedupeKey: `operation:${operation.operationId}`,
              now,
            }),
          );
          const sender = await repositories.members.getByDeviceId(this.session.tripId, peerDeviceId);
          if (!sender) throw new SyncEngineError('TRANSFER_PEER_UNKNOWN', 'Transfer sender disappeared.', true);
          await repositories.outbox.upsert(
            createOutboxRecord({
              id: this.ids.create(
                'message',
                'verified',
                transfer.id,
                completionMessageId,
              ),
              tripId: this.session.tripId,
              recipientMemberId: sender.id,
              messageType: `${PROTOCOL_OUTBOX_PREFIX}RESOURCE_COMPLETE`,
              payload: {
                transferId: transfer.id,
                resourceId: resource.id,
                status: 'RECEIVER_VERIFIED',
                byteLength: resource.byteLength,
                sha256: resource.sha256,
                errorCode: null,
              },
              dedupeKey:
                `resource-complete:receiver:${transfer.id}:${completionMessageId}`,
              now,
            }),
          );
        });
        this.catalogState = applied.state;
        this.onEvent({ kind: 'catalog-changed', source: 'local-refresh', appliedOperationCount: 1 });
      });
      this.emitTransferProgress({
        ...transfer,
        state: 'completed',
        bytesTransferred: resource.byteLength,
      });
      await this.cancelSiblingDownloads(resource.id, transfer.id, now);
      this.clearResourceRetry(resource.id);
      this.onEvent({ kind: 'resource-available', resourceId: resource.id, localUri: stored.uri });
    } catch (error) {
      const syncError = this.asSyncError(error, 'RESOURCE_FINALIZATION_PAUSED', true);
      // Integrity mismatches return through the explicit rejection branches
      // above. Everything that reaches this catch is a persistence/finalize
      // boundary failure: retain the verified partial or deterministic target
      // so the sender's completion retry (or app restart) can adopt it.
      await this.data.repositories.transfers.markPaused(
        this.session.tripId,
        transfer.id,
        syncError.code,
        checkedNow(this.clock),
      );
      this.emitTransferProgress({ ...transfer, state: 'paused' });
      this.scheduleResourceRetry(transfer.resourceId);
      this.report(syncError);
      throw syncError;
    } finally {
      this.incomingReservations.delete(transfer.id);
    }
    await this.flushOutbox();
  }

  private async cancelSiblingDownloads(
    resourceId: string,
    completedTransferId: string,
    now: number,
  ): Promise<void> {
    let active: TransferRecord[];
    let resource: ResourceRecord | null = null;
    try {
      [active, resource] = await Promise.all([
        this.data.repositories.transfers.listActive(this.session.tripId),
        this.data.repositories.resources.getById(this.session.tripId, resourceId),
      ]);
    } catch (error) {
      this.report(this.asSyncError(error, 'SIBLING_TRANSFER_CLEANUP_FAILED', true));
      return;
    }
    for (const sibling of active) {
      if (
        sibling.id === completedTransferId ||
        sibling.direction !== 'download' ||
        sibling.resourceId !== resourceId
      ) continue;
      try {
        this.clearCompletionWatchdog(sibling.id);
        this.clearDownloadInactivityWatchdog(sibling.id);
        this.incomingReservations.delete(sibling.id);
        this.recoveryRequestedOffsets.delete(sibling.id);
        const cancelled = await this.data.repositories.transfers.markCancelled(
          this.session.tripId,
          sibling.id,
          'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
          now,
        );
        if (!cancelled) continue;
        await this.fileStore.discardIncoming(sibling.id).catch(() => undefined);
        this.emitTransferProgress({
          ...sibling,
          state: 'cancelled',
          lastError: 'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
          updatedAt: now,
        });
        if (resource) {
          await this.queueProtocolMessage(
            sibling.peerMemberId,
            'RESOURCE_COMPLETE',
            {
              transferId: assertParsed(parseTransferId(sibling.id)),
              resourceId: assertResourceId(resource.id),
              status: 'RECEIVER_REJECTED',
              byteLength: sibling.bytesTransferred,
              sha256: assertSha256(resource.sha256),
              errorCode: 'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
            } satisfies ResourceCompleteMessage,
            `resource-complete:sibling-cancelled:${sibling.id}`,
          );
        }
      } catch (error) {
        this.report(this.asSyncError(error, 'SIBLING_TRANSFER_CLEANUP_FAILED', true));
      }
    }
  }

  private async queueReceiverVerified(
    transfer: TransferRecord,
    resource: ResourceRecord,
    peer: MemberRecord,
    completionMessageId: string,
  ): Promise<void> {
    await this.queueProtocolMessage(
      peer.id,
      'RESOURCE_COMPLETE',
      {
        transferId: assertParsed(parseTransferId(transfer.id)),
        resourceId: assertResourceId(resource.id),
        status: 'RECEIVER_VERIFIED',
        byteLength: resource.byteLength,
        sha256: assertSha256(resource.sha256),
        errorCode: null,
      } satisfies ResourceCompleteMessage,
      `resource-complete:receiver:${transfer.id}:${completionMessageId}`,
    );
  }

  private async rejectCompletedDownload(
    transfer: TransferRecord,
    resource: ResourceRecord | null,
    peerDeviceId: string,
    code: string,
  ): Promise<void> {
    this.clearCompletionWatchdog(transfer.id);
    this.clearDownloadInactivityWatchdog(transfer.id);
    this.incomingReservations.delete(transfer.id);
    await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
    await this.data.repositories.transfers.markFailed(
      this.session.tripId,
      transfer.id,
      code,
      checkedNow(this.clock),
    );
    this.emitTransferProgress({ ...transfer, state: 'failed' });
    const peer = await this.data.repositories.members.getByDeviceId(this.session.tripId, peerDeviceId);
    if (peer) this.coolDownResourcePeer(transfer.resourceId, peer.deviceId);
    this.scheduleResourceRetry(transfer.resourceId);
    if (resource && peer) {
      await this.queueProtocolMessage(
        peer.id,
        'RESOURCE_COMPLETE',
        {
          transferId: assertParsed(parseTransferId(transfer.id)),
          resourceId: assertResourceId(resource.id),
          status: 'RECEIVER_REJECTED',
          byteLength: transfer.bytesTransferred,
          sha256: assertSha256(resource.sha256),
          errorCode: code,
        } satisfies ResourceCompleteMessage,
        `resource-complete:rejected:${transfer.id}:${code}`,
      );
      await this.flushOutbox();
    }
  }

  private async failDownload(transfer: TransferRecord, code: string): Promise<void> {
    this.clearCompletionWatchdog(transfer.id);
    this.clearDownloadInactivityWatchdog(transfer.id);
    this.incomingReservations.delete(transfer.id);
    await this.fileStore.discardIncoming(transfer.id).catch(() => undefined);
    await this.data.repositories.transfers.markFailed(
      this.session.tripId,
      transfer.id,
      code,
      checkedNow(this.clock),
    );
    this.emitTransferProgress({ ...transfer, state: 'failed' });
    const peer = await this.data.repositories.members
      .getById(this.session.tripId, transfer.peerMemberId)
      .catch(() => null);
    if (peer) this.coolDownResourcePeer(transfer.resourceId, peer.deviceId);
    this.scheduleResourceRetry(transfer.resourceId);
    this.report(new SyncEngineError(code, `Download '${transfer.id}' failed verification.`, true));
  }

  private armDownloadInactivityWatchdog(transferId: string, reset = true): void {
    if (!reset && this.downloadInactivityWatchdogs.has(transferId)) return;
    this.clearDownloadInactivityWatchdog(transferId);
    if (this.state !== 'running') return;
    const timer = setTimeout(() => {
      this.downloadInactivityWatchdogs.delete(transferId);
      const recovery = this.recoverInactiveDownload(transferId)
        .catch((error) => {
          this.report(this.asSyncError(error, 'DOWNLOAD_RECOVERY_FAILED', true));
        })
        .finally(() => {
          if (this.activeDownloadRecoveries.get(transferId) === recovery) {
            this.activeDownloadRecoveries.delete(transferId);
          }
        });
      this.activeDownloadRecoveries.set(transferId, recovery);
    }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
    this.downloadInactivityWatchdogs.set(transferId, timer);
  }

  private clearDownloadInactivityWatchdog(transferId: string): void {
    const timer = this.downloadInactivityWatchdogs.get(transferId);
    if (timer !== undefined) clearTimeout(timer);
    this.downloadInactivityWatchdogs.delete(transferId);
  }

  private clearAllDownloadInactivityWatchdogs(): void {
    for (const timer of this.downloadInactivityWatchdogs.values()) clearTimeout(timer);
    this.downloadInactivityWatchdogs.clear();
  }

  private async recoverInactiveDownload(transferId: string): Promise<void> {
    if (this.state !== 'running') return;
    const stalled = await this.data.repositories.transfers.getById(
      this.session.tripId,
      transferId,
    );
    if (
      !stalled ||
      stalled.direction !== 'download' ||
      stalled.state !== 'transferring'
    ) return;

    const now = checkedNow(this.clock);
    await this.data.repositories.transfers.markPaused(
      this.session.tripId,
      stalled.id,
      'DOWNLOAD_STALLED',
      now,
    );
    this.incomingReservations.delete(stalled.id);
    const paused = await this.data.repositories.transfers.getById(
      this.session.tripId,
      stalled.id,
    );
    if (!paused || paused.direction !== 'download' || !isRecoverableTransferState(paused.state)) {
      return;
    }
    const reconciled = await this.reconcileDownloadCheckpoint(paused, 'DOWNLOAD_STALLED');
    if (reconciled.state === 'failed') {
      this.scheduleResourceRetry(stalled.resourceId);
      return;
    }
    if (reconciled.bytesTransferred === reconciled.totalBytes) {
      await this.ensureDownloadFinalized(
        reconciled,
        `inactivity:${reconciled.id}:${reconciled.bytesTransferred}`,
      );
      return;
    }

    const [resource, stalledPeer] = await Promise.all([
      this.data.repositories.resources.getById(this.session.tripId, reconciled.resourceId),
      this.data.repositories.members.getById(this.session.tripId, reconciled.peerMemberId),
    ]);
    if (!resource || !stalledPeer) {
      this.scheduleResourceRetry(reconciled.resourceId);
      return;
    }
    this.coolDownResourcePeer(resource.id, stalledPeer.deviceId);
    let requested = false;
    try {
      const fallbackDeviceId = await this.resolveVerifiedResourcePeer(
        resource,
        stalledPeer.deviceId,
      );
      await this.queueResourceRequest(
        resource,
        fallbackDeviceId,
        this.downloadPriorities.get(reconciled.id) ?? resourcePriority(resource),
      );
      requested = true;
    } catch {
      if (this.admittedDevices.has(stalledPeer.deviceId)) {
        await this.queueResumeRequest(
          reconciled,
          resource,
          stalledPeer,
          this.downloadPriorities.get(reconciled.id) ?? resourcePriority(resource),
        );
        requested = true;
      }
    }
    if (requested) {
      this.clearResourceRetry(resource.id);
      await this.flushOutbox();
    } else {
      this.scheduleResourceRetry(resource.id);
    }
    this.report(
      new SyncEngineError(
        'DOWNLOAD_STALLED',
        `Transfer '${reconciled.id}' stopped making progress and was resumed from its durable checkpoint.`,
        true,
        { transferId: reconciled.id, bytesTransferred: reconciled.bytesTransferred },
      ),
    );
  }

  private armCompletionWatchdog(transferId: string, peerDeviceId: string): void {
    this.clearCompletionWatchdog(transferId);
    const timer = setTimeout(() => {
      this.completionWatchdogs.delete(transferId);
      void this.replayCompletionRequest(transferId, peerDeviceId).catch((error) => {
        this.report(this.asSyncError(error, 'COMPLETION_REPLAY_FAILED', true));
      });
    }, COMPLETION_WATCHDOG_MS);
    this.completionWatchdogs.set(transferId, timer);
  }

  private clearCompletionWatchdog(transferId: string): void {
    const timer = this.completionWatchdogs.get(transferId);
    if (timer !== undefined) clearTimeout(timer);
    this.completionWatchdogs.delete(transferId);
  }

  private clearAllCompletionWatchdogs(): void {
    for (const timer of this.completionWatchdogs.values()) clearTimeout(timer);
    this.completionWatchdogs.clear();
  }

  private async replayCompletionRequest(
    transferId: string,
    peerDeviceId: string,
  ): Promise<void> {
    if (this.state !== 'running' || !this.admittedDevices.has(peerDeviceId)) return;
    const transfer = await this.data.repositories.transfers.getById(
      this.session.tripId,
      transferId,
    );
    if (
      !transfer ||
      transfer.direction !== 'download' ||
      transfer.state !== 'verifying' ||
      transfer.bytesTransferred !== transfer.totalBytes
    ) return;
    const [resource, peer] = await Promise.all([
      this.data.repositories.resources.getById(this.session.tripId, transfer.resourceId),
      this.data.repositories.members.getById(this.session.tripId, transfer.peerMemberId),
    ]);
    if (!resource || !peer || peer.deviceId !== peerDeviceId) return;
    this.recoveryRequestedOffsets.delete(transfer.id);
    await this.queueResumeRequest(
      transfer,
      resource,
      peer,
      this.downloadPriorities.get(transfer.id) ?? resourcePriority(resource),
    );
    this.report(
      new SyncEngineError(
        'RESOURCE_COMPLETION_TIMEOUT',
        `Transfer '${transfer.id}' reached 100% but completion was not confirmed; replaying it.`,
        true,
        { transferId: transfer.id, peerDeviceId },
      ),
    );
    await this.flushOutbox();
  }

  private acquireChunkPermit(transferId: string): Promise<() => void> {
    if (
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.uploadPreemptionRequests.has(transferId)
    ) {
      return Promise.reject(
        new SyncEngineError(
          this.uploadPreemptionRequests.has(transferId)
            ? 'UPLOAD_PREEMPTED'
            : 'ENGINE_STOPPED',
          'Encrypted chunk send was cancelled before it entered the shared socket.',
          true,
        ),
      );
    }
    const priority =
      this.activeUploadPriorities.get(transferId) ??
      this.uploadPriorities.get(transferId) ??
      'BACKGROUND_ORIGINAL';
    return new Promise<() => void>((resolve, reject) => {
      this.pendingChunkPermits.push({
        transferId,
        priority,
        sequence: this.nextChunkPermitSequence++,
        resolve,
        reject,
      });
      this.pumpChunkPermits();
    });
  }

  private pumpChunkPermits(): void {
    this.pendingChunkPermits.sort(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority) ||
        left.sequence - right.sequence,
    );
    while (
      this.activeChunkPermits < MAX_GLOBAL_IN_FLIGHT_CHUNKS &&
      this.pendingChunkPermits.length > 0
    ) {
      const pending = this.pendingChunkPermits.shift()!;
      if (this.uploadPreemptionRequests.has(pending.transferId)) {
        pending.reject(
          new SyncEngineError(
            'UPLOAD_PREEMPTED',
            'Background upload yielded to a user-visible transfer.',
            true,
          ),
        );
        continue;
      }
      this.activeChunkPermits += 1;
      let released = false;
      pending.resolve(() => {
        if (released) return;
        released = true;
        this.activeChunkPermits = Math.max(0, this.activeChunkPermits - 1);
        this.pumpChunkPermits();
      });
    }
  }

  private cancelChunkPermitsForTransfer(transferId: string, code: string): void {
    for (let index = this.pendingChunkPermits.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingChunkPermits[index];
      if (pending.transferId !== transferId) continue;
      this.pendingChunkPermits.splice(index, 1);
      pending.reject(
        new SyncEngineError(
          code,
          `Chunk for transfer '${transferId}' was cancelled before send.`,
          true,
        ),
      );
    }
  }

  private cancelAllChunkPermits(code: string): void {
    const pendingPermits = this.pendingChunkPermits.splice(0);
    for (const pending of pendingPermits) {
      pending.reject(
        new SyncEngineError(code, 'Chunk was cancelled before send.', true),
      );
    }
  }

  private cancelChunkAcksForTransfer(transferId: string, code: string): void {
    for (const [messageId, pending] of this.pendingChunkAcks) {
      if (pending.transferId !== transferId) continue;
      this.rejectPendingChunkAck(messageId, pending, code);
    }
  }

  private cancelChunkAcksForPeer(peerDeviceId: string, code: string): void {
    for (const [messageId, pending] of this.pendingChunkAcks) {
      if (pending.peerDeviceId !== peerDeviceId) continue;
      this.rejectPendingChunkAck(messageId, pending, code);
    }
  }

  private cancelAllChunkAcks(code: string): void {
    for (const [messageId, pending] of this.pendingChunkAcks) {
      this.rejectPendingChunkAck(messageId, pending, code);
    }
  }

  private rejectPendingChunkAck(
    messageId: string,
    pending: PendingChunkAck,
    code: string,
  ): void {
    clearTimeout(pending.timer);
    this.pendingChunkAcks.delete(messageId);
    pending.reject(
      new SyncEngineError(code, `Chunk '${messageId}' was interrupted before acknowledgement.`, true),
    );
  }

  private emitTransferProgress(transfer: TransferRecord): void {
    if (
      transfer.state === 'completed' ||
      transfer.state === 'failed' ||
      transfer.state === 'cancelled'
    ) {
      // These maps are resume hints, not durable state. Keeping them after a
      // terminal attempt caused memory to grow with every photo in long trips.
      this.pendingUploads.delete(transfer.id);
      this.uploadPriorities.delete(transfer.id);
      this.downloadPriorities.delete(transfer.id);
      this.uploadAttemptKeys.delete(transfer.id);
      this.uploadPreemptionRequests.delete(transfer.id);
      this.recoveryRequestedOffsets.delete(transfer.id);
      this.incomingReservations.delete(transfer.id);
      this.clearCompletionWatchdog(transfer.id);
      this.clearDownloadInactivityWatchdog(transfer.id);
      this.cancelChunkPermitsForTransfer(transfer.id, 'TRANSFER_TERMINAL');
    }
    this.onEvent({
      kind: 'resource-progress',
      transferId: transfer.id,
      resourceId: transfer.resourceId,
      direction: transfer.direction,
      state: transfer.state,
      bytesTransferred: transfer.bytesTransferred,
      totalBytes: transfer.totalBytes,
    });
  }

  private async reserveIncomingCapacity(
    transfer: TransferRecord,
    resource: ResourceRecord,
  ): Promise<void> {
    const remainingBytes = Math.max(0, resource.byteLength - transfer.bytesTransferred);
    const reservedByOthers = [...this.incomingReservations.entries()].reduce(
      (sum, [transferId, bytes]) => transferId === transfer.id ? sum : sum + bytes,
      0,
    );
    await this.assertIncomingCapacity(resource, remainingBytes + reservedByOthers);
    this.incomingReservations.set(transfer.id, remainingBytes);
  }

  private async assertIncomingCapacity(
    resource: ResourceRecord,
    requestedBytes: number,
  ): Promise<void> {
    const availableBytes = normalizeAvailableStorage(await this.availableStorageBytes());
    const requiredBytes = requestedBytes + MIN_FREE_STORAGE_RESERVE_BYTES;
    if (availableBytes < requiredBytes) {
      throw new SyncEngineError(
        'INSUFFICIENT_STORAGE',
        'Not enough free storage is available for this resource.',
        true,
        {
          resourceId: resource.id,
          availableBytes,
          requiredBytes,
        },
      );
    }
  }

  private async queueProtocolMessage(
    recipientMemberId: string,
    type: Exclude<ProtocolMessageType, 'HELLO' | 'HEARTBEAT' | 'RESOURCE_CHUNK'>,
    payload: JsonValue,
    dedupeKey: string,
  ): Promise<void> {
    const now = checkedNow(this.clock);
    await this.data.repositories.outbox.upsert(
      createOutboxRecord({
        id: this.ids.create('message', type, dedupeKey),
        tripId: this.session.tripId,
        recipientMemberId,
        messageType: `${PROTOCOL_OUTBOX_PREFIX}${type}`,
        payload,
        dedupeKey,
        now,
      }),
    );
  }

  private async requireTrip(): Promise<TripRecord> {
    const trip = await this.data.repositories.trips.getById(this.session.tripId);
    if (!trip) throw new SyncEngineError('TRIP_NOT_FOUND', 'Trip disappeared while syncing.', false);
    return trip;
  }

  private setState(state: SyncEngineState): void {
    this.state = state;
    this.onEvent({ kind: 'state', state });
  }

  private report(error: SyncEngineError): void {
    this.onEvent({ kind: 'error', error });
  }

  private asSyncError(error: unknown, code: string, recoverable: boolean): SyncEngineError {
    if (error instanceof SyncEngineError) return error;
    return new SyncEngineError(code, errorMessage(error), recoverable, {}, { cause: error });
  }
}

const systemScheduler: SyncEngineScheduler = {
  setInterval: (task, intervalMs) => setInterval(task, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const defaultSyncEngineIdFactory: SyncEngineIdFactory = {
  create: (kind, ...parts) => {
    const digest = sha256Hex(textEncoder.encode(['airmesh-sync-v1', kind, ...parts].join('\0')));
    return `${kind}_${digest.slice(0, 32)}`;
  },
};

function positiveInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 100) {
    throw new RangeError(`${name} must be a safe integer of at least 100 ms.`);
  }
  return value;
}

function normalizeAvailableStorage(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function hasOriginalStorageCapacity(availableBytes: number, resourceBytes: number): boolean {
  const normalizedAvailableBytes = normalizeAvailableStorage(availableBytes);
  return (
    normalizedAvailableBytes >= MIN_FREE_STORAGE_RESERVE_BYTES &&
    resourceBytes <= normalizedAvailableBytes - MIN_FREE_STORAGE_RESERVE_BYTES
  );
}

function recordDownloadDemand(
  usage: DownloadDemandUsage,
  priority: ResourcePriority,
): void {
  switch (priority) {
    case 'THUMBNAIL':
      usage.thumbnails += 1;
      return;
    case 'USER_VISIBLE_ORIGINAL':
      usage.userVisibleOriginals += 1;
      return;
    case 'BACKGROUND_ORIGINAL':
      usage.backgroundOriginals += 1;
  }
}

function withoutDownloadDemand(
  usage: DownloadDemandUsage,
  priority: ResourcePriority,
): DownloadDemandUsage {
  const next = { ...usage };
  switch (priority) {
    case 'THUMBNAIL':
      next.thumbnails = Math.max(0, next.thumbnails - 1);
      break;
    case 'USER_VISIBLE_ORIGINAL':
      next.userVisibleOriginals = Math.max(0, next.userVisibleOriginals - 1);
      break;
    case 'BACKGROUND_ORIGINAL':
      next.backgroundOriginals = Math.max(0, next.backgroundOriginals - 1);
      break;
  }
  return next;
}

function priorityRank(priority: ResourcePriority): number {
  switch (priority) {
    case 'THUMBNAIL':
      return 0;
    case 'USER_VISIBLE_ORIGINAL':
      return 1;
    case 'BACKGROUND_ORIGINAL':
      return 2;
  }
}

function resourcePriority(resource: ResourceRecord): ResourcePriority {
  return resource.kind === 'THUMBNAIL' ? 'THUMBNAIL' : 'BACKGROUND_ORIGINAL';
}

function isRecoverableTransferState(state: TransferRecord['state']): boolean {
  return state === 'queued' || state === 'transferring' || state === 'verifying' || state === 'paused';
}

function checkedNow(clock: SyncEngineClock): number {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Clock returned an invalid timestamp.');
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationHydrationOrder(left: SyncOperation, right: SyncOperation): number {
  if (left.originDeviceId === right.originDeviceId) {
    return left.originSequence - right.originSequence;
  }
  const priority = (operation: SyncOperation): number => {
    if (operation.kind === 'TRIP_CREATED') return 0;
    if (operation.kind === 'MEMBER_JOINED') return 1;
    return 2;
  };
  return (
    priority(left) - priority(right) ||
    left.createdAtMs - right.createdAtMs ||
    left.originDeviceId.localeCompare(right.originDeviceId) ||
    left.originSequence - right.originSequence
  );
}

function parseOperationRecord(record: SyncOperationRecord): SyncOperation {
  const { originIdentityPublicKey, originSignature, ...base } = record;
  return assertParsed(
    parseSyncOperation({
      ...base,
      ...(originIdentityPublicKey && originSignature
        ? {
            originIdentityPublicKey,
            originSignature,
          }
        : {}),
    }),
  );
}

function parseOutboxOperation(payload: JsonValue): SyncOperation {
  if (isJsonObject(payload) && 'operation' in payload) {
    return assertParsed(parseSyncOperation(payload.operation));
  }
  return assertParsed(parseSyncOperation(payload));
}

function acceptedOfferTransferId(payload: JsonValue): TransferId | null {
  if (!isJsonObject(payload) || payload.accepted !== true) return null;
  return assertParsed(parseTransferId(payload.transferId));
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectRendezvousPeer(
  resourceId: string,
  requesterDeviceId: string,
  candidates: readonly string[],
): string | null {
  let selected: string | null = null;
  let selectedScore = '';
  for (const candidate of new Set(candidates)) {
    const score = sha256Hex(
      textEncoder.encode(`${resourceId}\u0000${requesterDeviceId}\u0000${candidate}`),
    );
    if (
      selected === null ||
      score > selectedScore ||
      (score === selectedScore && candidate < selected)
    ) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

function toOperationRecord(operation: SyncOperation): SyncOperationRecord {
  return {
    schemaVersion: operation.schemaVersion,
    operationId: operation.operationId,
    tripId: operation.tripId,
    originDeviceId: operation.originDeviceId,
    originSequence: operation.originSequence,
    actorMemberId: operation.actorMemberId,
    membershipEpoch: operation.membershipEpoch,
    createdAtMs: operation.createdAtMs,
    originIdentityPublicKey: operation.originIdentityPublicKey ?? null,
    originSignature: operation.originSignature ?? null,
    kind: operation.kind,
    payload: operation.payload as unknown as JsonValue,
  };
}

function toTripRecord(trip: Trip, existing: TripRecord | null): TripRecord {
  return {
    ...trip,
    isActive: existing?.isActive ?? false,
  };
}

function toMemberRecord(member: Member): MemberRecord {
  return { ...member };
}

function toMediaRecord(item: MediaItem, sourceAssetId: string | null): MediaRecord {
  return { ...item, sourceAssetId };
}

function toResourceRecord(
  resource: MediaResource,
  existing: ResourceRecord | null,
): ResourceRecord {
  return {
    ...resource,
    availability: existing?.availability ?? 'missing',
    localUri: existing?.localUri ?? null,
    verifiedAtMs: existing?.verifiedAtMs ?? null,
    updatedAtMs: existing?.updatedAtMs ?? resource.createdAtMs,
  };
}

function toReplicaReceiptRecord(receipt: ReplicaReceipt): ReplicaReceiptRecord {
  return { ...receipt };
}

function toDomainResource(record: ResourceRecord): MediaResource {
  return assertParsed(
    parseMediaResource({
      schemaVersion: record.schemaVersion,
      id: record.id,
      tripId: record.tripId,
      mediaId: record.mediaId,
      kind: record.kind,
      mimeType: record.mimeType,
      fileExtension: record.fileExtension,
      byteLength: record.byteLength,
      sha256: record.sha256,
      width: record.width,
      height: record.height,
      createdAtMs: record.createdAtMs,
    }),
  );
}

function sameResourceManifest(record: ResourceRecord, resource: MediaResource): boolean {
  return (
    record.id === resource.id &&
    record.tripId === resource.tripId &&
    record.mediaId === resource.mediaId &&
    record.kind === resource.kind &&
    record.mimeType === resource.mimeType &&
    record.fileExtension === resource.fileExtension &&
    record.byteLength === resource.byteLength &&
    record.sha256 === resource.sha256 &&
    record.width === resource.width &&
    record.height === resource.height &&
    record.createdAtMs === resource.createdAtMs
  );
}

function createOutboxRecord(input: {
  id: string;
  tripId: string;
  recipientMemberId: string | null;
  messageType: string;
  payload: JsonValue;
  dedupeKey: string | null;
  now: number;
  availableAt?: number;
}): OutboxRecord {
  return {
    id: input.id,
    tripId: input.tripId,
    recipientMemberId: input.recipientMemberId,
    messageType: input.messageType,
    payload: input.payload,
    dedupeKey: input.dedupeKey,
    state: 'pending',
    attemptCount: 0,
    availableAt: input.availableAt ?? input.now,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function assertResourceId(value: string) {
  return assertParsed(parseResourceId(value));
}

function assertSha256(value: string) {
  return assertParsed(parseSha256Hex(value));
}
