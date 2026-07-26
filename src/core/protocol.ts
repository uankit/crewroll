import {
  MAX_ACTIVE_TRANSFERS,
  MAX_OPERATION_BATCH_SIZE,
  MAX_RESOURCE_CHUNK_BYTES,
  PROTOCOL_VERSION,
  type ProtocolVersion,
} from "./constants";
import {
  parseMediaResource,
  parseSyncOperation,
  type MediaResource,
  type SyncOperation,
} from "./domain";
import {
  parseDeviceId,
  parseIdentityPublicKey,
  parseMediaId,
  parseMemberId,
  parseMessageId,
  parseRequestId,
  parseResourceId,
  parseSha256Hex,
  parseTransferId,
  parseTripId,
  type DeviceId,
  type IdentityPublicKey,
  type MediaId,
  type MemberId,
  type MessageId,
  type RequestId,
  type ResourceId,
  type Sha256Hex,
  type TransferId,
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
  readBoolean,
  readEnum,
  readNumber,
  readString,
  readUint8Array,
  rejectUnknownKeys,
  requireRecord,
  type ParseResult,
  type UnknownRecord,
  type ValidationIssue,
} from "./validation";

export const PROTOCOL_MESSAGE_TYPES = [
  "HELLO",
  "SYNC_REQUEST",
  "OP_BATCH",
  "ACK",
  "RESOURCE_REQUEST",
  "RESOURCE_OFFER",
  "RESOURCE_CHUNK",
  "RESOURCE_COMPLETE",
  "HEARTBEAT",
] as const;
export type ProtocolMessageType = (typeof PROTOCOL_MESSAGE_TYPES)[number];

export type HighWaterVector = Readonly<Record<string, number>>;

export interface HelloMessage {
  readonly memberId: MemberId;
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly identityPublicKey: IdentityPublicKey;
  /** Exact signed invite ticket for first admission; null for known members. */
  readonly admissionInviteLink: string | null;
  readonly supportedProtocolVersions: readonly ProtocolVersion[];
  readonly membershipEpoch: number;
  readonly highWater: HighWaterVector;
  readonly canStoreOriginals: boolean;
  readonly availableStorageBytes: number;
  readonly maxChunkBytes: number;
}

export interface SyncRequestMessage {
  readonly requestId: RequestId;
  readonly knownHighWater: HighWaterVector;
  readonly maxOperations: number;
  readonly includeCatalogSnapshot: boolean;
}

export interface OperationBatchMessage {
  readonly requestId: RequestId;
  readonly batchSequence: number;
  readonly operations: readonly SyncOperation[];
  readonly senderHighWater: HighWaterVector;
  readonly hasMore: boolean;
}

export const ACK_STATUSES = ["ACCEPTED", "DUPLICATE", "REJECTED"] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export interface AckMessage {
  readonly acknowledgedMessageId: MessageId;
  readonly status: AckStatus;
  readonly highWater: HighWaterVector;
  readonly errorCode: string | null;
}

export const RESOURCE_PRIORITIES = [
  "THUMBNAIL",
  "USER_VISIBLE_ORIGINAL",
  "BACKGROUND_ORIGINAL",
] as const;
export type ResourcePriority = (typeof RESOURCE_PRIORITIES)[number];

export interface ResourceRequestMessage {
  readonly requestId: RequestId;
  readonly mediaId: MediaId;
  readonly resourceId: ResourceId;
  readonly expectedSha256: Sha256Hex;
  readonly startOffset: number;
  readonly priority: ResourcePriority;
}

export interface ResourceOfferMessage {
  readonly requestId: RequestId;
  readonly accepted: boolean;
  readonly transferId: TransferId | null;
  readonly resource: MediaResource | null;
  readonly chunkSize: number | null;
  readonly rejectionCode: string | null;
}

export interface ResourceChunkMessage {
  readonly transferId: TransferId;
  readonly resourceId: ResourceId;
  readonly chunkIndex: number;
  readonly offset: number;
  /** Binary transport payload. It must never be encoded into JSON/base64. */
  readonly bytes: Uint8Array;
  readonly chunkSha256: Sha256Hex;
}

