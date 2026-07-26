import * as Crypto from 'expo-crypto';

import { createGroupSecret, DeviceIdentityService } from '@/application/identity/DeviceIdentityService';
import { normalizeDisplayName } from '@/application/identity/profile';
import { createSessionKeyHandle, type TripKeyVault } from '@/application/security/TripKeyVault';
import {
  signTripInvite,
  verifyTripInviteSignature,
} from '@/application/security/inviteAuthenticity';
import { signSyncOperation } from '@/application/security/operationAuthenticity';
import {
  DOMAIN_SCHEMA_VERSION,
  INVITE_VERSION,
  MAX_INVITE_LIFETIME_MS,
  PROTOCOL_VERSION,
} from '@/core/constants';
import type { Member, SyncOperation, Trip } from '@/core/domain';
import {
  decodeInviteDeepLink,
  encodeInviteDeepLink,
  parseGroupSecret,
  type TripInvite,
} from '@/core/invite';
import {
  parseDeviceId,
  parseIdentityPublicKey,
  parseInviteId,
  parseMemberId,
  parseOperationId,
  parseTripId,
  type DeviceId,
  type TripId,
} from '@/core/ids';
import { assertParsed, type ParseResult } from '@/core/validation';
import type {
  AirMeshDataLayer,
  JsonValue,
  MemberRecord,
  OutboxRecord,
  SyncOperationRecord,
  TripRecord,
} from '@/data';
import { resolveCoordinatorLanAddress } from '@/platform/network/LanAddressResolver';

const DEFAULT_TCP_PORT = 38_457;
const INVITE_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1_000;

export interface CreateTripInput {
  name: string;
  displayName: string;
  defaultSharingMode?: 'AUTO_SHARE' | 'REVIEW_FIRST';
}

export interface JoinTripInput {
  inviteLink: string;
  displayName: string;
}

export interface TripSession {
  trip: TripRecord;
  localMember: MemberRecord;
  inviteLink: string | null;
  /** Exact signed ticket presented only while requesting first admission. */
  admissionInviteLink: string | null;
  endpoint: string;
  isCoordinator: boolean;
  coordinatorDeviceId: string;
  coordinatorIdentityPublicKey: string;
}

export interface TripLifecycleDependencies {
  data: AirMeshDataLayer;
  identity: DeviceIdentityService;
  keys: TripKeyVault;
  now?: () => number;
  randomUuid?: () => string;
  /** Supplies the invite transport endpoint. Relay mode injects WSS here. */
  endpoint?: () => Promise<string>;
  /** LAN fallback only. Ignored when endpoint is supplied. */
  localAddress?: () => Promise<string>;
  tcpPort?: number;
}

export class ActiveTripConflictError extends Error {
  constructor() {
    super('End or leave the current trip before starting another one.');
    this.name = 'ActiveTripConflictError';
  }
}

