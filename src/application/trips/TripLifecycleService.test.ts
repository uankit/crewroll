import { describe, expect, it, vi } from 'vitest';

import type { DeviceIdentityService } from '@/application/identity/DeviceIdentityService';
import { createSessionKeyHandle, type TripKeyVault } from '@/application/security/TripKeyVault';
import { DOMAIN_SCHEMA_VERSION, INVITE_VERSION, MAX_INVITE_LIFETIME_MS, PROTOCOL_VERSION } from '@/core/constants';
import { decodeInviteDeepLink, encodeInviteDeepLink, parseGroupSecret, type TripInvite } from '@/core/invite';
import { parseDeviceId, parseInviteId, parseMemberId, parseTripId } from '@/core/ids';
import { assertParsed } from '@/core/validation';
import type {
  AirMeshDataLayer,
  DeviceSettingRecord,
  MemberRecord,
  OutboxRecord,
  SyncOperationRecord,
  TripRecord,
} from '@/data';

import {
  acceptedInviteIdKey,
  acceptedInviteIssuedAtKey,
  coordinatorDeviceKey,
  coordinatorKey,
  endpointKey,
  localMemberKey,
  operationSequenceKey,
  TripLifecycleService,
} from './TripLifecycleService';

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(2),
  randomUUID: () => 'test-random-uuid',
}));
vi.mock('expo-network', () => ({ getIpAddressAsync: async () => '192.168.1.10' }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
  deleteItemAsync: async () => undefined,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
}));

const TRIP_ID = assertParsed(parseTripId('trip:lifecycle-test'));
const HOST_MEMBER_ID = assertParsed(parseMemberId('member:host-test'));
const LOCAL_MEMBER_ID = assertParsed(parseMemberId('member:local-test'));
const HOST_DEVICE_ID = assertParsed(parseDeviceId('device:host-test'));
const LOCAL_DEVICE_ID = assertParsed(parseDeviceId('device:local-test'));
const IDENTITY_KEY = 'A'.repeat(43);
const GROUP_SECRET = assertParsed(parseGroupSecret(`${'B'.repeat(42)}A`));
const NOW = 20_000;