export const RESOURCE_COMPLETION_STATUSES = [
  "SENDER_FINISHED",
  "SENDER_REJECTED",
  "RECEIVER_VERIFIED",
  "RECEIVER_REJECTED",
] as const;
export type ResourceCompletionStatus =
  (typeof RESOURCE_COMPLETION_STATUSES)[number];

export interface ResourceCompleteMessage {
  readonly transferId: TransferId;
  readonly resourceId: ResourceId;
  readonly status: ResourceCompletionStatus;
  readonly byteLength: number;
  readonly sha256: Sha256Hex;
  readonly errorCode: string | null;
}

export const PEER_STATES = ["READY", "DEGRADED", "DRAINING"] as const;
export type PeerState = (typeof PEER_STATES)[number];

export interface HeartbeatMessage {
  readonly highWater: HighWaterVector;
  readonly peerState: PeerState;
  readonly availableStorageBytes: number;
  readonly activeTransferCount: number;
}

interface ProtocolEnvelopeBase {
  readonly protocolVersion: ProtocolVersion;
  readonly messageId: MessageId;
  readonly tripId: TripId;
  readonly senderMemberId: MemberId;
  readonly senderDeviceId: DeviceId;
  readonly membershipEpoch: number;
  readonly senderMessageSequence: number;
  readonly sentAtMs: number;
}

export type ProtocolEnvelope =
  | (ProtocolEnvelopeBase & { readonly type: "HELLO"; readonly payload: HelloMessage })
  | (ProtocolEnvelopeBase & {
      readonly type: "SYNC_REQUEST";
      readonly payload: SyncRequestMessage;
    })
  | (ProtocolEnvelopeBase & {
      readonly type: "OP_BATCH";
      readonly payload: OperationBatchMessage;
    })
  | (ProtocolEnvelopeBase & { readonly type: "ACK"; readonly payload: AckMessage })
  | (ProtocolEnvelopeBase & {
      readonly type: "RESOURCE_REQUEST";
      readonly payload: ResourceRequestMessage;
    })
  | (ProtocolEnvelopeBase & {
      readonly type: "RESOURCE_OFFER";
      readonly payload: ResourceOfferMessage;
    })
  | (ProtocolEnvelopeBase & {
      readonly type: "RESOURCE_CHUNK";
      readonly payload: ResourceChunkMessage;
    })
  | (ProtocolEnvelopeBase & {
      readonly type: "RESOURCE_COMPLETE";
      readonly payload: ResourceCompleteMessage;
    })
  | (ProtocolEnvelopeBase & {
      readonly type: "HEARTBEAT";
      readonly payload: HeartbeatMessage;
    });

const ENVELOPE_KEYS = [
  "protocolVersion",
  "messageId",
  "tripId",
  "senderMemberId",
  "senderDeviceId",
  "membershipEpoch",
  "senderMessageSequence",
  "sentAtMs",
  "type",
  "payload",
] as const;

