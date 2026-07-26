import {
  DOMAIN_SCHEMA_VERSION,
  MAX_TRIP_MEMBERS,
  type DomainSchemaVersion,
} from "./constants";
import {
  parseDeviceId,
  parseIdentityPublicKey,
  parseMediaId,
  parseMemberId,
  parseOperationId,
  parseReplicaReceiptId,
  parseResourceId,
  parseSha256Hex,
  parseTripId,
  type DeviceId,
  type IdentityPublicKey,
  type MediaId,
  type MemberId,
  type OperationId,
  type ReplicaReceiptId,
  type ResourceId,
  type Sha256Hex,
  type TripId,
} from "./ids";
import {
  appendResult,
  hasOwn,
  issue,
  joinPath,
  parseFailure,
  parseSuccess,
  readArray,
  readEnum,
  readNullableNumber,
  readNumber,
  readString,
  rejectUnknownKeys,
  requireRecord,
  type ParseResult,
  type UnknownRecord,
  type ValidationIssue,
} from "./validation";

export const TRIP_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ENDED",
  "ARCHIVED",
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const SHARING_MODES = ["REVIEW_FIRST", "AUTO_SHARE", "MANUAL"] as const;
export type SharingMode = (typeof SHARING_MODES)[number];

export const LOCATION_SHARING_MODES = ["NONE", "APPROXIMATE", "EXACT"] as const;
export type LocationSharingMode = (typeof LOCATION_SHARING_MODES)[number];

