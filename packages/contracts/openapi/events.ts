import { Type, type Static } from "@sinclair/typebox";

import {
  ClosedObject,
  DateTimeSchema,
  DecimalSequenceSchema,
} from "./common.js";
import { DeliveryStatusSchema, TripStatusSchema } from "./enums.js";
import { AssetIdSchema, DeliveryIdSchema, TripIdSchema } from "./ids.js";

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

export const SyncAvailablePushHintSchema = ClosedObject({
  type: Type.Literal("SYNC_AVAILABLE"),
  tripId: TripIdSchema,
  sequence: DecimalSequenceSchema,
});
export type SyncAvailablePushHint = Static<typeof SyncAvailablePushHintSchema>;