export function parseProtocolEnvelope(value: unknown): ParseResult<ProtocolEnvelope> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ENVELOPE_KEYS, "$", issues);

  const protocolVersion = readNumber(record, "protocolVersion", "$", issues, {
    integer: true,
    safeInteger: true,
    min: PROTOCOL_VERSION,
    max: PROTOCOL_VERSION,
  });
  const messageId = appendResult(parseMessageId(record.messageId), issues, "messageId");
  const tripId = appendResult(parseTripId(record.tripId), issues, "tripId");
  const senderMemberId = appendResult(
    parseMemberId(record.senderMemberId),
    issues,
    "senderMemberId",
  );
  const senderDeviceId = appendResult(
    parseDeviceId(record.senderDeviceId),
    issues,
    "senderDeviceId",
  );
  const membershipEpoch = readCounter(record, "membershipEpoch", "$", issues);
  const senderMessageSequence = readPositiveCounter(
    record,
    "senderMessageSequence",
    "$",
    issues,
  );
  const sentAtMs = readTimestamp(record, "sentAtMs", "$", issues);
  const type = readEnum(record, "type", PROTOCOL_MESSAGE_TYPES, "$", issues);
  const payloadRecord = requireRecord(record.payload, "payload", issues);
  if (
    issues.length > 0 ||
    protocolVersion === undefined ||
    messageId === undefined ||
    tripId === undefined ||
    senderMemberId === undefined ||
    senderDeviceId === undefined ||
    membershipEpoch === undefined ||
    senderMessageSequence === undefined ||
    sentAtMs === undefined ||
    type === undefined ||
    payloadRecord === undefined
  ) {
    return parseFailure(issues);
  }

  const base: ProtocolEnvelopeBase = {
    protocolVersion: protocolVersion as ProtocolVersion,
    messageId,
    tripId,
    senderMemberId,
    senderDeviceId,
    membershipEpoch,
    senderMessageSequence,
    sentAtMs,
  };

  switch (type) {
    case "HELLO": {
      const parsed = parseHelloMessage(payloadRecord);
      if (!parsed.ok) return prefixPayloadFailure(parsed);
      if (
        parsed.value.memberId !== senderMemberId ||
        parsed.value.deviceId !== senderDeviceId ||
        parsed.value.membershipEpoch !== membershipEpoch
      ) {
        return parseFailure([
          issue("payload", "SENDER_MISMATCH", "HELLO identity must match its envelope."),
        ]);
      }
      return parseSuccess({ ...base, type, payload: parsed.value });
    }
    case "SYNC_REQUEST": {
      const parsed = parseSyncRequestMessage(payloadRecord);
      return parsed.ok
        ? parseSuccess({ ...base, type, payload: parsed.value })
        : prefixPayloadFailure(parsed);
    }
    case "OP_BATCH": {
      const parsed = parseOperationBatchMessage(payloadRecord);
      if (!parsed.ok) return prefixPayloadFailure(parsed);
      if (parsed.value.operations.some((operation) => operation.tripId !== tripId)) {
        return parseFailure([
          issue("payload.operations", "TRIP_MISMATCH", "Every operation must belong to the envelope trip."),
        ]);
      }
      return parseSuccess({ ...base, type, payload: parsed.value });
    }
    case "ACK": {
      const parsed = parseAckMessage(payloadRecord);
      return parsed.ok
        ? parseSuccess({ ...base, type, payload: parsed.value })
        : prefixPayloadFailure(parsed);
    }
    case "RESOURCE_REQUEST": {
      const parsed = parseResourceRequestMessage(payloadRecord);
      return parsed.ok
        ? parseSuccess({ ...base, type, payload: parsed.value })
        : prefixPayloadFailure(parsed);
    }
    case "RESOURCE_OFFER": {
      const parsed = parseResourceOfferMessage(payloadRecord);
      if (!parsed.ok) return prefixPayloadFailure(parsed);
      if (parsed.value.resource !== null && parsed.value.resource.tripId !== tripId) {
        return parseFailure([
          issue("payload.resource.tripId", "TRIP_MISMATCH", "Resource must belong to the envelope trip."),
        ]);
      }
      return parseSuccess({ ...base, type, payload: parsed.value });
    }
    case "RESOURCE_CHUNK": {
      const parsed = parseResourceChunkMessage(payloadRecord);
      return parsed.ok
        ? parseSuccess({ ...base, type, payload: parsed.value })
        : prefixPayloadFailure(parsed);
    }
    case "RESOURCE_COMPLETE": {
      const parsed = parseResourceCompleteMessage(payloadRecord);
      return parsed.ok
        ? parseSuccess({ ...base, type, payload: parsed.value })
        : prefixPayloadFailure(parsed);
    }
    case "HEARTBEAT": {
      const parsed = parseHeartbeatMessage(payloadRecord);
      return parsed.ok
        ? parseSuccess({ ...base, type, payload: parsed.value })
        : prefixPayloadFailure(parsed);
    }
  }
}