export const MEMBER_ROLES = ["ADMIN", "MEMBER"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ["ACTIVE", "LEAVING", "LEFT", "REMOVED"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const REPLICA_ROLES = [
  "NONE",
  "KEEPER_PRIMARY",
  "KEEPER_SECONDARY",
  "WITNESS",
] as const;
export type ReplicaRole = (typeof REPLICA_ROLES)[number];

export const MEDIA_SHARE_STATUSES = [
  "PRIVATE",
  "QUEUED",
  "PUBLISHED",
  "TOMBSTONED",
] as const;
export type MediaShareStatus = (typeof MEDIA_SHARE_STATUSES)[number];

export const MEDIA_RESOURCE_KINDS = ["ORIGINAL", "THUMBNAIL"] as const;
export type MediaResourceKind = (typeof MEDIA_RESOURCE_KINDS)[number];

export const REPLICA_RECEIPT_STATUSES = [
  "VERIFIED",
  "RELEASED",
  "LOST",
] as const;
export type ReplicaReceiptStatus = (typeof REPLICA_RECEIPT_STATUSES)[number];

export const SYNC_OPERATION_KINDS = [
  "TRIP_CREATED",
  "TRIP_STATUS_CHANGED",
  "MEMBER_JOINED",
  "MEMBER_STATUS_CHANGED",
  "MEDIA_PREVIEW_PUBLISHED",
  "MEDIA_ORIGINAL_PUBLISHED",
  "MEDIA_PUBLISHED",
  "MEDIA_TOMBSTONED",
  "REPLICA_RECORDED",
  "REPLICA_STATUS_CHANGED",
] as const;
export type SyncOperationKind = (typeof SYNC_OPERATION_KINDS)[number];

export interface Trip {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: TripId;
  readonly name: string;
  readonly createdByMemberId: MemberId;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly timeZone: string;
  readonly status: TripStatus;
  readonly defaultSharingMode: SharingMode;
  readonly locationSharingMode: LocationSharingMode;
  readonly targetReplicaCount: 1 | 2 | 3;
  readonly completeKeeperCount: 0 | 1 | 2;
  readonly membershipEpoch: number;
}

export interface Member {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: MemberId;
  readonly tripId: TripId;
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly identityPublicKey: IdentityPublicKey;
  readonly role: MemberRole;
  readonly status: MemberStatus;
  readonly replicaRole: ReplicaRole;
  readonly joinedAtMs: number;
  readonly updatedAtMs: number;
  readonly leftAtMs: number | null;
  readonly membershipEpoch: number;
}

export interface ExactMediaLocation {
  readonly kind: "EXACT";
  /** Latitude in signed decimal degrees multiplied by 10^7. */
  readonly latitudeE7: number;
  /** Longitude in signed decimal degrees multiplied by 10^7. */
  readonly longitudeE7: number;
  readonly accuracyMeters: number | null;
}

export interface ApproximateMediaLocation {
  readonly kind: "APPROXIMATE";
  /** Opaque offline spatial-cluster identifier, not a reverse-geocoded label. */
  readonly cellId: string;
}

export type MediaLocation = ExactMediaLocation | ApproximateMediaLocation;

export interface MediaItem {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: MediaId;
  readonly tripId: TripId;
  readonly originMemberId: MemberId;
  readonly originDeviceId: DeviceId;
  readonly originSequence: number;
  readonly source: "SYSTEM_LIBRARY";
  readonly mediaType: "IMAGE";
  readonly shareStatus: MediaShareStatus;
  readonly capturedAtMs: number;
  readonly captureTimeZoneOffsetMinutes: number;
  /** Calendar date at capture time, in YYYY-MM-DD form. */
  readonly captureLocalDate: string;
  readonly ingestedAtMs: number;
  readonly publishedAtMs: number | null;
  readonly tombstonedAtMs: number | null;
  readonly location: MediaLocation | null;
  readonly originalResourceId: ResourceId;
  readonly thumbnailResourceId: ResourceId | null;
}

export interface MediaResource {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: ResourceId;
  readonly tripId: TripId;
  readonly mediaId: MediaId;
  readonly kind: MediaResourceKind;
  readonly mimeType: string;
  /** Lowercase extension without a leading dot. */
  readonly fileExtension: string;
  readonly byteLength: number;
  readonly sha256: Sha256Hex;
  readonly width: number;
  readonly height: number;
  readonly createdAtMs: number;
}

export interface ReplicaReceipt {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: ReplicaReceiptId;
  readonly tripId: TripId;
  readonly mediaId: MediaId;
  readonly resourceId: ResourceId;
  readonly holderMemberId: MemberId;
  readonly holderDeviceId: DeviceId;
  readonly resourceSha256: Sha256Hex;
  readonly resourceByteLength: number;
  readonly status: ReplicaReceiptStatus;
  readonly verifiedAtMs: number;
  readonly updatedAtMs: number;
}

interface SyncOperationBase {
  readonly schemaVersion: DomainSchemaVersion;
  readonly operationId: OperationId;
  readonly tripId: TripId;
  readonly originDeviceId: DeviceId;
  /** Positive, gap-detectable sequence scoped to originDeviceId. */
  readonly originSequence: number;
  readonly actorMemberId: MemberId;
  readonly membershipEpoch: number;
  readonly createdAtMs: number;
  /** Ed25519 author attestation. Optional only for pre-security-upgrade local rows. */
  readonly originIdentityPublicKey?: IdentityPublicKey;
  readonly originSignature?: string;
}

export type SyncOperation =
  | (SyncOperationBase & {
      readonly kind: "TRIP_CREATED";
      readonly payload: { readonly trip: Trip };
    })
  | (SyncOperationBase & {
      readonly kind: "TRIP_STATUS_CHANGED";
      readonly payload: { readonly trip: Trip };
    })
  | (SyncOperationBase & {
      readonly kind: "MEMBER_JOINED";
      readonly payload: { readonly member: Member };
    })
  | (SyncOperationBase & {
      readonly kind: "MEMBER_STATUS_CHANGED";
      readonly payload: { readonly member: Member };
    })
  | (SyncOperationBase & {
      readonly kind: "MEDIA_PREVIEW_PUBLISHED";
      readonly payload: {
        readonly item: MediaItem;
        readonly resources: readonly MediaResource[];
      };
    })
  | (SyncOperationBase & {
      readonly kind: "MEDIA_ORIGINAL_PUBLISHED";
      readonly payload: {
        readonly mediaId: MediaId;
        readonly resource: MediaResource;
      };
    })
  | (SyncOperationBase & {
      readonly kind: "MEDIA_PUBLISHED";
      readonly payload: {
        readonly item: MediaItem;
        readonly resources: readonly MediaResource[];
      };
    })
  | (SyncOperationBase & {
      readonly kind: "MEDIA_TOMBSTONED";
      readonly payload: {
        readonly mediaId: MediaId;
        readonly tombstonedAtMs: number;
      };
    })
  | (SyncOperationBase & {
      readonly kind: "REPLICA_RECORDED";
      readonly payload: { readonly receipt: ReplicaReceipt };
    })
  | (SyncOperationBase & {
      readonly kind: "REPLICA_STATUS_CHANGED";
      readonly payload: { readonly receipt: ReplicaReceipt };
    });

const TRIP_KEYS = [
  "schemaVersion",
  "id",
  "name",
  "createdByMemberId",
  "createdAtMs",
  "updatedAtMs",
  "startsAtMs",
  "endsAtMs",
  "timeZone",
  "status",
  "defaultSharingMode",
  "locationSharingMode",
  "targetReplicaCount",
  "completeKeeperCount",
  "membershipEpoch",
] as const;

export function parseTrip(value: unknown): ParseResult<Trip> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, TRIP_KEYS, "$", issues);

  const schemaVersion = parseSchemaVersion(record, "$", issues);
  const id = appendResult(parseTripId(record.id), issues, "id");
  const name = readString(record, "name", "$", issues, {
    minLength: 1,
    maxLength: 80,
    requireTrimmed: true,
  });
  const createdByMemberId = appendResult(
    parseMemberId(record.createdByMemberId),
    issues,
    "createdByMemberId",
  );
  const createdAtMs = readTimestamp(record, "createdAtMs", "$", issues);
  const updatedAtMs = readTimestamp(record, "updatedAtMs", "$", issues);
  const startsAtMs = readTimestamp(record, "startsAtMs", "$", issues);
  const endsAtMs = readNullableTimestamp(record, "endsAtMs", "$", issues);
  const timeZone = readString(record, "timeZone", "$", issues, {
    minLength: 1,
    maxLength: 64,
    requireTrimmed: true,
    pattern: /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/,
  });
  const status = readEnum(record, "status", TRIP_STATUSES, "$", issues);
  const defaultSharingMode = readEnum(
    record,
    "defaultSharingMode",
    SHARING_MODES,
    "$",
    issues,
  );
  const locationSharingMode = readEnum(
    record,
    "locationSharingMode",
    LOCATION_SHARING_MODES,
    "$",
    issues,
  );
  const targetReplicaCount = readNumber(
    record,
    "targetReplicaCount",
    "$",
    issues,
    { integer: true, safeInteger: true, min: 1, max: 3 },
  );
  const completeKeeperCount = readNumber(
    record,
    "completeKeeperCount",
    "$",
    issues,
    { integer: true, safeInteger: true, min: 0, max: 2 },
  );
  const membershipEpoch = readCounter(record, "membershipEpoch", "$", issues);

  if (
    createdAtMs !== undefined &&
    updatedAtMs !== undefined &&
    updatedAtMs < createdAtMs
  ) {
    issues.push(issue("updatedAtMs", "INVALID_TIME_ORDER", "Must not predate creation."));
  }
  if (endsAtMs !== undefined && endsAtMs !== null && startsAtMs !== undefined && endsAtMs < startsAtMs) {
    issues.push(issue("endsAtMs", "INVALID_TIME_ORDER", "Must not predate trip start."));
  }
  if (
    completeKeeperCount !== undefined &&
    targetReplicaCount !== undefined &&
    completeKeeperCount > targetReplicaCount
  ) {
    issues.push(
      issue(
        "completeKeeperCount",
        "INVALID_REPLICA_POLICY",
        "Complete Keeper count cannot exceed target replica count.",
      ),
    );
  }
  if (issues.length > 0) return parseFailure(issues);

  return parseSuccess({
    schemaVersion: schemaVersion!,
    id: id!,
    name: name!,
    createdByMemberId: createdByMemberId!,
    createdAtMs: createdAtMs!,
    updatedAtMs: updatedAtMs!,
    startsAtMs: startsAtMs!,
    endsAtMs: endsAtMs!,
    timeZone: timeZone!,
    status: status!,
    defaultSharingMode: defaultSharingMode!,
    locationSharingMode: locationSharingMode!,
    targetReplicaCount: targetReplicaCount as 1 | 2 | 3,
    completeKeeperCount: completeKeeperCount as 0 | 1 | 2,
    membershipEpoch: membershipEpoch!,
  });
}

