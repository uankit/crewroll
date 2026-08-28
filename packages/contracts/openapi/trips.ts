import { Type, type Static } from "@sinclair/typebox";

import {
  ClosedObject,
  DateTimeSchema,
  IanaTimeZoneSchema,
  InviteCodeSchema,
  KeyEnvelopeSchema,
  LocalTimeSchema,
} from "./common.js";
import { MembershipStatusSchema, TripStatusSchema } from "./enums.js";
import { DeviceIdSchema, MembershipIdSchema, TripIdSchema } from "./ids.js";

export const ImmediateReleaseSchema = ClosedObject({ mode: Type.Literal("IMMEDIATE") });
export const NightlyReleaseSchema = ClosedObject({
  mode: Type.Literal("NIGHTLY"),
  timeZone: IanaTimeZoneSchema,
  localTime: LocalTimeSchema,
});
export const ReleaseSchema = Type.Union([ImmediateReleaseSchema, NightlyReleaseSchema]);

export const CreateTripBodySchema = ClosedObject({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  inviteCode: InviteCodeSchema,
  release: ReleaseSchema,
  endsAt: DateTimeSchema,
  ownerDeviceId: DeviceIdSchema,
  ownerKeyEnvelope: KeyEnvelopeSchema,
});
export type CreateTripBody = Static<typeof CreateTripBodySchema>;

export const TripMemberSchema = ClosedObject({
  membershipId: MembershipIdSchema,
  deviceId: DeviceIdSchema,
  displayName: Type.String({ minLength: 1, maxLength: 80 }),
  status: MembershipStatusSchema,
});

export const TripResponseSchema = ClosedObject({
  id: TripIdSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
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

export const InviteResponseSchema = ClosedObject({
  tripId: TripIdSchema,
  expiresAt: DateTimeSchema,
});
export type InviteResponse = Static<typeof InviteResponseSchema>;

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
export type ApproveJoinRequestBody = Static<typeof ApproveJoinRequestBodySchema>;

export const StartTripBodySchema = ClosedObject({ expectedVersion: Type.Integer({ minimum: 0 }) });
export type StartTripBody = Static<typeof StartTripBodySchema>;

export const EndTripBodySchema = ClosedObject({ expectedVersion: Type.Integer({ minimum: 0 }) });
export type EndTripBody = Static<typeof EndTripBodySchema>;