describe('TripLifecycleService P1 lifecycle', () => {
  it('persists an injected WSS endpoint through create, resume, refresh, and member join', async () => {
    const relayEndpoint = 'wss://relay.example.test/v1/relay?region=in';
    const coordinator = createHarness({
      coordinator: true,
      localAddress: '192.168.4.1',
      endpoint: relayEndpoint,
      active: false,
    });
    const created = await coordinator.service.create({
      name: 'Relay trip',
      displayName: 'Host',
    });
    const createdTripId = assertParsed(parseTripId(created.trip.id));
    expect(created.endpoint).toBe(relayEndpoint);
    const createdInvite = decodeInviteDeepLink(created.inviteLink!);
    expect(createdInvite.ok && createdInvite.value.endpointHint).toBe(relayEndpoint);

    const resumed = await coordinator.service.resumeActive();
    expect(resumed?.endpoint).toBe(relayEndpoint);
    const refreshed = await coordinator.service.refreshCoordinatorInvite(resumed!);
    expect(refreshed.endpoint).toBe(relayEndpoint);
    expect(coordinator.setting(endpointKey(createdTripId))).toBe(relayEndpoint);

    const member = createHarness({
      coordinator: false,
      localAddress: '10.0.0.2',
      active: false,
      randomUuid: () => 'uuid-member-relay',
    });
    const joined = await member.service.join({
      inviteLink: refreshed.inviteLink!,
      displayName: 'Member',
    });
    expect(joined.endpoint).toBe(relayEndpoint);
    expect(member.setting(endpointKey(createdTripId))).toBe(relayEndpoint);
  });

  it('rotates the coordinator QR when the advertised LAN address changes', async () => {
    const harness = createHarness({ coordinator: true, localAddress: '192.168.4.1' });
    const oldLink = inviteLink('tcp://192.168.1.20:38457');
    harness.vault.invite = oldLink;

    const session = await harness.service.resumeActive();

    expect(session).not.toBeNull();
    expect(session?.endpoint).toBe('tcp://192.168.4.1:38457');
    expect(session?.inviteLink).not.toBe(oldLink);
    const parsed = decodeInviteDeepLink(session!.inviteLink!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.endpointHint).toBe('tcp://192.168.4.1:38457');
      expect(parsed.value.groupSecret).toBe(GROUP_SECRET);
      expect(parsed.value.membershipEpoch).toBe(1);
    }
    expect(harness.setting(endpointKey(TRIP_ID))).toBe('tcp://192.168.4.1:38457');
    expect(harness.setting(acceptedInviteIssuedAtKey(TRIP_ID))).toBe(NOW);
  });

  it('rejects an older coordinator QR after publishing a newer host address', async () => {
    const harness = createHarness({ coordinator: true, localAddress: '192.168.4.1' });
    const older = inviteLink('tcp://192.168.1.20:38457', 1_000);
    harness.vault.invite = older;

    const refreshed = await harness.service.resumeActive();
    expect(refreshed?.endpoint).toBe('tcp://192.168.4.1:38457');

    await expect(
      harness.service.join({ inviteLink: older, displayName: 'Ankit' }),
    ).rejects.toThrow(/older than the connection/i);
    expect(harness.setting(endpointKey(TRIP_ID))).toBe('tcp://192.168.4.1:38457');
  });

  it('serializes overlapping coordinator refreshes so the later address wins', async () => {
    let resolveFirst!: (address: string) => void;
    const firstAddress = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const localAddressProvider = vi.fn()
      .mockReturnValueOnce(firstAddress)
      .mockResolvedValueOnce('192.168.9.2');
    const harness = createHarness({
      coordinator: true,
      localAddress: '192.168.9.1',
      localAddressProvider,
    });
    const session = {
      trip: harness.trip,
      localMember: harness.members.get(HOST_MEMBER_ID)!,
      inviteLink: harness.vault.invite,
      admissionInviteLink: null,
      endpoint: 'tcp://192.168.1.20:38457',
      isCoordinator: true,
      coordinatorDeviceId: HOST_DEVICE_ID,
      coordinatorIdentityPublicKey: IDENTITY_KEY,
    };

    const first = harness.service.refreshCoordinatorInvite(session);
    const second = harness.service.refreshCoordinatorInvite(session);
    await vi.waitFor(() => expect(localAddressProvider).toHaveBeenCalledTimes(1));
    resolveFirst('192.168.9.1');

    await first;
    const latest = await second;

    expect(localAddressProvider).toHaveBeenCalledTimes(2);
    expect(latest.endpoint).toBe('tcp://192.168.9.2:38457');
    const decoded = decodeInviteDeepLink(harness.vault.invite!);
    expect(decoded.ok && decoded.value.endpointHint).toBe('tcp://192.168.9.2:38457');
  });

  it('uses a same-trip QR to update an active member endpoint without replacing membership or counters', async () => {
    const harness = createHarness({ coordinator: false, localAddress: '10.0.0.2' });
    const operationKey = operationSequenceKey(TRIP_ID, LOCAL_DEVICE_ID);
    harness.settings.set(operationKey, setting(operationKey, 17));

    const session = await harness.service.join({
      inviteLink: inviteLink('tcp://10.0.0.1:38457'),
      displayName: 'Ankit',
    });

    expect(session.localMember.id).toBe(LOCAL_MEMBER_ID);
    expect(session.endpoint).toBe('tcp://10.0.0.1:38457');
    expect(harness.setting(endpointKey(TRIP_ID))).toBe('tcp://10.0.0.1:38457');
    expect(harness.setting(operationKey)).toBe(17);
    expect(harness.members.size).toBe(1);
  });

  it('does not roll a working endpoint back when an older same-trip QR is scanned', async () => {
    const harness = createHarness({ coordinator: false, localAddress: '10.0.0.2' });
    const latest = inviteLink('tcp://10.0.0.2:38457', 3_000);
    const older = inviteLink('tcp://10.0.0.1:38457', 2_000);

    const updated = await harness.service.join({ inviteLink: latest, displayName: 'Ankit' });
    expect(updated.endpoint).toBe('tcp://10.0.0.2:38457');

    await expect(
      harness.service.join({ inviteLink: older, displayName: 'Ankit' }),
    ).rejects.toThrow(/older than the connection/i);

    expect(harness.setting(endpointKey(TRIP_ID))).toBe('tcp://10.0.0.2:38457');
    expect(harness.setting(acceptedInviteIssuedAtKey(TRIP_ID))).toBe(3_000);
    expect(harness.setting(acceptedInviteIdKey(TRIP_ID))).toContain('invite:');
  });

  it('rejects an endpoint shape that the native TCP adapter cannot open', async () => {
    const harness = createHarness({ coordinator: false, localAddress: '10.0.0.2' });

    await expect(harness.service.join({
      inviteLink: inviteLink('tcp://10.0.0.1:38457/not-a-socket'),
      displayName: 'Ankit',
    })).rejects.toThrow(/valid TCP endpoint/i);

    expect(harness.setting(endpointKey(TRIP_ID))).toBe('tcp://192.168.1.20:38457');
    expect(harness.members.size).toBe(1);
  });

  it('publishes a self-leave and permits a new membership without resetting durable counters', async () => {
    let uuid = 0;
    const harness = createHarness({
      coordinator: false,
      localAddress: '10.0.0.2',
      randomUuid: () => `uuid-${++uuid}-lifecycle`,
    });
    const operationKey = operationSequenceKey(TRIP_ID, LOCAL_DEVICE_ID);
    harness.settings.set(operationKey, setting(operationKey, 3));
    const active = await harness.service.resumeActive();

    await harness.service.end(active!);

    expect(harness.trip.isActive).toBe(false);
    expect(harness.members.get(LOCAL_MEMBER_ID)?.status).toBe('LEFT');
    expect(harness.operations.at(-1)).toMatchObject({
      kind: 'MEMBER_STATUS_CHANGED',
      originSequence: 4,
      actorMemberId: LOCAL_MEMBER_ID,
    });
    expect(harness.outbox).toHaveLength(1);

    const rejoined = await harness.service.join({
      inviteLink: inviteLink('tcp://10.0.0.1:38457'),
      displayName: 'Ankit',
    });

    expect(rejoined.localMember.id).not.toBe(LOCAL_MEMBER_ID);
    expect(rejoined.localMember.status).toBe('ACTIVE');
    expect(harness.members.get(LOCAL_MEMBER_ID)?.status).toBe('LEFT');
    expect(harness.setting(operationKey)).toBe(4);
    expect(harness.trip.isActive).toBe(true);
  });

  it('always lets a member leave even when another active member has no verified copy', async () => {
    const harness = createHarness({
      coordinator: false,
      localAddress: '10.0.0.2',
      randomUuid: () => 'uuid-unconditional-leave',
    });
    harness.members.set(HOST_MEMBER_ID, baseMember(true));
    const active = await harness.service.resumeActive();

    await expect(harness.service.end(active!)).resolves.toBeUndefined();

    expect(harness.trip.isActive).toBe(false);
    expect(harness.members.get(LOCAL_MEMBER_ID)?.status).toBe('LEFT');
    expect(harness.operations.at(-1)).toMatchObject({
      kind: 'MEMBER_STATUS_CHANGED',
      actorMemberId: LOCAL_MEMBER_ID,
    });
  });
});

