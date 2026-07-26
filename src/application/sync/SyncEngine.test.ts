import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_SCHEMA_VERSION,
  FRAME_SECURITY_VERSION,
  PROTOCOL_VERSION,
} from '../../core/constants';
import {
  parseDeviceId,
  parseIdentityPublicKey,
  parseMediaId,
  parseMemberId,
  parseMessageId,
  parseOperationId,
  parseResourceId,
  parseTripId,
} from '../../core/ids';
import {
  parseMediaResource,
  parseMember,
  parseReplicaReceipt,
  parseSyncOperation,
  parseTrip,
  type SyncOperation,
} from '../../core/domain';
import { createEmptyCatalogState, type CatalogState } from '../../core/reconciliation';
import type {
  AckMessage,
  HelloMessage,
  ProtocolEnvelope,
  ResourceCompleteMessage,
} from '../../core/protocol';
import type {
  AuthenticatedFrameCrypto,
  SecureFrame,
  SecureFrameHeader,
  SecureFrameReplayGuard,
  SessionKeyHandle,
} from '../../core/security';
import { assertParsed } from '../../core/validation';
import { sha256Hex } from '../media/contentIdentity';
import type {
  AirMeshDataLayer,
  AirMeshRepositories,
  JsonValue,
  MemberRecord,
  OutboxRecord,
  ReplicaReceiptRecord,
  ResourceRecord,
  SyncOperationRecord,
  TransferRecord,
  TripRecord,
} from '../../data';
import type { ChunkedFileStore } from '../../platform/files';
import type {
  InboundBinaryChunk,
  InboundControlMessage,
  OutboundBinaryChunk,
  OutboundControlMessage,
  Transport,
  TransportConnectRequest,
  TransportEvent,
  TransportStateSnapshot,
  TransportSubscription,
} from '../../platform/transport/Transport';

import { SyncEngine, type SyncEngineEvent, type SyncSession } from './SyncEngine';
import { decodeBase64Url, encodeBase64Url } from '../security/base64url';
import {
  signSecureFrame,
  type FrameIdentityAuthenticator,
} from '../security/frameAuthenticity';
import { signSyncOperation, verifySyncOperation } from '../security/operationAuthenticity';
import {
  SECURE_CONTROL_TRANSPORT_TYPE,
  decodeControlEnvelopePlaintext,
  encodeControlEnvelopePlaintext,
  parseSerializedSignedSecureControlFrame,
  serializeSignedSecureBinaryFrame,
  serializeSignedSecureControlFrame,
} from './secureWire';

const tripId = assertParsed(parseTripId('trip:engine-test'));
const localMemberId = assertParsed(parseMemberId('member:local-test'));
const localDeviceId = assertParsed(parseDeviceId('device:local-test'));
const remoteDeviceId = assertParsed(parseDeviceId('device:remote-test'));
const coordinatorDeviceId = assertParsed(parseDeviceId('device:coordinator-test'));
const attackerDeviceId = assertParsed(parseDeviceId('device:attacker-test'));

class FakeTransport implements Transport {
  private listener: ((event: TransportEvent) => void) | null = null;
  private snapshot: TransportStateSnapshot = { state: 'idle', reconnectAttempt: 0 };
  readonly controls: OutboundControlMessage[] = [];
  readonly chunks: OutboundBinaryChunk[] = [];

  get state(): TransportStateSnapshot {
    return this.snapshot;
  }

  connect(_request: TransportConnectRequest): void {
    this.snapshot = { state: 'connected', reconnectAttempt: 0 };
    this.listener?.({ kind: 'state', snapshot: this.snapshot });
  }

  disconnect(): void {
    this.snapshot = { state: 'stopped', reconnectAttempt: 0 };
  }

  sendControl(message: OutboundControlMessage): void {
    this.controls.push(message);
  }

  sendChunk(chunk: OutboundBinaryChunk): void {
    this.chunks.push(chunk);
  }

  subscribe(listener: (event: TransportEvent) => void): TransportSubscription {
    this.listener = listener;
    return { remove: () => (this.listener = null) };
  }

  emit(event: TransportEvent): void {
    this.listener?.(event);
  }
}

class TransparentTestCrypto implements AuthenticatedFrameCrypto {
  async seal(input: {
    readonly header: SecureFrameHeader;
    readonly plaintext: Uint8Array;
    readonly key: SessionKeyHandle;
  }): Promise<SecureFrame> {
    return {
      ...input.header,
      nonce: new Uint8Array(24).fill(input.header.senderCounter),
      ciphertext: input.plaintext.slice(),
      authenticationTag: new Uint8Array(16).fill(3),
    };
  }

  async open(input: { readonly frame: SecureFrame; readonly key: SessionKeyHandle }) {
    return input.frame.ciphertext.slice();
  }
}

function localTrip(): TripRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: tripId,
    name: 'Engine test trip',
    createdByMemberId: localMemberId,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    startsAtMs: 1_000,
    endsAtMs: null,
    timeZone: 'Asia/Kolkata',
    status: 'ACTIVE',
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
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: localMemberId,
    tripId,
    deviceId: localDeviceId,
    displayName: 'Local Ankit',
    identityPublicKey: 'A'.repeat(43),
    role: 'ADMIN',
    status: 'ACTIVE',
    replicaRole: 'KEEPER_PRIMARY',
    joinedAtMs: 1_000,
    updatedAtMs: 1_000,
    leftAtMs: null,
    membershipEpoch: 1,
  };
}

function minimalData(): Pick<AirMeshDataLayer, 'repositories' | 'transaction'> {
  const trip = localTrip();
  const member = localMember();
  const repositories = {
    trips: { getById: async (id: string) => (id === trip.id ? trip : null) },
    members: {
      getById: async (_tripId: string, id: string) => (id === member.id ? member : null),
      getByDeviceId: async (_tripId: string, id: string) =>
        (id === member.deviceId ? member : null),
      listByTrip: async () => [member],
    },
    syncOperations: {
      getContiguousHighWaterMarks: async () => ({}),
      listRange: async () => [],
    },
    replicaReceipts: { listByResource: async () => [] },
    transfers: { listActive: async () => [] },
    outbox: {
      claimDue: async () => [],
      getNextWakeAt: async () => null,
      getById: async () => null,
    },
  } as unknown as AirMeshRepositories;
  return {
    repositories,
    transaction: (task) => task(repositories),
  };
}

async function settleEvents(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function createTestEngine(input: {
  session?: SyncSession;
  data?: Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
  transport?: FakeTransport;
  events?: SyncEngineEvent[];
  isCoordinator?: boolean;
  trustedCoordinatorDeviceId?: typeof localDeviceId;
  trustedCoordinatorIdentityPublicKey?: string;
  availableStorageBytes?: () => Promise<number>;
  fileStore?: ChunkedFileStore;
  identity?: FrameIdentityAuthenticator;
  replayGuard?: SecureFrameReplayGuard;
}) {
  const transport = input.transport ?? new FakeTransport();
  const events = input.events ?? [];
  let counter = 0;
  const key: SessionKeyHandle = {
    tripId,
    keyId: 'trip-key:engine-test',
    keyEpoch: 1,
    cipherSuite: 'XCHACHA20_POLY1305',
  };
  const engine = new SyncEngine({
    session: input.session ?? {
      tripId,
      localMemberId,
      localDeviceId,
      trustedCoordinatorDeviceId:
        input.trustedCoordinatorDeviceId ?? localDeviceId,
      localIdentityPublicKey: localMember().identityPublicKey,
      trustedCoordinatorIdentityPublicKey:
        input.trustedCoordinatorIdentityPublicKey ?? localMember().identityPublicKey,
      admissionInviteLink: null,
      endpoint: 'ws://local.test',
      isCoordinator: input.isCoordinator ?? true,
      key,
    },
    data: input.data ?? minimalData(),
    transport,
    fileStore: input.fileStore ?? ({} as ChunkedFileStore),
    crypto: new TransparentTestCrypto(),
    identity: input.identity ?? {
      sign: async () => 'A'.repeat(86),
      verify: () => true,
    },
    wireCounter: { next: async () => ++counter },
    replayGuard: input.replayGuard ?? { accept: async () => true },
    operationSequenceAllocator: { allocate: async () => 1 },
    scheduler: { setInterval: () => 1, clearInterval: () => undefined },
    clock: { nowMs: () => 2_000 },
    availableStorageBytes: input.availableStorageBytes ?? (async () => 512 * 1024 * 1024),
    onEvent: (event) => events.push(event),
  });
  return { engine, events, key, transport };
}

interface SyncEngineInternals {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  catalogState: CatalogState;
  admittedDevices: Set<string>;
  canStoreOriginalsByDevice: Map<string, boolean>;
  availableStorageBytesByDevice: Map<string, number>;
  connectedPeerIds: Set<string>;
  activeUploads: Map<string, Promise<void>>;
  pendingUploads: Map<string, { peerDeviceId: string; priority: string }>;
  uploadPreemptionRequests: Set<string>;
  pendingChunkAcks: Map<string, unknown>;
  incomingReservations: Map<string, number>;
  areOperationOriginsAuthorized(
    operations: readonly SyncOperation[],
    peerId: string,
  ): Promise<boolean>;
  handleAck(payload: AckMessage, peerId: string): Promise<void>;
  handleInboundControl(message: InboundControlMessage): Promise<void>;
  handleInboundChunk(chunk: InboundBinaryChunk): Promise<void>;
  handleHello(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'HELLO' }>,
    peerId: string,
  ): Promise<void>;
  handleResourceOffer(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_OFFER' }>,
    peerId: string,
  ): Promise<void>;
  requestPublishedResources(
    operations: readonly SyncOperation[],
    peerDeviceId: string,
  ): Promise<void>;
  startUpload(
    transferId: string,
    peerId: string,
    priority?: 'THUMBNAIL' | 'USER_VISIBLE_ORIGINAL' | 'BACKGROUND_ORIGINAL',
  ): void;
  pumpUploads(): void;
  uploadResource(transferId: string, peerId: string): Promise<void>;
  sendSecureChunk(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_CHUNK' }>,
    peerId: string,
  ): Promise<void>;
  reconcileDownloadCheckpoint(
    transfer: TransferRecord,
    reason: string,
  ): Promise<TransferRecord>;
  replayCompletionRequest(transferId: string, peerId: string): Promise<void>;
  finishDownload(
    transfer: TransferRecord,
    complete: ResourceCompleteMessage,
    peerId: string,
    completionMessageId: string,
  ): Promise<void>;
  rehandshakeJoinedMembers(operations: readonly SyncOperation[]): Promise<void>;
  reserveIncomingCapacity(transfer: TransferRecord, resource: ResourceRecord): Promise<void>;
}

