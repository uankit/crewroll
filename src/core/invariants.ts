import { MAX_TRIP_MEMBERS } from "./constants";
import {
  type MediaItem,
  type MediaResource,
  type MediaShareStatus,
  type Member,
  type MemberStatus,
  type ReplicaReceipt,
  type Trip,
  type TripStatus,
} from "./domain";
import type { DeviceId, MediaId, MemberId, ReplicaReceiptId, ResourceId } from "./ids";
import { issue, type ValidationIssue } from "./validation";

export class CoreInvariantError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "CoreInvariantError";
    this.issues = issues;
  }
}

export type ReplicaProtectionStatus =
  | "UNAVAILABLE"
  | "AT_RISK"
  | "PROTECTED"
  | "TRIP_SAFE";

export interface ReplicaAssessment {
  readonly resourceId: ResourceId;
  readonly targetReplicaCount: number;
  readonly verifiedReplicaCount: number;
  readonly status: ReplicaProtectionStatus;
  readonly isTripSafe: boolean;
  readonly holderDeviceIds: readonly DeviceId[];
  readonly invalidReceiptIds: readonly ReplicaReceiptId[];
}

export interface CatalogInvariantInput {
  readonly trips: readonly Trip[];
  readonly members: readonly Member[];
  readonly mediaItems: readonly MediaItem[];
  readonly resources: readonly MediaResource[];
  readonly replicaReceipts: readonly ReplicaReceipt[];
}

export interface DepartureAssessment {
  readonly memberId: MemberId;
  readonly safeToLeave: boolean;
  readonly requiredRemainingCopies: number;
  readonly atRiskMediaIds: readonly MediaId[];
}

export function assertInvariant(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new CoreInvariantError(message, [issue("$", code, message)]);
  }
}

export function assertCatalogInvariants(input: CatalogInvariantInput): void {
  const issues = validateCatalogInvariants(input);
  if (issues.length > 0) {
    throw new CoreInvariantError("Catalog invariants failed.", issues);
  }
}