const MEMBER_KEYS = [
  "schemaVersion",
  "id",
  "tripId",
  "deviceId",
  "displayName",
  "identityPublicKey",
  "role",
  "status",
  "replicaRole",
  "joinedAtMs",
  "updatedAtMs",
  "leftAtMs",
  "membershipEpoch",
] as const;

export function parseMember(value: unknown): ParseResult<Member> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, MEMBER_KEYS, "$", issues);

  const schemaVersion = parseSchemaVersion(record, "$", issues);
  const id = appendResult(parseMemberId(record.id), issues, "id");
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const deviceId = appendResult(parseDeviceId(record.deviceId), issues, "deviceId");
  const displayName = readString(record, "displayName", "$", issues, {
    minLength: 1,
    maxLength: 64,
    requireTrimmed: true,
  });
  const identityPublicKey = appendResult(
    parseIdentityPublicKey(record.identityPublicKey),
    issues,
    "identityPublicKey",
  );
  const role = readEnum(record, "role", MEMBER_ROLES, "$", issues);
  const status = readEnum(record, "status", MEMBER_STATUSES, "$", issues);
  const replicaRole = readEnum(record, "replicaRole", REPLICA_ROLES, "$", issues);
  const joinedAtMs = readTimestamp(record, "joinedAtMs", "$", issues);
  const updatedAtMs = readTimestamp(record, "updatedAtMs", "$", issues);
  const leftAtMs = readNullableTimestamp(record, "leftAtMs", "$", issues);
  const membershipEpoch = readCounter(record, "membershipEpoch", "$", issues);

  if (joinedAtMs !== undefined && updatedAtMs !== undefined && updatedAtMs < joinedAtMs) {
    issues.push(issue("updatedAtMs", "INVALID_TIME_ORDER", "Must not predate joining."));
  }
  if (leftAtMs !== undefined && leftAtMs !== null && joinedAtMs !== undefined && leftAtMs < joinedAtMs) {
    issues.push(issue("leftAtMs", "INVALID_TIME_ORDER", "Must not predate joining."));
  }
  if (status !== undefined) {
    const shouldHaveLeftAt = status === "LEFT" || status === "REMOVED";
    if (shouldHaveLeftAt !== (leftAtMs !== null && leftAtMs !== undefined)) {
      issues.push(
        issue(
          "leftAtMs",
          "INVALID_MEMBER_STATE",
          shouldHaveLeftAt
            ? "LEFT and REMOVED members require leftAtMs."
            : "ACTIVE and LEAVING members must have null leftAtMs.",
        ),
      );
    }
  }
  if (issues.length > 0) return parseFailure(issues);

  return parseSuccess({
    schemaVersion: schemaVersion!,
    id: id!,
    tripId: tripId!,
    deviceId: deviceId!,
    displayName: displayName!,
    identityPublicKey: identityPublicKey!,
    role: role!,
    status: status!,
    replicaRole: replicaRole!,
    joinedAtMs: joinedAtMs!,
    updatedAtMs: updatedAtMs!,
    leftAtMs: leftAtMs!,
    membershipEpoch: membershipEpoch!,
  });
}

