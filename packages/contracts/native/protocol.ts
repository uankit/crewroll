import { Type, type Static } from "@sinclair/typebox";

import {
  BackgroundBearerV1Schema,
  ClosedObject,
  DateTimeSchema,
  KeyEnvelopeSchema,
  OpaqueCursorSchema,
  P256PublicKeySchema,
  ProtocolVersionSchema,
  UriSchema,
  X25519PublicKeySchema,
} from "../openapi/common.js";
import {
  AssetIdSchema,
  DeviceIdSchema,
  MembershipIdSchema,
  TripIdSchema,
  UuidSchema,
} from "../openapi/ids.js";

export const NativeDeviceIdentitySchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  installationId: Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" }),
  authenticationKeyAlgorithm: Type.Literal("P-256"),
  authenticationPublicKey: P256PublicKeySchema,
  authenticationKeyVersion: Type.Literal(1),
  e2eeKeyAlgorithm: Type.Literal("X25519"),
  e2eePublicKey: X25519PublicKeySchema,
  e2eeKeyVersion: Type.Literal(1),
});
export type NativeDeviceIdentity = Static<typeof NativeDeviceIdentitySchema>;

export const InstallDeviceSessionCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  deviceId: DeviceIdSchema,
  backgroundBearer: BackgroundBearerV1Schema,
  backgroundBearerExpiresAt: DateTimeSchema,
  apiBaseUrl: UriSchema,
});
export type InstallDeviceSessionCommand = Static<
  typeof InstallDeviceSessionCommandSchema
>;

export const CreateTripKeyCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  keyEpoch: Type.Literal(1),
});
export type CreateTripKeyCommand = Static<typeof CreateTripKeyCommandSchema>;

export const CreateTripKeyResultSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  keyEpoch: Type.Literal(1),
});
export type CreateTripKeyResult = Static<typeof CreateTripKeyResultSchema>;

export const DiscardProvisionalTripKeyCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  keyEpoch: Type.Literal(1),
});
export type DiscardProvisionalTripKeyCommand = Static<
  typeof DiscardProvisionalTripKeyCommandSchema
>;

export const WrapTripKeyCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  keyEpoch: Type.Literal(1),
  recipientDeviceId: DeviceIdSchema,
  recipientE2eePublicKey: X25519PublicKeySchema,
  recipientE2eeKeyVersion: Type.Literal(1),
});
export type WrapTripKeyCommand = Static<typeof WrapTripKeyCommandSchema>;

export const WrapTripKeyResultSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  keyEpoch: Type.Literal(1),
  algorithmVersion: Type.Literal(1),
  senderDeviceId: DeviceIdSchema,
  recipientDeviceId: DeviceIdSchema,
  recipientE2eeKeyVersion: Type.Literal(1),
  wrappedKey: KeyEnvelopeSchema.properties.wrappedKey,
});
export type WrapTripKeyResult = Static<typeof WrapTripKeyResultSchema>;

export const ImportTripKeyCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  keyEpoch: Type.Literal(1),
  algorithmVersion: Type.Literal(1),
  expectedSenderDeviceId: DeviceIdSchema,
  recipientDeviceId: DeviceIdSchema,
  recipientE2eeKeyVersion: Type.Literal(1),
  wrappedKey: KeyEnvelopeSchema.properties.wrappedKey,
});
export type ImportTripKeyCommand = Static<typeof ImportTripKeyCommandSchema>;

export const ActivateTripCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
  membershipId: MembershipIdSchema,
  startsAt: DateTimeSchema,
  endsAt: DateTimeSchema,
  releaseAt: Type.Union([DateTimeSchema, Type.Null()]),
  keyEpoch: Type.Literal(1),
});
export type ActivateTripCommand = Static<typeof ActivateTripCommandSchema>;

export const DeactivateTripCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  tripId: TripIdSchema,
});
export type DeactivateTripCommand = Static<typeof DeactivateTripCommandSchema>;

export const SetTransferPolicyCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  paused: Type.Boolean(),
  cellularAllowed: Type.Boolean(),
});
export type SetTransferPolicyCommand = Static<
  typeof SetTransferPolicyCommandSchema
>;

export const ReconcileNowCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
});
export type ReconcileNowCommand = Static<typeof ReconcileNowCommandSchema>;

export const RetryCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  workId: UuidSchema,
});
export type RetryCommand = Static<typeof RetryCommandSchema>;

export const EngineBlockerSchema = Type.Union([
  Type.Literal("PHOTO_PERMISSION"),
  Type.Literal("STORAGE_FULL"),
  Type.Literal("AUTH_REVOKED"),
  Type.Literal("SOURCE_MISSING"),
  Type.Literal("INTEGRITY_FAILURE"),
  Type.Literal("KEY_ACCESS_LOCKED"),
  Type.Literal("KEY_MATERIAL_LOST"),
  Type.Literal("KEY_ENVELOPE_INVALID"),
]);

export const EngineCountsSchema = ClosedObject({
  discovered: Type.Integer({ minimum: 0 }),
  previewReady: Type.Integer({ minimum: 0 }),
  originalsSaved: Type.Integer({ minimum: 0 }),
  blocked: Type.Integer({ minimum: 0 }),
});

export const DurableEngineSnapshotSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  revision: Type.Integer({ minimum: 0 }),
  activeTripId: Type.Union([TripIdSchema, Type.Null()]),
  paused: Type.Boolean(),
  counts: EngineCountsSchema,
  blockers: Type.Array(EngineBlockerSchema, { uniqueItems: true }),
});
export type DurableEngineSnapshot = Static<typeof DurableEngineSnapshotSchema>;

const TransferStageSchema = Type.Union([
  Type.Literal("PENDING"),
  Type.Literal("STAGED"),
  Type.Literal("TRANSFERRING"),
  Type.Literal("TRANSFERRED"),
  Type.Literal("SAVED"),
]);

export const NativeAssetProjectionSchema = ClosedObject({
  workId: UuidSchema,
  assetId: Type.Union([AssetIdSchema, Type.Null()]),
  capturedAt: DateTimeSchema,
  previewStage: TransferStageSchema,
  originalStage: TransferStageSchema,
  blocker: Type.Union([EngineBlockerSchema, Type.Null()]),
});
export type NativeAssetProjection = Static<typeof NativeAssetProjectionSchema>;

export const ListAssetsQuerySchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  cursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
});
export type ListAssetsQuery = Static<typeof ListAssetsQuerySchema>;

export const AssetPageSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  revision: Type.Integer({ minimum: 0 }),
  items: Type.Array(NativeAssetProjectionSchema, { maxItems: 100 }),
  nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
});
export type AssetPage = Static<typeof AssetPageSchema>;

export const RevisionInvalidationSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal("ENGINE_INVALIDATED"),
  revision: Type.Integer({ minimum: 0 }),
});
export type RevisionInvalidation = Static<typeof RevisionInvalidationSchema>;