export function isBinaryProtocolEnvelope(
  envelope: ProtocolEnvelope,
): envelope is Extract<ProtocolEnvelope, { readonly type: "RESOURCE_CHUNK" }> {
  return envelope.type === "RESOURCE_CHUNK";
}

export function parseHighWaterVector(value: unknown): ParseResult<HighWaterVector> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  const entries = Object.entries(record);
  if (entries.length > 64) {
    issues.push(issue("$", "TOO_MANY_ENTRIES", "High-water vector supports at most 64 devices."));
  }
  const vector: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [rawDeviceId, rawSequence] of entries) {
    const deviceId = appendResult(parseDeviceId(rawDeviceId), issues, rawDeviceId);
    if (
      typeof rawSequence !== "number" ||
      !Number.isSafeInteger(rawSequence) ||
      rawSequence < 0
    ) {
      issues.push(issue(rawDeviceId, "INVALID_SEQUENCE", "High-water sequence must be a non-negative safe integer."));
    } else if (deviceId !== undefined) {
      vector[deviceId] = rawSequence;
    }
  }
  return issues.length > 0 ? parseFailure(issues) : parseSuccess(vector);
}

export function parseHelloMessage(value: unknown): ParseResult<HelloMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(
    record,
    [
      "memberId",
      "deviceId",
      "displayName",
      "identityPublicKey",
      "admissionInviteLink",
      "supportedProtocolVersions",
      "membershipEpoch",
      "highWater",
      "canStoreOriginals",
      "availableStorageBytes",
      "maxChunkBytes",
    ],
    "$",
    issues,
  );
  const memberId = appendResult(parseMemberId(record.memberId), issues, "memberId");
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
  const admissionInviteLink = readRequiredNullableString(
    record,
    "admissionInviteLink",
    issues,
    4_096,
  );
  const supportedValues = readArray(
    record,
    "supportedProtocolVersions",
    "$",
    issues,
    { minLength: 1, maxLength: 8 },
  );
  const supportedProtocolVersions: ProtocolVersion[] = [];
  if (supportedValues !== undefined) {
    supportedValues.forEach((candidate, index) => {
      if (candidate !== PROTOCOL_VERSION) {
        issues.push(issue(joinPath("supportedProtocolVersions", index), "UNSUPPORTED_VERSION", `Only protocol v${PROTOCOL_VERSION} is supported.`));
      } else {
        supportedProtocolVersions.push(PROTOCOL_VERSION);
      }
    });
    if (new Set(supportedProtocolVersions).size !== supportedProtocolVersions.length) {
      issues.push(issue("supportedProtocolVersions", "DUPLICATE_VERSION", "Protocol versions must be unique."));
    }
  }
  const membershipEpoch = readCounter(record, "membershipEpoch", "$", issues);
  const highWater = appendResult(parseHighWaterVector(record.highWater), issues, "highWater");
  const canStoreOriginals = readBoolean(record, "canStoreOriginals", "$", issues);
  const availableStorageBytes = readByteCount(record, "availableStorageBytes", "$", issues, 0);
  const maxChunkBytes = readNumber(record, "maxChunkBytes", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
    max: MAX_RESOURCE_CHUNK_BYTES,
  });
  if (issues.length > 0) return parseFailure(issues);
  return parseSuccess({
    memberId: memberId!,
    deviceId: deviceId!,
    displayName: displayName!,
    identityPublicKey: identityPublicKey!,
    admissionInviteLink: admissionInviteLink!,
    supportedProtocolVersions,
    membershipEpoch: membershipEpoch!,
    highWater: highWater!,
    canStoreOriginals: canStoreOriginals!,
    availableStorageBytes: availableStorageBytes!,
    maxChunkBytes: maxChunkBytes!,
  });
}