export function parseMediaLocation(value: unknown): ParseResult<MediaLocation> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  const kind = readEnum(record, "kind", ["EXACT", "APPROXIMATE"] as const, "$", issues);
  if (kind === "EXACT") {
    rejectUnknownKeys(record, ["kind", "latitudeE7", "longitudeE7", "accuracyMeters"], "$", issues);
    const latitudeE7 = readNumber(record, "latitudeE7", "$", issues, {
      integer: true,
      safeInteger: true,
      min: -900_000_000,
      max: 900_000_000,
    });
    const longitudeE7 = readNumber(record, "longitudeE7", "$", issues, {
      integer: true,
      safeInteger: true,
      min: -1_800_000_000,
      max: 1_800_000_000,
    });
    const accuracyMeters = readNullableNumber(record, "accuracyMeters", "$", issues, {
      min: 0,
      max: 1_000_000,
    });
    if (issues.length > 0) return parseFailure(issues);
    return parseSuccess({
      kind,
      latitudeE7: latitudeE7!,
      longitudeE7: longitudeE7!,
      accuracyMeters: accuracyMeters!,
    });
  }
  if (kind === "APPROXIMATE") {
    rejectUnknownKeys(record, ["kind", "cellId"], "$", issues);
    const cellId = readString(record, "cellId", "$", issues, {
      minLength: 1,
      maxLength: 64,
      requireTrimmed: true,
      pattern: /^[A-Za-z0-9._:-]+$/,
    });
    if (issues.length > 0) return parseFailure(issues);
    return parseSuccess({ kind, cellId: cellId! });
  }
  return parseFailure(issues);
}

const MEDIA_ITEM_KEYS = [
  "schemaVersion",
  "id",
  "tripId",
  "originMemberId",
  "originDeviceId",
  "originSequence",
  "source",
  "mediaType",
  "shareStatus",
  "capturedAtMs",
  "captureTimeZoneOffsetMinutes",
  "captureLocalDate",
  "ingestedAtMs",
  "publishedAtMs",
  "tombstonedAtMs",
  "location",
  "originalResourceId",
  "thumbnailResourceId",
] as const;

export function parseMediaItem(value: unknown): ParseResult<MediaItem> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, MEDIA_ITEM_KEYS, "$", issues);
  const schemaVersion = parseSchemaVersion(record, "$", issues);
  const id = appendResult(parseMediaId(record.id), issues, "id");
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const originMemberId = appendResult(
    parseMemberId(record.originMemberId),
    issues,
    "originMemberId",
  );
  const originDeviceId = appendResult(
    parseDeviceId(record.originDeviceId),
    issues,
    "originDeviceId",
  );
  const originSequence = readPositiveSequence(record, "originSequence", "$", issues);
  const source = readEnum(record, "source", ["SYSTEM_LIBRARY"] as const, "$", issues);
  const mediaType = readEnum(record, "mediaType", ["IMAGE"] as const, "$", issues);
  const shareStatus = readEnum(
    record,
    "shareStatus",
    MEDIA_SHARE_STATUSES,
    "$",
    issues,
  );
  const capturedAtMs = readTimestamp(record, "capturedAtMs", "$", issues);
  const captureTimeZoneOffsetMinutes = readNumber(
    record,
    "captureTimeZoneOffsetMinutes",
    "$",
    issues,
    { integer: true, safeInteger: true, min: -840, max: 840 },
  );
  const captureLocalDate = readString(record, "captureLocalDate", "$", issues, {
    minLength: 10,
    maxLength: 10,
    pattern: /^\d{4}-\d{2}-\d{2}$/,
  });
  if (captureLocalDate !== undefined && !isValidIsoDate(captureLocalDate)) {
    issues.push(issue("captureLocalDate", "INVALID_DATE", "Expected a real calendar date."));
  }
  const ingestedAtMs = readTimestamp(record, "ingestedAtMs", "$", issues);
  const publishedAtMs = readNullableTimestamp(record, "publishedAtMs", "$", issues);
  const tombstonedAtMs = readNullableTimestamp(record, "tombstonedAtMs", "$", issues);
  const location = parseNullableField(record, "location", parseMediaLocation, issues);
  const originalResourceId = appendResult(
    parseResourceId(record.originalResourceId),
    issues,
    "originalResourceId",
  );
  const thumbnailResourceId = parseNullableField(
    record,
    "thumbnailResourceId",
    parseResourceId,
    issues,
  );

  validateMediaLifecycle(shareStatus, publishedAtMs, tombstonedAtMs, issues);
  if (issues.length > 0) return parseFailure(issues);

  return parseSuccess({
    schemaVersion: schemaVersion!,
    id: id!,
    tripId: tripId!,
    originMemberId: originMemberId!,
    originDeviceId: originDeviceId!,
    originSequence: originSequence!,
    source: source!,
    mediaType: mediaType!,
    shareStatus: shareStatus!,
    capturedAtMs: capturedAtMs!,
    captureTimeZoneOffsetMinutes: captureTimeZoneOffsetMinutes!,
    captureLocalDate: captureLocalDate!,
    ingestedAtMs: ingestedAtMs!,
    publishedAtMs: publishedAtMs!,
    tombstonedAtMs: tombstonedAtMs!,
    location: location!,
    originalResourceId: originalResourceId!,
    thumbnailResourceId: thumbnailResourceId!,
  });
}

