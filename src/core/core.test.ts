import {
  DOMAIN_SCHEMA_VERSION,
  FRAME_SECURITY_VERSION,
  INVITE_VERSION,
  PROTOCOL_VERSION,
} from "./constants";
import {
  parseMediaItem,
  parseMediaResource,
  parseMember,
  parseReplicaReceipt,
  parseSyncOperation,
  parseTrip,
  type ReplicaReceipt,
  type SyncOperation,
  type Trip,
} from "./domain";
import { assessResourceProtection } from "./invariants";
import {
  decodeInviteDeepLink,
  encodeInviteDeepLink,
  parseTripInvite,
} from "./invite";
import { parseProtocolEnvelope } from "./protocol";
import {
  applySyncOperation,
  computeMissingRanges,
  createEmptyCatalogState,
  highWaterToVector,
} from "./reconciliation";
import { parseSecureFrame } from "./security";
import type { ParseResult } from "./validation";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PUBLIC_KEY = "A".repeat(43);
const GROUP_SECRET = `${"B".repeat(42)}A`;

/** Dependency-free core smoke tests, invoked by the Vitest adapter in CI. */
export function runCoreTests(): void {
  testStrictDomainParsing();
  testInviteRoundTripAndExpiry();
  testBinaryChunkContract();
  testSecureFrameContract();
  testIdempotencyAndContiguousHighWater();
  testTripStatusOperation();
  testMemberMayLeaveItself();
  testPhasedMediaPublication();
  testReplicaAssessmentCountsDistinctDevices();
}

function testStrictDomainParsing(): void {
  const trip = makeTrip("trip_0001");
  const unknownField = parseTrip({ ...trip, surprise: true });
  assert(!unknownField.ok, "Domain parser must reject unknown fields.");

  const wrongVersion = parseTrip({ ...trip, schemaVersion: 2 });
  assert(!wrongVersion.ok, "Domain parser must reject unknown schema versions.");
}

function testInviteRoundTripAndExpiry(): void {
  const invite = mustParse(
    parseTripInvite({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      inviteVersion: INVITE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      tripId: "trip_0001",
      inviteId: "invite_001",
      inviterMemberId: "member_001",
      inviterDeviceId: "device_001",
      inviterIdentityPublicKey: PUBLIC_KEY,
      membershipEpoch: 1,
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
      signature: "A".repeat(86),
      groupSecret: GROUP_SECRET,
      endpointHint: "nearby:host_001",
    }),
  );
  const encoded = encodeInviteDeepLink(invite);
  const decoded = decodeInviteDeepLink(encoded, { nowMs: 2_000 });
  assert(decoded.ok, "Canonical invite must round-trip.");
  if (decoded.ok) {
    assert(decoded.value.groupSecret === invite.groupSecret, "Invite secret changed in codec.");
  }
  assert(!encoded.includes("code="), "New invites must not contain a trip code.");

  const expired = decodeInviteDeepLink(encoded, { nowMs: 61_000 });
  assert(!expired.ok, "Expired invite must be rejected for joining.");

  const duplicated = decodeInviteDeepLink(`${encoded}&trip=trip_9999`);
  assert(!duplicated.ok, "Duplicate query parameters must be rejected.");

  const retiredCode = decodeInviteDeepLink(`${encoded}&code=ABCD23`);
  assert(!retiredCode.ok, "Retired trip-code parameters must be rejected.");
}

function testBinaryChunkContract(): void {
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "message_001",
    tripId: "trip_0001",
    senderMemberId: "member_001",
    senderDeviceId: "device_001",
    membershipEpoch: 1,
    senderMessageSequence: 1,
    sentAtMs: 2_000,
    type: "RESOURCE_CHUNK",
    payload: {
      transferId: "transfer_01",
      resourceId: "resource_01",
      chunkIndex: 0,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
      chunkSha256: HASH_A,
    },
  };
  assert(parseProtocolEnvelope(envelope).ok, "Uint8Array resource chunk must parse.");
  assert(
    !parseProtocolEnvelope({
      ...envelope,
      payload: { ...envelope.payload, bytes: "AQID" },
    }).ok,
    "Base64/string resource chunks must be rejected.",
  );
}