function createHarness(options: {
  coordinator: boolean;
  localAddress: string;
  localAddressProvider?: () => Promise<string>;
  endpoint?: string;
  active?: boolean;
  randomUuid?: () => string;
}) {
  let trip = { ...baseTrip(), isActive: options.active ?? true };
  const members = new Map<string, MemberRecord>();
  const localMember = baseMember(options.coordinator);
  members.set(localMember.id, localMember);
  const settings = new Map<string, DeviceSettingRecord>();
  const operations: SyncOperationRecord[] = [];
  const outbox: OutboxRecord[] = [];
  settings.set(localMemberKey(TRIP_ID), setting(localMemberKey(TRIP_ID), localMember.id));
  settings.set(endpointKey(TRIP_ID), setting(endpointKey(TRIP_ID), 'tcp://192.168.1.20:38457'));
  settings.set(coordinatorKey(TRIP_ID), setting(coordinatorKey(TRIP_ID), options.coordinator));
  settings.set(
    coordinatorDeviceKey(TRIP_ID),
    setting(coordinatorDeviceKey(TRIP_ID), HOST_DEVICE_ID),
  );

  const repositories = {
    trips: {
      getActive: vi.fn(async () => trip.isActive ? { ...trip } : null),
      getById: vi.fn(async (id: string) => id === trip.id ? { ...trip } : null),
      upsert: vi.fn(async (value: TripRecord) => {
        trip = { ...value };
      }),
      clearActive: vi.fn(async () => {
        trip = { ...trip, isActive: false };
      }),
      list: vi.fn(async () => [{ ...trip }]),
    },
    members: {
      getById: vi.fn(async (_tripId: string, memberId: string) => {
        const member = members.get(memberId);
        return member ? { ...member } : null;
      }),
      getByDeviceId: vi.fn(async (tripId: string, deviceId: string) => {
        const candidates = [...members.values()]
          .filter((member) => member.tripId === tripId && member.deviceId === deviceId)
          .sort((left, right) => memberPriority(left) - memberPriority(right) || right.updatedAtMs - left.updatedAtMs);
        return candidates[0] ? { ...candidates[0] } : null;
      }),
      upsert: vi.fn(async (member: MemberRecord) => {
        members.set(member.id, { ...member });
      }),
      listByTrip: vi.fn(async () => [...members.values()].map((member) => ({ ...member }))),
    },
    deviceSettings: {
      get: vi.fn(async (key: string) => settings.get(key) ?? null),
      set: vi.fn(async (value: DeviceSettingRecord) => {
        settings.set(value.key, value);
      }),
      remove: vi.fn(async (key: string) => settings.delete(key)),
    },
    syncOperations: {
      append: vi.fn(async (value: SyncOperationRecord) => {
        operations.push(value);
        return true;
      }),
      getContiguousHighWaterMarks: vi.fn(async () => {
        const result: Record<string, number> = {};
        for (const operation of operations) {
          result[operation.originDeviceId] = Math.max(
            result[operation.originDeviceId] ?? 0,
            operation.originSequence,
          );
        }
        return result;
      }),
    },
    outbox: {
      upsert: vi.fn(async (value: OutboxRecord) => {
        outbox.push(value);
      }),
    },
  };
  const data = {
    repositories,
    transaction: async <T,>(task: (value: typeof repositories) => Promise<T>) => task(repositories),
  } as unknown as AirMeshDataLayer;
  const identity = {
    load: vi.fn(async () => ({
      deviceId: options.coordinator ? HOST_DEVICE_ID : LOCAL_DEVICE_ID,
      identityPublicKey: IDENTITY_KEY,
      displayName: 'Ankit',
    })),
    saveDisplayName: vi.fn(async () => undefined),
    sign: vi.fn(async () => 'A'.repeat(86)),
    verify: vi.fn(() => true),
  } as unknown as DeviceIdentityService;
  const vault: {
    invite: string | null;
    key: ReturnType<typeof createSessionKeyHandle>;
    groupSecret: typeof GROUP_SECRET;
  } = {
    invite: inviteLink('tcp://192.168.1.20:38457'),
    key: createSessionKeyHandle(TRIP_ID, 1),
    groupSecret: GROUP_SECRET,
  };
  const keys = {
    getCurrent: vi.fn(async (tripId: string) =>
      vault.key.tripId === tripId
        ? { handle: vault.key, groupSecret: vault.groupSecret }
        : null),
    put: vi.fn(async (value: { handle: typeof vault.key; groupSecret: typeof GROUP_SECRET }) => {
      vault.key = value.handle;
      vault.groupSecret = value.groupSecret;
    }),
    getInvite: vi.fn(async () => vault.invite),
    putInvite: vi.fn(async (_tripId: string, value: string) => {
      vault.invite = value;
    }),
  } as unknown as TripKeyVault;
  const service = new TripLifecycleService({
    data,
    identity,
    keys,
    now: () => NOW,
    randomUuid: options.randomUuid ?? (() => 'uuid-default-lifecycle'),
    endpoint: options.endpoint ? async () => options.endpoint! : undefined,
    localAddress: options.localAddressProvider ?? (async () => options.localAddress),
  });

  return {
    service,
    vault,
    settings,
    members,
    operations,
    outbox,
    get trip() {
      return trip;
    },
    setting(key: string) {
      return settings.get(key)?.value;
    },
  };
}

