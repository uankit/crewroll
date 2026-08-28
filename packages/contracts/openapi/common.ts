import { FormatRegistry, Type, type Static, type TObject, type TProperties } from "@sinclair/typebox";

import { DeviceIdSchema, UuidSchema } from "./ids.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPAQUE = /^[A-Za-z0-9_-]+$/;

function registerFormat(name: string, check: (value: string) => boolean): void {
  if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, check);
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || !BASE64.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

registerFormat("uuid", (value) => UUID.test(value));
registerFormat("date-time", (value) => RFC_3339.test(value) && !Number.isNaN(Date.parse(value)));
registerFormat("uri", (value) => {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
});
registerFormat("iana-time-zone", (value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value === "UTC" || value.includes("/");
  } catch {
    return false;
  }
});
registerFormat("base64", isCanonicalBase64);
registerFormat("opaque-cursor", (value) => value.length >= 8 && value.length <= 256 && OPAQUE.test(value));
registerFormat(
  "opaque-source-asset-key",
  (value) => value.length >= 32 && value.length <= 128 && /^src_[A-Za-z0-9_-]+$/.test(value) && !UUID.test(value),
);

for (const maximum of [4_096, 65_536]) {
  registerFormat(`base64-max-${maximum}`, (value) => isCanonicalBase64(value) && Buffer.from(value, "base64").byteLength <= maximum);
}

for (const maximum of [100, 524_288, 52_428_800]) {
  registerFormat(`decimal-max-${maximum}`, (value) => /^(?:0|[1-9]\d*)$/.test(value) && BigInt(value) <= BigInt(maximum));
}

export function ClosedObject<T extends TProperties>(properties: T): TObject<T> {
  return Type.Object(properties, { additionalProperties: false });
}

export const ApiVersionSchema = Type.Literal("v1");
export type ApiVersion = Static<typeof ApiVersionSchema>;

export const ProtocolVersionSchema = Type.Literal(1);
export type ProtocolVersion = Static<typeof ProtocolVersionSchema>;

export const DateTimeSchema = Type.String({ format: "date-time" });
export const UriSchema = Type.String({ format: "uri" });
export const Base64Schema = Type.String({ format: "base64" });
export const OpaqueCursorSchema = Type.String({ format: "opaque-cursor" });
export const SourceAssetKeySchema = Type.String({ format: "opaque-source-asset-key" });
export const InviteCodeSchema = Type.String({ pattern: "^[0-9A-HJKMNP-TV-Z]{8}$" });
export const LocalTimeSchema = Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" });
export const IanaTimeZoneSchema = Type.String({ format: "iana-time-zone" });
export const DecimalSequenceSchema = Type.String({ pattern: "^(?:0|[1-9]\\d*)$" });

export const DecimalBytesSchema = (maximum: 524_288 | 52_428_800) =>
  Type.String({ format: `decimal-max-${maximum}` });
export const DecimalLimitSchema = Type.String({ format: "decimal-max-100" });
export const Base64MaxSchema = (maximum: 4_096 | 65_536) =>
  Type.String({ format: `base64-max-${maximum}` });

export const KeyEnvelopeSchema = ClosedObject({
  keyEpoch: Type.Literal(1),
  algorithmVersion: Type.Literal(1),
  wrappedKey: Base64MaxSchema(4_096),
});
export type KeyEnvelope = Static<typeof KeyEnvelopeSchema>;

export const BearerAuthorizationSchema = Type.String({ pattern: "^Bearer [^\\s]+$" });
export const DeviceRegistrationHeadersSchema = ClosedObject({
  authorization: BearerAuthorizationSchema,
  "idempotency-key": UuidSchema,
});
export type DeviceRegistrationHeaders = Static<typeof DeviceRegistrationHeadersSchema>;

export const MobileCommandHeadersSchema = ClosedObject({
  authorization: BearerAuthorizationSchema,
  "x-crewroll-device-id": DeviceIdSchema,
  "idempotency-key": UuidSchema,
});
export type MobileCommandHeaders = Static<typeof MobileCommandHeadersSchema>;

export const MobileQueryHeadersSchema = ClosedObject({
  authorization: BearerAuthorizationSchema,
  "x-crewroll-device-id": DeviceIdSchema,
});
export type MobileQueryHeaders = Static<typeof MobileQueryHeadersSchema>;
