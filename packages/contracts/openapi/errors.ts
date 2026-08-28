import { Type, type Static } from "@sinclair/typebox";

export const ProblemCodeSchema = Type.Union([
  Type.Literal("AUTH_REQUIRED"),
  Type.Literal("DEVICE_REVOKED"),
  Type.Literal("IDEMPOTENCY_CONFLICT"),
  Type.Literal("INVALID_REQUEST"),
  Type.Literal("ACTIVE_TRIP_EXISTS"),
  Type.Literal("TRIP_FULL"),
  Type.Literal("TRIP_FROZEN"),
  Type.Literal("INVITE_INVALID"),
  Type.Literal("KEY_ENVELOPE_INVALID"),
  Type.Literal("UPLOAD_EXPIRED"),
  Type.Literal("OBJECT_MISMATCH"),
  Type.Literal("CURSOR_EXPIRED"),
  Type.Literal("NOT_FOUND"),
  Type.Literal("CONFLICT"),
  Type.Literal("INTERNAL_ERROR"),
]);
export type ProblemCode = Static<typeof ProblemCodeSchema>;
