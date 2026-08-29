import { Type, type Static } from "@sinclair/typebox";

export const DevicePlatformSchema = Type.Union([
  Type.Literal("ios"),
  Type.Literal("android"),
]);
export type DevicePlatform = Static<typeof DevicePlatformSchema>;

export const ObjectVariantSchema = Type.Union([
  Type.Literal("PREVIEW"),
  Type.Literal("ORIGINAL"),
]);
export type ObjectVariant = Static<typeof ObjectVariantSchema>;

export const ReleaseModeSchema = Type.Union([
  Type.Literal("IMMEDIATE"),
  Type.Literal("NIGHTLY"),
]);
export type ReleaseMode = Static<typeof ReleaseModeSchema>;

export const TripStatusSchema = Type.Union([
  Type.Literal("LOBBY"),
  Type.Literal("ACTIVE"),
  Type.Literal("ENDING"),
  Type.Literal("COMPLETE"),
  Type.Literal("INCOMPLETE_EXPIRED"),
]);
export type TripStatus = Static<typeof TripStatusSchema>;

export const MembershipStatusSchema = Type.Union([
  Type.Literal("PENDING"),
  Type.Literal("APPROVED"),
  Type.Literal("REJECTED"),
]);
export type MembershipStatus = Static<typeof MembershipStatusSchema>;

export const DeliveryStatusSchema = Type.Union([
  Type.Literal("HELD"),
  Type.Literal("READY"),
  Type.Literal("SAVED"),
  Type.Literal("FAILED"),
]);
export type DeliveryStatus = Static<typeof DeliveryStatusSchema>;