function internals(engine: SyncEngine): SyncEngineInternals {
  return engine as unknown as SyncEngineInternals;
}

function testIdentity(secretByte: number): FrameIdentityAuthenticator & {
  readonly publicKey: string;
} {
  const secret = new Uint8Array(32).fill(secretByte);
  return {
    publicKey: encodeBase64Url(ed25519.getPublicKey(secret)),
    sign: async (bytes) => encodeBase64Url(ed25519.sign(bytes, secret)),
    verify: (bytes, signature, publicKey) => {
      try {
        return ed25519.verify(
          decodeBase64Url(signature),
          bytes,
          decodeBase64Url(publicKey),
          { zip215: false },
        );
      } catch {
        return false;
      }
    },
  };
}

async function signedInboundControl(
  envelope: ProtocolEnvelope,
  key: SessionKeyHandle,
  signer: FrameIdentityAuthenticator & { readonly publicKey: string },
): Promise<InboundControlMessage> {
  const frame = await new TransparentTestCrypto().seal({
    header: {
      securityVersion: FRAME_SECURITY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId: envelope.tripId,
      senderDeviceId: envelope.senderDeviceId,
      keyId: key.keyId,
      keyEpoch: key.keyEpoch,
      senderCounter: envelope.senderMessageSequence,
      cipherSuite: key.cipherSuite,
    },
    plaintext: encodeControlEnvelopePlaintext(envelope),
    key,
  });
  const signed = await signSecureFrame(frame, signer.publicKey, signer);
  return {
    sessionId: envelope.tripId,
    senderPeerId: envelope.senderDeviceId,
    targetPeerId: localDeviceId,
    messageId: envelope.messageId,
    type: SECURE_CONTROL_TRANSPORT_TYPE,
    payload: serializeSignedSecureControlFrame(signed),
  };
}

function helloEnvelope(input: {
  readonly deviceId: typeof localDeviceId;
  readonly memberId: typeof localMemberId;
  readonly identityPublicKey: string;
  readonly sequence?: number;
}): Extract<ProtocolEnvelope, { readonly type: 'HELLO' }> {
  const sequence = input.sequence ?? 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: assertParsed(parseMessageId(`message:hello-signed-${sequence}`)),
    tripId,
    senderMemberId: input.memberId,
    senderDeviceId: input.deviceId,
    membershipEpoch: 1,
    senderMessageSequence: sequence,
    sentAtMs: 2_000,
    type: 'HELLO',
    payload: {
      memberId: input.memberId,
      deviceId: input.deviceId,
      displayName: 'Signed peer',
      identityPublicKey: assertParsed(parseIdentityPublicKey(input.identityPublicKey)),
      admissionInviteLink: null,
      supportedProtocolVersions: [PROTOCOL_VERSION],
      membershipEpoch: 1,
      highWater: {},
      canStoreOriginals: true,
      availableStorageBytes: 1_000_000,
      maxChunkBytes: 64 * 1024,
    },
  };
}

