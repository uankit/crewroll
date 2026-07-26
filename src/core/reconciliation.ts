import {
  isMemberStatusTransitionAllowed,
  isMediaShareTransitionAllowed,
  isTripStatusTransitionAllowed,
} from "./invariants";
import {
  parseSyncOperation,
  type MediaItem,
  type MediaResource,
  type Member,
  type ReplicaReceipt,
  type SyncOperation,
  type Trip,
} from "./domain";
import type {
  DeviceId,
  MediaId,
  MemberId,
  OperationId,
  ReplicaReceiptId,
  ResourceId,
  TripId,
} from "./ids";
import { parseDeviceId } from "./ids";
import type { HighWaterVector } from "./protocol";
import { issue, type ValidationIssue } from "./validation";

export interface CatalogState {
  readonly trips: ReadonlyMap<TripId, Trip>;
  readonly members: ReadonlyMap<MemberId, Member>;
  readonly mediaItems: ReadonlyMap<MediaId, MediaItem>;
  readonly resources: ReadonlyMap<ResourceId, MediaResource>;
  readonly replicaReceipts: ReadonlyMap<ReplicaReceiptId, ReplicaReceipt>;
  readonly tombstones: ReadonlyMap<MediaId, number>;
  readonly operations: ReadonlyMap<OperationId, SyncOperation>;
  readonly sequenceOperationIds: ReadonlyMap<string, OperationId>;
  readonly entityVersions: ReadonlyMap<string, EntityVersion>;
  /** Highest contiguous applied operation sequence for each origin device. */
  readonly highWater: ReadonlyMap<DeviceId, number>;
  /** Applied sequences above a gap; never included in highWater until contiguous. */
  readonly pendingSequences: ReadonlyMap<DeviceId, ReadonlySet<number>>;
}

export interface EntityVersion {
  readonly membershipEpoch: number;
  readonly updatedAtMs: number;
  readonly originDeviceId: DeviceId;
  readonly originSequence: number;
  readonly operationId: OperationId;
}

export type ApplyDisposition = "APPLIED" | "DUPLICATE" | "REJECTED";

export interface ApplyOperationResult {
  readonly state: CatalogState;
  readonly disposition: ApplyDisposition;
  readonly entityChanged: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface ApplyOperationsResult {
  readonly state: CatalogState;
  readonly results: readonly ApplyOperationResult[];
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly rejectedCount: number;
}

export interface SequenceRange {
  readonly originDeviceId: DeviceId;
  readonly fromSequenceInclusive: number;
  readonly toSequenceInclusive: number;
}

export interface ReconciliationPlan {
  readonly requestFromRemote: readonly SequenceRange[];
  readonly offerToRemote: readonly SequenceRange[];
  readonly inSync: boolean;
}

export interface OperationSelection {
  readonly operations: readonly SyncOperation[];
  readonly hasMore: boolean;
}

export function createEmptyCatalogState(): CatalogState {
  return {
    trips: new Map(),
    members: new Map(),
    mediaItems: new Map(),
    resources: new Map(),
    replicaReceipts: new Map(),
    tombstones: new Map(),
    operations: new Map(),
    sequenceOperationIds: new Map(),
    entityVersions: new Map(),
    highWater: new Map(),
    pendingSequences: new Map(),
  };
}

/**
 * Applies an untrusted operation atomically. The parser runs again even when a
 * caller has a compile-time SyncOperation, so no malformed object reaches the
 * catalog through an `as` cast or decoded persistence row.
 */
export function applySyncOperation(
  state: CatalogState,
  operationValue: unknown,
): ApplyOperationResult {
  const parsed = parseSyncOperation(operationValue);
  if (!parsed.ok) {
    return {
      state,
      disposition: "REJECTED",
      entityChanged: false,
      issues: parsed.issues,
    };
  }
  const operation = parsed.value;
  const existingById = state.operations.get(operation.operationId);
  if (existingById !== undefined) {
    if (!sameOperation(existingById, operation)) {
      return rejected(
        state,
        "OPERATION_ID_CONFLICT",
        "Operation ID was reused with different content.",
      );
    }
    return {
      state,
      disposition: "DUPLICATE",
      entityChanged: false,
      issues: [],
    };
  }

  const sequenceKey = makeSequenceKey(
    operation.originDeviceId,
    operation.originSequence,
  );
  const authorizationFailure = authorizeOperation(state, operation);
  if (authorizationFailure !== null) {
    return rejected(state, authorizationFailure.code, authorizationFailure.message);
  }
  const existingSequenceOwner = state.sequenceOperationIds.get(sequenceKey);
  if (
    existingSequenceOwner !== undefined &&
    existingSequenceOwner !== operation.operationId
  ) {
    return rejected(
      state,
      "ORIGIN_SEQUENCE_CONFLICT",
      "Origin device reused an operation sequence.",
    );
  }

  const draft = cloneState(state);
  const mutation = applyEntityMutation(draft, operation);
  if (!mutation.ok) {
    return {
      state,
      disposition: "REJECTED",
      entityChanged: false,
      issues: mutation.issues,
    };
  }

  draft.operations.set(operation.operationId, operation);
  draft.sequenceOperationIds.set(sequenceKey, operation.operationId);
  recordAppliedSequence(
    draft.highWater,
    draft.pendingSequences,
    operation.originDeviceId,
    operation.originSequence,
  );

  return {
    state: draft,
    disposition: "APPLIED",
    entityChanged: mutation.entityChanged,
    issues: [],
  };
}

export function applySyncOperations(
  initialState: CatalogState,
  operationValues: readonly unknown[],
): ApplyOperationsResult {
  let state = initialState;
  const results: ApplyOperationResult[] = [];
  let appliedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;
  for (const operationValue of operationValues) {
    const result = applySyncOperation(state, operationValue);
    results.push(result);
    state = result.state;
    if (result.disposition === "APPLIED") appliedCount += 1;
    else if (result.disposition === "DUPLICATE") duplicateCount += 1;
    else rejectedCount += 1;
  }
  return { state, results, appliedCount, duplicateCount, rejectedCount };
}

export function highWaterToVector(
  highWater: ReadonlyMap<DeviceId, number>,
): HighWaterVector {
  const vector: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [deviceId, sequence] of highWater) vector[deviceId] = sequence;
  return vector;
}