export function parseSyncRequestMessage(value: unknown): ParseResult<SyncRequestMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["requestId", "knownHighWater", "maxOperations", "includeCatalogSnapshot"], "$", issues);
  const requestId = appendResult(parseRequestId(record.requestId), issues, "requestId");
  const knownHighWater = appendResult(
    parseHighWaterVector(record.knownHighWater),
    issues,
    "knownHighWater",
  );
  const maxOperations = readNumber(record, "maxOperations", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 1,
    max: MAX_OPERATION_BATCH_SIZE,
  });
  const includeCatalogSnapshot = readBoolean(
    record,
    "includeCatalogSnapshot",
    "$",
    issues,
  );
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        requestId: requestId!,
        knownHighWater: knownHighWater!,
        maxOperations: maxOperations!,
        includeCatalogSnapshot: includeCatalogSnapshot!,
      });
}

export function parseOperationBatchMessage(
  value: unknown,
): ParseResult<OperationBatchMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["requestId", "batchSequence", "operations", "senderHighWater", "hasMore"], "$", issues);
  const requestId = appendResult(parseRequestId(record.requestId), issues, "requestId");
  const batchSequence = readPositiveCounter(record, "batchSequence", "$", issues);
  const operationValues = readArray(record, "operations", "$", issues, {
    maxLength: MAX_OPERATION_BATCH_SIZE,
  });
  const operations: SyncOperation[] = [];
  if (operationValues !== undefined) {
    operationValues.forEach((candidate, index) => {
      const operation = appendResult(
        parseSyncOperation(candidate),
        issues,
        joinPath("operations", index),
      );
      if (operation !== undefined) operations.push(operation);
    });
  }
  const senderHighWater = appendResult(
    parseHighWaterVector(record.senderHighWater),
    issues,
    "senderHighWater",
  );
  const hasMore = readBoolean(record, "hasMore", "$", issues);
  if (issues.length > 0) return parseFailure(issues);
  return parseSuccess({
    requestId: requestId!,
    batchSequence: batchSequence!,
    operations,
    senderHighWater: senderHighWater!,
    hasMore: hasMore!,
  });
}

export function parseAckMessage(value: unknown): ParseResult<AckMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["acknowledgedMessageId", "status", "highWater", "errorCode"], "$", issues);
  const acknowledgedMessageId = appendResult(
    parseMessageId(record.acknowledgedMessageId),
    issues,
    "acknowledgedMessageId",
  );
  const status = readEnum(record, "status", ACK_STATUSES, "$", issues);
  const highWater = appendResult(parseHighWaterVector(record.highWater), issues, "highWater");
  const errorCode = readNullableErrorCode(record, "errorCode", issues);
  if (status === "REJECTED" && errorCode === null) {
    issues.push(issue("errorCode", "REQUIRED", "Rejected ACK requires an error code."));
  }
  if (status !== undefined && status !== "REJECTED" && errorCode !== null && errorCode !== undefined) {
    issues.push(issue("errorCode", "UNEXPECTED_ERROR", "Accepted or duplicate ACK cannot have an error code."));
  }
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        acknowledgedMessageId: acknowledgedMessageId!,
        status: status!,
        highWater: highWater!,
        errorCode: errorCode!,
      });
}

export function parseResourceRequestMessage(
  value: unknown,
): ParseResult<ResourceRequestMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["requestId", "mediaId", "resourceId", "expectedSha256", "startOffset", "priority"], "$", issues);
  const requestId = appendResult(parseRequestId(record.requestId), issues, "requestId");
  const mediaId = appendResult(parseMediaId(record.mediaId), issues, "mediaId");
  const resourceId = appendResult(parseResourceId(record.resourceId), issues, "resourceId");
  const expectedSha256 = appendResult(
    parseSha256Hex(record.expectedSha256),
    issues,
    "expectedSha256",
  );
  const startOffset = readByteCount(record, "startOffset", "$", issues, 0);
  const priority = readEnum(record, "priority", RESOURCE_PRIORITIES, "$", issues);
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        requestId: requestId!,
        mediaId: mediaId!,
        resourceId: resourceId!,
        expectedSha256: expectedSha256!,
        startOffset: startOffset!,
        priority: priority!,
      });
}