function testSecureFrameContract(): void {
  const frame = {
    securityVersion: FRAME_SECURITY_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    tripId: "trip_0001",
    senderDeviceId: "device_001",
    keyId: "key_00001",
    keyEpoch: 1,
    senderCounter: 1,
    cipherSuite: "XCHACHA20_POLY1305",
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array([1]),
    authenticationTag: new Uint8Array(16),
  };
  assert(parseSecureFrame(frame).ok, "XChaCha20-Poly1305 frame must parse.");
  assert(
    !parseSecureFrame({ ...frame, nonce: new Uint8Array(12) }).ok,
    "Non-24-byte XChaCha nonce must be rejected.",
  );
}

function testIdempotencyAndContiguousHighWater(): void {
  let state = createEmptyCatalogState();
  const operationOne = makeTripOperation("operation_01", "device_001", 1, makeTrip("trip_0001"));
  const first = applySyncOperation(state, operationOne);
  assert(first.disposition === "APPLIED", "First operation must apply.");
  state = first.state;
  const duplicate = applySyncOperation(state, operationOne);
  assert(duplicate.disposition === "DUPLICATE", "Repeated operation must be idempotent.");

  const sequenceConflict = applySyncOperation(
    state,
    makeTripOperation("operation_02", "device_001", 1, makeTrip("trip_0002")),
  );
  assert(sequenceConflict.disposition === "REJECTED", "Sequence reuse must be rejected.");

  const gapFirst = applySyncOperation(
    state,
    makeTripOperation("operation_12", "device_002", 2, makeTrip("trip_0012")),
  );
  assert(gapFirst.disposition === "APPLIED", "Out-of-order operation must be retained.");
  assert(
    highWaterToVector(gapFirst.state.highWater).device_002 === 0,
    "High-water must not skip a missing sequence.",
  );
  const fillGap = applySyncOperation(
    gapFirst.state,
    makeTripOperation("operation_11", "device_002", 1, makeTrip("trip_0011")),
  );
  assert(fillGap.disposition === "APPLIED", "Missing operation must apply.");
  assert(
    highWaterToVector(fillGap.state.highWater).device_002 === 2,
    "High-water must advance through contiguous pending sequences.",
  );

  const ranges = computeMissingRanges(
    { device_001: 1 },
    { device_001: 3, device_002: 2 },
  );
  assert(ranges.length === 2, "Reconciliation must request every missing origin range.");
  assert(ranges[0]?.fromSequenceInclusive === 2, "Missing range start is incorrect.");
}

function testReplicaAssessmentCountsDistinctDevices(): void {
  const resource = mustParse(
    parseMediaResource({
      schemaVersion: 1,
      id: "resource_01",
      tripId: "trip_0001",
      mediaId: "media_0001",
      kind: "ORIGINAL",
      mimeType: "image/heic",
      fileExtension: "heic",
      byteLength: 4_000_000,
      sha256: HASH_A,
      width: 4_000,
      height: 3_000,
      createdAtMs: 1_000,
    }),
  );
  const receipts = [
    makeReceipt("receipt_01", "member_001", "device_001", HASH_A),
    makeReceipt("receipt_02", "member_001", "device_001", HASH_A),
    makeReceipt("receipt_03", "member_002", "device_002", HASH_A),
    makeReceipt("receipt_04", "member_003", "device_003", HASH_B),
  ];
  const assessment = assessResourceProtection(resource, receipts, 3);
  assert(assessment.verifiedReplicaCount === 2, "Duplicate devices or wrong hashes must not inflate replicas.");
  assert(!assessment.isTripSafe, "Two distinct verified copies cannot satisfy target three.");
  assert(assessment.invalidReceiptIds.length === 1, "Bad receipt must be reported.");
}

