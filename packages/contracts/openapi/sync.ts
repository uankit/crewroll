import { Type, type Static } from "@sinclair/typebox";

import {
  ClosedObject,
  DateTimeSchema,
  DecimalLimitSchema,
  DecimalSequenceSchema,
  OpaqueCursorSchema,
} from "./common.js";
import { DeliveryStatusSchema } from "./enums.js";
import { InboxEventSchema } from "./events.js";
import {
  AssetIdSchema,
  DeviceIdSchema,
  MembershipIdSchema,
  TripIdSchema,
} from "./ids.js";

export const SyncQuerySchema = ClosedObject({
  cursor: Type.Optional(OpaqueCursorSchema),
  limit: Type.Optional(DecimalLimitSchema),
});
export type SyncQuery = Static<typeof SyncQuerySchema>;

export const SyncResponseSchema = ClosedObject({
  events: Type.Array(InboxEventSchema, { maxItems: 100 }),
  nextCursor: OpaqueCursorSchema,
  caughtUpThrough: DecimalSequenceSchema,
  cursorExpiresAt: DateTimeSchema,
  hasMore: Type.Boolean(),
});
export type SyncResponse = Static<typeof SyncResponseSchema>;

export const ReconciliationQuerySchema = ClosedObject({
  cursor: Type.Optional(OpaqueCursorSchema),
  limit: Type.Optional(DecimalLimitSchema),
});
export type ReconciliationQuery = Static<typeof ReconciliationQuerySchema>;

export const ReconciliationMemberSchema = ClosedObject({
  membershipId: MembershipIdSchema,
  deviceId: DeviceIdSchema,
  deliveryStatus: DeliveryStatusSchema,
  savedAt: Type.Union([DateTimeSchema, Type.Null()]),
});

export const ReconciliationAssetSchema = ClosedObject({
  assetId: AssetIdSchema,
  capturedAt: DateTimeSchema,
  members: Type.Array(ReconciliationMemberSchema, {
    minItems: 1,
    maxItems: 10,
  }),
});

export const ReconciliationResponseSchema = ClosedObject({
  tripId: TripIdSchema,
  items: Type.Array(ReconciliationAssetSchema, { maxItems: 100 }),
  nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  caughtUpThrough: DecimalSequenceSchema,
  cursorExpiresAt: DateTimeSchema,
  hasMore: Type.Boolean(),
});
export type ReconciliationResponse = Static<
  typeof ReconciliationResponseSchema
>;