export function parseResourceOfferMessage(
  value: unknown,
): ParseResult<ResourceOfferMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["requestId", "accepted", "transferId", "resource", "chunkSize", "rejectionCode"], "$", issues);
  const requestId = appendResult(parseRequestId(record.requestId), issues, "requestId");
  const accepted = readBoolean(record, "accepted", "$", issues);
  const transferId = parseNullable(record, "transferId", parseTransferId, issues);
  const resource = parseNullable(record, "resource", parseMediaResource, issues);
  const chunkSize = readRequiredNullableNumber(record, "chunkSize", issues, {
    min: 1,
    max: MAX_RESOURCE_CHUNK_BYTES,
  });
  const rejectionCode = readNullableErrorCode(record, "rejectionCode", issues);
  if (accepted === true) {
    if (transferId === null || resource === null || chunkSize === null || rejectionCode !== null) {
      issues.push(issue("accepted", "INVALID_OFFER", "Accepted offer requires transfer, resource, and chunk size only."));
    }
  } else if (accepted === false) {
    if (transferId !== null || resource !== null || chunkSize !== null || rejectionCode === null) {
      issues.push(issue("accepted", "INVALID_OFFER", "Rejected offer requires only a rejection code."));
    }
  }
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        requestId: requestId!,
        accepted: accepted!,
        transferId: transferId!,
        resource: resource!,
        chunkSize: chunkSize!,
        rejectionCode: rejectionCode!,
      });
}

export function parseResourceChunkMessage(
  value: unknown,
): ParseResult<ResourceChunkMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["transferId", "resourceId", "chunkIndex", "offset", "bytes", "chunkSha256"], "$", issues);
  const transferId = appendResult(parseTransferId(record.transferId), issues, "transferId");
  const resourceId = appendResult(parseResourceId(record.resourceId), issues, "resourceId");
  const chunkIndex = readCounter(record, "chunkIndex", "$", issues);
  const offset = readByteCount(record, "offset", "$", issues, 0);
  const bytes = readUint8Array(record, "bytes", "$", issues, {
    minLength: 1,
    maxLength: MAX_RESOURCE_CHUNK_BYTES,
  });
  const chunkSha256 = appendResult(
    parseSha256Hex(record.chunkSha256),
    issues,
    "chunkSha256",
  );
  if (
    offset !== undefined &&
    bytes !== undefined &&
    !Number.isSafeInteger(offset + bytes.byteLength)
  ) {
    issues.push(issue("offset", "BYTE_RANGE_OVERFLOW", "Chunk byte range exceeds the safe integer limit."));
  }
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        transferId: transferId!,
        resourceId: resourceId!,
        chunkIndex: chunkIndex!,
        offset: offset!,
        bytes: bytes!,
        chunkSha256: chunkSha256!,
      });
}

export function parseResourceCompleteMessage(
  value: unknown,
): ParseResult<ResourceCompleteMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["transferId", "resourceId", "status", "byteLength", "sha256", "errorCode"], "$", issues);
  const transferId = appendResult(parseTransferId(record.transferId), issues, "transferId");
  const resourceId = appendResult(parseResourceId(record.resourceId), issues, "resourceId");
  const status = readEnum(
    record,
    "status",
    RESOURCE_COMPLETION_STATUSES,
    "$",
    issues,
  );
  const byteLength = readByteCount(record, "byteLength", "$", issues, 1);
  const sha256 = appendResult(parseSha256Hex(record.sha256), issues, "sha256");
  const errorCode = readNullableErrorCode(record, "errorCode", issues);
  if ((status === "RECEIVER_REJECTED" || status === "SENDER_REJECTED") && errorCode === null) {
    issues.push(issue("errorCode", "REQUIRED", "Rejected completion requires an error code."));
  }
  if (
    status !== undefined &&
    status !== "RECEIVER_REJECTED" &&
    status !== "SENDER_REJECTED" &&
    errorCode !== null &&
    errorCode !== undefined
  ) {
    issues.push(issue("errorCode", "UNEXPECTED_ERROR", "Successful completion cannot include an error code."));
  }
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        transferId: transferId!,
        resourceId: resourceId!,
        status: status!,
        byteLength: byteLength!,
        sha256: sha256!,
        errorCode: errorCode!,
      });
}

