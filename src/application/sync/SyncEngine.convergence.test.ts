import { describe, expect, it, vi } from 'vitest';

import { DOMAIN_SCHEMA_VERSION, PROTOCOL_VERSION } from '../../core/constants';
import {
  parseDeviceId,
  parseMediaId,
  parseMemberId,
  parseMessageId,
  parseResourceId,
  parseSha256Hex,
  parseTripId,
} from '../../core/ids';
import type { ProtocolEnvelope, ResourceCompleteMessage } from '../../core/protocol';
import type {
  AuthenticatedFrameCrypto,
  SecureFrame,
  SecureFrameHeader,
  SessionKeyHandle,
} from '../../core/security';
import { assertParsed } from '../../core/validation';
import type {
  AirMeshDataLayer,
  AirMeshRepositories,
  MemberRecord,
  OutboxRecord,
  ReplicaReceiptRecord,
  ResourceRecord,
  TransferRecord,
  TripRecord,
} from '../../data';
import type { ChunkedFileStore } from '../../platform/files';
import type {
  OutboundBinaryChunk,
  OutboundControlMessage,
  Transport,
  TransportConnectRequest,
  TransportEvent,
  TransportStateSnapshot,
  TransportSubscription,
} from '../../platform/transport/Transport';

import { SyncEngine, type SyncEngineEvent } from './SyncEngine';

const tripId = assertParsed(parseTripId('trip:convergence-test'));
const localMemberId = assertParsed(parseMemberId('member:local-convergence'));
const localDeviceId = assertParsed(parseDeviceId('device:local-convergence'));
const originMemberId = assertParsed(parseMemberId('member:origin-convergence'));
const originDeviceId = assertParsed(parseDeviceId('device:origin-convergence'));
const holderMemberId = assertParsed(parseMemberId('member:holder-convergence'));
const holderDeviceId = assertParsed(parseDeviceId('device:holder-convergence'));
const chunkBytes = 192 * 1024;

class NoopTransport implements Transport {
  private snapshot: TransportStateSnapshot = { state: 'connected', reconnectAttempt: 0 };
  readonly controls: OutboundControlMessage[] = [];
  readonly chunks: OutboundBinaryChunk[] = [];

  get state(): TransportStateSnapshot {
    return this.snapshot;
  }

  connect(_request: TransportConnectRequest): void {
    this.snapshot = { state: 'connected', reconnectAttempt: 0 };
  }

  disconnect(): void {
    this.snapshot = { state: 'stopped', reconnectAttempt: 0 };
  }

  sendControl(message: OutboundControlMessage): void {
    this.controls.push(message);
  }

  sendChunk(message: OutboundBinaryChunk): void {
    this.chunks.push(message);
  }

  subscribe(_listener: (event: TransportEvent) => void): TransportSubscription {
    return { remove: () => undefined };
  }
}

class TransparentCrypto implements AuthenticatedFrameCrypto {
  async seal(input: {
    readonly header: SecureFrameHeader;
    readonly plaintext: Uint8Array;
    readonly key: SessionKeyHandle;
  }): Promise<SecureFrame> {
    return {
      ...input.header,
      nonce: new Uint8Array(24),
      ciphertext: input.plaintext.slice(),
      authenticationTag: new Uint8Array(16),
    };
  }

  async open(input: { readonly frame: SecureFrame; readonly key: SessionKeyHandle }) {
    return input.frame.ciphertext.slice();
  }
}

function trip(): TripRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: tripId,
    name: 'Convergence test trip',
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

function member(
  id: MemberRecord['id'],
  deviceId: MemberRecord['deviceId'],
  role: MemberRecord['role'] = 'MEMBER',
): MemberRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id,
    tripId,
    deviceId,
    displayName: String(id),
    identityPublicKey: 'A'.repeat(43),
    role,
    status: 'ACTIVE',
    replicaRole: role === 'ADMIN' ? 'KEEPER_PRIMARY' : 'NONE',
    joinedAtMs: 1_000,
    updatedAtMs: 1_000,
    leftAtMs: null,
    membershipEpoch: 1,
  };
}

const localMember = () => member(localMemberId, localDeviceId, 'ADMIN');
const originMember = () => member(originMemberId, originDeviceId);
const holderMember = () => member(holderMemberId, holderDeviceId);