export function computeMissingRanges(
  local: HighWaterVector,
  remote: HighWaterVector,
): readonly SequenceRange[] {
  const ranges: SequenceRange[] = [];
  for (const [rawDeviceId, remoteSequence] of Object.entries(remote)) {
    const parsedDeviceId = parseDeviceId(rawDeviceId);
    if (!parsedDeviceId.ok) continue;
    const localSequence = readVectorSequence(local, rawDeviceId);
    if (remoteSequence > localSequence) {
      ranges.push({
        originDeviceId: parsedDeviceId.value,
        fromSequenceInclusive: localSequence + 1,
        toSequenceInclusive: remoteSequence,
      });
    }
  }
  return ranges.sort(compareRanges);
}

export function planReconciliation(
  local: HighWaterVector,
  remote: HighWaterVector,
): ReconciliationPlan {
  const requestFromRemote = computeMissingRanges(local, remote);
  const offerToRemote = computeMissingRanges(remote, local);
  return {
    requestFromRemote,
    offerToRemote,
    inSync: requestFromRemote.length === 0 && offerToRemote.length === 0,
  };
}

export function selectOperationsForPeer(
  operations: Iterable<SyncOperation>,
  peerHighWater: HighWaterVector,
  limit: number,
): OperationSelection {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Operation selection limit must be a positive safe integer.");
  }
  const missing = [...operations]
    .filter(
      (operation) =>
        operation.originSequence >
        readVectorSequence(peerHighWater, operation.originDeviceId),
    )
    .sort(compareOperations);
  return {
    operations: missing.slice(0, limit),
    hasMore: missing.length > limit,
  };
}

export function isOperationAcknowledged(
  operation: SyncOperation,
  peerHighWater: HighWaterVector,
): boolean {
  return (
    readVectorSequence(peerHighWater, operation.originDeviceId) >=
    operation.originSequence
  );
}

