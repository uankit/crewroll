import { Paths } from 'expo-file-system';

import type { TransferBenchmarkRecorder } from '@/application/diagnostics/TransferBenchmarkRecorder';
import type { DeviceIdentityService } from '@/application/identity/DeviceIdentityService';
import { sha256Hex } from '@/application/media/contentIdentity';
import { NobleFrameCrypto } from '@/application/security/NobleFrameCrypto';
import { verifyTripInviteSignature } from '@/application/security/inviteAuthenticity';
import { signSyncOperation } from '@/application/security/operationAuthenticity';
import type { StoredTripKey, TripKeyVault } from '@/application/security/TripKeyVault';
import { PersistentSequenceAllocator } from '@/application/sequences/PersistentSequenceAllocator';
import {
  DataLayerReplayGuard,
  DataLayerWireCounter,
  SyncEngine,
  type AdmissionController,
  type AdmissionDecision,
  type AdmissionRequest,
  type SyncEngineEvent,
} from '@/application/sync';
import type { SyncDriver, SyncSnapshot } from '@/application/runtime/AirMeshRuntime';
import { syncStateAfterTransportError } from '@/application/runtime/syncState';
import type { TripSession } from '@/application/trips/TripLifecycleService';
import { DOMAIN_SCHEMA_VERSION, PROTOCOL_VERSION } from '@/core/constants';
import { parseMember, parseSyncOperation, type Member } from '@/core/domain';
import {
  parseDeviceId,
  parseMemberId,
  parseOperationId,
  parseTripId,
} from '@/core/ids';
import { decodeInviteDeepLink } from '@/core/invite';
import { assertParsed } from '@/core/validation';
import type { AirMeshDataLayer, ResourceRecord } from '@/data';
import type { ChunkedFileStore } from '@/platform/files';
import {
  type Transport,
  type TransportEvent,
  type TransportSubscription,
} from '@/platform/transport';

type RuntimeSubscription = ReturnType<SyncDriver['subscribe']>;

export interface LocalSyncTransportContext {
  readonly session: TripSession;
  readonly groupSecret: StoredTripKey['groupSecret'];
}

export interface LocalSyncDriverDependencies {
  data: AirMeshDataLayer;
  identity: DeviceIdentityService;
  fileStore: ChunkedFileStore;
  keys: TripKeyVault;
  transportFactory: (context: LocalSyncTransportContext) => Transport;
  transportEndpoint: (session: TripSession) => string;
  transferBenchmarks?: TransferBenchmarkRecorder;
  now?: () => number;
}

