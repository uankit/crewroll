import { Kind, Type, type Static } from "@sinclair/typebox";

import {
  ClosedObject,
  DateTimeSchema,
  IanaTimeZoneSchema,
  InviteCodeSchema,
  KeyEnvelopeSchema,
  LocalTimeSchema,
  X25519PublicKeySchema,
} from "./common.js";
import { MembershipStatusSchema, TripStatusSchema } from "./enums.js";
import { DeviceIdSchema, MembershipIdSchema, TripIdSchema } from "./ids.js";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const TRIP_CREATE_DEFAULT_DURATION_MS = DAY_IN_MILLISECONDS;
export const TRIP_CREATE_MAX_DURATION_MS = 14 * DAY_IN_MILLISECONDS;

export const ImmediateReleaseSchema = ClosedObject({
  mode: Type.Literal("IMMEDIATE"),
});
export const NightlyReleaseSchema = ClosedObject({
  mode: Type.Literal("NIGHTLY"),
  timeZone: IanaTimeZoneSchema,
  localTime: LocalTimeSchema,
});
export const ReleaseSchema = Type.Union([
  ImmediateReleaseSchema,
  NightlyReleaseSchema,
]);

export const TripNameSchema = Type.Unsafe<string>({
  [Kind]: "TemplateLiteral",
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern:
    "^(?:(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])|[^\\uD800-\\uDFFF]){1,80}$",
});

export const CreateTripBodySchema = ClosedObject({
  tripId: TripIdSchema,
  name: TripNameSchema,
  inviteCode: InviteCodeSchema,
  release: ReleaseSchema,
  endsAt: DateTimeSchema,
  ownerDeviceId: DeviceIdSchema,
  ownerKeyEnvelope: KeyEnvelopeSchema,
});
export type CreateTripBody = Static<typeof CreateTripBodySchema>;

export const CreateTripOutcomeBodySchema = ClosedObject({
  tripId: TripIdSchema,
});
export type CreateTripOutcomeBody = Static<typeof CreateTripOutcomeBodySchema>;

export const NominatedDeviceKeySchema = ClosedObject({
  deviceId: DeviceIdSchema,
  e2eeKeyAlgorithm: Type.Literal("X25519"),
  e2eePublicKey: X25519PublicKeySchema,
  e2eeKeyVersion: Type.Literal(1),
});
export type NominatedDeviceKey = Static<typeof NominatedDeviceKeySchema>;

export const TripReadinessSchema = ClosedObject({
  fullPhotoLibraryAccess: Type.Boolean(),
});
export type TripReadiness = Static<typeof TripReadinessSchema>;

export const SetTripReadinessBodySchema = TripReadinessSchema;
export type SetTripReadinessBody = Static<typeof SetTripReadinessBodySchema>;

export const TripMemberSchema = ClosedObject({
  membershipId: MembershipIdSchema,
  role: Type.Union([Type.Literal("OWNER"), Type.Literal("MEMBER")]),
  displayName: Type.String({ minLength: 1, maxLength: 80 }),
  status: Type.Union([Type.Literal("PENDING_KEY"), Type.Literal("ACTIVE")]),
  readiness: TripReadinessSchema,
  nominatedDevice: Type.Union([NominatedDeviceKeySchema, Type.Null()]),
});

export const TripResponseSchema = ClosedObject({
  id: TripIdSchema,
  version: Type.Integer({ minimum: 1 }),
  name: TripNameSchema,
  status: TripStatusSchema,
  release: ReleaseSchema,
  startsAt: Type.Union([DateTimeSchema, Type.Null()]),
  endsAt: DateTimeSchema,
  ownerDeviceId: DeviceIdSchema,
  currentMembershipId: MembershipIdSchema,
  keyEpoch: Type.Literal(1),
  tripKeyEnvelope: Type.Union([KeyEnvelopeSchema, Type.Null()]),
  members: Type.Array(TripMemberSchema, { minItems: 1, maxItems: 10 }),
});
export type TripResponse = Static<typeof TripResponseSchema>;

export const CreateTripOutcomeResponseSchema = Type.Union([
  ClosedObject({
    outcome: Type.Literal("COMMITTED"),
    trip: TripResponseSchema,
  }),
  ClosedObject({ outcome: Type.Literal("TERMINAL_NOT_COMMITTED") }),
  ClosedObject({ outcome: Type.Literal("STILL_UNKNOWN") }),
]);
export type CreateTripOutcomeResponse = Static<
  typeof CreateTripOutcomeResponseSchema
>;

export const InviteResponseSchema = ClosedObject({
  tripId: TripIdSchema,
  expiresAt: DateTimeSchema,
});
export type InviteResponse = Static<typeof InviteResponseSchema>;

export const InvitePreviewBodySchema = ClosedObject({
  inviteCode: InviteCodeSchema,
});
export type InvitePreviewBody = Static<typeof InvitePreviewBodySchema>;
export const InvitePreviewResponseSchema = ClosedObject({
  tripId: TripIdSchema,
  name: TripNameSchema,
  startsAt: Type.Union([DateTimeSchema, Type.Null()]),
  endsAt: DateTimeSchema,
  hostDisplayName: Type.String({ minLength: 1, maxLength: 80 }),
  members: Type.Array(
    ClosedObject({
      displayName: Type.String({ minLength: 1, maxLength: 80 }),
      role: Type.Union([Type.Literal("OWNER"), Type.Literal("MEMBER")]),
    }),
    { minItems: 1, maxItems: 10 },
  ),
});
export type InvitePreviewResponse = Static<typeof InvitePreviewResponseSchema>;

export const CreateJoinRequestBodySchema = ClosedObject({
  inviteCode: InviteCodeSchema,
  deviceId: DeviceIdSchema,
});
export type CreateJoinRequestBody = Static<typeof CreateJoinRequestBodySchema>;

export const MembershipResponseSchema = ClosedObject({
  membershipId: MembershipIdSchema,
  tripId: TripIdSchema,
  deviceId: DeviceIdSchema,
  status: MembershipStatusSchema,
  keyEpoch: Type.Literal(1),
  tripKeyEnvelope: Type.Union([KeyEnvelopeSchema, Type.Null()]),
});
export type MembershipResponse = Static<typeof MembershipResponseSchema>;

export const ApproveJoinRequestBodySchema = ClosedObject({
  keyEpoch: Type.Literal(1),
  algorithmVersion: Type.Literal(1),
  wrappedKey: KeyEnvelopeSchema.properties.wrappedKey,
});
export type ApproveJoinRequestBody = Static<
  typeof ApproveJoinRequestBodySchema
>;

export const StartTripBodySchema = ClosedObject({
  expectedVersion: Type.Integer({ minimum: 1 }),
});
export type StartTripBody = Static<typeof StartTripBodySchema>;

export const EndTripBodySchema = ClosedObject({
  expectedVersion: Type.Integer({ minimum: 1 }),
});
export type EndTripBody = Static<typeof EndTripBodySchema>;