function applyEntityMutation(
  state: MutableCatalogState,
  operation: SyncOperation,
): { readonly ok: true; readonly entityChanged: boolean } | {
  readonly ok: false;
  readonly issues: readonly ValidationIssue[];
} {
  switch (operation.kind) {
    case "TRIP_CREATED":
    case "TRIP_STATUS_CHANGED":
      return applyTripSnapshot(state, operation, operation.payload.trip);
    case "MEMBER_JOINED":
    case "MEMBER_STATUS_CHANGED":
      return applyMemberSnapshot(state, operation, operation.payload.member);
    case "MEDIA_PREVIEW_PUBLISHED":
    case "MEDIA_PUBLISHED": {
      const knownTombstone = state.tombstones.get(operation.payload.item.id);
      if (
        knownTombstone !== undefined &&
        operation.payload.item.publishedAtMs !== null &&
        knownTombstone < operation.payload.item.publishedAtMs
      ) {
        return mutationConflict(
          "INVALID_TOMBSTONE_TIME",
          "A known tombstone predates media publication.",
        );
      }
      const incoming = applyKnownTombstone(
        operation.payload.item,
        knownTombstone,
      );
      const existing = state.mediaItems.get(incoming.id);
      if (existing !== undefined && !samePublishedMedia(existing, incoming)) {
        return mutationConflict("MEDIA_CONFLICT", "Media ID already has different immutable content.");
      }
      for (const resource of operation.payload.resources) {
        const existingResource = state.resources.get(resource.id);
        if (existingResource !== undefined && !sameValue(existingResource, resource)) {
          return mutationConflict(
            "RESOURCE_CONFLICT",
            "Resource ID already has different immutable content.",
          );
        }
      }
      if (existing === undefined) state.mediaItems.set(incoming.id, incoming);
      let resourceChanged = false;
      for (const resource of operation.payload.resources) {
        if (!state.resources.has(resource.id)) {
          state.resources.set(resource.id, resource);
          resourceChanged = true;
        }
      }
      return { ok: true, entityChanged: existing === undefined || resourceChanged };
    }
    case "MEDIA_ORIGINAL_PUBLISHED": {
      const item = state.mediaItems.get(operation.payload.mediaId);
      if (item === undefined) {
        return mutationConflict(
          "MEDIA_NOT_FOUND",
          "Original publication requires an existing preview publication.",
        );
      }
      const resource = operation.payload.resource;
      if (
        resource.kind !== "ORIGINAL" ||
        resource.id !== item.originalResourceId ||
        resource.mediaId !== item.id ||
        resource.tripId !== item.tripId
      ) {
        return mutationConflict(
          "ORIGINAL_RESOURCE_MISMATCH",
          "Original manifest does not match the published media item.",
        );
      }
      const existingResource = state.resources.get(resource.id);
      if (existingResource !== undefined && !sameValue(existingResource, resource)) {
        return mutationConflict(
          "RESOURCE_CONFLICT",
          "Resource ID already has different immutable content.",
        );
      }
      if (existingResource === undefined) state.resources.set(resource.id, resource);
      return { ok: true, entityChanged: existingResource === undefined };
    }
    case "MEDIA_TOMBSTONED": {
      const previousTombstone = state.tombstones.get(operation.payload.mediaId);
      const tombstonedAtMs = Math.max(
        previousTombstone ?? 0,
        operation.payload.tombstonedAtMs,
      );
      state.tombstones.set(operation.payload.mediaId, tombstonedAtMs);
      const existing = state.mediaItems.get(operation.payload.mediaId);
      if (existing === undefined) {
        return { ok: true, entityChanged: previousTombstone !== tombstonedAtMs };
      }
      if (
        existing.publishedAtMs !== null &&
        operation.payload.tombstonedAtMs < existing.publishedAtMs
      ) {
        return mutationConflict(
          "INVALID_TOMBSTONE_TIME",
          "Tombstone cannot predate media publication.",
        );
      }
      if (!isMediaShareTransitionAllowed(existing.shareStatus, "TOMBSTONED")) {
        return mutationConflict(
          "INVALID_MEDIA_TRANSITION",
          `Cannot tombstone media in ${existing.shareStatus} state.`,
        );
      }
      const updated: MediaItem = {
        ...existing,
        shareStatus: "TOMBSTONED",
        tombstonedAtMs,
      };
      state.mediaItems.set(existing.id, updated);
      return { ok: true, entityChanged: !sameValue(existing, updated) };
    }
    case "REPLICA_RECORDED":
    case "REPLICA_STATUS_CHANGED":
      return applyReceiptSnapshot(state, operation, operation.payload.receipt);
  }
}