function resource(
  suffix: string,
  kind: ResourceRecord['kind'] = 'ORIGINAL',
  availability: ResourceRecord['availability'] = 'missing',
): ResourceRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: assertParsed(parseResourceId(`resource:${suffix}`)),
    tripId,
    mediaId: assertParsed(parseMediaId(`media:${suffix}`)),
    kind,
    mimeType: 'image/jpeg',
    fileExtension: 'jpg',
    byteLength: chunkBytes * 2,
    sha256: assertParsed(parseSha256Hex('b'.repeat(64))),
    width: 1,
    height: 1,
    createdAtMs: 1_000,
    availability,
    localUri: availability === 'available' ? `file:///resource/${suffix}.jpg` : null,
    verifiedAtMs: availability === 'available' ? 1_000 : null,
    updatedAtMs: 1_000,
  };
}

function transfer(input: {
  id: string;
  resource: ResourceRecord;
  peerMemberId?: MemberRecord['id'];
  direction?: TransferRecord['direction'];
  state?: TransferRecord['state'];
  bytesTransferred?: number;
  updatedAt?: number;
}): TransferRecord {
  const bytesTransferred = input.bytesTransferred ?? 0;
  return {
    id: input.id,
    tripId,
    resourceId: input.resource.id,
    peerMemberId: input.peerMemberId ?? originMemberId,
    direction: input.direction ?? 'download',
    state: input.state ?? 'queued',
    bytesTransferred,
    totalBytes: input.resource.byteLength,
    chunkSize: chunkBytes,
    nextChunkIndex: Math.ceil(bytesTransferred / chunkBytes),
    attemptCount: 0,
    lastError: null,
    startedAt: bytesTransferred > 0 ? 1_000 : null,
    completedAt: input.state === 'completed' ? 1_000 : null,
    createdAt: 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  };
}

interface TestRepositoriesInput {
  readonly resources?: ResourceRecord[];
  readonly transfers?: TransferRecord[];
  readonly receipts?: ReplicaReceiptRecord[];
  readonly outbox?: OutboxRecord[];
}