const MEDIA_RESOURCE_KEYS = [
  "schemaVersion",
  "id",
  "tripId",
  "mediaId",
  "kind",
  "mimeType",
  "fileExtension",
  "byteLength",
  "sha256",
  "width",
  "height",
  "createdAtMs",
] as const;

export function parseMediaResource(value: unknown): ParseResult<MediaResource> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, MEDIA_RESOURCE_KEYS, "$", issues);
  const schemaVersion = parseSchemaVersion(record, "$", issues);
  const id = appendResult(parseResourceId(record.id), issues, "id");
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const mediaId = appendResult(parseMediaId(record.mediaId), issues, "mediaId");
  const kind = readEnum(record, "kind", MEDIA_RESOURCE_KINDS, "$", issues);
  const mimeType = readString(record, "mimeType", "$", issues, {
    minLength: 7,
    maxLength: 80,
    pattern: /^image\/[a-z0-9][a-z0-9.+-]{0,63}$/,
  });
  const fileExtension = readString(record, "fileExtension", "$", issues, {
    minLength: 1,
    maxLength: 12,
    pattern: /^[a-z0-9]+$/,
  });
  const byteLength = readNumber(record, "byteLength", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
  });
  const sha256 = appendResult(parseSha256Hex(record.sha256), issues, "sha256");
  const width = readNumber(record, "width", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
    max: 1_000_000,
  });
  const height = readNumber(record, "height", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
    max: 1_000_000,
  });
  const createdAtMs = readTimestamp(record, "createdAtMs", "$", issues);
  if (issues.length > 0) return parseFailure(issues);

  return parseSuccess({
    schemaVersion: schemaVersion!,
    id: id!,
    tripId: tripId!,
    mediaId: mediaId!,
    kind: kind!,
    mimeType: mimeType!,
    fileExtension: fileExtension!,
    byteLength: byteLength!,
    sha256: sha256!,
    width: width!,
    height: height!,
    createdAtMs: createdAtMs!,
  });
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "id",
  "tripId",
  "mediaId",
  "resourceId",
  "holderMemberId",
  "holderDeviceId",
  "resourceSha256",
  "resourceByteLength",
  "status",
  "verifiedAtMs",
  "updatedAtMs",
] as const;

export function parseReplicaReceipt(value: unknown): ParseResult<ReplicaReceipt> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, RECEIPT_KEYS, "$", issues);
  const schemaVersion = parseSchemaVersion(record, "$", issues);
  const id = appendResult(parseReplicaReceiptId(record.id), issues, "id");
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const mediaId = appendResult(parseMediaId(record.mediaId), issues, "mediaId");
  const resourceId = appendResult(parseResourceId(record.resourceId), issues, "resourceId");
  const holderMemberId = appendResult(
    parseMemberId(record.holderMemberId),
    issues,
    "holderMemberId",
  );
  const holderDeviceId = appendResult(
    parseDeviceId(record.holderDeviceId),
    issues,
    "holderDeviceId",
  );
  const resourceSha256 = appendResult(
    parseSha256Hex(record.resourceSha256),
    issues,
    "resourceSha256",
  );
  const resourceByteLength = readNumber(record, "resourceByteLength", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
  });
  const status = readEnum(
    record,
    "status",
    REPLICA_RECEIPT_STATUSES,
    "$",
    issues,
  );
  const verifiedAtMs = readTimestamp(record, "verifiedAtMs", "$", issues);
  const updatedAtMs = readTimestamp(record, "updatedAtMs", "$", issues);
  if (verifiedAtMs !== undefined && updatedAtMs !== undefined && updatedAtMs < verifiedAtMs) {
    issues.push(issue("updatedAtMs", "INVALID_TIME_ORDER", "Must not predate verification."));
  }
  if (issues.length > 0) return parseFailure(issues);

  return parseSuccess({
    schemaVersion: schemaVersion!,
    id: id!,
    tripId: tripId!,
    mediaId: mediaId!,
    resourceId: resourceId!,
    holderMemberId: holderMemberId!,
    holderDeviceId: holderDeviceId!,
    resourceSha256: resourceSha256!,
    resourceByteLength: resourceByteLength!,
    status: status!,
    verifiedAtMs: verifiedAtMs!,
    updatedAtMs: updatedAtMs!,
  });
}