function applyMemberSnapshot(
  state: MutableCatalogState,
  operation: SyncOperation,
  incoming: Member,
): { readonly ok: true; readonly entityChanged: boolean } | {
  readonly ok: false;
  readonly issues: readonly ValidationIssue[];
} {
  const existing = state.members.get(incoming.id);
  if (operation.kind === "MEMBER_JOINED" && existing !== undefined) {
    return mutationConflict(
      "MEMBER_ALREADY_EXISTS",
      "A new MEMBER_JOINED operation cannot replace an existing member.",
    );
  }
  if (operation.kind === "MEMBER_STATUS_CHANGED" && existing === undefined) {
    return mutationConflict(
      "MEMBER_NOT_FOUND",
      "A member status operation requires an existing member.",
    );
  }
  if (existing !== undefined && !sameMemberIdentity(existing, incoming)) {
    return mutationConflict(
      "MEMBER_IDENTITY_CONFLICT",
      "Member update attempted to change immutable identity fields.",
    );
  }
  const versionKey = `member:${incoming.id}`;
  const incomingVersion = versionFor(operation, incoming.updatedAtMs);
  const currentVersion = state.entityVersions.get(versionKey);
  if (currentVersion !== undefined && compareVersions(incomingVersion, currentVersion) <= 0) {
    return { ok: true, entityChanged: false };
  }
  if (
    existing !== undefined &&
    !isMemberStatusTransitionAllowed(existing.status, incoming.status)
  ) {
    return mutationConflict(
      "INVALID_MEMBER_TRANSITION",
      `Cannot change member status from ${existing.status} to ${incoming.status}.`,
    );
  }
  state.members.set(incoming.id, incoming);
  state.entityVersions.set(versionKey, incomingVersion);
  return { ok: true, entityChanged: existing === undefined || !sameValue(existing, incoming) };
}

function applyTripSnapshot(
  state: MutableCatalogState,
  operation: SyncOperation,
  incoming: Trip,
): { readonly ok: true; readonly entityChanged: boolean } | {
  readonly ok: false;
  readonly issues: readonly ValidationIssue[];
} {
  const existing = state.trips.get(incoming.id);
  if (operation.kind === "TRIP_CREATED" && existing !== undefined) {
    return mutationConflict(
      "TRIP_ALREADY_EXISTS",
      "A new TRIP_CREATED operation cannot replace an existing trip.",
    );
  }
  if (operation.kind === "TRIP_STATUS_CHANGED" && existing === undefined) {
    return mutationConflict(
      "TRIP_NOT_FOUND",
      "A trip status operation requires an existing trip.",
    );
  }
  if (existing !== undefined && !sameTripConfiguration(existing, incoming)) {
    return mutationConflict(
      "TRIP_CONFIGURATION_CONFLICT",
      "Trip status operation attempted to change immutable trip configuration.",
    );
  }
  if (
    existing !== undefined &&
    existing.endsAtMs !== incoming.endsAtMs &&
    !(
      existing.endsAtMs === null &&
      incoming.endsAtMs !== null &&
      (incoming.status === "ENDED" || incoming.status === "ARCHIVED")
    )
  ) {
    return mutationConflict(
      "INVALID_TRIP_END_TIME",
      "Trip end time may only be set once when the trip ends.",
    );
  }
  if (
    incoming.endsAtMs !== null &&
    incoming.status !== "ENDED" &&
    incoming.status !== "ARCHIVED"
  ) {
    return mutationConflict(
      "INVALID_TRIP_END_TIME",
      "Only ended or archived trips may have an end time.",
    );
  }
  const versionKey = `trip:${incoming.id}`;
  const incomingVersion = versionFor(operation, incoming.updatedAtMs);
  const currentVersion = state.entityVersions.get(versionKey);
  if (currentVersion !== undefined && compareVersions(incomingVersion, currentVersion) <= 0) {
    return { ok: true, entityChanged: false };
  }
  if (
    existing !== undefined &&
    !isTripStatusTransitionAllowed(existing.status, incoming.status)
  ) {
    return mutationConflict(
      "INVALID_TRIP_TRANSITION",
      `Cannot change trip status from ${existing.status} to ${incoming.status}.`,
    );
  }
  state.trips.set(incoming.id, incoming);
  state.entityVersions.set(versionKey, incomingVersion);
  return { ok: true, entityChanged: existing === undefined || !sameValue(existing, incoming) };
}

