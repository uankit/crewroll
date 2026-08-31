import type {
  ActiveTripRecord,
  InboxInsert,
  OutboxInsert,
  TripDeviceRecord,
  TripEnvelopeRecord,
  TripIdempotencyRecord,
  TripInviteRecord,
  TripMembershipRecord,
  TripProjectionRead,
  TripRecord,
  TripTransaction,
  TripUnitOfWork,
} from "../../src/modules/trips/ports/tripUnitOfWork.js";
import type {
  ForegroundActorSnapshot,
  ForegroundTripActor,
} from "../../src/modules/trips/types.js";

interface FakeUser {
  readonly clerkSubject: string;
  readonly displayName: string;
  readonly userId: string;
}

interface FakeInbox extends InboxInsert {
  readonly sequence: string;
}

interface FakeOutbox extends OutboxInsert {
  readonly dedupeKey: string;
}

export interface TripFakeState {
  activeTrips: Map<string, ActiveTripRecord>;
  devices: Map<string, TripDeviceRecord>;
  envelopes: Map<string, TripEnvelopeRecord>;
  idempotencies: Map<string, TripIdempotencyRecord>;
  inboxes: FakeInbox[];
  invites: Map<string, TripInviteRecord>;
  memberships: Map<string, TripMembershipRecord>;
  outboxes: Map<string, FakeOutbox>;
  trips: Map<string, TripRecord>;
  users: Map<string, FakeUser>;
}

function envelopeKey(tripId: string, recipientDeviceId: string): string {
  return `${tripId}:${recipientDeviceId}`;
}

function idempotencyKey(record: {
  readonly idempotencyKey: string;
  readonly routeKey: string;
  readonly userId: string;
}): string {
  return `${record.userId}:${record.routeKey}:${record.idempotencyKey}`;
}

function cloneState(state: TripFakeState): TripFakeState {
  return {
    activeTrips: new Map(state.activeTrips),
    devices: new Map(state.devices),
    envelopes: new Map(state.envelopes),
    idempotencies: new Map(state.idempotencies),
    inboxes: [...state.inboxes],
    invites: new Map(state.invites),
    memberships: new Map(state.memberships),
    outboxes: new Map(state.outboxes),
    trips: new Map(state.trips),
    users: new Map(state.users),
  };
}

function replaceState(target: TripFakeState, source: TripFakeState): void {
  target.activeTrips = source.activeTrips;
  target.devices = source.devices;
  target.envelopes = source.envelopes;
  target.idempotencies = source.idempotencies;
  target.inboxes = source.inboxes;
  target.invites = source.invites;
  target.memberships = source.memberships;
  target.outboxes = source.outboxes;
  target.trips = source.trips;
  target.users = source.users;
}

function bytesEqual(
  left: Readonly<Uint8Array>,
  right: Readonly<Uint8Array>,
): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

const CLOSED_TRANSACTION_MESSAGE = "Trip transaction scope is closed";
const UNSETTLED_TRANSACTION_MESSAGE =
  "Trip transaction callback left unsettled work";

function callbackTransactionScope(raw: TripTransaction) {
  let active = true;
  const pending = new Set<Promise<unknown>>();

  function invoke<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!active) {
      return Promise.reject(new Error(CLOSED_TRANSACTION_MESSAGE));
    }
    let result: Promise<Result>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(
        error instanceof Error
          ? error
          : new Error("Trip transaction operation failed"),
      );
    }
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  }

  const transaction = Object.freeze<TripTransaction>({
    acquireCreateCommandLock: (identity) =>
      invoke(() => raw.acquireCreateCommandLock(identity)),
    authoritativeNow: () => invoke(() => raw.authoritativeNow()),
    deleteActiveTrip: (userId, tripId) =>
      invoke(() => raw.deleteActiveTrip(userId, tripId)),
    deleteIdempotency: (record) => invoke(() => raw.deleteIdempotency(record)),
    findEnvelope: (tripId, recipientDeviceId) =>
      invoke(() => raw.findEnvelope(tripId, recipientDeviceId)),
    findIdempotency: (input) => invoke(() => raw.findIdempotency(input)),
    insertActiveTrip: (record) => invoke(() => raw.insertActiveTrip(record)),
    insertEnvelope: (record) => invoke(() => raw.insertEnvelope(record)),
    insertIdempotency: (record) => invoke(() => raw.insertIdempotency(record)),
    insertInbox: (record) => invoke(() => raw.insertInbox(record)),
    insertInvite: (record) => invoke(() => raw.insertInvite(record)),
    insertMembership: (record) => invoke(() => raw.insertMembership(record)),
    insertOutbox: (record) => invoke(() => raw.insertOutbox(record)),
    insertTrip: (record) => invoke(() => raw.insertTrip(record)),
    lockActiveTrip: (userId) => invoke(() => raw.lockActiveTrip(userId)),
    lockDevice: (deviceId) => invoke(() => raw.lockDevice(deviceId)),
    lockDevices: (deviceIds) => invoke(() => raw.lockDevices(deviceIds)),
    lockInvite: (inviteId) => invoke(() => raw.lockInvite(inviteId)),
    lockMembership: (tripId, membershipId) =>
      invoke(() => raw.lockMembership(tripId, membershipId)),
    lockMembershipForUser: (tripId, userId) =>
      invoke(() => raw.lockMembershipForUser(tripId, userId)),
    lockMemberships: (tripId) => invoke(() => raw.lockMemberships(tripId)),
    lockTrip: (tripId) => invoke(() => raw.lockTrip(tripId)),
    readProjection: (actor, tripId) =>
      invoke(() => raw.readProjection(actor, tripId)),
    reauthorizeForegroundActor: (actor) =>
      invoke(() => raw.reauthorizeForegroundActor(actor)),
    tryAcquireCreateCommandLock: (identity) =>
      invoke(() => raw.tryAcquireCreateCommandLock(identity)),
    updateInvite: (record) => invoke(() => raw.updateInvite(record)),
    updateMembership: (record) => invoke(() => raw.updateMembership(record)),
    updateTrip: (record) => invoke(() => raw.updateTrip(record)),
  });

  return {
    transaction,
    hasPending: () => pending.size > 0,
    invalidate() {
      active = false;
    },
    async settlePending() {
      await Promise.allSettled([...pending]);
    },
  };
}