/** Production sync adapter: selected transport, encrypted frames, and durable reconciliation. */
export class LocalSyncDriver implements SyncDriver {
  private current: SyncSnapshot = {
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
  private readonly peers = new Set<string>();
  private readonly transportPeers = new Set<string>();
  private readonly transportFactory: (context: LocalSyncTransportContext) => Transport;
  private readonly transportEndpoint: (session: TripSession) => string;
  private readonly now: () => number;
  private engine: SyncEngine | null = null;
  private transport: Transport | null = null;
  private transportSubscription: TransportSubscription | null = null;
  private frameCrypto: NobleFrameCrypto | null = null;
  private session: TripSession | null = null;
  private pendingRefresh: Promise<void> | null = null;
  private progressNotificationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly benchmarkProgressSignatures = new Map<string, string>();

  constructor(private readonly dependencies: LocalSyncDriverDependencies) {
    this.transportFactory = dependencies.transportFactory;
    this.transportEndpoint = dependencies.transportEndpoint;
    this.now = dependencies.now ?? Date.now;
  }

  get snapshot(): SyncSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: SyncSnapshot) => void): RuntimeSubscription {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  async start(session: TripSession): Promise<void> {
    await this.stop();
    const transportEndpoint = this.transportEndpoint(session);
    this.session = session;
    this.peers.clear();
    this.transportPeers.clear();
    this.benchmarkProgressSignatures.clear();
    this.publish({
      state: 'connecting',
      peerDeviceIds: [],
      pendingOutbox: 0,
      contentRevision: this.current.contentRevision,
      transferRevision: this.current.transferRevision,
      lastError: null,
      diagnostics: {
        role: session.isCoordinator ? 'coordinator' : 'member',
        advertisedEndpoint: transportEndpoint,
        transportState: 'connecting',
        transportPeerDeviceIds: [],
        reconnectAttempt: 0,
        pendingOutbox: 0,
        pendingTransfers: 0,
        lastError: null,
      },
    });

    let engine: SyncEngine | null = null;
    try {
      const tripId = assertParsed(parseTripId(session.trip.id));
      const localMemberId = assertParsed(parseMemberId(session.localMember.id));
      const localDeviceId = assertParsed(parseDeviceId(session.localMember.deviceId));
      const trustedCoordinatorDeviceId = assertParsed(
        parseDeviceId(session.coordinatorDeviceId),
      );
      const storedKey = await this.dependencies.keys.getCurrent(tripId);
      if (!storedKey || storedKey.handle.keyEpoch !== session.trip.membershipEpoch) {
        throw new Error('The current trip encryption key is missing or has the wrong epoch.');
      }

      const transport = this.transportFactory({ session, groupSecret: storedKey.groupSecret });
      this.transport = transport;
      this.transportSubscription = transport.subscribe((event) =>
        this.onTransportEvent(event),
      );
      const operationSequenceAllocator = new PersistentSequenceAllocator(
        this.dependencies.data,
        'operation',
      );
      const frameCrypto = new NobleFrameCrypto(this.dependencies.keys);
      this.frameCrypto = frameCrypto;
      engine = new SyncEngine({
        session: {
          tripId,
          localMemberId,
          localDeviceId,
          trustedCoordinatorDeviceId,
          localIdentityPublicKey: session.localMember.identityPublicKey,
          trustedCoordinatorIdentityPublicKey: session.coordinatorIdentityPublicKey,
          admissionInviteLink: session.admissionInviteLink,
          endpoint: transportEndpoint,
          isCoordinator: session.isCoordinator,
          key: storedKey.handle,
        },
        data: this.dependencies.data,
        transport,
        fileStore: this.dependencies.fileStore,
        crypto: frameCrypto,
        identity: this.dependencies.identity,
        wireCounter: new DataLayerWireCounter(this.dependencies.data),
        replayGuard: new DataLayerReplayGuard(this.dependencies.data),
        operationSequenceAllocator,
        admission: session.isCoordinator
          ? new CoordinatorAdmissionController({
              data: this.dependencies.data,
              identity: this.dependencies.identity,
              keys: this.dependencies.keys,
              session,
              operationSequenceAllocator,
              now: this.now,
            })
          : undefined,
        availableStorageBytes: async () =>
          Math.max(0, Math.trunc(Paths.availableDiskSpace)),
        onEvent: (event) => this.onEngineEvent(event),
      });
      this.engine = engine;

      await this.refreshPendingOutbox(false);
      await engine.start();
    } catch (error) {
      this.engine = null;
      await engine?.stop().catch(() => undefined);
      this.frameCrypto?.clearCachedKeys();
      this.frameCrypto = null;
      this.transportSubscription?.remove();
      this.transportSubscription = null;
      try {
        this.transport?.disconnect();
      } catch {
        // Preserve the initiating error; disconnect is best-effort cleanup here.
      }
      this.transport = null;
      this.session = null;
      this.peers.clear();
      this.transportPeers.clear();
      this.benchmarkProgressSignatures.clear();
      const message = errorMessage(error);
      this.publish({
        ...this.current,
        state: 'error',
        peerDeviceIds: [],
        lastError: message,
        diagnostics: {
          ...this.current.diagnostics,
          transportState: 'stopped',
          transportPeerDeviceIds: [],
          lastError: {
            source: 'sync',
            code: 'SYNC_START_FAILED',
            message,
            atMs: this.now(),
          },
        },
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    try {
      if (engine) await engine.stop();
    } finally {
      this.frameCrypto?.clearCachedKeys();
      this.frameCrypto = null;
      this.transportSubscription?.remove();
      this.transportSubscription = null;
      try {
        this.transport?.disconnect();
      } catch {
        // SyncEngine owns normal disconnect errors; this is an idempotent fallback.
      }
      this.transport = null;
      this.session = null;
      this.peers.clear();
      this.transportPeers.clear();
      this.benchmarkProgressSignatures.clear();
      if (this.progressNotificationTimer) clearTimeout(this.progressNotificationTimer);
      this.progressNotificationTimer = null;
      this.publish({
        state: this.current.state === 'idle' ? 'idle' : 'stopped',
        peerDeviceIds: [],
        pendingOutbox: this.current.pendingOutbox,
        contentRevision: this.current.contentRevision,
        transferRevision: this.current.transferRevision,
        lastError: this.current.lastError,
        diagnostics: {
          ...this.current.diagnostics,
          transportState: 'stopped',
          transportPeerDeviceIds: [],
          reconnectAttempt: 0,
        },
      });
    }
  }

  async flush(): Promise<void> {
    await this.engine?.flushOutbox();
    await this.refreshPendingOutbox();
  }

  async requestResource(resource: ResourceRecord): Promise<void> {
    const engine = this.engine;
    if (!engine) throw new Error('Local sync is not running.');
    await engine.requestOriginal(resource.mediaId);
    await this.refreshPendingOutbox();
  }

  private onTransportEvent(event: TransportEvent): void {
    if (event.kind === 'state') {
      const state = mapTransportState(event.snapshot.state);
      const previousError = this.current.diagnostics.lastError;
      const nextError = state === 'connected'
        ? null
        : event.snapshot.reason
          ? previousError?.message === event.snapshot.reason
            ? previousError
            : {
                source: 'state' as const,
                code: 'TRANSPORT_STATE',
                message: event.snapshot.reason,
                atMs: this.now(),
              }
          : previousError;
      this.publish({
        ...this.current,
        state,
        lastError: event.snapshot.reason ?? (state === 'connected' ? null : this.current.lastError),
        diagnostics: {
          ...this.current.diagnostics,
          transportState: event.snapshot.state,
          reconnectAttempt: event.snapshot.reconnectAttempt,
          lastError: nextError,
        },
      });
    } else if (event.kind === 'error') {
      this.publish({
        ...this.current,
        // A recoverable peer error does not imply that the coordinator's
        // listening server stopped. State events remain the source of truth
        // for connecting/reconnecting transitions.
        state: syncStateAfterTransportError(this.current.state, event.recoverable),
        lastError: event.message,
        diagnostics: {
          ...this.current.diagnostics,
          lastError: {
            source: event.source,
            code: event.code,
            message: event.message,
            atMs: this.now(),
          },
        },
      });
    } else if (event.kind === 'peers') {
      this.transportPeers.clear();
      for (const peerId of event.peerIds) this.transportPeers.add(peerId);
      this.publishTransportPeers();
    } else if (event.kind === 'peer-joined') {
      this.transportPeers.add(event.peerId);
      this.publishTransportPeers();
    } else if (event.kind === 'peer-left') {
      this.transportPeers.delete(event.peerId);
      this.publishTransportPeers();
    }
  }

  private onEngineEvent(event: SyncEngineEvent): void {
    if (event.kind === 'peer-admitted') {
      this.peers.add(event.deviceId);
      this.publishPeers();
      return;
    }
    if (event.kind === 'peer-left') {
      this.peers.delete(event.deviceId);
      this.publishPeers();
      return;
    }
    if (event.kind === 'error') {
      const message = event.error.message;
      this.publish({
        ...this.current,
        state: event.error.recoverable ? this.current.state : 'error',
        lastError: message,
        diagnostics: {
          ...this.current.diagnostics,
          lastError: {
            source: 'sync',
            code: event.error.code,
            message,
            atMs: this.now(),
          },
        },
      });
      return;
    }
    if (event.kind === 'state' && event.state === 'stopped') {
      this.publish({ ...this.current, state: 'stopped' });
      return;
    }

    if (event.kind === 'resource-progress') {
      const tripId = this.session?.trip.id;
      const progressBucket = event.totalBytes > 0
        ? Math.min(4, Math.floor((event.bytesTransferred * 4) / event.totalBytes))
        : event.state === 'completed' ? 4 : 0;
      const benchmarkSignature = `${event.state}:${progressBucket}`;
      if (tripId && this.benchmarkProgressSignatures.get(event.transferId) !== benchmarkSignature) {
        this.benchmarkProgressSignatures.set(event.transferId, benchmarkSignature);
        void this.dependencies.transferBenchmarks
          ?.observeTransfer(tripId, event.transferId)
          .catch(() => undefined);
      }
      if (!this.progressNotificationTimer) {
        this.progressNotificationTimer = setTimeout(() => {
          this.progressNotificationTimer = null;
          this.current = {
            ...this.current,
            transferRevision: this.current.transferRevision + 1,
          };
          void this.refreshPendingOutbox().catch((error) => this.publishSyncError(error));
        }, 250);
      }
      return;
    }
    if (event.kind === 'outbox-changed') {
      void this.refreshPendingOutbox().catch((error) => this.publishSyncError(error));
      return;
    }
    if (event.kind === 'catalog-changed' || event.kind === 'resource-available') {
      const tripId = this.session?.trip.id;
      if (event.kind === 'resource-available' && tripId) {
        void this.dependencies.transferBenchmarks
          ?.observeResourceReady(tripId, event.resourceId)
          .catch(() => undefined);
      }
      this.current = {
        ...this.current,
        contentRevision: this.current.contentRevision + 1,
        transferRevision: this.current.transferRevision + 1,
      };
      void this.refreshPendingOutbox(false)
        .then(() => this.notify())
        .catch((error) => this.publishSyncError(error));
    }
  }

  private publishPeers(): void {
    this.publish({ ...this.current, peerDeviceIds: [...this.peers].sort() });
  }

  private publishTransportPeers(): void {
    this.publish({
      ...this.current,
      diagnostics: {
        ...this.current.diagnostics,
        transportPeerDeviceIds: [...this.transportPeers].sort(),
      },
    });
  }

  private refreshPendingOutbox(emit = true): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    const session = this.session;
    if (!session) return Promise.resolve();
    this.pendingRefresh = Promise.all([
      this.dependencies.data.repositories.outbox.countUndelivered(session.trip.id),
      this.dependencies.data.repositories.transfers.listActive(session.trip.id),
    ])
      .then(([pendingOutbox, transfers]) => {
        if (this.session?.trip.id === session.trip.id) {
          const next = {
            ...this.current,
            pendingOutbox,
            diagnostics: {
              ...this.current.diagnostics,
              pendingOutbox,
              pendingTransfers: transfers.length,
            },
          };
          if (emit) this.publish(next);
          else this.current = next;
        }
      })
      .finally(() => {
        this.pendingRefresh = null;
      });
    return this.pendingRefresh;
  }

  private publish(snapshot: SyncSnapshot): void {
    this.current = snapshot;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.current);
  }

  private publishSyncError(error: unknown): void {
    const message = errorMessage(error);
    this.publish({
      ...this.current,
      state: 'error',
      lastError: message,
      diagnostics: {
        ...this.current.diagnostics,
        lastError: {
          source: 'sync',
          code: 'DIAGNOSTICS_REFRESH_FAILED',
          message,
          atMs: this.now(),
        },
      },
    });
  }
}

interface CoordinatorAdmissionDependencies {
  data: AirMeshDataLayer;
  identity: DeviceIdentityService;
  keys: TripKeyVault;
  session: TripSession;
  operationSequenceAllocator: PersistentSequenceAllocator;
  now: () => number;
}

export class CoordinatorAdmissionController implements AdmissionController {
  constructor(private readonly dependencies: CoordinatorAdmissionDependencies) {}

  async decide(request: AdmissionRequest): Promise<AdmissionDecision> {
    if (!request.isCoordinator || !this.dependencies.session.isCoordinator) {
      return rejectAdmission('NOT_COORDINATOR', 'Only the trip coordinator may admit a member.');
    }
    const now = checkedNow(this.dependencies.now);
    const inviteLink = await this.dependencies.keys.getInvite(
      assertParsed(parseTripId(request.trip.id)),
    );
    if (!inviteLink) {
      return rejectAdmission('INVITE_UNAVAILABLE', 'The coordinator invite is unavailable.');
    }
    const parsedInvite = decodeInviteDeepLink(inviteLink, { nowMs: now });
    if (!parsedInvite.ok) {
      return rejectAdmission('INVITE_EXPIRED', 'The trip invite has expired or is invalid.');
    }
    const invite = parsedInvite.value;
    const presentedLink = request.hello.admissionInviteLink;
    if (!presentedLink) {
      return rejectAdmission('ADMISSION_TICKET_REQUIRED', 'A current signed invite is required.');
    }
    const parsedPresented = decodeInviteDeepLink(presentedLink, { nowMs: now });
    if (
      !parsedPresented.ok ||
      !verifyTripInviteSignature(invite, this.dependencies.identity) ||
      !verifyTripInviteSignature(parsedPresented.value, this.dependencies.identity)
    ) {
      return rejectAdmission('INVALID_ADMISSION_TICKET', 'The signed admission ticket is invalid or expired.');
    }
    const presented = parsedPresented.value;
    if (
      invite.tripId !== request.trip.id ||
      invite.inviterDeviceId !== this.dependencies.session.coordinatorDeviceId ||
      invite.membershipEpoch !== request.trip.membershipEpoch ||
      request.hello.membershipEpoch !== request.trip.membershipEpoch ||
      request.transportPeerId !== request.hello.deviceId ||
      !request.hello.supportedProtocolVersions.includes(PROTOCOL_VERSION) ||
      presented.tripId !== invite.tripId ||
      presented.inviteId !== invite.inviteId ||
      presented.inviterMemberId !== invite.inviterMemberId ||
      presented.inviterDeviceId !== invite.inviterDeviceId ||
      presented.inviterIdentityPublicKey !== invite.inviterIdentityPublicKey ||
      presented.membershipEpoch !== invite.membershipEpoch ||
      presented.issuedAtMs !== invite.issuedAtMs ||
      presented.expiresAtMs !== invite.expiresAtMs ||
      presented.groupSecret !== invite.groupSecret ||
      presented.endpointHint !== invite.endpointHint ||
      presented.signature !== invite.signature
    ) {
      return rejectAdmission('INVITE_CONTEXT_MISMATCH', 'Join identity does not match this invite.');
    }
    if (
      request.currentMembers.some(
        (member) =>
          member.id === request.hello.memberId ||
          ((member.status === 'ACTIVE' || member.status === 'LEAVING') &&
            member.identityPublicKey === request.hello.identityPublicKey),
      )
    ) {
      return rejectAdmission('MEMBER_IDENTITY_CONFLICT', 'This member identity is already in use.');
    }

    const member = assertParsed(
      parseMember({
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        id: request.hello.memberId,
        tripId: request.trip.id,
        deviceId: request.hello.deviceId,
        displayName: request.hello.displayName,
        identityPublicKey: request.hello.identityPublicKey,
        role: 'MEMBER',
        status: 'ACTIVE',
        replicaRole: request.currentMembers.some(
          (candidate) =>
            candidate.status === 'ACTIVE' && candidate.replicaRole === 'KEEPER_SECONDARY',
        )
          ? 'NONE'
          : 'KEEPER_SECONDARY',
        joinedAtMs: now,
        updatedAtMs: now,
        leftAtMs: null,
        membershipEpoch: request.trip.membershipEpoch,
      }),
    );
    const originDeviceId = assertParsed(
      parseDeviceId(this.dependencies.session.localMember.deviceId),
    );
    const sequence = await this.dependencies.operationSequenceAllocator.allocate({
      tripId: request.trip.id,
      originDeviceId,
      idempotencyKey: `MEMBER_JOINED:${member.id}:${member.identityPublicKey}`,
    });
    const operationId = assertParsed(
      parseOperationId(
        `operation_${sha256Hex(
          new TextEncoder().encode(`MEMBER_JOINED\0${member.id}\0${member.identityPublicKey}`),
        ).slice(0, 32)}`,
      ),
    );
    const unsignedOperation = assertParsed(
      parseSyncOperation({
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        operationId,
        tripId: request.trip.id,
        originDeviceId,
        originSequence: sequence,
        actorMemberId: this.dependencies.session.localMember.id,
        membershipEpoch: request.trip.membershipEpoch,
        createdAtMs: now,
        kind: 'MEMBER_JOINED',
        payload: { member },
      }),
    );
    const operation = await signSyncOperation(
      unsignedOperation,
      this.dependencies.session.localMember.identityPublicKey,
      this.dependencies.identity,
    );
    if (operation.kind !== 'MEMBER_JOINED') {
      return rejectAdmission('INVALID_ADMISSION_OPERATION', 'Admission operation changed kind.');
    }
    return { accepted: true, member: member as Member, operation };
  }
}

function mapTransportState(state: Transport['state']['state']): SyncSnapshot['state'] {
  if (state === 'idle') return 'idle';
  if (state === 'connecting' || state === 'handshaking') return 'connecting';
  if (state === 'connected') return 'connected';
  if (state === 'reconnecting') return 'reconnecting';
  return 'stopped';
}

function rejectAdmission(code: string, message: string): AdmissionDecision {
  return { accepted: false, code, message };
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Clock returned an invalid time.');
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