function applyReceiptSnapshot(
  state: MutableCatalogState,
  operation: SyncOperation,
  incoming: ReplicaReceipt,
): { readonly ok: true; readonly entityChanged: boolean } | {
  readonly ok: false;
  readonly issues: readonly ValidationIssue[];
} {
  const existing = state.replicaReceipts.get(incoming.id);
  if (existing !== undefined && !sameReceiptIdentity(existing, incoming)) {
    return mutationConflict(
      "RECEIPT_IDENTITY_CONFLICT",
      "Receipt update attempted to change resource or holder identity.",
    );
  }
  const versionKey = `receipt:${incoming.id}`;
  const incomingVersion = versionFor(operation, incoming.updatedAtMs);
  const currentVersion = state.entityVersions.get(versionKey);
  if (currentVersion !== undefined && compareVersions(incomingVersion, currentVersion) <= 0) {
    return { ok: true, entityChanged: false };
  }
  state.replicaReceipts.set(incoming.id, incoming);
  state.entityVersions.set(versionKey, incomingVersion);
  return { ok: true, entityChanged: existing === undefined || !sameValue(existing, incoming) };
}

function recordAppliedSequence(
  highWater: Map<DeviceId, number>,
  pendingSequences: Map<DeviceId, Set<number>>,
  deviceId: DeviceId,
  sequence: number,
): void {
  let contiguous = highWater.get(deviceId) ?? 0;
  if (sequence <= contiguous) return;
  const pending = pendingSequences.get(deviceId) ?? new Set<number>();
  pending.add(sequence);
  while (pending.delete(contiguous + 1)) contiguous += 1;
  highWater.set(deviceId, contiguous);
  if (pending.size === 0) pendingSequences.delete(deviceId);
  else pendingSequences.set(deviceId, pending);
}

interface MutableCatalogState {
  readonly trips: Map<TripId, Trip>;
  readonly members: Map<MemberId, Member>;
  readonly mediaItems: Map<MediaId, MediaItem>;
  readonly resources: Map<ResourceId, MediaResource>;
  readonly replicaReceipts: Map<ReplicaReceiptId, ReplicaReceipt>;
  readonly tombstones: Map<MediaId, number>;
  readonly operations: Map<OperationId, SyncOperation>;
  readonly sequenceOperationIds: Map<string, OperationId>;
  readonly entityVersions: Map<string, EntityVersion>;
  readonly highWater: Map<DeviceId, number>;
  readonly pendingSequences: Map<DeviceId, Set<number>>;
}

function cloneState(state: CatalogState): MutableCatalogState {
  return {
    trips: new Map(state.trips),
    members: new Map(state.members),
    mediaItems: new Map(state.mediaItems),
    resources: new Map(state.resources),
    replicaReceipts: new Map(state.replicaReceipts),
    tombstones: new Map(state.tombstones),
    operations: new Map(state.operations),
    sequenceOperationIds: new Map(state.sequenceOperationIds),
    entityVersions: new Map(state.entityVersions),
    highWater: new Map(state.highWater),
    pendingSequences: new Map(
      [...state.pendingSequences].map(([deviceId, sequences]) => [
        deviceId,
        new Set(sequences),
      ]),
    ),
  };
}

function versionFor(operation: SyncOperation, updatedAtMs: number): EntityVersion {
  return {
    membershipEpoch: operation.membershipEpoch,
    updatedAtMs,
    originDeviceId: operation.originDeviceId,
    originSequence: operation.originSequence,
    operationId: operation.operationId,
  };
}

function compareVersions(left: EntityVersion, right: EntityVersion): number {
  if (left.membershipEpoch !== right.membershipEpoch) {
    return left.membershipEpoch - right.membershipEpoch;
  }
  if (left.updatedAtMs !== right.updatedAtMs) return left.updatedAtMs - right.updatedAtMs;
  const deviceOrder = left.originDeviceId.localeCompare(right.originDeviceId);
  if (deviceOrder !== 0) return deviceOrder;
  if (left.originSequence !== right.originSequence) {
    return left.originSequence - right.originSequence;
  }
  return left.operationId.localeCompare(right.operationId);
}

function sameMemberIdentity(left: Member, right: Member): boolean {
  return (
    left.id === right.id &&
    left.tripId === right.tripId &&
    left.deviceId === right.deviceId &&
    left.identityPublicKey === right.identityPublicKey &&
    left.role === right.role &&
    left.joinedAtMs === right.joinedAtMs
  );
}