export function validateCatalogInvariants(
  input: CatalogInvariantInput,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tripById = uniqueById(input.trips, "trips", issues);
  const memberById = uniqueById(input.members, "members", issues);
  const mediaById = uniqueById(input.mediaItems, "mediaItems", issues);
  const resourceById = uniqueById(input.resources, "resources", issues);
  uniqueById(input.replicaReceipts, "replicaReceipts", issues);

  for (const trip of input.trips) {
    const tripMembers = input.members.filter((member) => member.tripId === trip.id);
    const activeMembers = tripMembers.filter(
      (member) => member.status === "ACTIVE" || member.status === "LEAVING",
    );
    if (activeMembers.length > MAX_TRIP_MEMBERS) {
      issues.push(
        issue(
          `trips.${trip.id}.members`,
          "TOO_MANY_MEMBERS",
          `A trip supports at most ${MAX_TRIP_MEMBERS} active members.`,
        ),
      );
    }

    const activeDeviceIds = new Set<string>();
    for (const member of activeMembers) {
      if (activeDeviceIds.has(member.deviceId)) {
        issues.push(
          issue(
            `members.${member.id}.deviceId`,
            "DUPLICATE_ACTIVE_DEVICE",
            "One device cannot represent multiple active trip members.",
          ),
        );
      }
      activeDeviceIds.add(member.deviceId);
    }

    const creator = memberById.get(trip.createdByMemberId);
    if (creator === undefined || creator.tripId !== trip.id || creator.role !== "ADMIN") {
      issues.push(
        issue(
          `trips.${trip.id}.createdByMemberId`,
          "INVALID_TRIP_CREATOR",
          "Trip creator must refer to an ADMIN member of the same trip.",
        ),
      );
    }

    if (trip.status === "ACTIVE") {
      const activeCompleteKeepers = activeMembers.filter(
        (member) =>
          member.replicaRole === "KEEPER_PRIMARY" ||
          member.replicaRole === "KEEPER_SECONDARY",
      );
      if (activeCompleteKeepers.length < trip.completeKeeperCount) {
        issues.push(
          issue(
            `trips.${trip.id}.completeKeeperCount`,
            "INSUFFICIENT_KEEPERS",
            "Active trip has fewer complete Keepers than its policy requires.",
          ),
        );
      }
    }
  }

  for (const member of input.members) {
    if (!tripById.has(member.tripId)) {
      issues.push(
        issue(
          `members.${member.id}.tripId`,
          "MISSING_TRIP",
          "Member references an unknown trip.",
        ),
      );
    }
  }

  for (const item of input.mediaItems) {
    const trip = tripById.get(item.tripId);
    const originMember = memberById.get(item.originMemberId);
    if (trip === undefined) {
      issues.push(
        issue(`mediaItems.${item.id}.tripId`, "MISSING_TRIP", "Media references an unknown trip."),
      );
    }
    if (
      originMember === undefined ||
      originMember.tripId !== item.tripId ||
      originMember.deviceId !== item.originDeviceId
    ) {
      issues.push(
        issue(
          `mediaItems.${item.id}.originMemberId`,
          "INVALID_MEDIA_ORIGIN",
          "Media origin must refer to the matching member and device in its trip.",
        ),
      );
    }

    const original = resourceById.get(item.originalResourceId);
    if (
      original === undefined ||
      original.kind !== "ORIGINAL" ||
      original.mediaId !== item.id ||
      original.tripId !== item.tripId
    ) {
      issues.push(
        issue(
          `mediaItems.${item.id}.originalResourceId`,
          "INVALID_ORIGINAL_RESOURCE",
          "Media must refer to its exact original resource.",
        ),
      );
    }

    if (item.thumbnailResourceId !== null) {
      const thumbnail = resourceById.get(item.thumbnailResourceId);
      if (
        thumbnail === undefined ||
        thumbnail.kind !== "THUMBNAIL" ||
        thumbnail.mediaId !== item.id ||
        thumbnail.tripId !== item.tripId
      ) {
        issues.push(
          issue(
            `mediaItems.${item.id}.thumbnailResourceId`,
            "INVALID_THUMBNAIL_RESOURCE",
            "Thumbnail must refer to a derivative resource for the same media.",
          ),
        );
      }
    }

    if (trip !== undefined && item.shareStatus === "PUBLISHED") {
      if (trip.locationSharingMode === "NONE" && item.location !== null) {
        issues.push(
          issue(
            `mediaItems.${item.id}.location`,
            "LOCATION_POLICY_VIOLATION",
            "Trip policy forbids publishing indexed location.",
          ),
        );
      }
      if (
        trip.locationSharingMode === "APPROXIMATE" &&
        item.location?.kind === "EXACT"
      ) {
        issues.push(
          issue(
            `mediaItems.${item.id}.location`,
            "LOCATION_POLICY_VIOLATION",
            "Trip policy permits only approximate indexed location.",
          ),
        );
      }
    }
  }

  for (const resource of input.resources) {
    const media = mediaById.get(resource.mediaId);
    if (
      media === undefined ||
      media.tripId !== resource.tripId
    ) {
      issues.push(
        issue(
          `resources.${resource.id}.mediaId`,
          "MISSING_MEDIA",
          "Resource references unknown or cross-trip media.",
        ),
      );
    }
  }

  for (const receipt of input.replicaReceipts) {
    const resource = resourceById.get(receipt.resourceId);
    const member = memberById.get(receipt.holderMemberId);
    if (
      resource === undefined ||
      resource.mediaId !== receipt.mediaId ||
      resource.tripId !== receipt.tripId
    ) {
      issues.push(
        issue(
          `replicaReceipts.${receipt.id}.resourceId`,
          "INVALID_RECEIPT_RESOURCE",
          "Receipt must refer to a resource in the same media and trip.",
        ),
      );
    } else if (
      resource.sha256 !== receipt.resourceSha256 ||
      resource.byteLength !== receipt.resourceByteLength
    ) {
      issues.push(
        issue(
          `replicaReceipts.${receipt.id}`,
          "RECEIPT_INTEGRITY_MISMATCH",
          "Receipt hash and byte length must match the resource manifest.",
        ),
      );
    }
    if (
      member === undefined ||
      member.tripId !== receipt.tripId ||
      member.deviceId !== receipt.holderDeviceId
    ) {
      issues.push(
        issue(
          `replicaReceipts.${receipt.id}.holderMemberId`,
          "INVALID_RECEIPT_HOLDER",
          "Receipt holder must be the matching member and device in the trip.",
        ),
      );
    }
  }

  return issues;
}