function fakeProjection(
  state: TripFakeState,
  actor: ForegroundTripActor,
  tripId: string,
): TripProjectionRead {
  const trip = state.trips.get(tripId);
  if (trip === undefined) return { kind: "NOT_FOUND" };
  const caller = [...state.memberships.values()].find(
    (membership) =>
      membership.tripId === tripId &&
      membership.userId === actor.userId &&
      membership.state !== "REJECTED",
  );
  if (caller === undefined || caller.state !== "ACTIVE") {
    return { kind: "NOT_FOUND" };
  }
  if (caller.participatingDeviceId !== actor.deviceId) {
    return { kind: "DEVICE_NOT_PARTICIPANT" };
  }
  const callerDevice = state.devices.get(caller.participatingDeviceId);
  if (callerDevice?.revoked === true) return { kind: "DEVICE_REVOKED" };
  if (callerDevice === undefined) return { kind: "INVARIANT_ERROR" };
  const owner = [...state.memberships.values()].find(
    (membership) =>
      membership.tripId === tripId &&
      membership.role === "OWNER" &&
      membership.state === "ACTIVE",
  );
  const ownerDevice =
    owner === undefined
      ? undefined
      : state.devices.get(owner.participatingDeviceId);
  const selfEnvelope = state.envelopes.get(
    envelopeKey(tripId, caller.participatingDeviceId),
  );
  if (
    owner === undefined ||
    ownerDevice === undefined ||
    ownerDevice.revoked ||
    selfEnvelope === undefined
  ) {
    return { kind: "INVARIANT_ERROR" };
  }
  const visible = [...state.memberships.values()]
    .filter(
      (membership) =>
        membership.tripId === tripId &&
        membership.state !== "REJECTED" &&
        (caller.role === "OWNER" || membership.state === "ACTIVE"),
    )
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.membershipId.localeCompare(right.membershipId),
    );
  const members = visible.map((membership) => {
    const user = state.users.get(membership.userId);
    const revealDevice =
      caller.role === "OWNER" ||
      membership.membershipId === caller.membershipId;
    const device = revealDevice
      ? state.devices.get(membership.participatingDeviceId)
      : undefined;
    if (
      user === undefined ||
      (revealDevice && (device === undefined || device.revoked))
    ) {
      throw new Error("Invalid fake Trip projection invariant");
    }
    return {
      displayName: user.displayName,
      fullPhotoLibraryAccess: membership.fullPhotoLibraryAccess,
      membershipId: membership.membershipId,
      nominatedDevice:
        device === undefined
          ? null
          : {
              deviceId: device.deviceId,
              e2eeKeyAlgorithm: device.e2eeKeyAlgorithm,
              e2eeKeyVersion: device.e2eeKeyVersion,
              e2eePublicKey: device.e2eePublicKey,
            },
      role: membership.role,
      status: membership.state as "ACTIVE" | "PENDING_KEY",
    };
  });
  return {
    kind: "FOUND",
    projection: {
      currentMembershipId: caller.membershipId,
      endsAt: trip.endsAt,
      keyEpoch: 1,
      members,
      name: trip.name,
      ownerDeviceId: owner.participatingDeviceId,
      release: trip.release,
      startsAt: trip.startedAt,
      state: trip.state,
      tripId: trip.tripId,
      tripKeyEnvelope: {
        algorithmVersion: selfEnvelope.algorithmVersion,
        keyEpoch: selfEnvelope.keyEpoch,
        wrappedKey: selfEnvelope.wrappedKey,
      },
      version: trip.version,
    },
  };
}