function sameTripConfiguration(left: Trip, right: Trip): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.createdByMemberId === right.createdByMemberId &&
    left.createdAtMs === right.createdAtMs &&
    left.startsAtMs === right.startsAtMs &&
    left.timeZone === right.timeZone &&
    left.defaultSharingMode === right.defaultSharingMode &&
    left.locationSharingMode === right.locationSharingMode &&
    left.targetReplicaCount === right.targetReplicaCount &&
    left.completeKeeperCount === right.completeKeeperCount &&
    left.membershipEpoch === right.membershipEpoch
  );
}

interface AuthorizationFailure {
  readonly code: string;
  readonly message: string;
}

function authorizeOperation(
  state: CatalogState,
  operation: SyncOperation,
): AuthorizationFailure | null {
  if (operation.kind === "TRIP_CREATED") {
    const incoming = operation.payload.trip;
    if (
      state.trips.has(incoming.id) ||
      operation.actorMemberId !== incoming.createdByMemberId ||
      operation.membershipEpoch !== incoming.membershipEpoch
    ) {
      return authorizationFailure(
        "INVALID_TRIP_GENESIS",
        "Trip genesis must be authored by its declared creator at the declared membership epoch.",
      );
    }
    return null;
  }

  const trip = state.trips.get(operation.tripId);
  if (!trip) {
    return authorizationFailure(
      "UNKNOWN_OPERATION_TRIP",
      "Operation requires an existing trip genesis.",
    );
  }
  if (operation.membershipEpoch !== trip.membershipEpoch) {
    return authorizationFailure(
      "STALE_MEMBERSHIP_EPOCH",
      "Operation membership epoch does not match the trip.",
    );
  }

  const knownActor = state.members.get(operation.actorMemberId);
  if (operation.kind === "MEMBER_JOINED" && knownActor === undefined) {
    const incoming = operation.payload.member;
    const isCreatorBootstrap =
      incoming.id === trip.createdByMemberId &&
      incoming.id === operation.actorMemberId &&
      incoming.deviceId === operation.originDeviceId &&
      incoming.tripId === trip.id &&
      incoming.role === "ADMIN" &&
      incoming.status === "ACTIVE" &&
      incoming.membershipEpoch === trip.membershipEpoch;
    return isCreatorBootstrap
      ? null
      : authorizationFailure(
          "INVALID_CREATOR_MEMBERSHIP",
          "The only membership operation allowed before actor admission is the trip creator's ADMIN membership.",
        );
  }

  if (
    knownActor === undefined ||
    knownActor.tripId !== operation.tripId ||
    knownActor.deviceId !== operation.originDeviceId ||
    knownActor.status !== "ACTIVE" ||
    knownActor.membershipEpoch !== trip.membershipEpoch
  ) {
    return authorizationFailure(
      "INVALID_OPERATION_ACTOR",
      "Operation actor must be a known ACTIVE member bound to the origin device and current epoch.",
    );
  }

  switch (operation.kind) {
    case "TRIP_STATUS_CHANGED":
      return knownActor.role === "ADMIN"
        ? null
        : authorizationFailure("ADMIN_REQUIRED", "Only an ADMIN member may change trip status.");
    case "MEMBER_JOINED": {
      const incoming = operation.payload.member;
      if (
        knownActor.role !== "ADMIN" ||
        incoming.role !== "MEMBER" ||
        incoming.status !== "ACTIVE" ||
        incoming.tripId !== trip.id ||
        incoming.membershipEpoch !== trip.membershipEpoch
      ) {
        return authorizationFailure(
          "INVALID_MEMBER_ADMISSION",
          "Only an ADMIN may admit a new ACTIVE MEMBER at the current epoch.",
        );
      }
      return null;
    }
    case "MEMBER_STATUS_CHANGED": {
      const incoming = operation.payload.member;
      const isSelfLeave =
        incoming.id === knownActor.id &&
        (incoming.status === "LEAVING" || incoming.status === "LEFT");
      return knownActor.role === "ADMIN" || isSelfLeave
        ? null
        : authorizationFailure(
            "ADMIN_REQUIRED",
            "Only an ADMIN may change another member; a member may only leave itself.",
          );
    }
    case "MEDIA_PREVIEW_PUBLISHED":
    case "MEDIA_PUBLISHED": {
      const item = operation.payload.item;
      return item.originMemberId === knownActor.id &&
        item.originDeviceId === knownActor.deviceId &&
        item.tripId === trip.id
        ? null
        : authorizationFailure(
            "MEDIA_ORIGIN_MISMATCH",
            "Published media must be owned by the operation actor and origin device.",
          );
    }
    case "MEDIA_ORIGINAL_PUBLISHED": {
      const item = state.mediaItems.get(operation.payload.mediaId);
      const resource = operation.payload.resource;
      return item !== undefined &&
        item.originMemberId === knownActor.id &&
        item.originDeviceId === knownActor.deviceId &&
        item.tripId === trip.id &&
        resource.tripId === trip.id &&
        resource.mediaId === item.id &&
        resource.id === item.originalResourceId &&
        resource.kind === "ORIGINAL"
        ? null
        : authorizationFailure(
            "MEDIA_ORIGIN_MISMATCH",
            "Only the media origin may attach its matching original manifest.",
          );
    }
    case "MEDIA_TOMBSTONED": {
      const item = state.mediaItems.get(operation.payload.mediaId);
      return knownActor.role === "ADMIN" || item?.originMemberId === knownActor.id
        ? null
        : authorizationFailure(
            "MEDIA_OWNER_REQUIRED",
            "Only the media owner or an ADMIN may tombstone a photo.",
          );
    }
    case "REPLICA_RECORDED":
    case "REPLICA_STATUS_CHANGED": {
      const receipt = operation.payload.receipt;
      const resource = state.resources.get(receipt.resourceId);
      return receipt.holderMemberId === knownActor.id &&
        receipt.holderDeviceId === knownActor.deviceId &&
        receipt.tripId === trip.id &&
        resource !== undefined &&
        resource.mediaId === receipt.mediaId &&
        resource.sha256 === receipt.resourceSha256 &&
        resource.byteLength === receipt.resourceByteLength
        ? null
        : authorizationFailure(
            "INVALID_REPLICA_AUTHORITY",
            "Replica receipts must be authored by their holder and match a known resource.",
          );
    }
  }
}