function baseTrip(): TripRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: TRIP_ID,
    name: 'Lifecycle test',
    createdByMemberId: HOST_MEMBER_ID,
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

function baseMember(coordinator: boolean): MemberRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: coordinator ? HOST_MEMBER_ID : LOCAL_MEMBER_ID,
    tripId: TRIP_ID,
    deviceId: coordinator ? HOST_DEVICE_ID : LOCAL_DEVICE_ID,
    displayName: 'Ankit',
    identityPublicKey: IDENTITY_KEY,
    role: coordinator ? 'ADMIN' : 'MEMBER',
    status: 'ACTIVE',
    replicaRole: coordinator ? 'KEEPER_PRIMARY' : 'NONE',
    joinedAtMs: 1_000,
    updatedAtMs: 1_000,
    leftAtMs: null,
    membershipEpoch: 1,
  };
}

function inviteLink(endpoint: string, issuedAtMs = 1_000): string {
  const invite: TripInvite = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    inviteVersion: INVITE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    tripId: TRIP_ID,
    inviteId: assertParsed(
      parseInviteId(`invite:${issuedAtMs}-${endpoint.replace(/[^A-Za-z0-9]/g, '-')}`),
    ),
    inviterMemberId: HOST_MEMBER_ID,
    inviterDeviceId: HOST_DEVICE_ID,
    inviterIdentityPublicKey: IDENTITY_KEY as TripInvite['inviterIdentityPublicKey'],
    membershipEpoch: 1,
    issuedAtMs,
    expiresAtMs: issuedAtMs + MAX_INVITE_LIFETIME_MS,
    signature: 'A'.repeat(86),
    groupSecret: GROUP_SECRET,
    endpointHint: endpoint,
  };
  return encodeInviteDeepLink(invite);
}

function setting<T extends DeviceSettingRecord['value']>(key: string, value: T): DeviceSettingRecord<T> {
  return { key, value, updatedAt: NOW };
}

function memberPriority(member: MemberRecord): number {
  if (member.status === 'ACTIVE') return 0;
  if (member.status === 'LEAVING') return 1;
  return 2;
}