function testTripStatusOperation(): void {
  const trip = makeTrip("trip_0100");
  let state = applySyncOperation(
    createEmptyCatalogState(),
    makeTripOperation("operation_100", "device_001", 1, trip),
  ).state;
  const member = mustParse(
    parseMember({
      schemaVersion: 1,
      id: "member_001",
      tripId: trip.id,
      deviceId: "device_001",
      displayName: "Ankit",
      identityPublicKey: PUBLIC_KEY,
      role: "ADMIN",
      status: "ACTIVE",
      replicaRole: "KEEPER_PRIMARY",
      joinedAtMs: 1_000,
      updatedAtMs: 1_000,
      leftAtMs: null,
      membershipEpoch: 1,
    }),
  );
  state = applySyncOperation(
    state,
    mustParse(
      parseSyncOperation({
        schemaVersion: 1,
        operationId: "operation_101",
        tripId: trip.id,
        originDeviceId: "device_001",
        originSequence: 2,
        actorMemberId: member.id,
        membershipEpoch: 1,
        createdAtMs: 1_100,
        kind: "MEMBER_JOINED",
        payload: { member },
      }),
    ),
  ).state;
  const activate = mustParse(
    parseSyncOperation({
      schemaVersion: 1,
      operationId: "operation_102",
      tripId: trip.id,
      originDeviceId: "device_001",
      originSequence: 3,
      actorMemberId: member.id,
      membershipEpoch: 1,
      createdAtMs: 2_000,
      kind: "TRIP_STATUS_CHANGED",
      payload: { trip: { ...trip, status: "ACTIVE", updatedAtMs: 2_000 } },
    }),
  );
  const activated = applySyncOperation(state, activate);
  assert(activated.disposition === "APPLIED", "Admin must be able to activate a draft trip.");
  const forged = mustParse(
    parseSyncOperation({
      ...activate,
      operationId: "operation_unauthorized",
      originDeviceId: "device_999",
      actorMemberId: "member_999",
      originSequence: 1,
      createdAtMs: 2_500,
      payload: { trip: { ...trip, status: "PAUSED", updatedAtMs: 2_500 } },
    }),
  );
  assert(
    applySyncOperation(activated.state, forged).disposition === "REJECTED",
    "An unknown actor must not change trip state even when it has the group key.",
  );
  const end = mustParse(
    parseSyncOperation({
      ...activate,
      operationId: "operation_103",
      originSequence: 4,
      createdAtMs: 3_000,
      payload: {
        trip: { ...trip, status: "ENDED", endsAtMs: 3_000, updatedAtMs: 3_000 },
      },
    }),
  );
  const ended = applySyncOperation(activated.state, end);
  assert(
    ended.disposition === "APPLIED",
    "Admin must be able to set the trip end time while ending the trip.",
  );
  const regress = mustParse(
    parseSyncOperation({
      ...activate,
      operationId: "operation_104",
      originSequence: 5,
      createdAtMs: 4_000,
      payload: { trip: { ...trip, status: "DRAFT", updatedAtMs: 4_000 } },
    }),
  );
  assert(
    applySyncOperation(ended.state, regress).disposition === "REJECTED",
    "Trip status must not transition backward.",
  );
}