function authorizationFailure(code: string, message: string): AuthorizationFailure {
  return { code, message };
}

function sameReceiptIdentity(left: ReplicaReceipt, right: ReplicaReceipt): boolean {
  return (
    left.id === right.id &&
    left.tripId === right.tripId &&
    left.mediaId === right.mediaId &&
    left.resourceId === right.resourceId &&
    left.holderMemberId === right.holderMemberId &&
    left.holderDeviceId === right.holderDeviceId &&
    left.resourceSha256 === right.resourceSha256 &&
    left.resourceByteLength === right.resourceByteLength &&
    left.verifiedAtMs === right.verifiedAtMs
  );
}

function applyKnownTombstone(item: MediaItem, tombstonedAtMs: number | undefined): MediaItem {
  if (tombstonedAtMs === undefined) return item;
  return { ...item, shareStatus: "TOMBSTONED", tombstonedAtMs };
}

function samePublishedMedia(left: MediaItem, right: MediaItem): boolean {
  const normalize = (item: MediaItem): MediaItem =>
    item.shareStatus === "TOMBSTONED"
      ? { ...item, shareStatus: "PUBLISHED", tombstonedAtMs: null }
      : item;
  return sameValue(normalize(left), normalize(right));
}

function sameOperation(left: SyncOperation, right: SyncOperation): boolean {
  return sameValue(left, right);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mutationConflict(
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly ValidationIssue[] } {
  return { ok: false, issues: [issue("$", code, message)] };
}

function rejected(
  state: CatalogState,
  code: string,
  message: string,
): ApplyOperationResult {
  return {
    state,
    disposition: "REJECTED",
    entityChanged: false,
    issues: [issue("$", code, message)],
  };
}

function makeSequenceKey(deviceId: DeviceId, sequence: number): string {
  return `${deviceId}\u0000${sequence}`;
}

function readVectorSequence(vector: HighWaterVector, deviceId: string): number {
  const value = Object.prototype.hasOwnProperty.call(vector, deviceId)
    ? vector[deviceId]
    : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function compareRanges(left: SequenceRange, right: SequenceRange): number {
  return (
    left.originDeviceId.localeCompare(right.originDeviceId) ||
    left.fromSequenceInclusive - right.fromSequenceInclusive
  );
}

function compareOperations(left: SyncOperation, right: SyncOperation): number {
  return (
    left.originDeviceId.localeCompare(right.originDeviceId) ||
    left.originSequence - right.originSequence ||
    left.operationId.localeCompare(right.operationId)
  );
}
