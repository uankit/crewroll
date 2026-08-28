import { Type, type Static } from "@sinclair/typebox";

export const UuidSchema = Type.String({ format: "uuid" });
export type Uuid = Static<typeof UuidSchema>;

export const DeviceIdSchema = UuidSchema;
export type DeviceId = Static<typeof DeviceIdSchema>;

export const TripIdSchema = UuidSchema;
export type TripId = Static<typeof TripIdSchema>;

export const MembershipIdSchema = UuidSchema;
export type MembershipId = Static<typeof MembershipIdSchema>;

export const AssetIdSchema = UuidSchema;
export type AssetId = Static<typeof AssetIdSchema>;

export const DeliveryIdSchema = UuidSchema;
export type DeliveryId = Static<typeof DeliveryIdSchema>;

export const UploadSessionIdSchema = UuidSchema;
export type UploadSessionId = Static<typeof UploadSessionIdSchema>;
