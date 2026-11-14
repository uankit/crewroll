import { Type, type Static } from "@sinclair/typebox";

import {
  ClosedObject,
  DateTimeSchema,
  DecimalSequenceSchema,
} from "./common.js";
import { DeliveryStatusSchema, TripStatusSchema } from "./enums.js";
import {
  AssetIdSchema,
  DeliveryIdSchema,
  TripIdSchema,
  DeviceIdSchema,
  UuidSchema,
} from "./ids.js";

/** Opaque wake-up only; never authority to activate a trip or disclose media. */
export const PushSyncHintSchema = ClosedObject({
  type: Type.Literal("crewroll.sync.v1"),
  deviceId: DeviceIdSchema,
  tripId: TripIdSchema,
  eventId: UuidSchema,
});
export type PushSyncHint = Static<typeof PushSyncHintSchema>;

export const AssetCommittedEventSchema = ClosedObject({
  type: Type.Literal("ASSET_COMMITTED"),
  sequence: DecimalSequenceSchema,
  occurredAt: DateTimeSchema,
  tripId: TripIdSchema,
  assetId: AssetIdSchema,
});

export const DeliveryChangedEventSchema = ClosedObject({
  type: Type.Literal("DELIVERY_CHANGED"),
  sequence: DecimalSequenceSchema,
  occurredAt: DateTimeSchema,
  tripId: TripIdSchema,
  assetId: AssetIdSchema,
  deliveryId: DeliveryIdSchema,
  status: DeliveryStatusSchema,
});

export const TripChangedEventSchema = ClosedObject({
  type: Type.Literal("TRIP_CHANGED"),
  sequence: DecimalSequenceSchema,
  occurredAt: DateTimeSchema,
  tripId: TripIdSchema,
  status: TripStatusSchema,
});

export const InboxEventSchema = Type.Union([
  AssetCommittedEventSchema,
  DeliveryChangedEventSchema,
  TripChangedEventSchema,
]);
export type InboxEvent = Static<typeof InboxEventSchema>;
