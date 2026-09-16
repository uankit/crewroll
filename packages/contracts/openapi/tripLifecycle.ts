import { Type, type Static } from "@sinclair/typebox";
import { ClosedObject, DateTimeSchema } from "./common.js";
import { TripIdSchema } from "./ids.js";
import { TripStatusSchema } from "./enums.js";

export const TripParticipationSchema = Type.Union([
  Type.Literal("JOINING"),
  Type.Literal("JOINED"),
  Type.Literal("LEAVING"),
  Type.Literal("LEFT"),
]);
export const TripSummarySchema = ClosedObject({
  id: TripIdSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  status: TripStatusSchema,
  participation: TripParticipationSchema,
  role: Type.Union([Type.Literal("OWNER"), Type.Literal("MEMBER")]),
  startsAt: Type.Union([DateTimeSchema, Type.Null()]),
  endsAt: DateTimeSchema,
  leftAt: Type.Union([DateTimeSchema, Type.Null()]),
  sharingPaused: Type.Boolean(),
  onThisDevice: Type.Boolean(),
  memberCount: Type.Integer({ minimum: 0 }),
  savedPhotoCount: Type.Integer({ minimum: 0 }),
});
export type TripSummary = Static<typeof TripSummarySchema>;
export const TripListResponseSchema = ClosedObject({
  items: Type.Array(TripSummarySchema),
});
export type TripListResponse = Static<typeof TripListResponseSchema>;
export const TripLifecycleBodySchema = ClosedObject({
  action: Type.Union([
    Type.Literal("PAUSE"),
    Type.Literal("RESUME"),
    Type.Literal("LEAVE"),
    Type.Literal("LEAVE_NOW"),
    Type.Literal("END"),
  ]),
  expectedVersion: Type.Integer({ minimum: 1 }),
});
export type TripLifecycleBody = Static<typeof TripLifecycleBodySchema>;
export const TripTransferStateSchema = ClosedObject({
  tripId: TripIdSchema,
  version: Type.Integer({ minimum: 1 }),
  status: TripStatusSchema,
  participation: TripParticipationSchema,
  sharingPaused: Type.Boolean(),
  captureFrom: Type.Optional(DateTimeSchema),
  captureUntil: DateTimeSchema,
  excludedCaptureWindows: Type.Array(
    ClosedObject({
      from: DateTimeSchema,
      until: Type.Union([DateTimeSchema, Type.Null()]),
    }),
  ),
  pendingUploads: Type.Integer({ minimum: 0 }),
  pendingDownloads: Type.Integer({ minimum: 0 }),
  deliveryDeadline: DateTimeSchema,
});
export type TripTransferState = Static<typeof TripTransferStateSchema>;
export const TripDrainBodySchema = ClosedObject({
  observedVersion: Type.Integer({ minimum: 1 }),
});
export type TripDrainBody = Static<typeof TripDrainBodySchema>;