export function parseHeartbeatMessage(value: unknown): ParseResult<HeartbeatMessage> {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(value, "$", issues);
  if (record === undefined) return parseFailure(issues);
  rejectUnknownKeys(record, ["highWater", "peerState", "availableStorageBytes", "activeTransferCount"], "$", issues);
  const highWater = appendResult(parseHighWaterVector(record.highWater), issues, "highWater");
  const peerState = readEnum(record, "peerState", PEER_STATES, "$", issues);
  const availableStorageBytes = readByteCount(record, "availableStorageBytes", "$", issues, 0);
  const activeTransferCount = readNumber(record, "activeTransferCount", "$", issues, {
    integer: true,
    safeInteger: true,
    min: 0,
    max: MAX_ACTIVE_TRANSFERS,
  });
  return issues.length > 0
    ? parseFailure(issues)
    : parseSuccess({
        highWater: highWater!,
        peerState: peerState!,
        availableStorageBytes: availableStorageBytes!,
        activeTransferCount: activeTransferCount!,
      });
}

function prefixPayloadFailure<T>(result: ParseResult<T>): ParseResult<never> {
  if (result.ok) {
    return parseFailure([issue("payload", "INTERNAL_ERROR", "Expected parser failure.")]);
  }
  return parseFailure(
    result.issues.map((entry) => ({
      ...entry,
      path: entry.path === "$" ? "payload" : `payload.${entry.path}`,
    })),
  );
}

function readTimestamp(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  return readNumber(record, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 0,
  });
}

function readCounter(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  return readNumber(record, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 0,
  });
}

function readPositiveCounter(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  return readNumber(record, key, path, issues, {
    integer: true,
    safeInteger: true,
    min: 1,
  });
}

function readByteCount(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  min: number,
): number | undefined {
  return readNumber(record, key, path, issues, {
    integer: true,
    safeInteger: true,
    min,
  });
}

function parseNullable<T>(
  record: UnknownRecord,
  key: string,
  parser: (candidate: unknown) => ParseResult<T>,
  issues: ValidationIssue[],
): T | null | undefined {
  if (!hasOwn(record, key)) {
    issues.push(issue(key, "REQUIRED", "Field is required."));
    return undefined;
  }
  if (record[key] === null) return null;
  return appendResult(parser(record[key]), issues, key);
}

function readRequiredNullableNumber(
  record: UnknownRecord,
  key: string,
  issues: ValidationIssue[],
  range: { readonly min: number; readonly max: number },
): number | null | undefined {
  if (!hasOwn(record, key)) {
    issues.push(issue(key, "REQUIRED", "Field is required."));
    return undefined;
  }
  if (record[key] === null) return null;
  return readNumber(record, key, "$", issues, {
    integer: true,
    safeInteger: true,
    min: range.min,
    max: range.max,
  });
}

function readRequiredNullableString(
  record: UnknownRecord,
  key: string,
  issues: ValidationIssue[],
  maxLength: number,
): string | null | undefined {
  if (!hasOwn(record, key)) {
    issues.push(issue(key, "REQUIRED", "Field is required."));
    return undefined;
  }
  if (record[key] === null) return null;
  return readString(record, key, "$", issues, {
    minLength: 1,
    maxLength,
    requireTrimmed: true,
  });
}

function readNullableErrorCode(
  record: UnknownRecord,
  key: string,
  issues: ValidationIssue[],
): string | null | undefined {
  if (!hasOwn(record, key)) {
    issues.push(issue(key, "REQUIRED", "Field is required."));
    return undefined;
  }
  if (record[key] === null) return null;
  return readString(record, key, "$", issues, {
    minLength: 1,
    maxLength: 64,
    pattern: /^[A-Z][A-Z0-9_]*$/,
  });
}