function testRepositories(input: TestRepositoriesInput = {}) {
  const resources = input.resources ?? [];
  const transfers = input.transfers ?? [];
  const receipts = input.receipts ?? [];
  const outbox = input.outbox ?? [];
  const members = [localMember(), originMember(), holderMember()];
  const repositories = {
    trips: { getById: async () => trip() },
    members: {
      getById: async (_tripId: string, id: string) =>
        members.find((candidate) => candidate.id === id) ?? null,
      getByDeviceId: async (_tripId: string, deviceId: string) =>
        members.find((candidate) => candidate.deviceId === deviceId) ?? null,
      listByTrip: async () => members,
    },
    media: {
      getById: async (_tripId: string, mediaId: string) => {
        const manifest = resources.find((candidate) => candidate.mediaId === mediaId);
        return manifest
          ? {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              id: manifest.mediaId,
              tripId,
              originMemberId,
              originDeviceId,
              originalResourceId: manifest.id,
              thumbnailResourceId: manifest.kind === 'THUMBNAIL' ? manifest.id : null,
              capturedAtMs: 1_000,
              sharedAtMs: 1_000,
              width: 1,
              height: 1,
              durationMs: null,
              mediaType: 'IMAGE',
              lifecycle: 'ACTIVE',
              sharingMode: 'AUTO_SHARE',
              sourceAssetId: null,
              updatedAtMs: 1_000,
            }
          : null;
      },
    },
    resources: {
      getById: async (_tripId: string, id: string) =>
        resources.find((candidate) => candidate.id === id) ?? null,
      listUnavailable: vi.fn(async (
        _tripId: string,
        limit: number,
        after?: Pick<ResourceRecord, 'kind' | 'createdAtMs' | 'id'> | null,
      ) => {
        const rank = (kind: ResourceRecord['kind']) => kind === 'THUMBNAIL' ? 0 : 1;
        return resources
          .filter((candidate) => candidate.availability !== 'available')
          .sort((left, right) =>
            rank(left.kind) - rank(right.kind) ||
            left.createdAtMs - right.createdAtMs ||
            left.id.localeCompare(right.id))
          .filter((candidate) => !after ||
            rank(candidate.kind) > rank(after.kind) ||
            (rank(candidate.kind) === rank(after.kind) &&
              (candidate.createdAtMs > after.createdAtMs ||
                (candidate.createdAtMs === after.createdAtMs && candidate.id > after.id))))
          .slice(0, limit);
      }),
    },
    replicaReceipts: {
      listByResource: async (_tripId: string, resourceId: string) =>
        receipts.filter((receipt) => receipt.resourceId === resourceId),
    },
    transfers: {
      listActive: async () => transfers.filter((candidate) =>
        ['queued', 'transferring', 'verifying', 'paused'].includes(candidate.state)),
      getById: async (_tripId: string, id: string) =>
        transfers.find((candidate) => candidate.id === id) ?? null,
      upsert: async (record: TransferRecord) => {
        const index = transfers.findIndex((candidate) => candidate.id === record.id);
        if (index === -1) transfers.push(record);
        else transfers[index] = record;
      },
      updateProgress: async (
        _tripId: string,
        id: string,
        bytesTransferred: number,
        nextChunkIndex: number,
        state: TransferRecord['state'],
        updatedAt: number,
      ) => {
        const index = transfers.findIndex((candidate) => candidate.id === id);
        if (index === -1) return;
        transfers[index] = {
          ...transfers[index]!,
          bytesTransferred,
          nextChunkIndex,
          state,
          updatedAt,
        };
      },
      markPaused: async (_tripId: string, id: string, reason: string, updatedAt: number) => {
        const index = transfers.findIndex((candidate) => candidate.id === id);
        if (index === -1) return;
        const current = transfers[index]!;
        transfers[index] = {
          ...current,
          state: 'paused',
          attemptCount: current.attemptCount + (current.state === 'paused' ? 0 : 1),
          lastError: reason,
          updatedAt,
        };
      },
      markFailed: async (_tripId: string, id: string, reason: string, updatedAt: number) => {
        const index = transfers.findIndex((candidate) => candidate.id === id);
        if (index === -1) return;
        transfers[index] = { ...transfers[index]!, state: 'failed', lastError: reason, updatedAt };
      },
      markCancelled: async (_tripId: string, id: string, reason: string, updatedAt: number) => {
        const index = transfers.findIndex((candidate) => candidate.id === id);
        if (index === -1) return false;
        transfers[index] = { ...transfers[index]!, state: 'cancelled', lastError: reason, updatedAt };
        return true;
      },
    },
    outbox: {
      upsert: async (record: OutboxRecord) => {
        const index = outbox.findIndex((candidate) => candidate.id === record.id);
        if (index === -1) outbox.push(record);
        else outbox[index] = record;
      },
      claimDue: async () => [],
      getNextWakeAt: async () => null,
      getById: async (_tripId: string, id: string) =>
        outbox.find((candidate) => candidate.id === id) ?? null,
    },
    syncOperations: {
      getContiguousHighWaterMarks: async () => ({}),
      listRange: async () => [],
    },
  } as unknown as AirMeshRepositories;
  return { repositories, resources, transfers, receipts, outbox };
}

function createEngine(
  repositories: AirMeshRepositories,
  input: { fileStore?: ChunkedFileStore; events?: SyncEngineEvent[] } = {},
) {
  const key: SessionKeyHandle = {
    tripId,
    keyId: 'trip-key:convergence',
    keyEpoch: 1,
    cipherSuite: 'XCHACHA20_POLY1305',
  };
  let counter = 0;
  const events = input.events ?? [];
  const data = {
    repositories,
    transaction: (task: (value: AirMeshRepositories) => Promise<unknown>) => task(repositories),
  } as Pick<AirMeshDataLayer, 'repositories' | 'transaction'>;
  const engine = new SyncEngine({
    session: {
      tripId,
      localMemberId,
      localDeviceId,
      trustedCoordinatorDeviceId: localDeviceId,
      localIdentityPublicKey: localMember().identityPublicKey,
      trustedCoordinatorIdentityPublicKey: localMember().identityPublicKey,
      admissionInviteLink: null,
      endpoint: 'ws://convergence.test',
      isCoordinator: true,
      key,
    },
    data,
    transport: new NoopTransport(),
    fileStore: input.fileStore ?? ({} as ChunkedFileStore),
    crypto: new TransparentCrypto(),
    identity: {
      sign: async () => 'A'.repeat(86),
      verify: () => true,
    },
    wireCounter: { next: async () => ++counter },
    replayGuard: { accept: async () => true },
    operationSequenceAllocator: { allocate: async () => 1 },
    scheduler: { setInterval: () => 1, clearInterval: () => undefined },
    clock: { nowMs: () => 10_000 },
    availableStorageBytes: async () => 512 * 1024 * 1024,
    onEvent: (event) => events.push(event),
  });
  return { engine, events };
}