const OPERATION_BASE_KEYS = [
  "schemaVersion",
  "operationId",
  "tripId",
  "originDeviceId",
  "originSequence",
  "actorMemberId",
  "membershipEpoch",
  "createdAtMs",
  "originIdentityPublicKey",
  "originSignature",
  "kind",
  "payload",
] as const;

export function parseSyncOperation(value: unknown): ParseResult<SyncOperation> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, OPERATION_BASE_KEYS, "$", issues);
  const schemaVersion = parseSchemaVersion(record, "$", issues);
  const operationId = appendResult(
    parseOperationId(record.operationId),
    issues,
    "operationId",
  );
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const originDeviceId = appendResult(
    parseDeviceId(record.originDeviceId),
    issues,
    "originDeviceId",
  );
  const originSequence = readPositiveSequence(record, "originSequence", "$", issues);
  const actorMemberId = appendResult(
    parseMemberId(record.actorMemberId),
    issues,
    "actorMemberId",
  );
  const membershipEpoch = readCounter(record, "membershipEpoch", "$", issues);
  const createdAtMs = readTimestamp(record, "createdAtMs", "$", issues);
  const originIdentityPublicKey = hasOwn(record, "originIdentityPublicKey")
    ? appendResult(
        parseIdentityPublicKey(record.originIdentityPublicKey),
        issues,
        "originIdentityPublicKey",
      )
    : undefined;
  const originSignature = hasOwn(record, "originSignature")
    ? readString(record, "originSignature", "$", issues, {
        minLength: 86,
        maxLength: 86,
        pattern: /^[A-Za-z0-9_-]+$/,
      })
    : undefined;
  if ((originIdentityPublicKey === undefined) !== (originSignature === undefined)) {
    issues.push(
      issue(
        "originSignature",
        "INCOMPLETE_OPERATION_ATTESTATION",
        "Operation identity key and signature must be supplied together.",
      ),
    );
  }
  const kind = readEnum(record, "kind", SYNC_OPERATION_KINDS, "$", issues);
  const payloadRecord = requireRecord(record.payload, "payload", issues);

  if (
    issues.length > 0 ||
    schemaVersion === undefined ||
    operationId === undefined ||
    tripId === undefined ||
    originDeviceId === undefined ||
    originSequence === undefined ||
    actorMemberId === undefined ||
    membershipEpoch === undefined ||
    createdAtMs === undefined ||
    kind === undefined ||
    payloadRecord === undefined
  ) {
    return parseFailure(issues);
  }

  const base: SyncOperationBase = {
    schemaVersion,
    operationId,
    tripId,
    originDeviceId,
    originSequence,
    actorMemberId,
    membershipEpoch,
    createdAtMs,
    ...(originIdentityPublicKey && originSignature
      ? { originIdentityPublicKey, originSignature }
      : {}),
  };

  switch (kind) {
    case "TRIP_CREATED":
    case "TRIP_STATUS_CHANGED": {
      rejectUnknownKeys(payloadRecord, ["trip"], "payload", issues);
      const trip = appendResult(parseTrip(payloadRecord.trip), issues, "payload.trip");
      if (trip !== undefined && trip.id !== tripId) {
        issues.push(issue("payload.trip.id", "TRIP_MISMATCH", "Operation and payload trip differ."));
      }
      if (
        kind === "TRIP_CREATED" &&
        trip !== undefined &&
        trip.createdByMemberId !== actorMemberId
      ) {
        issues.push(issue("actorMemberId", "ACTOR_MISMATCH", "Trip creator must be the actor."));
      }
      if (trip !== undefined && trip.membershipEpoch !== membershipEpoch) {
        issues.push(issue("payload.trip.membershipEpoch", "EPOCH_MISMATCH", "Trip and operation epochs differ."));
      }
      return issues.length > 0
        ? parseFailure(issues)
        : kind === "TRIP_CREATED"
          ? parseSuccess({ ...base, kind, payload: { trip: trip! } })
          : parseSuccess({ ...base, kind, payload: { trip: trip! } });
    }
    case "MEMBER_JOINED":
    case "MEMBER_STATUS_CHANGED": {
      rejectUnknownKeys(payloadRecord, ["member"], "payload", issues);
      const member = appendResult(parseMember(payloadRecord.member), issues, "payload.member");
      if (member !== undefined && member.tripId !== tripId) {
        issues.push(issue("payload.member.tripId", "TRIP_MISMATCH", "Operation and member trip differ."));
      }
      if (kind === "MEMBER_JOINED" && member !== undefined && member.status !== "ACTIVE") {
        issues.push(issue("payload.member.status", "INVALID_MEMBER_STATE", "A joined member must start ACTIVE."));
      }
      if (member !== undefined && member.membershipEpoch !== membershipEpoch) {
        issues.push(issue("payload.member.membershipEpoch", "EPOCH_MISMATCH", "Member and operation epochs differ."));
      }
      return issues.length > 0
        ? parseFailure(issues)
        : parseSuccess({ ...base, kind, payload: { member: member! } });
    }
    case "MEDIA_PREVIEW_PUBLISHED":
    case "MEDIA_PUBLISHED": {
      rejectUnknownKeys(payloadRecord, ["item", "resources"], "payload", issues);
      const item = appendResult(parseMediaItem(payloadRecord.item), issues, "payload.item");
      const resourceValues = readArray(
        payloadRecord,
        "resources",
        "payload",
        issues,
        { minLength: 1, maxLength: 2 },
      );
      const resources: MediaResource[] = [];
      if (resourceValues !== undefined) {
        resourceValues.forEach((resourceValue, index) => {
          const parsed = appendResult(
            parseMediaResource(resourceValue),
            issues,
            joinPath("payload.resources", index),
          );
          if (parsed !== undefined) resources.push(parsed);
        });
      }
      if (item !== undefined && item.tripId !== tripId) {
        issues.push(issue("payload.item.tripId", "TRIP_MISMATCH", "Operation and media trip differ."));
      }
      if (item !== undefined && item.shareStatus !== "PUBLISHED") {
        issues.push(issue("payload.item.shareStatus", "INVALID_MEDIA_STATE", "Published operation requires PUBLISHED media."));
      }
      if (
        item !== undefined &&
        (item.originDeviceId !== originDeviceId || item.originMemberId !== actorMemberId)
      ) {
        issues.push(issue("payload.item", "ORIGIN_MISMATCH", "Media publisher must match its origin member and device."));
      }
      if (kind === "MEDIA_PREVIEW_PUBLISHED") {
        validatePreviewResources(item, resources, issues);
      } else {
        validatePublishedResources(item, resources, issues);
      }
      resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
      return issues.length > 0
        ? parseFailure(issues)
        : kind === "MEDIA_PREVIEW_PUBLISHED"
          ? parseSuccess({ ...base, kind, payload: { item: item!, resources } })
          : parseSuccess({ ...base, kind, payload: { item: item!, resources } });
    }
    case "MEDIA_ORIGINAL_PUBLISHED": {
      rejectUnknownKeys(payloadRecord, ["mediaId", "resource"], "payload", issues);
      const mediaId = appendResult(parseMediaId(payloadRecord.mediaId), issues, "payload.mediaId");
      const resource = appendResult(
        parseMediaResource(payloadRecord.resource),
        issues,
        "payload.resource",
      );
      if (resource !== undefined && resource.tripId !== tripId) {
        issues.push(issue("payload.resource.tripId", "TRIP_MISMATCH", "Operation and resource trip differ."));
      }
      if (resource !== undefined && mediaId !== undefined && resource.mediaId !== mediaId) {
        issues.push(issue("payload.resource.mediaId", "MEDIA_MISMATCH", "Original resource and payload media differ."));
      }
      if (resource !== undefined && resource.kind !== "ORIGINAL") {
        issues.push(issue("payload.resource.kind", "ORIGINAL_REQUIRED", "Original publication requires an ORIGINAL resource."));
      }
      return issues.length > 0
        ? parseFailure(issues)
        : parseSuccess({ ...base, kind, payload: { mediaId: mediaId!, resource: resource! } });
    }
    case "MEDIA_TOMBSTONED": {
      rejectUnknownKeys(payloadRecord, ["mediaId", "tombstonedAtMs"], "payload", issues);
      const mediaId = appendResult(parseMediaId(payloadRecord.mediaId), issues, "payload.mediaId");
      const tombstonedAtMs = readTimestamp(payloadRecord, "tombstonedAtMs", "payload", issues);
      return issues.length > 0
        ? parseFailure(issues)
        : parseSuccess({ ...base, kind, payload: { mediaId: mediaId!, tombstonedAtMs: tombstonedAtMs! } });
    }
    case "REPLICA_RECORDED":
    case "REPLICA_STATUS_CHANGED": {
      rejectUnknownKeys(payloadRecord, ["receipt"], "payload", issues);
      const receipt = appendResult(
        parseReplicaReceipt(payloadRecord.receipt),
        issues,
        "payload.receipt",
      );
      if (receipt !== undefined && receipt.tripId !== tripId) {
        issues.push(issue("payload.receipt.tripId", "TRIP_MISMATCH", "Operation and receipt trip differ."));
      }
      if (kind === "REPLICA_RECORDED" && receipt !== undefined && receipt.status !== "VERIFIED") {
        issues.push(issue("payload.receipt.status", "INVALID_REPLICA_STATE", "A recorded receipt must be VERIFIED."));
      }
      if (
        receipt !== undefined &&
        (receipt.holderDeviceId !== originDeviceId || receipt.holderMemberId !== actorMemberId)
      ) {
        issues.push(issue("payload.receipt", "HOLDER_MISMATCH", "Replica receipt must be authored by its holder."));
      }
      return issues.length > 0
        ? parseFailure(issues)
        : parseSuccess({ ...base, kind, payload: { receipt: receipt! } });
    }
  }
}