describe('SyncEngine secure transport boundary', () => {
  it('runs at most two resource uploads and starts the next queued upload on completion', async () => {
    const { engine } = createTestEngine({});
    await engine.start();
    const internal = internals(engine);
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const starts: string[] = [];
    let running = 0;
    let peakRunning = 0;
    internal.uploadResource = async (transferId: string) => {
      const gate = deferred<void>();
      gates.set(transferId, gate);
      starts.push(transferId);
      running += 1;
      peakRunning = Math.max(peakRunning, running);
      await gate.promise;
      running -= 1;
    };

    internal.startUpload('transfer:first', remoteDeviceId, 'THUMBNAIL');
    internal.startUpload('transfer:second', remoteDeviceId, 'USER_VISIBLE_ORIGINAL');
    internal.startUpload('transfer:third', remoteDeviceId, 'BACKGROUND_ORIGINAL');

    expect(starts).toEqual(['transfer:first', 'transfer:second']);
    expect(internal.activeUploads.size).toBe(2);
    expect(internal.pendingUploads.size).toBe(1);

    gates.get('transfer:first')!.resolve();
    await settleEvents();

    expect(starts).toEqual(['transfer:first', 'transfer:second', 'transfer:third']);
    expect(peakRunning).toBe(2);
    gates.get('transfer:second')!.resolve();
    gates.get('transfer:third')!.resolve();
    await settleEvents();
    expect(internal.activeUploads.size).toBe(0);
    await engine.stop();
  });

  it('uses both upload lanes for originals but preempts one for a thumbnail', async () => {
    const { engine } = createTestEngine({});
    await engine.start();
    const internal = internals(engine);
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const starts: string[] = [];
    internal.uploadResource = async (transferId: string) => {
      const gate = deferred<void>();
      gates.set(transferId, gate);
      starts.push(transferId);
      await gate.promise;
    };

    internal.startUpload('transfer:background-one', remoteDeviceId, 'BACKGROUND_ORIGINAL');
    internal.startUpload('transfer:background-two', remoteDeviceId, 'BACKGROUND_ORIGINAL');
    expect(starts).toEqual(['transfer:background-one', 'transfer:background-two']);

    internal.startUpload('transfer:thumbnail', remoteDeviceId, 'THUMBNAIL');
    expect(starts).toEqual(['transfer:background-one', 'transfer:background-two']);
    expect(internal.uploadPreemptionRequests.size).toBe(1);

    const preemptedTransferId = [...internal.uploadPreemptionRequests][0];
    gates.get(preemptedTransferId)!.resolve();
    await settleEvents();
    expect(starts).toEqual([
      'transfer:background-one',
      'transfer:background-two',
      'transfer:thumbnail',
    ]);

    gates.get('transfer:thumbnail')!.resolve();
    const remainingBackgroundId = preemptedTransferId === 'transfer:background-one'
      ? 'transfer:background-two'
      : 'transfer:background-one';
    gates.get(remainingBackgroundId)!.resolve();
    await settleEvents();
    await engine.stop();
  });

  it('orders queued uploads thumbnail, user-visible original, then background original', async () => {
    const { engine } = createTestEngine({});
    const internal = internals(engine);
    const starts: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    internal.uploadResource = async (transferId: string) => {
      starts.push(transferId);
      const gate = deferred<void>();
      gates.set(transferId, gate);
      await gate.promise;
    };

    internal.startUpload('transfer:background', remoteDeviceId, 'BACKGROUND_ORIGINAL');
    internal.startUpload('transfer:user', remoteDeviceId, 'USER_VISIBLE_ORIGINAL');
    internal.startUpload('transfer:thumbnail', remoteDeviceId, 'THUMBNAIL');
    expect(starts).toEqual([]);

    internal.state = 'running';
    internal.pumpUploads();
    expect(starts).toEqual(['transfer:thumbnail', 'transfer:user']);
    expect(internal.pendingUploads.has('transfer:background')).toBe(true);

    gates.get('transfer:thumbnail')!.resolve();
    gates.get('transfer:user')!.resolve();
    await settleEvents();
    expect(starts).toEqual(['transfer:thumbnail', 'transfer:user', 'transfer:background']);
    gates.get('transfer:background')!.resolve();
    await settleEvents();
    internal.state = 'stopped';
  });

  it('does not consider an encrypted chunk delivered until its receiving peer ACKs it', async () => {
    const { engine, transport } = createTestEngine({});
    const internal = internals(engine);
    const messageId = assertParsed(parseMessageId('message:chunk-ack-test'));
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      tripId,
      senderMemberId: localMemberId,
      senderDeviceId: localDeviceId,
      membershipEpoch: 1,
      senderMessageSequence: 1,
      sentAtMs: 2_000,
      type: 'RESOURCE_CHUNK',
      payload: {
        transferId: 'transfer:chunk-ack-test',
        resourceId: 'resource:chunk-ack-test',
        chunkIndex: 0,
        offset: 0,
        bytes: new Uint8Array([1, 2, 3]),
        chunkSha256: 'a'.repeat(64),
      },
    } as unknown as Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_CHUNK' }>;

    let settled = false;
    const sent = internal.sendSecureChunk(envelope, remoteDeviceId).finally(() => {
      settled = true;
    });
    await settleEvents();

    expect(transport.chunks).toHaveLength(1);
    expect(settled).toBe(false);
    expect(internal.pendingChunkAcks.has(messageId)).toBe(true);

    await internal.handleAck({
      acknowledgedMessageId: messageId,
      status: 'ACCEPTED',
      highWater: {},
      errorCode: null,
    }, remoteDeviceId);
    await sent;
    expect(settled).toBe(true);
    expect(internal.pendingChunkAcks.has(messageId)).toBe(false);
  });

  it('times out an unacknowledged chunk so its upload can be paused and resumed', async () => {
    vi.useFakeTimers();
    try {
      const { engine } = createTestEngine({});
      const internal = internals(engine);
      const messageId = assertParsed(parseMessageId('message:chunk-timeout-test'));
      const envelope = {
        protocolVersion: PROTOCOL_VERSION,
        messageId,
        tripId,
        senderMemberId: localMemberId,
        senderDeviceId: localDeviceId,
        membershipEpoch: 1,
        senderMessageSequence: 1,
        sentAtMs: 2_000,
        type: 'RESOURCE_CHUNK',
        payload: {
          transferId: 'transfer:chunk-timeout-test',
          resourceId: 'resource:chunk-timeout-test',
          chunkIndex: 0,
          offset: 0,
          bytes: new Uint8Array([1]),
          chunkSha256: 'a'.repeat(64),
        },
      } as unknown as Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_CHUNK' }>;
      const sent = internal.sendSecureChunk(envelope, remoteDeviceId);
      const rejection = expect(sent).rejects.toMatchObject({ code: 'CHUNK_ACK_TIMEOUT' });
      await settleEvents();
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(internal.pendingChunkAcks.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('globally bounds unacknowledged chunks and checkpoints sender progress without hiding UI progress', async () => {
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:window-peer')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:window-test')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:window-test')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 4,
      sha256: sha256Hex(new Uint8Array([1, 2, 3, 4])),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'available',
      localUri: 'file:///documents/airmesh/originals/window.jpg',
      verifiedAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    let transfer: TransferRecord = {
      id: 'request:window-test',
      tripId,
      resourceId: resource.id,
      peerMemberId: remoteMember.id,
      direction: 'upload',
      state: 'queued',
      bytesTransferred: 0,
      totalBytes: resource.byteLength,
      chunkSize: 1,
      nextChunkIndex: 0,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const progress: { bytes: number; state: TransferRecord['state'] }[] = [];
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getById: async (_tripId: string, id: string) =>
          (id === remoteMember.id ? remoteMember : localMember()),
      },
      resources: { getById: async () => resource },
      transfers: {
        ...base.repositories.transfers,
        getById: async () => transfer,
        updateProgress: async (
          _tripId: string,
          _id: string,
          bytesTransferred: number,
          nextChunkIndex: number,
          state: TransferRecord['state'],
          updatedAt: number,
        ) => {
          transfer = { ...transfer, bytesTransferred, nextChunkIndex, state, updatedAt };
          progress.push({ bytes: bytesTransferred, state });
        },
      },
      outbox: {
        ...base.repositories.outbox,
        upsert: async () => undefined,
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const fileStore = {
      async *readChunks() {
        for (let offset = 0; offset < 4; offset += 1) {
          yield {
            offset,
            bytes: new Uint8Array([offset + 1]),
            isLast: offset === 3,
          };
        }
      },
    } as unknown as ChunkedFileStore;
    const { engine, transport, events } = createTestEngine({ data, fileStore });
    const internal = internals(engine);
    internal.state = 'running';
    internal.admittedDevices.add(remoteDeviceId);

    const upload = internal.uploadResource(transfer.id, remoteDeviceId);
    for (let index = 0; index < 100 && transport.chunks.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(transport.chunks).toHaveLength(2);
    expect(progress).toEqual([]);

    const acknowledgeNext = async () => {
      const messageId = internal.pendingChunkAcks.keys().next().value as string;
      await internal.handleAck({
        acknowledgedMessageId: assertParsed(parseMessageId(messageId)),
        status: 'ACCEPTED',
        highWater: {},
        errorCode: null,
      }, remoteDeviceId);
      await settleEvents();
    };
    await acknowledgeNext();
    expect(transport.chunks).toHaveLength(3);
    expect(progress[0]).toEqual({ bytes: 1, state: 'transferring' });

    while (internal.pendingChunkAcks.size > 0) await acknowledgeNext();
    await upload;
    expect(progress).toEqual([
      { bytes: 1, state: 'transferring' },
      { bytes: 4, state: 'transferring' },
      { bytes: 4, state: 'verifying' },
    ]);
    expect(
      events
        .filter((event) => event.kind === 'resource-progress')
        .map((event) => event.bytesTransferred),
    ).toEqual([1, 2, 3, 4, 4]);
    internal.state = 'stopped';
  });

  it('quarantines a corrupt verified upload with a signed durable LOST receipt and rejects its requester', async () => {
    const signer = testIdentity(41);
    const senderMember = assertParsed(parseMember({
      ...localMember(),
      identityPublicKey: signer.publicKey,
    }));
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:corrupt-upload-requester')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const expectedBytes = new Uint8Array([1, 2, 3, 4]);
    const corruptBytes = new Uint8Array([1, 2, 3, 5]);
    let resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:corrupt-verified-upload')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:corrupt-verified-upload')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: expectedBytes.byteLength,
      sha256: sha256Hex(expectedBytes),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'available',
      localUri: 'file:///documents/airmesh/originals/corrupt.jpg',
      verifiedAtMs: 1_100,
      updatedAtMs: 1_200,
    };
    let receipt: ReplicaReceiptRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: 'receipt:corrupt-verified-upload',
      tripId,
      mediaId: resource.mediaId,
      resourceId: resource.id,
      holderMemberId: localMemberId,
      holderDeviceId: localDeviceId,
      resourceSha256: resource.sha256,
      resourceByteLength: resource.byteLength,
      status: 'VERIFIED',
      verifiedAtMs: 1_100,
      updatedAtMs: 1_100,
    };
    let transfer: TransferRecord = {
      id: 'request:corrupt-verified-upload',
      tripId,
      resourceId: resource.id,
      peerMemberId: remoteMember.id,
      direction: 'upload',
      state: 'queued',
      bytesTransferred: 0,
      totalBytes: resource.byteLength,
      chunkSize: resource.byteLength,
      nextChunkIndex: 0,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: 1_500,
      updatedAt: 1_500,
    };
    const durableOperations: SyncOperationRecord[] = [];
    const outbox: OutboxRecord[] = [];
    const markVerifiedLocalCopyLost = vi.fn(async (
      _tripId: string,
      _resourceId: string,
      _expectedLocalUri: string,
      _expectedVerifiedAtMs: number,
      _expectedUpdatedAtMs: number,
      updatedAtMs: number,
    ) => {
      resource = {
        ...resource,
        availability: 'missing',
        localUri: null,
        verifiedAtMs: null,
        updatedAtMs,
      };
      return true;
    });
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      trips: { getById: async () => localTrip() },
      members: {
        getById: async (_tripId: string, id: string) => {
          if (id === remoteMember.id) return remoteMember;
          if (id === senderMember.id) return { ...localMember(), identityPublicKey: signer.publicKey };
          return null;
        },
        getByDeviceId: async (_tripId: string, deviceId: string) => {
          if (deviceId === remoteMember.deviceId) return remoteMember;
          if (deviceId === senderMember.deviceId) {
            return { ...localMember(), identityPublicKey: signer.publicKey };
          }
          return null;
        },
        listByTrip: async () => [
          { ...localMember(), identityPublicKey: signer.publicKey },
          remoteMember,
        ],
      },
      resources: {
        getById: async () => resource,
        markVerifiedLocalCopyLost,
      },
      replicaReceipts: {
        listByResource: async () => [receipt],
        upsert: async (record: ReplicaReceiptRecord) => {
          receipt = record;
        },
      },
      transfers: {
        ...base.repositories.transfers,
        getById: async () => transfer,
        updateProgress: async (
          _tripId: string,
          _id: string,
          bytesTransferred: number,
          nextChunkIndex: number,
          state: TransferRecord['state'],
          updatedAt: number,
        ) => {
          transfer = { ...transfer, bytesTransferred, nextChunkIndex, state, updatedAt };
        },
        markFailed: async (
          _tripId: string,
          _id: string,
          lastError: string,
          updatedAt: number,
        ) => {
          transfer = { ...transfer, state: 'failed', lastError, updatedAt };
        },
      },
      syncOperations: {
        ...base.repositories.syncOperations,
        append: async (record: SyncOperationRecord) => {
          durableOperations.push(record);
        },
      },
      outbox: {
        ...base.repositories.outbox,
        upsert: async (record: OutboxRecord) => {
          outbox.push(record);
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const key: SessionKeyHandle = {
      tripId,
      keyId: 'trip-key:corrupt-verified-upload',
      keyEpoch: 1,
      cipherSuite: 'XCHACHA20_POLY1305',
    };
    const fileStore = {
      async *readChunks() {
        yield { offset: 0, bytes: corruptBytes, isLast: true };
      },
    } as unknown as ChunkedFileStore;
    const { engine } = createTestEngine({
      data,
      fileStore,
      identity: signer,
      session: {
        tripId,
        localMemberId,
        localDeviceId,
        trustedCoordinatorDeviceId: localDeviceId,
        localIdentityPublicKey: signer.publicKey,
        trustedCoordinatorIdentityPublicKey: signer.publicKey,
        admissionInviteLink: null,
        endpoint: 'ws://corrupt-upload.test',
        isCoordinator: true,
        key,
      },
    });
    const internal = internals(engine);
    const catalogResource = assertParsed(parseMediaResource({
      schemaVersion: resource.schemaVersion,
      id: resource.id,
      tripId: resource.tripId,
      mediaId: resource.mediaId,
      kind: resource.kind,
      mimeType: resource.mimeType,
      fileExtension: resource.fileExtension,
      byteLength: resource.byteLength,
      sha256: resource.sha256,
      width: resource.width,
      height: resource.height,
      createdAtMs: resource.createdAtMs,
    }));
    const catalogReceipt = assertParsed(parseReplicaReceipt(receipt));
    const catalogTrip = assertParsed(parseTrip({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: tripId,
      name: localTrip().name,
      createdByMemberId: localMemberId,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      startsAtMs: 1_000,
      endsAtMs: null,
      timeZone: 'Asia/Kolkata',
      status: 'ACTIVE',
      defaultSharingMode: 'AUTO_SHARE',
      locationSharingMode: 'NONE',
      targetReplicaCount: 2,
      completeKeeperCount: 1,
      membershipEpoch: 1,
    }));
    internal.catalogState = {
      ...createEmptyCatalogState(),
      trips: new Map([[catalogTrip.id, catalogTrip]]),
      members: new Map([[senderMember.id, senderMember]]),
      resources: new Map([[catalogResource.id, catalogResource]]),
      replicaReceipts: new Map([[catalogReceipt.id, catalogReceipt]]),
    };
    internal.state = 'running';
    internal.admittedDevices.add(remoteDeviceId);

    internal.startUpload(transfer.id, remoteDeviceId, 'USER_VISIBLE_ORIGINAL');
    await vi.waitFor(() => {
      expect(internal.pendingChunkAcks.size).toBe(1);
    });
    const chunkMessageId = internal.pendingChunkAcks.keys().next().value as string;
    await internal.handleAck({
      acknowledgedMessageId: assertParsed(parseMessageId(chunkMessageId)),
      status: 'ACCEPTED',
      highWater: {},
      errorCode: null,
    }, remoteDeviceId);
    await vi.waitFor(() => {
      expect(internal.activeUploads.size).toBe(0);
    });

    expect(markVerifiedLocalCopyLost).toHaveBeenCalledWith(
      tripId,
      catalogResource.id,
      'file:///documents/airmesh/originals/corrupt.jpg',
      1_100,
      1_200,
      2_000,
    );
    expect(resource).toMatchObject({
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
    });
    expect(receipt).toMatchObject({ status: 'LOST', updatedAtMs: 2_000 });
    expect(transfer).toMatchObject({
      state: 'failed',
      lastError: 'UPLOAD_SOURCE_INTEGRITY_FAILED',
    });

    expect(durableOperations).toHaveLength(1);
    const lostOperation = assertParsed(parseSyncOperation(durableOperations[0]));
    expect(lostOperation).toMatchObject({
      kind: 'REPLICA_STATUS_CHANGED',
      payload: { receipt: { id: receipt.id, status: 'LOST' } },
    });
    expect(verifySyncOperation(lostOperation, signer, signer.publicKey)).toBe(true);
    expect(outbox).toContainEqual(expect.objectContaining({
      recipientMemberId: null,
      messageType: 'SYNC_OPERATION',
      payload: lostOperation,
      state: 'pending',
    }));
    expect(outbox).toContainEqual(expect.objectContaining({
      recipientMemberId: remoteMember.id,
      messageType: 'PROTOCOL:RESOURCE_COMPLETE',
      payload: expect.objectContaining({
        transferId: transfer.id,
        resourceId: resource.id,
        status: 'SENDER_REJECTED',
        errorCode: 'UPLOAD_SOURCE_INTEGRITY_FAILED',
      }),
      state: 'pending',
    }));
    internal.state = 'stopped';
  });

  it('reserves incoming bytes so concurrent downloads cannot overcommit free disk', async () => {
    const freeBytes = 64 * 1024 * 1024 + 150;
    const { engine } = createTestEngine({ availableStorageBytes: async () => freeBytes });
    const internal = internals(engine);
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:storage-test')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:storage-test')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 100,
      sha256: 'a'.repeat(64),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const transfer = (id: string): TransferRecord => ({
      id,
      tripId,
      resourceId: resource.id,
      peerMemberId: localMemberId,
      direction: 'download',
      state: 'queued',
      bytesTransferred: 0,
      totalBytes: resource.byteLength,
      chunkSize: 64,
      nextChunkIndex: 0,
      attemptCount: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await internal.reserveIncomingCapacity(transfer('transfer:first'), resource);
    await expect(
      internal.reserveIncomingCapacity(transfer('transfer:second'), resource),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
    expect(internal.incomingReservations).toEqual(new Map([['transfer:first', 100]]));
  });

  it('reconciles a durable partial-file checkpoint instead of discarding it after restart', async () => {
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:resume-test')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:resume-test')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 192,
      sha256: 'c'.repeat(64),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'partial',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const transfer: TransferRecord = {
      id: 'transfer:resume-test',
      tripId,
      resourceId: resource.id,
      peerMemberId: localMemberId,
      direction: 'download',
      state: 'transferring',
      bytesTransferred: 64,
      totalBytes: resource.byteLength,
      chunkSize: 64,
      nextChunkIndex: 1,
      attemptCount: 0,
      lastError: null,
      startedAt: 1_000,
      completedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    let persisted: TransferRecord | null = null;
    let discarded = false;
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      resources: { getById: async () => resource },
      transfers: {
        ...base.repositories.transfers,
        upsert: async (record: TransferRecord) => {
          persisted = record;
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const fileStore = {
      getIncoming: () => ({
        uri: 'file:///documents/airmesh/incoming/transfer-resume-test.part',
        byteSize: 128,
        mimeType: 'application/octet-stream',
      }),
      getOriginal: () => null,
      discardIncoming: async () => {
        discarded = true;
      },
    } as unknown as ChunkedFileStore;
    const { engine, events } = createTestEngine({ data, fileStore });

    const reconciled = await internals(engine).reconcileDownloadCheckpoint(
      transfer,
      'ENGINE_RESTARTED',
    );

    expect(reconciled).toMatchObject({
      state: 'paused',
      bytesTransferred: 128,
      nextChunkIndex: 2,
      lastError: 'ENGINE_RESTARTED',
    });
    expect(persisted).toMatchObject(reconciled);
    expect(discarded).toBe(false);
    expect(events).toContainEqual({
      kind: 'resource-progress',
      transferId: transfer.id,
      resourceId: resource.id,
      direction: 'download',
      state: 'paused',
      bytesTransferred: 128,
      totalBytes: 192,
    });
  });

  it('replays a full-offset request when sender completion is lost at 100 percent', async () => {
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:completion-peer')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:completion-replay')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:completion-replay')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 256,
      sha256: 'f'.repeat(64),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'partial',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const transfer: TransferRecord = {
      id: 'request:completion-replay',
      tripId,
      resourceId: resource.id,
      peerMemberId: remoteMember.id,
      direction: 'download',
      state: 'verifying',
      bytesTransferred: resource.byteLength,
      totalBytes: resource.byteLength,
      chunkSize: 128,
      nextChunkIndex: 2,
      attemptCount: 0,
      lastError: null,
      startedAt: 1_000,
      completedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const outbox: OutboxRecord[] = [];
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getById: async (_tripId: string, id: string) =>
          (id === remoteMember.id ? remoteMember : localMember()),
      },
      resources: { getById: async () => resource },
      transfers: {
        ...base.repositories.transfers,
        getById: async () => transfer,
      },
      outbox: {
        ...base.repositories.outbox,
        getById: async () => null,
        upsert: async (record: OutboxRecord) => {
          outbox.push(record);
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const { engine, events } = createTestEngine({ data });
    const internal = internals(engine);
    internal.state = 'running';
    internal.admittedDevices.add(remoteDeviceId);

    await internal.replayCompletionRequest(transfer.id, remoteDeviceId);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.messageType).toBe('PROTOCOL:RESOURCE_REQUEST');
    expect(outbox[0]?.payload).toMatchObject({
      requestId: transfer.id,
      startOffset: resource.byteLength,
      priority: 'BACKGROUND_ORIGINAL',
    });
    expect(events.some(
      (event) => event.kind === 'error' && event.error.code === 'RESOURCE_COMPLETION_TIMEOUT',
    )).toBe(true);
    internal.state = 'stopped';
  });

  it('keeps a verified target recoverable when persistence fails after finalization', async () => {
    const bytes = new Uint8Array([7, 8, 9, 10]);
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:finalize-boundary')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:finalize-boundary')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: bytes.byteLength,
      sha256: sha256Hex(bytes),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'partial',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const transfer: TransferRecord = {
      id: 'request:finalize-boundary',
      tripId,
      resourceId: resource.id,
      peerMemberId: localMemberId,
      direction: 'download',
      state: 'verifying',
      bytesTransferred: bytes.byteLength,
      totalBytes: bytes.byteLength,
      chunkSize: bytes.byteLength,
      nextChunkIndex: 1,
      attemptCount: 0,
      lastError: null,
      startedAt: 1_000,
      completedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    let pausedReason: string | null = null;
    let failed = false;
    let discarded = false;
    let deleted = false;
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      resources: { getById: async () => resource },
      transfers: {
        ...base.repositories.transfers,
        markPaused: async (
          _tripId: string,
          _id: string,
          reason: string,
        ) => {
          pausedReason = reason;
        },
        markFailed: async () => {
          failed = true;
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const incomingUri = 'file:///documents/airmesh/incoming/finalize-boundary.part';
    const targetUri = 'file:///documents/airmesh/originals/finalize-boundary.jpg';
    const fileStore = {
      async *readChunks(request: { uri: string }) {
        yield { offset: 0, bytes, isLast: true };
        expect([incomingUri, targetUri]).toContain(request.uri);
      },
      getIncoming: () => ({
        uri: incomingUri,
        byteSize: bytes.byteLength,
        mimeType: 'application/octet-stream',
      }),
      finalizeIncoming: async () => ({
        uri: targetUri,
        byteSize: bytes.byteLength,
        mimeType: 'image/jpeg',
      }),
      discardIncoming: async () => {
        discarded = true;
      },
      deleteStoredFile: async () => {
        deleted = true;
        return true;
      },
    } as unknown as ChunkedFileStore;
    const { engine } = createTestEngine({ data, fileStore });
    const complete: ResourceCompleteMessage = {
      transferId: transfer.id as ResourceCompleteMessage['transferId'],
      resourceId: resource.id as ResourceCompleteMessage['resourceId'],
      status: 'SENDER_FINISHED',
      byteLength: resource.byteLength,
      sha256: resource.sha256 as ResourceCompleteMessage['sha256'],
      errorCode: null,
    };

    await expect(internals(engine).finishDownload(
      transfer,
      complete,
      remoteDeviceId,
      'message:finalize-boundary',
    )).rejects.toMatchObject({ code: 'REPLICA_OPERATION_REJECTED' });

    expect(pausedReason).toBe('REPLICA_OPERATION_REJECTED');
    expect(failed).toBe(false);
    expect(discarded).toBe(false);
    expect(deleted).toBe(false);
  });

  it('rejects a third simultaneous incoming transfer before creating its partial file', async () => {
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:download-sender')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:bounded-download')),
      tripId,
      mediaId: assertParsed(parseMediaId('media:bounded-download')),
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 100,
      sha256: 'b'.repeat(64),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const transfer = (id: string, state: TransferRecord['state']): TransferRecord => ({
      id,
      tripId,
      resourceId: resource.id,
      peerMemberId: remoteMember.id,
      direction: 'download',
      state,
      bytesTransferred: 0,
      totalBytes: resource.byteLength,
      chunkSize: 64,
      nextChunkIndex: 0,
      attemptCount: 0,
      lastError: null,
      startedAt: state === 'transferring' ? 1_000 : null,
      completedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const requested = transfer('request:bounded-download', 'queued');
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getByDeviceId: async (_tripId: string, deviceId: string) =>
          deviceId === remoteDeviceId ? remoteMember : localMember(),
      },
      resources: { getById: async () => resource },
      transfers: {
        getById: async () => requested,
        listActive: async () => [
          requested,
          transfer('transfer:already-one', 'transferring'),
          transfer('transfer:already-two', 'transferring'),
        ],
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    let prepared = false;
    const fileStore = {
      prepareIncoming: async () => {
        prepared = true;
        throw new Error('must not prepare a third incoming file');
      },
    } as unknown as ChunkedFileStore;
    const { engine, key, transport } = createTestEngine({ data, fileStore });
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: assertParsed(parseMessageId('message:bounded-offer')),
      tripId,
      senderMemberId: remoteMember.id,
      senderDeviceId: remoteDeviceId,
      membershipEpoch: 1,
      senderMessageSequence: 1,
      sentAtMs: 2_000,
      type: 'RESOURCE_OFFER',
      payload: {
        requestId: requested.id,
        accepted: true,
        transferId: requested.id,
        resource: {
          schemaVersion: resource.schemaVersion,
          id: resource.id,
          tripId: resource.tripId,
          mediaId: resource.mediaId,
          kind: resource.kind,
          mimeType: resource.mimeType,
          fileExtension: resource.fileExtension,
          byteLength: resource.byteLength,
          sha256: resource.sha256,
          width: resource.width,
          height: resource.height,
          createdAtMs: resource.createdAtMs,
        },
        chunkSize: 64,
        rejectionCode: null,
      },
    } as unknown as Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_OFFER' }>;

    await internals(engine).handleResourceOffer(envelope, remoteDeviceId);

    expect(prepared).toBe(false);
    const frame = parseSerializedSignedSecureControlFrame(
      transport.controls.at(-1)!.payload,
    ).frame;
    const ack = decodeControlEnvelopePlaintext(
      await new TransparentTestCrypto().open({ frame, key }),
    );
    expect(ack.type).toBe('ACK');
    if (ack.type === 'ACK') {
      expect(ack.payload.status).toBe('REJECTED');
      expect(ack.payload.errorCode).toBe('TRANSFER_LIMIT_REACHED');
    }
  });

  it('sends only an encrypted HELLO container and rejects plaintext control', async () => {
    const transport = new FakeTransport();
    const crypto = new TransparentTestCrypto();
    const events: SyncEngineEvent[] = [];
    let counter = 0;
    const key: SessionKeyHandle = {
      tripId,
      keyId: 'trip-key:engine-test',
      keyEpoch: 1,
      cipherSuite: 'XCHACHA20_POLY1305',
    };
    const engine = new SyncEngine({
      session: {
        tripId,
        localMemberId,
        localDeviceId,
        trustedCoordinatorDeviceId: localDeviceId,
        localIdentityPublicKey: localMember().identityPublicKey,
        trustedCoordinatorIdentityPublicKey: localMember().identityPublicKey,
        admissionInviteLink: null,
        endpoint: 'ws://local.test',
        isCoordinator: true,
        key,
      },
      data: minimalData(),
      transport,
      fileStore: {} as ChunkedFileStore,
      crypto,
      identity: {
        sign: async () => 'A'.repeat(86),
        verify: () => true,
      },
      wireCounter: { next: async () => ++counter },
      replayGuard: { accept: async () => true },
      operationSequenceAllocator: { allocate: async () => 1 },
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      clock: { nowMs: () => 2_000 },
      availableStorageBytes: async () => 5_000_000,
      onEvent: (event) => events.push(event),
    });

    await engine.start();
    transport.emit({ kind: 'peer-joined', peerId: remoteDeviceId });
    await settleEvents();

    expect(transport.controls).toHaveLength(1);
    const outbound = transport.controls[0]!;
    expect(outbound.type).toBe(SECURE_CONTROL_TRANSPORT_TYPE);
    expect(JSON.stringify(outbound.payload)).not.toContain('Local Ankit');
    const frame = parseSerializedSignedSecureControlFrame(outbound.payload).frame;
    const decoded = decodeControlEnvelopePlaintext(await crypto.open({ frame, key }));
    expect(decoded.type).toBe('HELLO');
    if (decoded.type === 'HELLO') expect(decoded.payload.displayName).toBe('Local Ankit');

    const rawMessage: InboundControlMessage = {
      sessionId: tripId,
      senderPeerId: remoteDeviceId,
      targetPeerId: localDeviceId,
      messageId: 'message:raw-test',
      type: 'HELLO',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        displayName: 'plaintext must never be accepted',
      },
    };
    transport.emit({ kind: 'control', message: rawMessage });
    await settleEvents();

    const errors = events.filter((event) => event.kind === 'error');
    expect(errors.at(-1)?.error.code).toBe('PLAINTEXT_CONTROL_REJECTED');
    await engine.stop();
  });

  it('verifies a signed unknown HELLO before it reaches coordinator admission', async () => {
    const signer = testIdentity(21);
    const replayAccept = vi.fn(async () => true);
    const { engine, key, transport } = createTestEngine({
      identity: signer,
      replayGuard: { accept: replayAccept },
    });
    const remoteMemberId = assertParsed(parseMemberId('member:signed-newcomer'));
    const envelope = helloEnvelope({
      deviceId: remoteDeviceId,
      memberId: remoteMemberId,
      identityPublicKey: signer.publicKey,
    });

    await internals(engine).handleInboundControl(
      await signedInboundControl(envelope, key, signer),
    );

    expect(replayAccept).toHaveBeenCalledTimes(1);
    const responseFrame = parseSerializedSignedSecureControlFrame(
      transport.controls.at(-1)!.payload,
    ).frame;
    const response = decodeControlEnvelopePlaintext(
      await new TransparentTestCrypto().open({ frame: responseFrame, key }),
    );
    expect(response.type).toBe('ACK');
    if (response.type === 'ACK') {
      expect(response.payload.errorCode).toBe('ADMISSION_REQUIRED');
    }
  });

  it('rejects a captured signed frame with a poisoned counter before replay state changes', async () => {
    const signer = testIdentity(22);
    const replayAccept = vi.fn(async () => true);
    const { engine, key } = createTestEngine({
      identity: signer,
      replayGuard: { accept: replayAccept },
    });
    const remoteMemberId = assertParsed(parseMemberId('member:counter-attacker'));
    const original = await signedInboundControl(
      helloEnvelope({
        deviceId: remoteDeviceId,
        memberId: remoteMemberId,
        identityPublicKey: signer.publicKey,
      }),
      key,
      signer,
    );
    const payload = original.payload as Record<string, unknown>;
    const poisoned: InboundControlMessage = {
      ...original,
      payload: { ...payload, senderCounter: Number.MAX_SAFE_INTEGER },
    };

    await expect(internals(engine).handleInboundControl(poisoned)).rejects.toMatchObject({
      code: 'FRAME_IDENTITY_SIGNATURE_INVALID',
    });
    expect(replayAccept).not.toHaveBeenCalled();
  });

  it('does not let a group-key holder impersonate the invite-pinned coordinator', async () => {
    const attacker = testIdentity(23);
    const replayAccept = vi.fn(async () => true);
    const { engine, key } = createTestEngine({
      isCoordinator: false,
      trustedCoordinatorDeviceId: coordinatorDeviceId,
      identity: attacker,
      replayGuard: { accept: replayAccept },
    });
    const forged = helloEnvelope({
      deviceId: coordinatorDeviceId,
      memberId: localMemberId,
      identityPublicKey: attacker.publicKey,
    });

    await expect(
      internals(engine).handleInboundControl(
        await signedInboundControl(forged, key, attacker),
      ),
    ).rejects.toMatchObject({ code: 'FRAME_IDENTITY_MISMATCH' });
    expect(replayAccept).not.toHaveBeenCalled();
  });

  it('rejects a tampered signed binary packet before decrypting or mutating replay state', async () => {
    const remoteIdentity = testIdentity(24);
    const replayAccept = vi.fn(async () => true);
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:binary-signer')),
      deviceId: remoteDeviceId,
      identityPublicKey: remoteIdentity.publicKey,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getByDeviceId: async (_tripId: string, deviceId: string) =>
          deviceId === remoteDeviceId ? remoteMember : localMember(),
        listByTrip: async () => [localMember(), remoteMember],
      },
    } as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const { engine, key } = createTestEngine({
      data,
      identity: remoteIdentity,
      replayGuard: { accept: replayAccept },
    });
    internals(engine).admittedDevices.add(remoteDeviceId);
    const frame: SecureFrame = {
      securityVersion: FRAME_SECURITY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId,
      senderDeviceId: remoteDeviceId,
      keyId: key.keyId,
      keyEpoch: key.keyEpoch,
      senderCounter: 9,
      cipherSuite: key.cipherSuite,
      nonce: new Uint8Array(24).fill(4),
      ciphertext: new Uint8Array([1, 2, 3]),
      authenticationTag: new Uint8Array(16).fill(5),
    };
    const packet = serializeSignedSecureBinaryFrame(
      await signSecureFrame(frame, remoteIdentity.publicKey, remoteIdentity),
    );
    packet[packet.length - 1] ^= 1;
    const chunk: InboundBinaryChunk = {
      sessionId: tripId,
      senderPeerId: remoteDeviceId,
      targetPeerId: localDeviceId,
      transferId: 'transfer:tampered-binary',
      resourceId: 'resource:tampered-binary',
      chunkIndex: 0,
      offset: 0,
      totalBytes: packet.byteLength,
      isLast: true,
      bytes: packet,
    };

    await expect(internals(engine).handleInboundChunk(chunk)).rejects.toMatchObject({
      code: 'FRAME_IDENTITY_SIGNATURE_INVALID',
    });
    expect(replayAccept).not.toHaveBeenCalled();
  });

  it('only allows the invite-pinned coordinator to bootstrap an unknown peer', async () => {
    const { engine, events, key, transport } = createTestEngine({
      isCoordinator: false,
      trustedCoordinatorDeviceId: coordinatorDeviceId,
    });
    const attackerMemberId = assertParsed(parseMemberId('member:attacker-test'));
    const hello: HelloMessage = {
      memberId: attackerMemberId,
      deviceId: attackerDeviceId,
      displayName: 'Impostor',
      identityPublicKey: assertParsed(parseIdentityPublicKey('B'.repeat(43))),
      admissionInviteLink: null,
      supportedProtocolVersions: [PROTOCOL_VERSION],
      membershipEpoch: 1,
      highWater: {},
      canStoreOriginals: true,
      availableStorageBytes: 1_000_000,
      maxChunkBytes: 64 * 1024,
    };
    const envelope: Extract<ProtocolEnvelope, { type: 'HELLO' }> = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: assertParsed(parseMessageId('message:attacker-hello')),
      tripId,
      senderMemberId: attackerMemberId,
      senderDeviceId: attackerDeviceId,
      membershipEpoch: 1,
      senderMessageSequence: 1,
      sentAtMs: 2_000,
      type: 'HELLO',
      payload: hello,
    };

    await internals(engine).handleHello(envelope, attackerDeviceId);

    expect(events.some((event) => event.kind === 'peer-admitted')).toBe(false);
    expect(transport.controls).toHaveLength(1);
    const frame = parseSerializedSignedSecureControlFrame(
      transport.controls[0]!.payload,
    ).frame;
    const response = decodeControlEnvelopePlaintext(
      await new TransparentTestCrypto().open({ frame, key }),
    );
    expect(response.type).toBe('ACK');
    if (response.type === 'ACK') {
      expect(response.payload.status).toBe('REJECTED');
      expect(response.payload.errorCode).toBe('UNTRUSTED_BOOTSTRAP_PEER');
    }
  });

  it('converges an existing member with a late joiner after the coordinator membership operation', async () => {
    const newcomerMemberId = assertParsed(parseMemberId('member:late-joiner'));
    const newcomer: MemberRecord = {
      ...localMember(),
      id: newcomerMemberId,
      deviceId: remoteDeviceId,
      displayName: 'Late joiner',
      identityPublicKey: 'B'.repeat(43),
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const mediaId = assertParsed(parseMediaId('media:late-joiner'));
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseResourceId('resource:late-joiner')),
      tripId,
      mediaId,
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 4,
      sha256: 'e'.repeat(64),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const outbox: OutboxRecord[] = [];
    const transfers: TransferRecord[] = [];
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        getById: async (_tripId: string, id: string) =>
          (id === newcomer.id ? newcomer : localMember()),
        getByDeviceId: async (_tripId: string, deviceId: string) =>
          (deviceId === newcomer.deviceId ? newcomer : localMember()),
        listByTrip: async () => [localMember(), newcomer],
      },
      resources: { getById: async () => resource },
      transfers: {
        listActive: async () => [],
        upsert: async (record: TransferRecord) => {
          transfers.push(record);
        },
      },
      outbox: {
        ...base.repositories.outbox,
        upsert: async (record: OutboxRecord) => {
          outbox.push(record);
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const { engine, key, transport } = createTestEngine({
      data,
      isCoordinator: false,
      trustedCoordinatorDeviceId: coordinatorDeviceId,
    });
    const internal = internals(engine);
    internal.connectedPeerIds.add(remoteDeviceId);
    const joined = {
      kind: 'MEMBER_JOINED',
      payload: { member: newcomer },
    } as SyncOperation;

    await internal.rehandshakeJoinedMembers([joined]);
    const firstHelloFrame = parseSerializedSignedSecureControlFrame(
      transport.controls[0]!.payload,
    ).frame;
    const firstHello = decodeControlEnvelopePlaintext(
      await new TransparentTestCrypto().open({ frame: firstHelloFrame, key }),
    );
    expect(firstHello.type).toBe('HELLO');
    expect(transport.controls[0]?.targetPeerId).toBe(remoteDeviceId);

    const helloEnvelope: Extract<ProtocolEnvelope, { readonly type: 'HELLO' }> = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: assertParsed(parseMessageId('message:late-joiner-hello')),
      tripId,
      senderMemberId: newcomerMemberId,
      senderDeviceId: remoteDeviceId,
      membershipEpoch: 1,
      senderMessageSequence: 7,
      sentAtMs: 2_000,
      type: 'HELLO',
      payload: {
        memberId: newcomerMemberId,
        deviceId: remoteDeviceId,
        displayName: newcomer.displayName,
        identityPublicKey: assertParsed(parseIdentityPublicKey(newcomer.identityPublicKey)),
        admissionInviteLink: 'airmesh://join?signed=test',
        supportedProtocolVersions: [PROTOCOL_VERSION],
        membershipEpoch: 1,
        highWater: {},
        canStoreOriginals: true,
        availableStorageBytes: 1_000_000,
        maxChunkBytes: 64 * 1024,
      },
    };
    await internal.handleHello(helloEnvelope, remoteDeviceId);
    expect(internal.admittedDevices.has(remoteDeviceId)).toBe(true);

    const decodedResponses = await Promise.all(
      transport.controls.slice(1).map(async (control) => {
        const frame = parseSerializedSignedSecureControlFrame(control.payload).frame;
        return decodeControlEnvelopePlaintext(
          await new TransparentTestCrypto().open({ frame, key }),
        );
      }),
    );
    expect(decodedResponses.some((response) => response.type === 'HELLO')).toBe(true);

    await internal.requestPublishedResources([{
      kind: 'MEDIA_PUBLISHED',
      payload: {
        item: {
          originDeviceId: remoteDeviceId,
          originalResourceId: resource.id,
          thumbnailResourceId: null,
        },
      },
    } as SyncOperation], remoteDeviceId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.peerMemberId).toBe(newcomer.id);
    expect((outbox[0]?.payload as { priority?: string }).priority).toBe('BACKGROUND_ORIGINAL');
  });

  it('accepts relayed operations only when the durable origin identity signed them', async () => {
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:remote-auth')),
      deviceId: remoteDeviceId,
      identityPublicKey: 'B'.repeat(43),
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        listByTrip: async () => [localMember(), remoteMember],
      },
    } as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const engine = createTestEngine({ data }).engine;
    const relayedOperation = {
      originDeviceId: remoteDeviceId,
      originIdentityPublicKey: remoteMember.identityPublicKey,
      originSignature: 'A'.repeat(86),
    } as SyncOperation;
    const forgedOperation = {
      ...relayedOperation,
      originIdentityPublicKey: 'C'.repeat(43),
    } as SyncOperation;

    await expect(
      internals(engine).areOperationOriginsAuthorized([relayedOperation], attackerDeviceId),
    ).resolves.toBe(true);
    await expect(
      internals(engine).areOperationOriginsAuthorized([forgedOperation], remoteDeviceId),
    ).resolves.toBe(false);
  });

  it('authenticates coordinator membership before accepting relayed member history', async () => {
    const coordinatorIdentity = testIdentity(31);
    const memberIdentity = testIdentity(32);
    const joinedMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:relay-origin')),
      deviceId: remoteDeviceId,
      identityPublicKey: memberIdentity.publicKey,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const joined = await signSyncOperation(
      assertParsed(
        parseSyncOperation({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          operationId: assertParsed(parseOperationId('operation:relay-join')),
          tripId,
          originDeviceId: localDeviceId,
          originSequence: 1,
          actorMemberId: localMemberId,
          membershipEpoch: 1,
          createdAtMs: 1_500,
          kind: 'MEMBER_JOINED',
          payload: { member: joinedMember },
        }),
      ),
      coordinatorIdentity.publicKey,
      coordinatorIdentity,
    );
    const memberHistory = await signSyncOperation(
      assertParsed(
        parseSyncOperation({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          operationId: assertParsed(parseOperationId('operation:relay-member-status')),
          tripId,
          originDeviceId: remoteDeviceId,
          originSequence: 1,
          actorMemberId: joinedMember.id,
          membershipEpoch: 1,
          createdAtMs: 1_600,
          kind: 'MEMBER_STATUS_CHANGED',
          payload: { member: { ...joinedMember, updatedAtMs: 1_600 } },
        }),
      ),
      memberIdentity.publicKey,
      memberIdentity,
    );
    const { engine } = createTestEngine({
      identity: coordinatorIdentity,
      trustedCoordinatorIdentityPublicKey: coordinatorIdentity.publicKey,
    });

    await expect(
      internals(engine).areOperationOriginsAuthorized(
        [memberHistory, joined],
        attackerDeviceId,
      ),
    ).resolves.toBe(true);
    await expect(
      internals(engine).areOperationOriginsAuthorized([memberHistory], attackerDeviceId),
    ).resolves.toBe(false);

    const tampered = {
      ...memberHistory,
      payload: {
        member: {
          ...joinedMember,
          updatedAtMs: 1_600,
          displayName: 'Forged after signing',
        },
      },
    } as SyncOperation;
    await expect(
      internals(engine).areOperationOriginsAuthorized([joined, tampered], attackerDeviceId),
    ).resolves.toBe(false);
  });

  it('does not let the wrong peer ACK a targeted message', async () => {
    const intendedMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:intended-test')),
      deviceId: coordinatorDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const messageId = assertParsed(parseMessageId('message:targeted-test'));
    const record: OutboxRecord = {
      id: messageId,
      tripId,
      recipientMemberId: intendedMember.id,
      messageType: 'TEST',
      payload: {},
      dedupeKey: null,
      state: 'in_flight',
      attemptCount: 1,
      availableAt: 1_000,
      leaseOwner: localDeviceId,
      leaseExpiresAt: 3_000,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    let delivered = false;
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getById: async (_tripId: string, id: string) =>
          (id === intendedMember.id ? intendedMember : localMember()),
      },
      outbox: {
        ...base.repositories.outbox,
        getById: async () => record,
        markDelivered: async () => {
          delivered = true;
        },
      },
    } as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const events: SyncEngineEvent[] = [];
    const { engine } = createTestEngine({ data, events });
    const ack: AckMessage = {
      acknowledgedMessageId: messageId,
      status: 'ACCEPTED',
      highWater: {},
      errorCode: null,
    };

    await expect(internals(engine).handleAck(ack, attackerDeviceId)).rejects.toMatchObject({
      code: 'ACK_PEER_MISMATCH',
    });
    expect(delivered).toBe(false);
    await internals(engine).handleAck(ack, coordinatorDeviceId);
    expect(delivered).toBe(true);
    expect(events).toContainEqual({
      kind: 'outbox-changed',
      messageId,
      state: 'delivered',
    });
  });

  it('backs off a capacity-rejected offer instead of retrying it every 750 ms', async () => {
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:capacity-peer')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const messageId = assertParsed(parseMessageId('message:capacity-offer'));
    const record: OutboxRecord = {
      id: messageId,
      tripId,
      recipientMemberId: remoteMember.id,
      messageType: 'PROTOCOL:RESOURCE_OFFER',
      payload: {},
      dedupeKey: 'capacity-offer',
      state: 'in_flight',
      attemptCount: 3,
      availableAt: 1_000,
      leaseOwner: localDeviceId,
      leaseExpiresAt: 3_000,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const reschedule = vi.fn(async () => undefined);
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getById: async (_tripId: string, id: string) =>
          (id === remoteMember.id ? remoteMember : localMember()),
      },
      outbox: {
        ...base.repositories.outbox,
        getById: async () => record,
        reschedule,
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const { engine } = createTestEngine({ data });

    await internals(engine).handleAck({
      acknowledgedMessageId: messageId,
      status: 'REJECTED',
      highWater: {},
      errorCode: 'TRANSFER_LIMIT_REACHED',
    }, remoteDeviceId);

    expect(reschedule).toHaveBeenCalledWith(
      tripId,
      messageId,
      10_000,
      'TRANSFER_LIMIT_REACHED',
      2_000,
    );
  });

  it('queues a thumbnail first and an original for every member, not only keepers', async () => {
    const mediaId = assertParsed(parseMediaId('media:fanout-test'));
    const resourceId = assertParsed(parseResourceId('resource:fanout-original'));
    const thumbnailId = assertParsed(parseResourceId('resource:fanout-thumbnail'));
    const nonKeeper: MemberRecord = { ...localMember(), replicaRole: 'NONE' };
    const remoteMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:photo-origin')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: resourceId,
      tripId,
      mediaId,
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 4,
      sha256: 'a'.repeat(64),
      width: 2,
      height: 2,
      createdAtMs: 1_500,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_500,
    };
    const thumbnail: ResourceRecord = {
      ...resource,
      id: thumbnailId,
      kind: 'THUMBNAIL',
      byteLength: 2,
      sha256: 'b'.repeat(64),
    };
    const outbox: OutboxRecord[] = [];
    const transfers: TransferRecord[] = [];
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getById: async (_tripId: string, id: string) =>
          (id === remoteMember.id ? remoteMember : nonKeeper),
        getByDeviceId: async (_tripId: string, id: string) =>
          (id === remoteDeviceId ? remoteMember : nonKeeper),
      },
      resources: {
        getById: async (_tripId: string, id: string) =>
          (id === thumbnailId ? thumbnail : resource),
      },
      transfers: {
        listActive: async () => [],
        upsert: async (record: TransferRecord) => {
          transfers.push(record);
        },
      },
      outbox: {
        ...base.repositories.outbox,
        upsert: async (record: OutboxRecord) => {
          outbox.push(record);
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const { engine } = createTestEngine({ data });
    const internal = internals(engine);
    internal.admittedDevices.add(remoteDeviceId);
    const publish = {
      kind: 'MEDIA_PUBLISHED',
      payload: {
        item: {
          originDeviceId: remoteDeviceId,
          originalResourceId: resourceId,
          thumbnailResourceId: thumbnailId,
        },
      },
    } as SyncOperation;

    await internal.requestPublishedResources([publish], remoteDeviceId);

    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({
      resourceId: thumbnailId,
      peerMemberId: remoteMember.id,
      direction: 'download',
      state: 'queued',
    });
    expect(transfers[1]).toMatchObject({
      resourceId,
      peerMemberId: remoteMember.id,
      direction: 'download',
      state: 'queued',
    });
    expect(outbox).toHaveLength(2);
    expect(outbox[0]?.messageType).toBe('PROTOCOL:RESOURCE_REQUEST');
    expect((outbox[0]?.payload as { priority?: string }).priority).toBe('THUMBNAIL');
    expect(outbox[0]?.availableAt).toBe(2_000);
    expect((outbox[1]?.payload as { priority?: string }).priority).toBe('BACKGROUND_ORIGINAL');
    expect(outbox[1]?.availableAt).toBe(2_300);
  });

  it('bounds a deterministic ten-member original fanout to two origin seeds, then uses verified holders', async () => {
    const mediaId = assertParsed(parseMediaId('media:ten-member-fanout'));
    const resourceId = assertParsed(parseResourceId('resource:ten-member-fanout-original'));
    const members = Array.from({ length: 10 }, (_, index): MemberRecord => ({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: assertParsed(parseMemberId(`member:fanout-${index}`)),
      tripId,
      deviceId: assertParsed(parseDeviceId(`device:fanout-${index}`)),
      displayName: index === 0 ? 'Origin' : `Receiver ${index}`,
      identityPublicKey: String(index).padStart(43, 'A'),
      role: index === 0 ? 'ADMIN' : 'MEMBER',
      status: 'ACTIVE',
      replicaRole: 'NONE',
      joinedAtMs: 1_000 + index,
      updatedAtMs: 1_000 + index,
      leftAtMs: null,
      membershipEpoch: 1,
    }));
    const origin = members[0]!;
    const receivers = members.slice(1);
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: resourceId,
      tripId,
      mediaId,
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 4_096,
      sha256: 'f'.repeat(64),
      width: 1_920,
      height: 1_080,
      createdAtMs: 1_500,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_500,
    };
    const publish = {
      kind: 'MEDIA_PUBLISHED',
      payload: {
        item: {
          originDeviceId: origin.deviceId,
          originalResourceId: resourceId,
          thumbnailResourceId: null,
        },
      },
    } as SyncOperation;
    const key: SessionKeyHandle = {
      tripId,
      keyId: 'trip-key:ten-member-fanout',
      keyEpoch: 1,
      cipherSuite: 'XCHACHA20_POLY1305',
    };

    const createReceiver = (
      receiver: MemberRecord,
      receipts: readonly ReplicaReceiptRecord[],
      reversePeerInsertion = false,
      storageByDevice: ReadonlyMap<string, number> = new Map(),
    ) => {
      const transfers: TransferRecord[] = [];
      const outbox: OutboxRecord[] = [];
      const base = minimalData();
      const repositories = {
        ...base.repositories,
        members: {
          getById: async (_tripId: string, memberId: string) =>
            members.find((member) => member.id === memberId) ?? null,
          getByDeviceId: async (_tripId: string, deviceId: string) =>
            members.find((member) => member.deviceId === deviceId) ?? null,
          listByTrip: async () => members,
        },
        resources: {
          getById: async (_tripId: string, id: string) => (id === resource.id ? resource : null),
        },
        replicaReceipts: {
          listByResource: async () => [...receipts],
        },
        transfers: {
          listActive: async () => [],
          upsert: async (record: TransferRecord) => {
            transfers.push(record);
          },
        },
        outbox: {
          ...base.repositories.outbox,
          upsert: async (record: OutboxRecord) => {
            outbox.push(record);
          },
        },
      } as unknown as AirMeshRepositories;
      const data = {
        repositories,
        transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
      } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
      const { engine } = createTestEngine({
        data,
        availableStorageBytes: async () =>
          storageByDevice.get(receiver.deviceId) ?? 512 * 1024 * 1024,
        session: {
          tripId,
          localMemberId: assertParsed(parseMemberId(receiver.id)),
          localDeviceId: assertParsed(parseDeviceId(receiver.deviceId)),
          trustedCoordinatorDeviceId: assertParsed(parseDeviceId(origin.deviceId)),
          localIdentityPublicKey: receiver.identityPublicKey,
          trustedCoordinatorIdentityPublicKey: origin.identityPublicKey,
          admissionInviteLink: null,
          endpoint: 'ws://fanout.test',
          isCoordinator: false,
          key,
        },
      });
      const internal = internals(engine);
      const peers = members.filter((member) => member.deviceId !== receiver.deviceId);
      if (reversePeerInsertion) peers.reverse();
      for (const peer of peers) {
        internal.admittedDevices.add(peer.deviceId);
        internal.canStoreOriginalsByDevice.set(peer.deviceId, true);
        internal.availableStorageBytesByDevice.set(
          peer.deviceId,
          storageByDevice.get(peer.deviceId) ?? 512 * 1024 * 1024,
        );
      }
      return { receiver, internal, transfers, outbox };
    };

    const requestWave = async (
      candidates: readonly MemberRecord[],
      receipts: readonly ReplicaReceiptRecord[],
      reversePeerInsertion = false,
      storageByDevice: ReadonlyMap<string, number> = new Map(),
    ) => {
      const wave = candidates.map((receiver) =>
        createReceiver(receiver, receipts, reversePeerInsertion, storageByDevice));
      await Promise.all(
        wave.map(({ internal }) =>
          internal.requestPublishedResources([publish], origin.deviceId)),
      );
      return wave;
    };

    const firstWave = await requestWave(receivers, []);
    const firstDownloads = firstWave.filter(({ transfers }) => transfers.length > 0);
    expect(firstDownloads).toHaveLength(2);
    expect(firstDownloads.flatMap(({ transfers }) => transfers)).toHaveLength(2);
    expect(firstDownloads.every(({ transfers }) =>
      transfers[0]?.peerMemberId === origin.id)).toBe(true);

    const repeatedWave = await requestWave(receivers, [], true);
    const selectedSeedIds = firstDownloads.map(({ receiver }) => receiver.deviceId).sort();
    expect(repeatedWave
      .filter(({ transfers }) => transfers.length > 0)
      .map(({ receiver }) => receiver.deviceId)
      .sort()).toEqual(selectedSeedIds);

    const storageByDevice = new Map(
      receivers.map((receiver) => [receiver.deviceId, 512 * 1024 * 1024] as const),
    );
    for (const seedDeviceId of selectedSeedIds) storageByDevice.set(seedDeviceId, 1_000_000);
    const storageAwareWave = await requestWave(receivers, [], false, storageByDevice);
    const storageAwareSeeds = storageAwareWave.filter(({ transfers }) => transfers.length > 0);
    expect(storageAwareSeeds).toHaveLength(2);
    expect(storageAwareSeeds.every(
      ({ receiver }) => !selectedSeedIds.includes(receiver.deviceId),
    )).toBe(true);

    const seedMembers = firstDownloads.map(({ receiver }) => receiver);
    const verifiedSeedReceipts: ReplicaReceiptRecord[] = seedMembers.map((holder, index) => ({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: `receipt:fanout-seed-${index}`,
      tripId,
      mediaId,
      resourceId,
      holderMemberId: holder.id,
      holderDeviceId: holder.deviceId,
      resourceSha256: resource.sha256,
      resourceByteLength: resource.byteLength,
      status: 'VERIFIED',
      verifiedAtMs: 2_500 + index,
      updatedAtMs: 2_500 + index,
    }));
    const remainingReceivers = receivers.filter(
      (receiver) => !selectedSeedIds.includes(receiver.deviceId),
    );
    const fanoutWave = await requestWave(remainingReceivers, verifiedSeedReceipts);
    const holderMemberIds = new Set(seedMembers.map((member) => member.id));
    const fanoutDownloads = fanoutWave.flatMap(({ transfers }) => transfers);

    expect(fanoutDownloads).toHaveLength(7);
    expect(fanoutDownloads.every((transfer) => holderMemberIds.has(transfer.peerMemberId))).toBe(true);
    expect(fanoutDownloads.every((transfer) => transfer.peerMemberId !== origin.id)).toBe(true);
    expect(fanoutWave.flatMap(({ outbox }) => outbox).every(
      (record) => record.recipientMemberId !== origin.id,
    )).toBe(true);
  });

  it('requests a relayed publication from its connected origin instead of the coordinator relay', async () => {
    const mediaId = assertParsed(parseMediaId('media:relayed-source'));
    const resourceId = assertParsed(parseResourceId('resource:relayed-source'));
    const originMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:relayed-origin')),
      deviceId: remoteDeviceId,
      role: 'MEMBER',
      replicaRole: 'NONE',
    };
    const coordinatorMember: MemberRecord = {
      ...localMember(),
      id: assertParsed(parseMemberId('member:relay-coordinator')),
      deviceId: coordinatorDeviceId,
    };
    const resource: ResourceRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: resourceId,
      tripId,
      mediaId,
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 4,
      sha256: '1'.repeat(64),
      width: 1,
      height: 1,
      createdAtMs: 1_000,
      availability: 'missing',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 1_000,
    };
    const outbox: OutboxRecord[] = [];
    const transfers: TransferRecord[] = [];
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      members: {
        ...base.repositories.members,
        getByDeviceId: async (_tripId: string, deviceId: string) => {
          if (deviceId === remoteDeviceId) return originMember;
          if (deviceId === coordinatorDeviceId) return coordinatorMember;
          return localMember();
        },
      },
      resources: { getById: async () => resource },
      transfers: {
        listActive: async () => [],
        upsert: async (record: TransferRecord) => {
          transfers.push(record);
        },
      },
      outbox: {
        ...base.repositories.outbox,
        upsert: async (record: OutboxRecord) => {
          outbox.push(record);
        },
      },
    } as unknown as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const { engine } = createTestEngine({ data });
    const internal = internals(engine);
    internal.admittedDevices.add(coordinatorDeviceId);
    internal.admittedDevices.add(remoteDeviceId);

    await internal.requestPublishedResources([{
      kind: 'MEDIA_PUBLISHED',
      payload: {
        item: {
          originDeviceId: remoteDeviceId,
          originalResourceId: resourceId,
          thumbnailResourceId: null,
        },
      },
    } as SyncOperation], coordinatorDeviceId);

    expect(transfers[0]?.peerMemberId).toBe(originMember.id);
    expect(outbox[0]?.recipientMemberId).toBe(originMember.id);
    expect(outbox[0]?.recipientMemberId).not.toBe(coordinatorMember.id);
  });

  it('refreshes newly committed local operations before flushing', async () => {
    const records: SyncOperationRecord[] = [];
    const base = minimalData();
    const repositories = {
      ...base.repositories,
      syncOperations: {
        ...base.repositories.syncOperations,
        getContiguousHighWaterMarks: async () =>
          records.length === 0 ? {} : { [localDeviceId]: records.at(-1)!.originSequence },
        listRange: async (
          _tripId: string,
          originDeviceId: string,
          after: number,
          through: number | null,
          limit: number,
        ) =>
          records
            .filter(
              (record) =>
                record.originDeviceId === originDeviceId &&
                record.originSequence > after &&
                (through === null || record.originSequence <= through),
            )
            .slice(0, limit),
      },
    } as AirMeshRepositories;
    const data = {
      repositories,
      transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
    } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
    const events: SyncEngineEvent[] = [];
    const { engine } = createTestEngine({ data, events });
    await engine.start();
    const trip = localTrip();
    records.push({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      operationId: assertParsed(parseOperationId('operation:local-trip')),
      tripId,
      originDeviceId: localDeviceId,
      originSequence: 1,
      actorMemberId: localMemberId,
      membershipEpoch: 1,
      createdAtMs: 1_000,
      originIdentityPublicKey: localMember().identityPublicKey,
      originSignature: 'A'.repeat(86),
      kind: 'TRIP_CREATED',
      payload: {
        trip: {
          schemaVersion: trip.schemaVersion,
          id: trip.id,
          name: trip.name,
          createdByMemberId: trip.createdByMemberId,
          createdAtMs: trip.createdAtMs,
          updatedAtMs: trip.updatedAtMs,
          startsAtMs: trip.startsAtMs,
          endsAtMs: trip.endsAtMs,
          timeZone: trip.timeZone,
          status: trip.status,
          defaultSharingMode: trip.defaultSharingMode,
          locationSharingMode: trip.locationSharingMode,
          targetReplicaCount: 2,
          completeKeeperCount: 1,
          membershipEpoch: trip.membershipEpoch,
        },
      } as unknown as JsonValue,
    });

    internals(engine).admittedDevices.add(remoteDeviceId);
    await engine.flushOutbox();

    expect(events).toContainEqual({
      kind: 'catalog-changed',
      source: 'local-refresh',
      appliedOperationCount: 1,
    });
    await engine.stop();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
