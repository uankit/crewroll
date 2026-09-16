import { Type, type Static } from "@sinclair/typebox";
import {
  Base64ExactSchema,
  ClosedObject,
  DateTimeSchema,
  InviteCodeSchema,
} from "./common.js";
import { DeviceIdSchema, MembershipIdSchema, TripIdSchema } from "./ids.js";
import { TripStatusSchema } from "./enums.js";

export const DeviceApprovalRequestSchema = ClosedObject({
  requestId: Type.String({ format: "uuid" }),
  membershipId: MembershipIdSchema,
  displayName: Type.String(),
  deviceId: DeviceIdSchema,
  platform: Type.Union([Type.Literal("android"), Type.Literal("ios")]),
  e2eePublicKey: Base64ExactSchema(32),
  status: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("APPROVED"),
    Type.Literal("REJECTED"),
    Type.Literal("CANCELLED"),
  ]),
  requestedAt: DateTimeSchema,
});
export type DeviceApprovalRequest = Static<typeof DeviceApprovalRequestSchema>;
export const TripContinuitySchema = ClosedObject({
  tripId: TripIdSchema,
  version: Type.Integer({ minimum: 1 }),
  tripName: Type.String(),
  status: TripStatusSchema,
  hostDisplayName: Type.String(),
  onThisDevice: Type.Boolean(),
  syncFrom: Type.Union([DateTimeSchema, Type.Null()]),
  ownerInviteCode: Type.Union([InviteCodeSchema, Type.Null()]),
  deviceRequest: Type.Union([DeviceApprovalRequestSchema, Type.Null()]),
  approvalRequests: Type.Array(DeviceApprovalRequestSchema, { maxItems: 10 }),
});
export type TripContinuity = Static<typeof TripContinuitySchema>;
export const TripContinuityBodySchema = Type.Union([
  ClosedObject({
    action: Type.Literal("SAVE_INVITE"),
    inviteCode: InviteCodeSchema,
    expectedVersion: Type.Integer({ minimum: 1 }),
  }),
  ClosedObject({
    action: Type.Literal("REQUEST_DEVICE"),
    expectedVersion: Type.Integer({ minimum: 1 }),
  }),
  ClosedObject({
    action: Type.Literal("APPROVE_DEVICE"),
    requestId: Type.String({ format: "uuid" }),
    wrappedKey: Base64ExactSchema(148),
    expectedVersion: Type.Integer({ minimum: 1 }),
  }),
  ClosedObject({
    action: Type.Literal("REJECT_DEVICE"),
    requestId: Type.String({ format: "uuid" }),
    expectedVersion: Type.Integer({ minimum: 1 }),
  }),
]);
export type TripContinuityBody = Static<typeof TripContinuityBodySchema>;