export function countActiveMembers(members: readonly Member[]): number {
  return members.filter(
    (member) => member.status === "ACTIVE" || member.status === "LEAVING",
  ).length;
}

export function canAdmitMember(members: readonly Member[]): boolean {
  return countActiveMembers(members) < MAX_TRIP_MEMBERS;
}

function parseSchemaVersion(
  value: UnknownRecord,
  path: string,
  issues: ValidationIssue[],
): DomainSchemaVersion | undefined {
  const candidate = readNumber(value, "schemaVersion", path, issues, {
    integer: true,
    safeInteger: true,
    min: DOMAIN_SCHEMA_VERSION,
    max: DOMAIN_SCHEMA_VERSION,
  });
  return candidate === DOMAIN_SCHEMA_VERSION ? DOMAIN_SCHEMA_VERSION : undefined;
}

function readTimestamp(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  return readNumber(value, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 0,
  });
}

function readNullableTimestamp(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | null | undefined {
  return readNullableNumber(value, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 0,
  });
}

function readCounter(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  return readNumber(value, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 0,
  });
}

function readPositiveSequence(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  return readNumber(value, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 1,
  });
}

function parseNullableField<T>(
  value: UnknownRecord,
  key: string,
  parser: (candidate: unknown) => ParseResult<T>,
  issues: ValidationIssue[],
): T | null | undefined {
  if (!hasOwn(value, key)) {
    issues.push(issue(key, "REQUIRED", "Field is required."));
    return undefined;
  }
  if (value[key] === null) return null;
  return appendResult(parser(value[key]), issues, key);
}