export class TripLifecycleService {
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly endpoint: () => Promise<string>;
  private coordinatorInviteRefreshTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: TripLifecycleDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomUuid = dependencies.randomUuid ?? Crypto.randomUUID;
    this.endpoint = dependencies.endpoint ?? (async () => {
      const address = normalizeLocalAddress(
        await (dependencies.localAddress ?? resolveCoordinatorLanAddress)(),
      );
      return `tcp://${formatAddress(address)}:${dependencies.tcpPort ?? DEFAULT_TCP_PORT}`;
    });
  }

  async create(input: CreateTripInput): Promise<TripSession> {
    await this.assertNoActiveTrip();
    const displayName = normalizeDisplayName(input.displayName);
    const name = normalizeTripName(input.name);
    const identity = await this.dependencies.identity.load();
    await this.dependencies.identity.saveDisplayName(displayName);

    const endpoint = requireTransportEndpoint(await this.endpoint());
    const now = this.now();
    const tripId = id('trip', this.randomUuid(), parseTripId);
    const memberId = id('member', this.randomUuid(), parseMemberId);
    const deviceId = assertParsed(parseDeviceId(identity.deviceId));
    const identityPublicKey = assertParsed(parseIdentityPublicKey(identity.identityPublicKey));
    const groupSecret = assertParsed(parseGroupSecret(await createGroupSecret()));

    const trip: Trip = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: tripId,
      name,
      createdByMemberId: memberId,
      createdAtMs: now,
      updatedAtMs: now,
      startsAtMs: now,
      endsAtMs: null,
      timeZone: resolvedTimeZone(),
      status: 'ACTIVE',
      defaultSharingMode: input.defaultSharingMode ?? 'AUTO_SHARE',
      locationSharingMode: 'NONE',
      targetReplicaCount: 2,
      completeKeeperCount: 1,
      membershipEpoch: 1,
    };
    const member: Member = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: memberId,
      tripId,
      deviceId,
      displayName,
      identityPublicKey,
      role: 'ADMIN',
      status: 'ACTIVE',
      replicaRole: 'KEEPER_PRIMARY',
      joinedAtMs: now,
      updatedAtMs: now,
      leftAtMs: null,
      membershipEpoch: 1,
    };
    const invite = await signTripInvite({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      inviteVersion: INVITE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId,
      inviteId: id('invite', this.randomUuid(), parseInviteId),
      inviterMemberId: memberId,
      inviterDeviceId: deviceId,
      inviterIdentityPublicKey: identityPublicKey,
      membershipEpoch: 1,
      issuedAtMs: now,
      expiresAtMs: now + MAX_INVITE_LIFETIME_MS,
      groupSecret,
      endpointHint: endpoint,
    }, this.dependencies.identity);
    const inviteLink = encodeInviteDeepLink(invite);
    const tripRecord = toTripRecord(trip, true);
    const memberRecord = toMemberRecord(member);
    const operations = await Promise.all([
      signSyncOperation(
        operation('trip-created', this.randomUuid(), trip, member, 1, 'TRIP_CREATED', { trip }),
        identityPublicKey,
        this.dependencies.identity,
      ),
      signSyncOperation(
        operation('member-joined', this.randomUuid(), trip, member, 2, 'MEMBER_JOINED', { member }),
        identityPublicKey,
        this.dependencies.identity,
      ),
    ]);
    const handle = createSessionKeyHandle(tripId, trip.membershipEpoch);

    // SecureStore cannot join a SQLite transaction. Writing the key first is
    // failure-safe: a DB rollback can leave only an unreachable encrypted key,
    // while the reverse ordering could leave a visible trip that cannot decrypt.
    await this.dependencies.keys.put({ handle, groupSecret });
    await this.dependencies.keys.putInvite(tripId, inviteLink);
    await this.dependencies.data.transaction(async (repositories) => {
      await repositories.trips.upsert(tripRecord);
      await repositories.members.upsert(memberRecord);
      for (const item of operations) {
        const record = toOperationRecord(item);
        await repositories.syncOperations.append(record);
        await repositories.outbox.upsert(operationOutbox(record, now));
      }
      await Promise.all([
        repositories.deviceSettings.set(setting(localMemberKey(tripId), memberId, now)),
        repositories.deviceSettings.set(setting(endpointKey(tripId), endpoint, now)),
        repositories.deviceSettings.set(setting(coordinatorKey(tripId), true, now)),
        repositories.deviceSettings.set(setting(coordinatorDeviceKey(tripId), deviceId, now)),
        repositories.deviceSettings.set(
          setting(acceptedInviteIssuedAtKey(tripId), invite.issuedAtMs, now),
        ),
        repositories.deviceSettings.set(
          setting(acceptedInviteIdKey(tripId), invite.inviteId, now),
        ),
        repositories.deviceSettings.set(setting(operationSequenceKey(tripId, deviceId), 2, now)),
        repositories.deviceSettings.set(setting(mediaSequenceKey(tripId, deviceId), 0, now)),
        repositories.deviceSettings.set(setting(wireSequenceKey(tripId, deviceId), 0, now)),
      ]);
    });

    return {
      trip: tripRecord,
      localMember: memberRecord,
      inviteLink,
      admissionInviteLink: null,
      endpoint,
      isCoordinator: true,
      coordinatorDeviceId: deviceId,
      coordinatorIdentityPublicKey: identityPublicKey,
    };
  }

  async join(input: JoinTripInput): Promise<TripSession> {
    const now = this.now();
    const inviteLink = input.inviteLink.trim();
    const parsedInvite = decodeInviteDeepLink(inviteLink, { nowMs: now });
    const invite = assertParsed(parsedInvite);
    if (!verifyTripInviteSignature(invite, this.dependencies.identity)) {
      throw new Error('This invite signature is invalid. Ask the trip creator for a new invite.');
    }
    const endpoint = requireTransportEndpoint(invite.endpointHint);
    const displayName = normalizeDisplayName(input.displayName);
    const identity = await this.dependencies.identity.load();
    await this.dependencies.identity.saveDisplayName(displayName);
    const deviceId = assertParsed(parseDeviceId(identity.deviceId));
    const identityPublicKey = assertParsed(parseIdentityPublicKey(identity.identityPublicKey));
    const activeTrip = await this.dependencies.data.repositories.trips.getActive();
    if (activeTrip) {
      if (activeTrip.id !== invite.tripId) throw new ActiveTripConflictError();
      const session = await this.loadStoredSession(activeTrip);
      return this.applyRefreshedMemberInvite(session, invite, endpoint);
    }

    const [
      existingTrip,
      existingMember,
      storedKey,
      acceptedIssuedAt,
      acceptedInviteId,
    ] = await Promise.all([
      this.dependencies.data.repositories.trips.getById(invite.tripId),
      this.dependencies.data.repositories.members.getByDeviceId(invite.tripId, deviceId),
      this.dependencies.keys.getCurrent(invite.tripId),
      this.dependencies.data.repositories.deviceSettings.get<number>(
        acceptedInviteIssuedAtKey(invite.tripId),
      ),
      this.dependencies.data.repositories.deviceSettings.get<string>(
        acceptedInviteIdKey(invite.tripId),
      ),
    ]);
    if (
      existingTrip &&
      (existingTrip.status === 'ENDED' ||
        existingTrip.status === 'ARCHIVED' ||
        existingTrip.membershipEpoch !== invite.membershipEpoch)
    ) {
      throw new Error('This trip has already ended on this phone.');
    }
    if (storedKey && storedKey.groupSecret !== invite.groupSecret) {
      throw new Error('This invite does not match the locally saved trip key.');
    }
    if (existingMember?.status === 'REMOVED') {
      throw new Error('This device was removed from the trip.');
    }
    if (existingMember?.status === 'LEAVING') {
      throw new Error('This device is still finishing its previous leave request.');
    }
    assertInviteIsCurrent(invite, acceptedIssuedAt?.value, acceptedInviteId?.value);
    if (
      existingMember?.status === 'ACTIVE' &&
      existingMember.identityPublicKey !== identityPublicKey
    ) {
      throw new Error('The saved trip membership belongs to another device identity.');
    }

    const reusableMember = existingMember?.status === 'ACTIVE' ? existingMember : null;
    const localMemberId = reusableMember
      ? assertParsed(parseMemberId(reusableMember.id))
      : id('member', this.randomUuid(), parseMemberId);
    const placeholderTrip: Trip = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: invite.tripId,
      name: 'Joining CrewRoll trip',
      createdByMemberId: invite.inviterMemberId,
      createdAtMs: invite.issuedAtMs,
      updatedAtMs: now,
      // The authoritative TRIP_CREATED operation replaces this conservative
      // placeholder before media discovery is enabled.
      startsAtMs: invite.issuedAtMs,
      endsAtMs: null,
      timeZone: resolvedTimeZone(),
      status: 'DRAFT',
      defaultSharingMode: 'AUTO_SHARE',
      locationSharingMode: 'NONE',
      targetReplicaCount: 2,
      completeKeeperCount: 0,
      membershipEpoch: invite.membershipEpoch,
    };
    const memberRecord: MemberRecord = reusableMember ?? {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: localMemberId,
      tripId: invite.tripId,
      deviceId,
      displayName,
      identityPublicKey,
      role: 'MEMBER',
      status: 'ACTIVE',
      replicaRole: 'NONE',
      joinedAtMs: now,
      updatedAtMs: now,
      leftAtMs: null,
      membershipEpoch: invite.membershipEpoch,
    };
    const tripRecord: TripRecord = existingTrip
      ? { ...existingTrip, isActive: true }
      : toTripRecord(placeholderTrip, true);
    const handle = createSessionKeyHandle(invite.tripId, invite.membershipEpoch);

    if (!storedKey) {
      await this.dependencies.keys.put({ handle, groupSecret: invite.groupSecret });
    }
    await this.dependencies.keys.putInvite(invite.tripId, inviteLink);
    await this.dependencies.data.transaction(async (repositories) => {
      await repositories.trips.upsert(tripRecord);
      await repositories.members.upsert(memberRecord);
      await Promise.all([
        repositories.deviceSettings.set(setting(localMemberKey(invite.tripId), localMemberId, now)),
        repositories.deviceSettings.set(setting(endpointKey(invite.tripId), endpoint, now)),
        repositories.deviceSettings.set(setting(coordinatorKey(invite.tripId), false, now)),
        repositories.deviceSettings.set(
          setting(coordinatorDeviceKey(invite.tripId), invite.inviterDeviceId, now),
        ),
        repositories.deviceSettings.set(
          setting(acceptedInviteIssuedAtKey(invite.tripId), invite.issuedAtMs, now),
        ),
        repositories.deviceSettings.set(
          setting(acceptedInviteIdKey(invite.tripId), invite.inviteId, now),
        ),
      ]);
      for (const key of [
        operationSequenceKey(invite.tripId, deviceId),
        mediaSequenceKey(invite.tripId, deviceId),
        wireSequenceKey(invite.tripId, deviceId),
      ]) {
        if (!(await repositories.deviceSettings.get<number>(key))) {
          await repositories.deviceSettings.set(setting(key, 0, now));
        }
      }
    });

    return {
      trip: tripRecord,
      localMember: memberRecord,
      inviteLink: null,
      admissionInviteLink: inviteLink,
      endpoint,
      isCoordinator: false,
      coordinatorDeviceId: invite.inviterDeviceId,
      coordinatorIdentityPublicKey: invite.inviterIdentityPublicKey,
    };
  }

  async resumeActive(): Promise<TripSession | null> {
    const trip = await this.dependencies.data.repositories.trips.getActive();
    if (!trip) return null;
    const session = await this.loadStoredSession(trip);
    if (!session.isCoordinator) return session;
    try {
      return await this.refreshCoordinatorInvite(session);
    } catch {
      // A coordinator may resume offline. Keep the last usable session and
      // refresh the share QR when a local interface becomes available again.
      return session;
    }
  }

  /**
   * Reconnects one ended keeper as a data-plane responder. Ended rolls remain
   * browse-only in the UI, but a keeper can still repair an offline member's
   * catalog/resources without reopening capture or creating a server archive.
   */
  async resumeResponder(): Promise<TripSession | null> {
    const trips = (await this.dependencies.data.repositories.trips.list())
      .filter((trip) =>
        !trip.isActive && (trip.status === 'ENDED' || trip.status === 'ARCHIVED'),
      )
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    for (const trip of trips) {
      try {
        const session = await this.loadStoredSession(trip);
        if (
          (session.localMember.status === 'ACTIVE' ||
            session.localMember.status === 'LEAVING') &&
          (session.localMember.role === 'ADMIN' ||
            session.localMember.replicaRole === 'KEEPER_PRIMARY' ||
            session.localMember.replicaRole === 'KEEPER_SECONDARY')
        ) return { ...session, admissionInviteLink: null, inviteLink: null };
      } catch {
        // A damaged/removed saved roll must not prevent another responder from starting.
      }
    }
    return null;
  }

  /** Clears active UI ownership after receiving END while preserving membership for repair. */
  async archiveEndedForResponder(session: TripSession): Promise<TripSession> {
    await this.dependencies.data.transaction(async (repositories) => {
      const trip = await repositories.trips.getById(session.trip.id);
      if (!trip || (trip.status !== 'ENDED' && trip.status !== 'ARCHIVED')) {
        throw new Error('Only an ended trip can become a saved-roll responder.');
      }
      await repositories.trips.clearActive();
    });
    const trip = await this.dependencies.data.repositories.trips.getById(session.trip.id);
    if (!trip) throw new Error('The ended trip disappeared while archiving it.');
    const responder = await this.loadStoredSession(trip);
    return { ...responder, admissionInviteLink: null, inviteLink: null };
  }

  refreshCoordinatorInvite(session: TripSession): Promise<TripSession> {
    const run = this.coordinatorInviteRefreshTail.then(
      () => this.performCoordinatorInviteRefresh(session),
      () => this.performCoordinatorInviteRefresh(session),
    );
    this.coordinatorInviteRefreshTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performCoordinatorInviteRefresh(session: TripSession): Promise<TripSession> {
    if (!session.isCoordinator || session.localMember.role !== 'ADMIN') return session;
    const tripId = assertParsed(parseTripId(session.trip.id));
    const memberId = assertParsed(parseMemberId(session.localMember.id));
    const deviceId = assertParsed(parseDeviceId(session.localMember.deviceId));
    const storedKey = await this.dependencies.keys.getCurrent(tripId);
    if (!storedKey || storedKey.handle.keyEpoch !== session.trip.membershipEpoch) {
      throw new Error('The current trip key is unavailable.');
    }

    const endpoint = requireTransportEndpoint(await this.endpoint());
    const now = this.now();
    const storedLink = await this.dependencies.keys.getInvite(tripId);
    const parsed = storedLink ? decodeInviteDeepLink(storedLink) : null;
    const currentInvite =
      parsed?.ok && verifyTripInviteSignature(parsed.value, this.dependencies.identity)
        ? parsed.value
        : null;
    const canReuse =
      currentInvite !== null &&
      currentInvite.tripId === tripId &&
      currentInvite.inviterMemberId === memberId &&
      currentInvite.inviterDeviceId === deviceId &&
      currentInvite.membershipEpoch === session.trip.membershipEpoch &&
      currentInvite.groupSecret === storedKey.groupSecret &&
      currentInvite.endpointHint === endpoint &&
      currentInvite.expiresAtMs > now + INVITE_REFRESH_WINDOW_MS;
    if (canReuse && storedLink && currentInvite) {
      await this.persistCoordinatorInviteSettings(tripId, endpoint, currentInvite, now);
      return { ...session, endpoint, inviteLink: storedLink };
    }

    const issuedAtMs = Math.max(now, (currentInvite?.issuedAtMs ?? -1) + 1);
    const invite = await signTripInvite({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      inviteVersion: INVITE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId,
      inviteId: id('invite', this.randomUuid(), parseInviteId),
      inviterMemberId: memberId,
      inviterDeviceId: deviceId,
      inviterIdentityPublicKey: assertParsed(
        parseIdentityPublicKey(session.localMember.identityPublicKey),
      ),
      membershipEpoch: session.trip.membershipEpoch,
      issuedAtMs,
      expiresAtMs: issuedAtMs + MAX_INVITE_LIFETIME_MS,
      groupSecret: storedKey.groupSecret,
      endpointHint: endpoint,
    }, this.dependencies.identity);
    const inviteLink = encodeInviteDeepLink(invite);
    await this.dependencies.keys.putInvite(tripId, inviteLink);
    await this.persistCoordinatorInviteSettings(tripId, endpoint, invite, now);
    return { ...session, endpoint, inviteLink };
  }

  private async persistCoordinatorInviteSettings(
    tripId: TripId,
    endpoint: string,
    invite: TripInvite,
    now: number,
  ): Promise<void> {
    await this.dependencies.data.transaction(async (repositories) => {
      await Promise.all([
        repositories.deviceSettings.set(setting(endpointKey(tripId), endpoint, now)),
        repositories.deviceSettings.set(
          setting(acceptedInviteIssuedAtKey(tripId), invite.issuedAtMs, now),
        ),
        repositories.deviceSettings.set(
          setting(acceptedInviteIdKey(tripId), invite.inviteId, now),
        ),
      ]);
    });
  }

  private async loadStoredSession(trip: TripRecord): Promise<TripSession> {
    const [memberSetting, endpointSetting, coordinatorSetting, coordinatorDeviceSetting] =
      await Promise.all([
      this.dependencies.data.repositories.deviceSettings.get<string>(localMemberKey(trip.id as TripId)),
      this.dependencies.data.repositories.deviceSettings.get<string>(endpointKey(trip.id as TripId)),
      this.dependencies.data.repositories.deviceSettings.get<boolean>(coordinatorKey(trip.id as TripId)),
      this.dependencies.data.repositories.deviceSettings.get<string>(
        coordinatorDeviceKey(trip.id as TripId),
      ),
    ]);
    if (!memberSetting || !endpointSetting || !coordinatorSetting || !coordinatorDeviceSetting) {
      throw new Error('Active trip session settings are incomplete.');
    }
    const member = await this.dependencies.data.repositories.members.getById(trip.id, memberSetting.value);
    if (!member) throw new Error('The local trip member record is missing.');
    const coordinator = await this.dependencies.data.repositories.members.getById(
      trip.id,
      trip.createdByMemberId,
    );
    const storedInvite = await this.dependencies.keys.getInvite(trip.id as TripId);
    const parsedInvite = storedInvite ? decodeInviteDeepLink(storedInvite) : null;
    const coordinatorIdentityPublicKey = coordinator?.identityPublicKey ??
      (parsedInvite?.ok ? parsedInvite.value.inviterIdentityPublicKey : null);
    if (!coordinatorIdentityPublicKey) {
      throw new Error('The trip coordinator identity is missing.');
    }
    return {
      trip,
      localMember: member,
      inviteLink: coordinatorSetting.value ? storedInvite : null,
      admissionInviteLink: coordinatorSetting.value ? null : storedInvite,
      endpoint: endpointSetting.value,
      isCoordinator: coordinatorSetting.value,
      coordinatorDeviceId: coordinatorDeviceSetting.value,
      coordinatorIdentityPublicKey,
    };
  }

  private async applyRefreshedMemberInvite(
    session: TripSession,
    invite: TripInvite,
    endpoint: string,
  ): Promise<TripSession> {
    if (
      session.trip.id !== invite.tripId ||
      session.trip.membershipEpoch !== invite.membershipEpoch ||
      session.trip.createdByMemberId !== invite.inviterMemberId ||
      session.coordinatorDeviceId !== invite.inviterDeviceId ||
      session.coordinatorIdentityPublicKey !== invite.inviterIdentityPublicKey ||
      session.localMember.status !== 'ACTIVE'
    ) {
      throw new Error('This invite does not match the active trip session.');
    }
    if (!verifyTripInviteSignature(invite, this.dependencies.identity)) {
      throw new Error('This refreshed invite signature is invalid.');
    }
    const tripId = assertParsed(parseTripId(session.trip.id));
    const [storedKey, acceptedIssuedAt, acceptedInviteId] = await Promise.all([
      this.dependencies.keys.getCurrent(tripId),
      this.dependencies.data.repositories.deviceSettings.get<number>(
        acceptedInviteIssuedAtKey(tripId),
      ),
      this.dependencies.data.repositories.deviceSettings.get<string>(
        acceptedInviteIdKey(tripId),
      ),
    ]);
    if (!storedKey || storedKey.groupSecret !== invite.groupSecret) {
      throw new Error('This invite does not match the active trip key.');
    }
    assertInviteIsCurrent(invite, acceptedIssuedAt?.value, acceptedInviteId?.value);
    const now = this.now();
    await this.dependencies.keys.putInvite(tripId, encodeInviteDeepLink(invite));
    await this.dependencies.data.transaction(async (repositories) => {
      await Promise.all([
        repositories.deviceSettings.set(setting(endpointKey(tripId), endpoint, now)),
        repositories.deviceSettings.set(
          setting(acceptedInviteIssuedAtKey(tripId), invite.issuedAtMs, now),
        ),
        repositories.deviceSettings.set(
          setting(acceptedInviteIdKey(tripId), invite.inviteId, now),
        ),
      ]);
    });
    return {
      ...session,
      endpoint,
      admissionInviteLink: encodeInviteDeepLink(invite),
    };
  }

  async end(session: TripSession): Promise<void> {
    const now = this.now();
    if (!session.isCoordinator || session.localMember.role !== 'ADMIN') {
      await this.leaveMember(session, now);
      return;
    }

    const tripId = assertParsed(parseTripId(session.trip.id));
    const deviceId = assertParsed(parseDeviceId(session.localMember.deviceId));
    const memberId = assertParsed(parseMemberId(session.localMember.id));
    const operationId = id('trip-ended', this.randomUuid(), parseOperationId);

    await this.dependencies.data.transaction(async (repositories) => {
      const current = await repositories.trips.getById(session.trip.id);
      if (!current) throw new Error('The active trip no longer exists.');
      if (current.status === 'ENDED' || current.status === 'ARCHIVED') {
        await repositories.trips.clearActive();
        return;
      }

      const [sequenceSetting, highWater] = await Promise.all([
        repositories.deviceSettings.get<number>(operationSequenceKey(tripId, deviceId)),
        repositories.syncOperations.getContiguousHighWaterMarks(tripId),
      ]);
      const previous = Math.max(sequenceSetting?.value ?? 0, highWater[deviceId] ?? 0);
      if (!Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) {
        throw new Error('The local operation sequence is malformed or exhausted.');
      }
      const nextSequence = previous + 1;
      const endedTrip: Trip = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        id: tripId,
        name: current.name,
        createdByMemberId: assertParsed(parseMemberId(current.createdByMemberId)),
        createdAtMs: current.createdAtMs,
        updatedAtMs: now,
        startsAtMs: current.startsAtMs,
        endsAtMs: now,
        timeZone: current.timeZone,
        status: 'ENDED',
        defaultSharingMode: current.defaultSharingMode,
        locationSharingMode: current.locationSharingMode,
        targetReplicaCount: current.targetReplicaCount as 1 | 2 | 3,
        completeKeeperCount: current.completeKeeperCount as 0 | 1 | 2,
        membershipEpoch: current.membershipEpoch,
      };
      const unsignedOperation: Extract<SyncOperation, { kind: 'TRIP_STATUS_CHANGED' }> = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        operationId,
        tripId,
        originDeviceId: deviceId,
        originSequence: nextSequence,
        actorMemberId: memberId,
        membershipEpoch: current.membershipEpoch,
        createdAtMs: now,
        kind: 'TRIP_STATUS_CHANGED',
        payload: { trip: endedTrip },
      };
      const operationValue = await signSyncOperation(
        unsignedOperation,
        session.localMember.identityPublicKey,
        this.dependencies.identity,
      );
      const record = toOperationRecord(operationValue);
      await repositories.trips.upsert(toTripRecord(endedTrip, false));
      await repositories.syncOperations.append(record);
      await repositories.outbox.upsert(operationOutbox(record, now));
      await repositories.deviceSettings.set(
        setting(operationSequenceKey(tripId, deviceId), nextSequence, now),
      );
    });
  }

  private async leaveMember(session: TripSession, now: number): Promise<void> {
    const tripId = assertParsed(parseTripId(session.trip.id));
    const deviceId = assertParsed(parseDeviceId(session.localMember.deviceId));
    const memberId = assertParsed(parseMemberId(session.localMember.id));
    const operationId = id('member-left', this.randomUuid(), parseOperationId);

    await this.dependencies.data.transaction(async (repositories) => {
      const [currentTrip, currentMember] = await Promise.all([
        repositories.trips.getById(session.trip.id),
        repositories.members.getById(session.trip.id, session.localMember.id),
      ]);
      if (!currentTrip || !currentMember) {
        throw new Error('The active trip membership no longer exists.');
      }
      if (
        currentTrip.status === 'ENDED' ||
        currentTrip.status === 'ARCHIVED' ||
        currentMember.status === 'LEFT'
      ) {
        await repositories.trips.clearActive();
        return;
      }
      if (currentMember.status !== 'ACTIVE') {
        throw new Error('Only an active member can leave this trip.');
      }

      const [sequenceSetting, highWater] = await Promise.all([
        repositories.deviceSettings.get<number>(operationSequenceKey(tripId, deviceId)),
        repositories.syncOperations.getContiguousHighWaterMarks(tripId),
      ]);
      const previous = Math.max(sequenceSetting?.value ?? 0, highWater[deviceId] ?? 0);
      if (!Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) {
        throw new Error('The local operation sequence is malformed or exhausted.');
      }
      const leftMember: Member = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        id: memberId,
        tripId,
        deviceId,
        displayName: currentMember.displayName,
        identityPublicKey: assertParsed(parseIdentityPublicKey(currentMember.identityPublicKey)),
        role: currentMember.role,
        status: 'LEFT',
        replicaRole: currentMember.replicaRole,
        joinedAtMs: currentMember.joinedAtMs,
        updatedAtMs: now,
        leftAtMs: now,
        membershipEpoch: currentTrip.membershipEpoch,
      };
      const unsignedOperation: Extract<SyncOperation, { kind: 'MEMBER_STATUS_CHANGED' }> = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        operationId,
        tripId,
        originDeviceId: deviceId,
        originSequence: previous + 1,
        actorMemberId: memberId,
        membershipEpoch: currentTrip.membershipEpoch,
        createdAtMs: now,
        kind: 'MEMBER_STATUS_CHANGED',
        payload: { member: leftMember },
      };
      const operationValue = await signSyncOperation(
        unsignedOperation,
        session.localMember.identityPublicKey,
        this.dependencies.identity,
      );
      const record = toOperationRecord(operationValue);
      await repositories.members.upsert(toMemberRecord(leftMember));
      await repositories.syncOperations.append(record);
      await repositories.outbox.upsert(operationOutbox(record, now));
      await repositories.deviceSettings.set(
        setting(operationSequenceKey(tripId, deviceId), previous + 1, now),
      );
      await repositories.trips.clearActive();
    });
  }

  private async assertNoActiveTrip(): Promise<void> {
    if (await this.dependencies.data.repositories.trips.getActive()) {
      throw new ActiveTripConflictError();
    }
  }
}