function testMemberMayLeaveItself(): void {
  const trip = makeTrip("trip_leave");
  let state = applySyncOperation(
    createEmptyCatalogState(),
    makeTripOperation("operation_leave_1", "device_001", 1, trip),
  ).state;
  const admin = mustParse(
    parseMember({
      schemaVersion: 1,
      id: "member_001",
      tripId: trip.id,
      deviceId: "device_001",
      displayName: "Host",
      identityPublicKey: PUBLIC_KEY,
      role: "ADMIN",
      status: "ACTIVE",
      replicaRole: "KEEPER_PRIMARY",
      joinedAtMs: 1_000,
      updatedAtMs: 1_000,
      leftAtMs: null,
      membershipEpoch: 1,
    }),
  );
  state = applySyncOperation(
    state,
    mustParse(parseSyncOperation({
      schemaVersion: 1,
      operationId: "operation_leave_2",
      tripId: trip.id,
      originDeviceId: admin.deviceId,
      originSequence: 2,
      actorMemberId: admin.id,
      membershipEpoch: 1,
      createdAtMs: 1_100,
      kind: "MEMBER_JOINED",
      payload: { member: admin },
    })),
  ).state;
  const member = mustParse(
    parseMember({
      schemaVersion: 1,
      id: "member_002",
      tripId: trip.id,
      deviceId: "device_002",
      displayName: "Friend",
      identityPublicKey: `${"C".repeat(42)}A`,
      role: "MEMBER",
      status: "ACTIVE",
      replicaRole: "NONE",
      joinedAtMs: 1_200,
      updatedAtMs: 1_200,
      leftAtMs: null,
      membershipEpoch: 1,
    }),
  );
  state = applySyncOperation(
    state,
    mustParse(parseSyncOperation({
      schemaVersion: 1,
      operationId: "operation_leave_3",
      tripId: trip.id,
      originDeviceId: admin.deviceId,
      originSequence: 3,
      actorMemberId: admin.id,
      membershipEpoch: 1,
      createdAtMs: 1_200,
      kind: "MEMBER_JOINED",
      payload: { member },
    })),
  ).state;

  const forgedOtherLeave = mustParse(parseSyncOperation({
    schemaVersion: 1,
    operationId: "operation_leave_forged",
    tripId: trip.id,
    originDeviceId: member.deviceId,
    originSequence: 1,
    actorMemberId: member.id,
    membershipEpoch: 1,
    createdAtMs: 1_300,
    kind: "MEMBER_STATUS_CHANGED",
    payload: {
      member: { ...admin, status: "LEFT", leftAtMs: 1_300, updatedAtMs: 1_300 },
    },
  }));
  assert(
    applySyncOperation(state, forgedOtherLeave).disposition === "REJECTED",
    "A regular member must not change another member's status.",
  );

  const selfLeave = mustParse(parseSyncOperation({
    schemaVersion: 1,
    operationId: "operation_leave_self",
    tripId: trip.id,
    originDeviceId: member.deviceId,
    originSequence: 1,
    actorMemberId: member.id,
    membershipEpoch: 1,
    createdAtMs: 1_300,
    kind: "MEMBER_STATUS_CHANGED",
    payload: {
      member: { ...member, status: "LEFT", leftAtMs: 1_300, updatedAtMs: 1_300 },
    },
  }));
  const applied = applySyncOperation(state, selfLeave);
  assert(applied.disposition === "APPLIED", "An ACTIVE member must be able to leave itself.");
}