interface SyncEngineInternals {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  admittedDevices: Set<string>;
  activeUploads: Map<string, Promise<void>>;
  downloadPriorities: Map<string, 'THUMBNAIL' | 'USER_VISIBLE_ORIGINAL' | 'BACKGROUND_ORIGINAL'>;
  availableAutomaticDownloadSlots(
    priority: 'THUMBNAIL' | 'USER_VISIBLE_ORIGINAL' | 'BACKGROUND_ORIGINAL',
    usage: {
      thumbnails: number;
      userVisibleOriginals: number;
      backgroundOriginals: number;
    },
  ): number;
  reconcileUnavailableResources(force?: boolean): Promise<void>;
  reconcileRecoverableTransfers(): Promise<void>;
  recoverInactiveDownload(transferId: string): Promise<void>;
  handleResourceRequest(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_REQUEST' }>,
    peerDeviceId: string,
  ): Promise<void>;
  handleResourceComplete(
    envelope: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_COMPLETE' }>,
    peerDeviceId: string,
  ): Promise<void>;
  ensureDownloadFinalized(transfer: TransferRecord, completionKey: string): Promise<void>;
  sendAck(
    acknowledgedMessageId: string,
    targetPeerId: string,
    status: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE',
    errorCode: string | null,
  ): Promise<void>;
  finishDownload(
    transfer: TransferRecord,
    complete: ResourceCompleteMessage,
    peerDeviceId: string,
    completionMessageId: string,
  ): Promise<void>;
  cancelSiblingDownloads(resourceId: string, completedTransferId: string, now: number): Promise<void>;
}

const internals = (engine: SyncEngine) => engine as unknown as SyncEngineInternals;

function resourceRequestEnvelope(
  requestId: string,
  manifest: ResourceRecord,
  startOffset: number,
  messageSuffix: string,
): Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_REQUEST' }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: assertParsed(parseMessageId(`message:${messageSuffix}`)),
    tripId,
    senderMemberId: originMemberId,
    senderDeviceId: originDeviceId,
    membershipEpoch: 1,
    senderMessageSequence: 1,
    sentAtMs: 10_000,
    type: 'RESOURCE_REQUEST',
    payload: {
      requestId: requestId as Extract<ProtocolEnvelope, { type: 'RESOURCE_REQUEST' }>['payload']['requestId'],
      mediaId: assertParsed(parseMediaId(manifest.mediaId)),
      resourceId: assertParsed(parseResourceId(manifest.id)),
      expectedSha256: assertParsed(parseSha256Hex(manifest.sha256)),
      startOffset,
      priority: 'BACKGROUND_ORIGINAL',
    },
  };
}