function operation<K extends SyncOperation['kind']>(
  prefix: string,
  uuid: string,
  trip: Trip,
  member: Member,
  originSequence: number,
  kind: K,
  payload: Extract<SyncOperation, { kind: K }>['payload'],
): Extract<SyncOperation, { kind: K }> {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    operationId: id(prefix, uuid, parseOperationId),
    tripId: trip.id,
    originDeviceId: member.deviceId,
    originSequence,
    actorMemberId: member.id,
    membershipEpoch: trip.membershipEpoch,
    createdAtMs: trip.createdAtMs,
    kind,
    payload,
  } as Extract<SyncOperation, { kind: K }>;
}

function toTripRecord(trip: Trip, isActive: boolean): TripRecord {
  return { ...trip, isActive };
}

function toMemberRecord(member: Member): MemberRecord {
  return { ...member };
}

function toOperationRecord(operationValue: SyncOperation): SyncOperationRecord {
  const { originIdentityPublicKey, originSignature } = operationValue;
  return {
    ...operationValue,
    originIdentityPublicKey: originIdentityPublicKey ?? null,
    originSignature: originSignature ?? null,
    payload: toJsonValue(operationValue.payload),
  };
}

function operationOutbox(operationValue: SyncOperationRecord, now: number): OutboxRecord {
  return {
    id: `outbox:${operationValue.operationId}`,
    tripId: operationValue.tripId,
    recipientMemberId: null,
    messageType: 'SYNC_OPERATION',
    payload: toJsonValue(operationValue),
    dedupeKey: `operation:${operationValue.operationId}`,
    state: 'pending',
    attemptCount: 0,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setting<T extends JsonValue>(key: string, value: T, now: number) {
  return { key, value, updatedAt: now } as const;
}

function id<T>(prefix: string, uuid: string, parser: (value: unknown) => ParseResult<T>): T {
  return assertParsed(parser(`${prefix}:${uuid}`));
}

function normalizeTripName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80 || /\p{C}/u.test(name)) {
    throw new Error('Trip name must contain 2–80 visible characters.');
  }
  return name;
}