export function createTripTestHarness() {
  const state: TripFakeState = {
    activeTrips: new Map(),
    devices: new Map(),
    envelopes: new Map(),
    idempotencies: new Map(),
    inboxes: [],
    invites: new Map(),
    memberships: new Map(),
    outboxes: new Map(),
    trips: new Map(),
    users: new Map(),
  };
  const trace: string[] = [];
  let authoritativeNow = new Date("2026-08-30T12:00:00.000Z");
  let reauthorization: ForegroundActorSnapshot = {
    kind: "DEVICE_NOT_OWNED",
  };
  let failedWrite: number | undefined;
  let writes = 0;
  let createTryLockAvailable = true;
  let authoritativeNowGate:
    | Readonly<{
        release: Promise<void>;
        started: () => void;
      }>
    | undefined;

  function recordWrite(label: string): void {
    trace.push(label);
    writes += 1;
    if (writes === failedWrite) {
      throw new Error(`Forced Trip write boundary ${writes}`);
    }
  }

  function transactionFor(working: TripFakeState): TripTransaction {
    return {
      acquireCreateCommandLock() {
        trace.push("lock.create.blocking");
        return Promise.resolve();
      },
      async authoritativeNow() {
        const gate = authoritativeNowGate;
        authoritativeNowGate = undefined;
        if (gate !== undefined) {
          gate.started();
          await gate.release;
        }
        return new Date(authoritativeNow.getTime());
      },
      deleteActiveTrip(userId, tripId) {
        working.activeTrips.delete(userId);
        recordWrite("write.active-trip.delete");
        if (
          [...working.activeTrips.values()].some(
            (record) => record.userId === userId && record.tripId === tripId,
          )
        ) {
          throw new Error("Fake active Trip delete failed");
        }
        return Promise.resolve();
      },
      deleteIdempotency(record) {
        working.idempotencies.delete(idempotencyKey(record));
        recordWrite("write.idempotency.delete");
        return Promise.resolve();
      },
      findEnvelope(tripId, recipientDeviceId) {
        return Promise.resolve(
          working.envelopes.get(envelopeKey(tripId, recipientDeviceId)) ?? null,
        );
      },
      findIdempotency(input) {
        trace.push("lock.idempotency");
        return Promise.resolve(
          working.idempotencies.get(idempotencyKey(input)) ?? null,
        );
      },
      insertActiveTrip(record) {
        working.activeTrips.set(record.userId, record);
        recordWrite("write.active-trip");
        return Promise.resolve();
      },
      insertEnvelope(record) {
        working.envelopes.set(
          envelopeKey(record.tripId, record.recipientDeviceId),
          record,
        );
        recordWrite("write.envelope");
        return Promise.resolve();
      },
      insertIdempotency(record) {
        working.idempotencies.set(idempotencyKey(record), record);
        recordWrite("write.idempotency");
        return Promise.resolve();
      },
      insertInbox(record) {
        const sequence = String(working.inboxes.length + 1);
        working.inboxes.push({ ...record, sequence });
        recordWrite("write.inbox");
        return Promise.resolve(sequence);
      },
      insertInvite(record) {
        working.invites.set(record.inviteId, record);
        recordWrite("write.invite");
        return Promise.resolve();
      },
      insertMembership(record) {
        working.memberships.set(record.membershipId, record);
        recordWrite("write.membership");
        return Promise.resolve();
      },
      insertOutbox(record) {
        const dedupeKey = `trip.changed:${record.tripId}:v${record.version}`;
        if (working.outboxes.has(dedupeKey)) {
          return Promise.resolve("duplicate");
        }
        working.outboxes.set(dedupeKey, { ...record, dedupeKey });
        recordWrite("write.outbox");
        return Promise.resolve("inserted");
      },
      insertTrip(record) {
        working.trips.set(record.tripId, record);
        recordWrite("write.trip");
        return Promise.resolve();
      },
      lockActiveTrip(userId) {
        trace.push("lock.active-trip");
        return Promise.resolve(working.activeTrips.get(userId) ?? null);
      },
      lockDevice(deviceId) {
        trace.push(`lock.device:${deviceId}`);
        return Promise.resolve(working.devices.get(deviceId) ?? null);
      },
      lockDevices(deviceIds) {
        const sorted = [...new Set(deviceIds)].sort();
        trace.push(`lock.devices:${sorted.join(",")}`);
        return Promise.resolve(
          sorted.flatMap((deviceId) => {
            const device = working.devices.get(deviceId);
            return device === undefined ? [] : [device];
          }),
        );
      },
      lockInvite(inviteId) {
        trace.push("lock.invite");
        return Promise.resolve(working.invites.get(inviteId) ?? null);
      },
      lockMembership(tripId, membershipId) {
        trace.push("lock.membership");
        const membership = working.memberships.get(membershipId);
        return Promise.resolve(
          membership?.tripId === tripId ? membership : null,
        );
      },
      lockMembershipForUser(tripId, userId) {
        trace.push("lock.membership.user");
        return Promise.resolve(
          [...working.memberships.values()].find(
            (membership) =>
              membership.tripId === tripId && membership.userId === userId,
          ) ?? null,
        );
      },
      lockMemberships(tripId) {
        trace.push("lock.memberships");
        return Promise.resolve(
          [...working.memberships.values()]
            .filter((membership) => membership.tripId === tripId)
            .sort((left, right) =>
              left.membershipId.localeCompare(right.membershipId),
            ),
        );
      },
      lockTrip(tripId) {
        trace.push("lock.trip");
        return Promise.resolve(working.trips.get(tripId) ?? null);
      },
      readProjection(actor, tripId) {
        trace.push("read.projection.transaction");
        return Promise.resolve(fakeProjection(working, actor, tripId));
      },
      reauthorizeForegroundActor(actor) {
        trace.push("lock.actor.user", "lock.actor.device");
        return Promise.resolve(
          reauthorization.kind === "ACTIVE"
            ? { actor, kind: "ACTIVE" }
            : reauthorization,
        );
      },
      tryAcquireCreateCommandLock() {
        trace.push("lock.create.try");
        return Promise.resolve(createTryLockAvailable);
      },
      updateInvite(record) {
        working.invites.set(record.inviteId, record);
        recordWrite("write.invite.update");
        return Promise.resolve();
      },
      updateMembership(record) {
        working.memberships.set(record.membershipId, record);
        recordWrite("write.membership.update");
        return Promise.resolve();
      },
      updateTrip(record) {
        working.trips.set(record.tripId, record);
        recordWrite("write.trip.update");
        return Promise.resolve();
      },
    };
  }

  const unitOfWork: TripUnitOfWork = {
    findInviteCandidate(inviteCodeHmac) {
      trace.push("read.invite-candidate");
      const invite = [...state.invites.values()].find((candidate) =>
        bytesEqual(candidate.inviteCodeHmac, inviteCodeHmac),
      );
      return Promise.resolve(
        invite === undefined
          ? null
          : { inviteId: invite.inviteId, tripId: invite.tripId },
      );
    },
    readProjection(actor, tripId) {
      trace.push("read.projection.plain");
      return Promise.resolve(fakeProjection(state, actor, tripId));
    },
    async run(operation) {
      trace.push("transaction.begin");
      const working = cloneState(state);
      writes = 0;
      const scope = callbackTransactionScope(transactionFor(working));
      try {
        let result;
        try {
          result = await operation(scope.transaction);
        } catch (error) {
          scope.invalidate();
          await scope.settlePending();
          throw error;
        }
        scope.invalidate();
        if (scope.hasPending()) {
          await scope.settlePending();
          throw new Error(UNSETTLED_TRANSACTION_MESSAGE);
        }
        replaceState(state, working);
        trace.push("transaction.commit");
        return result;
      } catch (error) {
        trace.push("transaction.rollback");
        throw error;
      }
    },
  };

  return {
    deferAuthoritativeNow() {
      let signalStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      authoritativeNowGate = {
        release: releasePromise,
        started: signalStarted,
      };
      return { release, started };
    },
    failAfterWrite(boundary: number | undefined) {
      failedWrite = boundary;
    },
    setAuthoritativeNow(now: Date) {
      authoritativeNow = new Date(now.getTime());
    },
    setCreateTryLockAvailable(available: boolean) {
      createTryLockAvailable = available;
    },
    setReauthorization(snapshot: ForegroundActorSnapshot) {
      reauthorization = snapshot;
      if (snapshot.kind === "ACTIVE") {
        state.users.set(snapshot.actor.userId, {
          clerkSubject: snapshot.actor.clerkSubject,
          displayName: "CrewRoll member",
          userId: snapshot.actor.userId,
        });
        state.devices.set(snapshot.actor.deviceId, {
          deviceId: snapshot.actor.deviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eeKeyVersion: 1,
          e2eePublicKey: new Uint8Array(32).fill(0x11),
          revoked: false,
          userId: snapshot.actor.userId,
        });
      }
    },
    state,
    trace,
    unitOfWork,
  };
}