function validateMediaLifecycle(
  shareStatus: MediaShareStatus | undefined,
  publishedAtMs: number | null | undefined,
  tombstonedAtMs: number | null | undefined,
  issues: ValidationIssue[],
): void {
  if (shareStatus === undefined || publishedAtMs === undefined || tombstonedAtMs === undefined) return;
  if (shareStatus === "PRIVATE" || shareStatus === "QUEUED") {
    if (publishedAtMs !== null || tombstonedAtMs !== null) {
      issues.push(issue("shareStatus", "INVALID_MEDIA_STATE", "Private or queued media cannot have publication timestamps."));
    }
    return;
  }
  if (shareStatus === "PUBLISHED") {
    if (publishedAtMs === null || tombstonedAtMs !== null) {
      issues.push(issue("shareStatus", "INVALID_MEDIA_STATE", "Published media requires publishedAtMs and no tombstone."));
    }
    return;
  }
  if (publishedAtMs === null || tombstonedAtMs === null) {
    issues.push(issue("shareStatus", "INVALID_MEDIA_STATE", "Tombstoned media requires publication and tombstone timestamps."));
  } else if (tombstonedAtMs < publishedAtMs) {
    issues.push(issue("tombstonedAtMs", "INVALID_TIME_ORDER", "Tombstone must not predate publication."));
  }
}

function validatePublishedResources(
  item: MediaItem | undefined,
  resources: readonly MediaResource[],
  issues: ValidationIssue[],
): void {
  if (item === undefined) return;
  const originalResources = resources.filter((resource) => resource.kind === "ORIGINAL");
  const thumbnailResources = resources.filter((resource) => resource.kind === "THUMBNAIL");
  if (originalResources.length !== 1 || originalResources[0]?.id !== item.originalResourceId) {
    issues.push(issue("payload.resources", "MISSING_ORIGINAL", "Exactly one matching original resource is required."));
  }
  if (item.thumbnailResourceId === null) {
    if (thumbnailResources.length !== 0) {
      issues.push(issue("payload.resources", "UNEXPECTED_THUMBNAIL", "Item without a thumbnail ID cannot include a thumbnail."));
    }
  } else if (thumbnailResources.length !== 1 || thumbnailResources[0]?.id !== item.thumbnailResourceId) {
    issues.push(issue("payload.resources", "MISSING_THUMBNAIL", "Exactly one matching thumbnail resource is required."));
  }
  for (const resource of resources) {
    if (resource.tripId !== item.tripId || resource.mediaId !== item.id) {
      issues.push(issue("payload.resources", "RESOURCE_OWNER_MISMATCH", "Resource must belong to the published media and trip."));
    }
  }
}

function validatePreviewResources(
  item: MediaItem | undefined,
  resources: readonly MediaResource[],
  issues: ValidationIssue[],
): void {
  if (item === undefined) return;
  const originalResources = resources.filter((resource) => resource.kind === "ORIGINAL");
  const thumbnailResources = resources.filter((resource) => resource.kind === "THUMBNAIL");
  if (item.thumbnailResourceId === null) {
    issues.push(issue("payload.item.thumbnailResourceId", "THUMBNAIL_REQUIRED", "Preview publication requires a thumbnail."));
  } else if (thumbnailResources.length !== 1 || thumbnailResources[0]?.id !== item.thumbnailResourceId) {
    issues.push(issue("payload.resources", "MISSING_THUMBNAIL", "Exactly one matching thumbnail resource is required."));
  }
  if (originalResources.length !== 0) {
    issues.push(issue("payload.resources", "UNEXPECTED_ORIGINAL", "Preview publication cannot include the original manifest."));
  }
  for (const resource of resources) {
    if (resource.tripId !== item.tripId || resource.mediaId !== item.id) {
      issues.push(issue("payload.resources", "RESOURCE_OWNER_MISMATCH", "Resource must belong to the published media and trip."));
    }
  }
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}