function normalizeLocalAddress(value: string): string {
  const address = value.trim();
  if (!address || address === '0.0.0.0' || address === '::' || address === '127.0.0.1') {
    throw new Error('Connect this phone to Wi-Fi or enable its personal hotspot before creating a trip.');
  }
  return address;
}

function formatAddress(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

function requireTransportEndpoint(value: string | null): string {
  if (!value) throw new Error('This invite does not contain a transport endpoint.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The invite transport endpoint is invalid.');
  }

  if (url.protocol === 'tcp:') {
    const port = Number(url.port);
    if (
      !url.hostname ||
      url.hostname === '0.0.0.0' ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new Error('The invite coordinator address is not a valid TCP endpoint.');
    }
    return url.toString();
  }

  if (
    (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
    !url.hostname ||
    url.hostname === '0.0.0.0' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('The invite does not contain a valid TCP or WebSocket endpoint.');
  }

  return url.toString();
}

function assertInviteIsCurrent(
  invite: TripInvite,
  acceptedIssuedAt: number | undefined,
  acceptedInviteId: string | undefined,
): void {
  if (acceptedIssuedAt === undefined) return;
  if (
    invite.issuedAtMs < acceptedIssuedAt ||
    (invite.issuedAtMs === acceptedIssuedAt &&
      acceptedInviteId !== undefined &&
      invite.inviteId !== acceptedInviteId)
  ) {
    throw new Error('This QR is older than the connection already saved on this phone. Scan the latest QR.');
  }
}

function resolvedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export const localMemberKey = (tripId: TripId) => `trip.${tripId}.local-member`;
export const endpointKey = (tripId: TripId) => `trip.${tripId}.endpoint`;
export const coordinatorKey = (tripId: TripId) => `trip.${tripId}.coordinator`;
export const coordinatorDeviceKey = (tripId: TripId) =>
  `trip.${tripId}.coordinator-device`;
export const acceptedInviteIssuedAtKey = (tripId: TripId) =>
  `trip.${tripId}.invite.accepted-issued-at`;
export const acceptedInviteIdKey = (tripId: TripId) =>
  `trip.${tripId}.invite.accepted-id`;
export const operationSequenceKey = (tripId: TripId, deviceId: DeviceId) =>
  `trip.${tripId}.sequence.operation.${deviceId}`;
export const mediaSequenceKey = (tripId: TripId, deviceId: DeviceId) =>
  `trip.${tripId}.sequence.media.${deviceId}`;
export const wireSequenceKey = (tripId: TripId, deviceId: DeviceId) =>
  `trip.${tripId}.sequence.wire.${deviceId}`;
