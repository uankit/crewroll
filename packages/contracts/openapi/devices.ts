import { Type, type Static } from "@sinclair/typebox";

import {
  AppVersionSchema,
  BackgroundBearerV1Schema,
  ClosedObject,
  DateTimeSchema,
  P256PublicKeySchema,
  PushTokenSchema,
  X25519PublicKeySchema,
} from "./common.js";
import { DevicePlatformSchema } from "./enums.js";
import { DeviceIdSchema } from "./ids.js";

export const RegisterDeviceBodySchema = ClosedObject({
  installationId: Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" }),
  platform: DevicePlatformSchema,
  authenticationKeyAlgorithm: Type.Literal("P-256"),
  authenticationPublicKey: P256PublicKeySchema,
  authenticationKeyVersion: Type.Literal(1),
  e2eeKeyAlgorithm: Type.Literal("X25519"),
  e2eePublicKey: X25519PublicKeySchema,
  e2eeKeyVersion: Type.Literal(1),
  pushToken: Type.Optional(PushTokenSchema),
  appVersion: AppVersionSchema,
});
export type RegisterDeviceBody = Static<typeof RegisterDeviceBodySchema>;

export const DeviceResponseSchema = ClosedObject({
  deviceId: DeviceIdSchema,
  backgroundBearer: BackgroundBearerV1Schema,
  backgroundBearerExpiresAt: DateTimeSchema,
});
export type DeviceResponse = Static<typeof DeviceResponseSchema>;

export const UpdatePushTokenBodySchema = ClosedObject({
  pushToken: Type.Union([PushTokenSchema, Type.Null()]),
  appVersion: AppVersionSchema,
});
export type UpdatePushTokenBody = Static<typeof UpdatePushTokenBodySchema>;