export function assessResourceProtection(
  resource: MediaResource,
  receipts: readonly ReplicaReceipt[],
  targetReplicaCount: number,
): ReplicaAssessment {
  assertInvariant(
    Number.isSafeInteger(targetReplicaCount) && targetReplicaCount >= 1,
    "INVALID_REPLICA_TARGET",
    "Target replica count must be a positive safe integer.",
  );

  const holderDeviceIds = new Set<DeviceId>();
  const invalidReceiptIds: ReplicaReceiptId[] = [];
  for (const receipt of receipts) {
    if (receipt.resourceId !== resource.id || receipt.status !== "VERIFIED") continue;
    if (
      receipt.tripId !== resource.tripId ||
      receipt.mediaId !== resource.mediaId ||
      receipt.resourceSha256 !== resource.sha256 ||
      receipt.resourceByteLength !== resource.byteLength
    ) {
      invalidReceiptIds.push(receipt.id);
      continue;
    }
    holderDeviceIds.add(receipt.holderDeviceId);
  }

  const verifiedReplicaCount = holderDeviceIds.size;
  let status: ReplicaProtectionStatus;
  if (verifiedReplicaCount === 0) status = "UNAVAILABLE";
  else if (verifiedReplicaCount === 1) status = "AT_RISK";
  else if (verifiedReplicaCount < targetReplicaCount) status = "PROTECTED";
  else status = "TRIP_SAFE";

  return {
    resourceId: resource.id,
    targetReplicaCount,
    verifiedReplicaCount,
    status,
    isTripSafe: verifiedReplicaCount >= targetReplicaCount,
    holderDeviceIds: [...holderDeviceIds].sort(),
    invalidReceiptIds,
  };
}

export function assessMemberDeparture(
  memberId: MemberId,
  mediaItems: readonly MediaItem[],
  resources: readonly MediaResource[],
  receipts: readonly ReplicaReceipt[],
  requiredRemainingCopies = 2,
): DepartureAssessment {
  assertInvariant(
    Number.isSafeInteger(requiredRemainingCopies) && requiredRemainingCopies >= 1,
    "INVALID_REPLICA_TARGET",
    "Required remaining copies must be a positive safe integer.",
  );
  const leavingDeviceIds = new Set(
    receipts
      .filter((receipt) => receipt.holderMemberId === memberId)
      .map((receipt) => receipt.holderDeviceId),
  );
  const originalById = new Map(
    resources
      .filter((resource) => resource.kind === "ORIGINAL")
      .map((resource) => [resource.id, resource] as const),
  );
  const atRiskMediaIds: MediaId[] = [];

  for (const item of mediaItems) {
    if (item.shareStatus !== "PUBLISHED") continue;
    const original = originalById.get(item.originalResourceId);
    if (original === undefined) {
      atRiskMediaIds.push(item.id);
      continue;
    }
    const remainingHolders = new Set<DeviceId>();
    for (const receipt of receipts) {
      if (
        receipt.resourceId === original.id &&
        receipt.status === "VERIFIED" &&
        receipt.resourceSha256 === original.sha256 &&
        receipt.resourceByteLength === original.byteLength &&
        !leavingDeviceIds.has(receipt.holderDeviceId)
      ) {
        remainingHolders.add(receipt.holderDeviceId);
      }
    }
    if (remainingHolders.size < requiredRemainingCopies) {
      atRiskMediaIds.push(item.id);
    }
  }

  return {
    memberId,
    safeToLeave: atRiskMediaIds.length === 0,
    requiredRemainingCopies,
    atRiskMediaIds,
  };
}

export function isTripStatusTransitionAllowed(
  from: TripStatus,
  to: TripStatus,
): boolean {
  if (from === to) return true;
  const allowed: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
    DRAFT: ["ACTIVE", "ARCHIVED"],
    ACTIVE: ["PAUSED", "ENDED"],
    PAUSED: ["ACTIVE", "ENDED"],
    ENDED: ["ARCHIVED"],
    ARCHIVED: [],
  };
  return allowed[from].includes(to);
}

export function isMemberStatusTransitionAllowed(
  from: MemberStatus,
  to: MemberStatus,
): boolean {
  if (from === to) return true;
  const allowed: Readonly<Record<MemberStatus, readonly MemberStatus[]>> = {
    ACTIVE: ["LEAVING", "LEFT", "REMOVED"],
    LEAVING: ["ACTIVE", "LEFT", "REMOVED"],
    LEFT: [],
    REMOVED: [],
  };
  return allowed[from].includes(to);
}

export function isMediaShareTransitionAllowed(
  from: MediaShareStatus,
  to: MediaShareStatus,
): boolean {
  if (from === to) return true;
  const allowed: Readonly<Record<MediaShareStatus, readonly MediaShareStatus[]>> = {
    PRIVATE: ["QUEUED", "PUBLISHED"],
    QUEUED: ["PRIVATE", "PUBLISHED"],
    PUBLISHED: ["TOMBSTONED"],
    TOMBSTONED: [],
  };
  return allowed[from].includes(to);
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  path: string,
  issues: ValidationIssue[],
): Map<T["id"], T> {
  const result = new Map<T["id"], T>();
  for (const value of values) {
    if (result.has(value.id)) {
      issues.push(issue(`${path}.${value.id}`, "DUPLICATE_ID", "Identifier must be unique."));
    }
    result.set(value.id, value);
  }
  return result;
}