describe('SyncEngine durable resource convergence', () => {
  it('turns persisted missing manifests into bounded automatic demand without duplicate attempts', async () => {
    const thumbnail = resource('auto-thumb', 'THUMBNAIL');
    const original = resource('auto-original');
    const state = testRepositories({ resources: [thumbnail, original] });
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);

    await internal.reconcileUnavailableResources(true);
    await internal.reconcileUnavailableResources(true);

    expect(state.repositories.resources.listUnavailable).toHaveBeenCalledWith(tripId, 32);
    expect(state.transfers.filter((candidate) => candidate.direction === 'download')).toHaveLength(2);
    const requests = state.outbox.filter(
      (record) => record.messageType === 'PROTOCOL:RESOURCE_REQUEST',
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((record) => record.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: thumbnail.id, priority: 'THUMBNAIL' }),
      expect.objectContaining({ resourceId: original.id, priority: 'BACKGROUND_ORIGINAL' }),
    ]));
  });

  it('advances a keyset scan so the oldest unavailable rows cannot starve newer photos', async () => {
    const manifests = Array.from(
      { length: 35 },
      (_, index) => resource(`fair-scan-${String(index).padStart(2, '0')}`, 'THUMBNAIL'),
    );
    const state = testRepositories({ resources: manifests });
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);

    await internal.reconcileUnavailableResources(true);
    await internal.reconcileUnavailableResources(true);

    const calls = vi.mocked(state.repositories.resources.listUnavailable).mock.calls;
    expect(calls[0]).toEqual([tripId, 32]);
    expect(calls[1]).toEqual([
      tripId,
      32,
      {
        kind: manifests[31]!.kind,
        createdAtMs: manifests[31]!.createdAtMs,
        id: manifests[31]!.id,
      },
    ]);
  });

  it('kicks the outbox once after a reconciliation pass creates multiple resource requests', async () => {
    const thumbnails = Array.from(
      { length: 3 },
      (_, index) => resource(`reconcile-outbox-${index}`, 'THUMBNAIL'),
    );
    const state = testRepositories({ resources: thumbnails });
    const claimDue = vi.spyOn(state.repositories.outbox, 'claimDue');
    const getNextWakeAt = vi.spyOn(state.repositories.outbox, 'getNextWakeAt');
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);

    await internal.reconcileUnavailableResources(true);

    expect(state.outbox.filter(
      (record) => record.messageType === 'PROTOCOL:RESOURCE_REQUEST',
    )).toHaveLength(3);
    expect(claimDue).toHaveBeenCalledTimes(1);
    expect(getNextWakeAt).toHaveBeenCalledTimes(1);
  });

  it('keeps automatic demand within receiver capacity and gives thumbnails every slot', async () => {
    const thumbnails = Array.from(
      { length: 20 },
      (_, index) => resource(`overload-thumbnail-${index}`, 'THUMBNAIL'),
    );
    const originals = Array.from(
      { length: 20 },
      (_, index) => resource(`overload-original-${index}`),
    );
    const state = testRepositories({ resources: [...thumbnails, ...originals] });
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);

    await internal.reconcileUnavailableResources(true);
    await internal.reconcileUnavailableResources(true);

    const demanded = state.transfers.filter(
      (candidate) => candidate.direction === 'download' && candidate.state === 'queued',
    );
    expect(demanded).toHaveLength(3);
    expect(demanded.every((candidate) =>
      thumbnails.some((thumbnail) => thumbnail.id === candidate.resourceId))).toBe(true);
    expect(state.outbox.filter(
      (record) => record.messageType === 'PROTOCOL:RESOURCE_REQUEST',
    )).toHaveLength(3);
  });

  it('reserves a preview lane when background and user-visible originals came from earlier batches', async () => {
    const thumbnail = resource('cross-batch-thumbnail', 'THUMBNAIL');
    const background = resource('cross-batch-background');
    const userVisible = resource('cross-batch-user-visible');
    const backgroundTransfer = transfer({
      id: 'request:cross-batch-background',
      resource: background,
      state: 'verifying',
    });
    const userVisibleTransfer = transfer({
      id: 'request:cross-batch-user-visible',
      resource: userVisible,
      state: 'verifying',
    });
    const state = testRepositories({
      resources: [thumbnail, background, userVisible],
      transfers: [backgroundTransfer, userVisibleTransfer],
    });
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);
    internal.downloadPriorities.set(backgroundTransfer.id, 'BACKGROUND_ORIGINAL');
    internal.downloadPriorities.set(userVisibleTransfer.id, 'USER_VISIBLE_ORIGINAL');

    await internal.reconcileUnavailableResources(true);

    expect(state.transfers).toContainEqual(expect.objectContaining({
      resourceId: thumbnail.id,
      direction: 'download',
      state: 'queued',
    }));
    expect(state.outbox).toContainEqual(expect.objectContaining({
      messageType: 'PROTOCOL:RESOURCE_REQUEST',
      payload: expect.objectContaining({
        resourceId: thumbnail.id,
        priority: 'THUMBNAIL',
      }),
    }));
  });

  it('does not overbook a user-visible original when all three lanes have thumbnails', () => {
    const internal = internals(createEngine(testRepositories().repositories).engine);

    expect(internal.availableAutomaticDownloadSlots('USER_VISIBLE_ORIGINAL', {
      thumbnails: 3,
      userVisibleOriginals: 0,
      backgroundOriginals: 0,
    })).toBe(0);
    expect(internal.availableAutomaticDownloadSlots('USER_VISIBLE_ORIGINAL', {
      thumbnails: 0,
      userVisibleOriginals: 0,
      backgroundOriginals: 1,
    })).toBe(1);
  });

  it('keeps automatic original demand to one background lane', async () => {
    const originals = Array.from(
      { length: 8 },
      (_, index) => resource(`bounded-background-${index}`),
    );
    const state = testRepositories({ resources: originals });
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);

    await internal.reconcileUnavailableResources(true);

    const demanded = state.transfers.filter(
      (candidate) => candidate.direction === 'download' && candidate.state === 'queued',
    );
    expect(demanded).toHaveLength(1);
    expect(state.outbox).toContainEqual(expect.objectContaining({
      messageType: 'PROTOCOL:RESOURCE_REQUEST',
      payload: expect.objectContaining({ priority: 'BACKGROUND_ORIGINAL' }),
    }));
  });

  it('never rewinds an advanced upload and rejects a duplicate request for a completed attempt', async () => {
    const manifest = resource('idempotent-upload', 'ORIGINAL', 'available');
    const advanced = transfer({
      id: 'request:advanced-upload',
      resource: manifest,
      direction: 'upload',
      state: 'verifying',
      bytesTransferred: manifest.byteLength,
    });
    const completed = transfer({
      id: 'request:completed-upload',
      resource: manifest,
      direction: 'upload',
      state: 'completed',
      bytesTransferred: manifest.byteLength,
    });
    const state = testRepositories({ resources: [manifest], transfers: [advanced, completed] });
    const upsert = vi.spyOn(state.repositories.transfers, 'upsert');
    const internal = internals(createEngine(state.repositories).engine);

    await internal.handleResourceRequest(
      resourceRequestEnvelope(advanced.id, manifest, 0, 'advanced-upload'),
      originDeviceId,
    );
    await internal.handleResourceRequest(
      resourceRequestEnvelope(completed.id, manifest, 0, 'completed-upload'),
      originDeviceId,
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(state.transfers.find((candidate) => candidate.id === advanced.id)).toMatchObject({
      state: 'verifying',
      bytesTransferred: manifest.byteLength,
    });
    const offers = state.outbox.filter(
      (record) => record.messageType === 'PROTOCOL:RESOURCE_OFFER',
    );
    expect(offers.map((record) => record.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: advanced.id, accepted: true }),
      expect.objectContaining({
        requestId: completed.id,
        accepted: false,
        rejectionCode: 'TRANSFER_ALREADY_COMPLETED',
      }),
    ]));
  });

  it('recovers an inactive download from its durable checkpoint on the same peer', async () => {
    const manifest = resource('stalled-download');
    const stalled = transfer({
      id: 'request:stalled-download',
      resource: manifest,
      state: 'transferring',
      bytesTransferred: chunkBytes,
    });
    const state = testRepositories({ resources: [manifest], transfers: [stalled] });
    const fileStore = {
      getIncoming: () => ({
        uri: 'file:///incoming/stalled.part',
        byteSize: chunkBytes,
        mimeType: 'application/octet-stream',
      }),
      getOriginal: () => null,
    } as unknown as ChunkedFileStore;
    const { engine, events } = createEngine(state.repositories, { fileStore });
    const internal = internals(engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);

    await internal.recoverInactiveDownload(stalled.id);

    expect(state.transfers.find((candidate) => candidate.id === stalled.id)).toMatchObject({
      state: 'paused',
      bytesTransferred: chunkBytes,
      nextChunkIndex: 1,
      lastError: 'DOWNLOAD_STALLED',
    });
    expect(state.outbox).toContainEqual(expect.objectContaining({
      messageType: 'PROTOCOL:RESOURCE_REQUEST',
      payload: expect.objectContaining({ requestId: stalled.id, startOffset: chunkBytes }),
    }));
    expect(events.some(
      (event) => event.kind === 'error' && event.error.code === 'DOWNLOAD_STALLED',
    )).toBe(true);
  });

  it('does not postpone the inactivity deadline when periodic reconciliation observes no progress', async () => {
    vi.useFakeTimers();
    try {
      const manifest = resource('watchdog-deadline');
      const stalled = transfer({
        id: 'request:watchdog-deadline',
        resource: manifest,
        state: 'transferring',
      });
      const state = testRepositories({ resources: [manifest], transfers: [stalled] });
      const internal = internals(createEngine(state.repositories).engine);
      internal.state = 'running';
      internal.admittedDevices.add(originDeviceId);
      const recover = vi.fn(async () => undefined);
      internal.recoverInactiveDownload = recover;

      await internal.reconcileUnavailableResources(true);
      await vi.advanceTimersByTimeAsync(10_000);
      await internal.reconcileUnavailableResources(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(recover).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledWith(stalled.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails over a missing resource to an admitted verified holder', async () => {
    const manifest = resource('holder-failover');
    const originAttempt = transfer({
      id: 'request:origin-attempt',
      resource: manifest,
      state: 'paused',
    });
    const receipt: ReplicaReceiptRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: 'receipt:holder-failover',
      tripId,
      mediaId: manifest.mediaId,
      resourceId: manifest.id,
      holderMemberId,
      holderDeviceId,
      resourceSha256: manifest.sha256,
      resourceByteLength: manifest.byteLength,
      status: 'VERIFIED',
      verifiedAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    const state = testRepositories({
      resources: [manifest],
      transfers: [originAttempt],
      receipts: [receipt],
    });
    const internal = internals(createEngine(state.repositories).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);
    internal.admittedDevices.add(holderDeviceId);

    await internal.reconcileUnavailableResources(true);

    const holderAttempt = state.transfers.find(
      (candidate) => candidate.peerMemberId === holderMemberId,
    );
    expect(holderAttempt).toMatchObject({ direction: 'download', state: 'queued' });
    expect(state.outbox).toContainEqual(expect.objectContaining({
      recipientMemberId: holderMemberId,
      messageType: 'PROTOCOL:RESOURCE_REQUEST',
    }));
  });

  it.each<TransferRecord['state']>(['transferring', 'failed'])(
    'immediately selects another verified holder after a sender rejects its corrupt source from a %s attempt',
    async (initialState) => {
    const manifest = resource('sender-rejected-failover');
    const rejectedAttempt = {
      ...transfer({
      id: 'request:sender-rejected-failover',
      resource: manifest,
      state: initialState,
      bytesTransferred: chunkBytes,
      }),
      lastError: initialState === 'failed' ? 'WHOLE_FILE_HASH_MISMATCH' : null,
    };
    const receipt: ReplicaReceiptRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: 'receipt:sender-rejected-failover',
      tripId,
      mediaId: manifest.mediaId,
      resourceId: manifest.id,
      holderMemberId,
      holderDeviceId,
      resourceSha256: manifest.sha256,
      resourceByteLength: manifest.byteLength,
      status: 'VERIFIED',
      verifiedAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    const state = testRepositories({
      resources: [manifest],
      transfers: [rejectedAttempt],
      receipts: [receipt],
    });
    const fileStore = {
      discardIncoming: async () => undefined,
    } as unknown as ChunkedFileStore;
    const internal = internals(createEngine(state.repositories, { fileStore }).engine);
    internal.state = 'running';
    internal.admittedDevices.add(originDeviceId);
    internal.admittedDevices.add(holderDeviceId);
    const rejection: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_COMPLETE' }> = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: assertParsed(parseMessageId('message:sender-rejected-failover')),
      tripId,
      senderMemberId: originMemberId,
      senderDeviceId: originDeviceId,
      membershipEpoch: 1,
      senderMessageSequence: 1,
      sentAtMs: 10_000,
      type: 'RESOURCE_COMPLETE',
      payload: {
        transferId: rejectedAttempt.id as ResourceCompleteMessage['transferId'],
        resourceId: manifest.id as ResourceCompleteMessage['resourceId'],
        status: 'SENDER_REJECTED',
        byteLength: manifest.byteLength,
        sha256: manifest.sha256 as ResourceCompleteMessage['sha256'],
        errorCode: 'UPLOAD_SOURCE_INTEGRITY_FAILED',
      },
    };

    await internal.handleResourceComplete(rejection, originDeviceId);

    expect(state.transfers.find((candidate) => candidate.id === rejectedAttempt.id)).toMatchObject({
      state: 'failed',
      lastError: initialState === 'failed'
        ? 'WHOLE_FILE_HASH_MISMATCH'
        : 'UPLOAD_SOURCE_INTEGRITY_FAILED',
    });
    expect(state.transfers.find(
      (candidate) => candidate.peerMemberId === holderMemberId,
    )).toMatchObject({
      direction: 'download',
      state: 'queued',
      resourceId: manifest.id,
    });
    expect(state.outbox).toContainEqual(expect.objectContaining({
      recipientMemberId: holderMemberId,
      messageType: 'PROTOCOL:RESOURCE_REQUEST',
      payload: expect.objectContaining({ resourceId: manifest.id }),
    }));
    },
  );

  it('self-finalizes a full checkpoint after restart without waiting for SENDER_FINISHED', async () => {
    const manifest = resource('restart-finalization', 'ORIGINAL', 'partial');
    const recovered = transfer({
      id: 'request:restart-finalization',
      resource: manifest,
      state: 'transferring',
      bytesTransferred: manifest.byteLength,
    });
    const state = testRepositories({ resources: [manifest], transfers: [recovered] });
    const fileStore = {
      getIncoming: () => ({
        uri: 'file:///incoming/restart-finalization.part',
        byteSize: manifest.byteLength,
        mimeType: 'application/octet-stream',
      }),
      getOriginal: () => null,
    } as unknown as ChunkedFileStore;
    const internal = internals(createEngine(state.repositories, { fileStore }).engine);
    const finishDownload = vi.fn(async (
      _transfer: TransferRecord,
      _complete: ResourceCompleteMessage,
      _peerDeviceId: string,
      _completionMessageId: string,
    ) => undefined);
    internal.finishDownload = finishDownload;

    await internal.reconcileRecoverableTransfers();

    expect(finishDownload).toHaveBeenCalledOnce();
    expect(finishDownload.mock.calls[0]?.[1]).toMatchObject({
      transferId: recovered.id,
      resourceId: manifest.id,
      status: 'SENDER_FINISHED',
      byteLength: manifest.byteLength,
      sha256: manifest.sha256,
    });
  });

  it('keeps the transport event path responsive while a full download is hashing', async () => {
    const manifest = resource('nonblocking-finalization', 'ORIGINAL', 'partial');
    const completedBytes = transfer({
      id: 'request:nonblocking-finalization',
      resource: manifest,
      state: 'verifying',
      bytesTransferred: manifest.byteLength,
    });
    const state = testRepositories({ resources: [manifest], transfers: [completedBytes] });
    const internal = internals(createEngine(state.repositories).engine);
    let releaseHash!: () => void;
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    internal.ensureDownloadFinalized = vi.fn(() => hashGate);
    internal.sendAck = vi.fn(async () => undefined);
    const messageId = assertParsed(parseMessageId('message:nonblocking-finalization'));
    const completion: Extract<ProtocolEnvelope, { readonly type: 'RESOURCE_COMPLETE' }> = {
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      tripId,
      senderMemberId: originMemberId,
      senderDeviceId: originDeviceId,
      membershipEpoch: 1,
      senderMessageSequence: 1,
      sentAtMs: 10_000,
      type: 'RESOURCE_COMPLETE',
      payload: {
        transferId: completedBytes.id as ResourceCompleteMessage['transferId'],
        resourceId: manifest.id as ResourceCompleteMessage['resourceId'],
        status: 'SENDER_FINISHED',
        byteLength: manifest.byteLength,
        sha256: manifest.sha256 as ResourceCompleteMessage['sha256'],
        errorCode: null,
      },
    };

    await internal.handleResourceComplete(completion, originDeviceId);
    await Promise.resolve();
    expect(internal.ensureDownloadFinalized).toHaveBeenCalledOnce();
    expect(internal.sendAck).not.toHaveBeenCalled();

    releaseHash();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(internal.sendAck).toHaveBeenCalledWith(
      messageId,
      originDeviceId,
      'ACCEPTED',
      null,
    );
  });

  it('cancels and removes partial files for losing sibling attempts after one succeeds', async () => {
    const manifest = resource('sibling-cleanup');
    const winner = transfer({ id: 'request:winner', resource: manifest, state: 'verifying' });
    const sibling = transfer({ id: 'request:sibling', resource: manifest, state: 'paused' });
    const state = testRepositories({ resources: [manifest], transfers: [winner, sibling] });
    const discarded: string[] = [];
    const fileStore = {
      discardIncoming: async (transferId: string) => {
        discarded.push(transferId);
      },
    } as unknown as ChunkedFileStore;
    const internal = internals(createEngine(state.repositories, { fileStore }).engine);

    await internal.cancelSiblingDownloads(manifest.id, winner.id, 10_000);

    expect(state.transfers.find((candidate) => candidate.id === sibling.id)).toMatchObject({
      state: 'cancelled',
      lastError: 'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
    });
    expect(discarded).toEqual([sibling.id]);
    expect(state.outbox).toContainEqual(expect.objectContaining({
      recipientMemberId: sibling.peerMemberId,
      messageType: 'PROTOCOL:RESOURCE_COMPLETE',
      payload: expect.objectContaining({
        transferId: sibling.id,
        status: 'RECEIVER_REJECTED',
        errorCode: 'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
      }),
    }));
  });
});