function testPhasedMediaPublication(): void {
  const trip = makeTrip("trip_phased_media");
  let state = applySyncOperation(
    createEmptyCatalogState(),
    makeTripOperation("operation_phased_1", "device_001", 1, trip),
  ).state;
  const admin = mustParse(parseMember({
    schemaVersion: 1,
    id: "member_001",
    tripId: trip.id,
    deviceId: "device_001",
    displayName: "Origin",
    identityPublicKey: PUBLIC_KEY,
    role: "ADMIN",
    status: "ACTIVE",
    replicaRole: "KEEPER_PRIMARY",
    joinedAtMs: 1_000,
    updatedAtMs: 1_000,
    leftAtMs: null,
    membershipEpoch: 1,
  }));
  state = applySyncOperation(state, mustParse(parseSyncOperation({
    schemaVersion: 1,
    operationId: "operation_phased_2",
    tripId: trip.id,
    originDeviceId: admin.deviceId,
    originSequence: 2,
    actorMemberId: admin.id,
    membershipEpoch: 1,
    createdAtMs: 1_100,
    kind: "MEMBER_JOINED",
    payload: { member: admin },
  }))).state;
  const item = mustParse(parseMediaItem({
    schemaVersion: 1,
    id: "media_phased_1",
    tripId: trip.id,
    originMemberId: admin.id,
    originDeviceId: admin.deviceId,
    originSequence: 1,
    source: "SYSTEM_LIBRARY",
    mediaType: "IMAGE",
    shareStatus: "PUBLISHED",
    capturedAtMs: 1_200,
    captureTimeZoneOffsetMinutes: 330,
    captureLocalDate: "2026-07-25",
    ingestedAtMs: 1_300,
    publishedAtMs: 1_300,
    tombstonedAtMs: null,
    location: null,
    originalResourceId: "resource_phased_original",
    thumbnailResourceId: "resource_phased_thumbnail",
  }));
  const thumbnail = mustParse(parseMediaResource({
    schemaVersion: 1,
    id: item.thumbnailResourceId,
    tripId: trip.id,
    mediaId: item.id,
    kind: "THUMBNAIL",
    mimeType: "image/jpeg",
    fileExtension: "jpg",
    byteLength: 4,
    sha256: HASH_A,
    width: 120,
    height: 90,
    createdAtMs: 1_300,
  }));
  const preview = mustParse(parseSyncOperation({
    schemaVersion: 1,
    operationId: "operation_phased_preview",
    tripId: trip.id,
    originDeviceId: admin.deviceId,
    originSequence: 3,
    actorMemberId: admin.id,
    membershipEpoch: 1,
    createdAtMs: 1_300,
    kind: "MEDIA_PREVIEW_PUBLISHED",
    payload: { item, resources: [thumbnail] },
  }));
  const previewApplied = applySyncOperation(state, preview);
  assert(previewApplied.disposition === "APPLIED", "Preview publication must apply independently.");
  assert(
    previewApplied.state.resources.has(thumbnail.id) &&
      !previewApplied.state.resources.has(item.originalResourceId),
    "Preview publication must expose only the thumbnail manifest.",
  );
  const original = mustParse(parseMediaResource({
    schemaVersion: 1,
    id: item.originalResourceId,
    tripId: trip.id,
    mediaId: item.id,
    kind: "ORIGINAL",
    mimeType: "image/jpeg",
    fileExtension: "jpg",
    byteLength: 40,
    sha256: HASH_B,
    width: 4_000,
    height: 3_000,
    createdAtMs: 1_300,
  }));
  const attach = mustParse(parseSyncOperation({
    schemaVersion: 1,
    operationId: "operation_phased_original",
    tripId: trip.id,
    originDeviceId: admin.deviceId,
    originSequence: 4,
    actorMemberId: admin.id,
    membershipEpoch: 1,
    createdAtMs: 1_400,
    kind: "MEDIA_ORIGINAL_PUBLISHED",
    payload: { mediaId: item.id, resource: original },
  }));
  const attached = applySyncOperation(previewApplied.state, attach);
  assert(attached.disposition === "APPLIED", "Matching original manifest must attach later.");
  assert(attached.state.resources.has(original.id), "Attached original manifest must enter catalog.");
  const wrongOriginal = mustParse(parseMediaResource({
    ...original,
    id: "resource_phased_wrong",
  }));
  const wrongAttach = mustParse(parseSyncOperation({
    ...attach,
    operationId: "operation_phased_wrong",
    originSequence: 5,
    payload: { mediaId: item.id, resource: wrongOriginal },
  }));
  assert(
    applySyncOperation(attached.state, wrongAttach).disposition === "REJECTED",
    "An origin must not attach a different immutable original ID.",
  );
}

function makeTrip(id: string): Trip {
  return mustParse(
    parseTrip({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id,
      name: `Trip ${id}`,
      createdByMemberId: "member_001",
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      startsAtMs: 1_000,
      endsAtMs: null,
      timeZone: "Asia/Kolkata",
      status: "DRAFT",
      defaultSharingMode: "REVIEW_FIRST",
      locationSharingMode: "NONE",
      targetReplicaCount: 3,
      completeKeeperCount: 0,
      membershipEpoch: 1,
    }),
  );
}

function makeTripOperation(
  operationId: string,
  originDeviceId: string,
  originSequence: number,
  trip: Trip,
): SyncOperation {
  return mustParse(
    parseSyncOperation({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      operationId,
      tripId: trip.id,
      originDeviceId,
      originSequence,
      actorMemberId: trip.createdByMemberId,
      membershipEpoch: trip.membershipEpoch,
      createdAtMs: 1_000 + originSequence,
      kind: "TRIP_CREATED",
      payload: { trip },
    }),
  );
}

function makeReceipt(
  id: string,
  holderMemberId: string,
  holderDeviceId: string,
  hash: string,
): ReplicaReceipt {
  return mustParse(
    parseReplicaReceipt({
      schemaVersion: 1,
      id,
      tripId: "trip_0001",
      mediaId: "media_0001",
      resourceId: "resource_01",
      holderMemberId,
      holderDeviceId,
      resourceSha256: hash,
      resourceByteLength: 4_000_000,
      status: "VERIFIED",
      verifiedAtMs: 2_000,
      updatedAtMs: 2_000,
    }),
  );
}

function mustParse<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Fixture failed validation: ${result.issues
        .map((entry) => `${entry.path}:${entry.code}`)
        .join(", ")}`,
    );
  }
  return result.value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
