import { Type, type Static } from "@sinclair/typebox";

import { Base64Schema, ClosedObject, DateTimeSchema } from "./common.js";
import { DevicePlatformSchema } from "./enums.js";
import { DeviceIdSchema } from "./ids.js";

export const RegisterDeviceBodySchema = ClosedObject({
  installationId: Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" }),
  platform: DevicePlatformSchema,
  authenticationKeyAlgorithm: Type.Literal("P-256"),
  authenticationPublicKey: Base64Schema,
  authenticationKeyVersion: Type.Literal(1),
  e2eeKeyAlgorithm: Type.Literal("X25519"),
  e2eePublicKey: Base64Schema,
  e2eeKeyVersion: Type.Literal(1),
  pushToken: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  appVersion: Type.String({
    pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$",
  }),
});
export type RegisterDeviceBody = Static<typeof RegisterDeviceBodySchema>;

export const DeviceResponseSchema = ClosedObject({
  deviceId: DeviceIdSchema,
  backgroundBearer: Type.String({ pattern: "^crb_[A-Za-z0-9_-]{12,512}$" }),
  backgroundBearerExpiresAt: DateTimeSchema,
});
export type DeviceResponse = Static<typeof DeviceResponseSchema>;

export const UpdatePushTokenBodySchema = ClosedObject({
  pushToken: Type.Union([
    Type.String({ minLength: 1, maxLength: 4096 }),
    Type.Null(),
  ]),
  appVersion: Type.String({
    pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$",
  }),
});
export type UpdatePushTokenBody = Static<typeof UpdatePushTokenBodySchema>;
