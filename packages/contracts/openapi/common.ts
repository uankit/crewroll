import {
  FormatRegistry,
  Type,
  type Static,
  type TObject,
  type TProperties,
} from "@sinclair/typebox";

import { DeviceIdSchema, UuidSchema } from "./ids.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC_3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const BASE64_PATTERN =
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$";
const OPAQUE = /^[A-Za-z0-9_-]+$/;

type FormatValidator = (value: string) => boolean;

export type CrewRollFormatRegistry = Readonly<{
  Get(format: string): FormatValidator | undefined;
  Set(format: string, validator: FormatValidator): void;
}>;

function isRfc3339DateTime(value: string): boolean {
  const match = RFC_3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!)
    return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

function decimalPattern(maximum: number): string {
  const digits = String(maximum);
  const alternatives = ["0"];
  if (digits.length > 1) alternatives.push(`[1-9]\\d{0,${digits.length - 2}}`);
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[index]);
    const lower = index === 0 ? 1 : 0;
    const upper = digit - 1;
    if (upper < lower) continue;
    const range = lower === upper ? String(lower) : `[${lower}-${upper}]`;
    const remaining = digits.length - index - 1;
    alternatives.push(
      `${digits.slice(0, index)}${range}${remaining === 0 ? "" : `\\d{${remaining}}`}`,
    );
  }
  alternatives.push(digits);
  return `^(?:${[...new Set(alternatives)].join("|")})$`;
}

function exactBase64Pattern(decodedBytes: number): string {
  const groups = Math.floor(decodedBytes / 3);
  const remainder = decodedBytes % 3;
  const prefix = `(?:[A-Za-z0-9+/]{4}){${groups}}`;
  if (remainder === 1) return `^${prefix}[A-Za-z0-9+/][AQgw]==$`;
  if (remainder === 2) return `^${prefix}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$`;
  return `^${prefix}$`;
}

const CREWROLL_FORMAT_VALIDATORS = {
  uuid: (value: string) => UUID.test(value),
  "date-time": isRfc3339DateTime,
  uri: (value: string) => {
    try {
      return new URL(value).protocol.length > 1;
    } catch {
      return false;
    }
  },
  "iana-time-zone": (value: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return value === "UTC" || value.includes("/");
    } catch {
      return false;
    }
  },
  "opaque-cursor": (value: string) =>
    value.length >= 8 && value.length <= 256 && OPAQUE.test(value),
  "opaque-source-asset-key": (value: string) =>
    value.length >= 32 &&
    value.length <= 128 &&
    /^src_[A-Za-z0-9_-]+$/.test(value) &&
    !UUID.test(value),
} satisfies Readonly<Record<string, FormatValidator>>;

export function installCrewRollFormats(registry: CrewRollFormatRegistry): void {
  for (const [name, validator] of Object.entries(CREWROLL_FORMAT_VALIDATORS)) {
    if (registry.Get(name) !== validator) registry.Set(name, validator);
  }
}

installCrewRollFormats(FormatRegistry);

export function ClosedObject<T extends TProperties>(properties: T): TObject<T> {
  return Type.Object(properties, { additionalProperties: false });
}

export const ApiVersionSchema = Type.Literal("v1");
export type ApiVersion = Static<typeof ApiVersionSchema>;

export const ProtocolVersionSchema = Type.Literal(1);
export type ProtocolVersion = Static<typeof ProtocolVersionSchema>;

export const DateTimeSchema = Type.String({
  format: "date-time",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
});
export const UriSchema = Type.String({ format: "uri" });
export const Base64Schema = Type.String({
  contentEncoding: "base64",
  minLength: 4,
  pattern: BASE64_PATTERN,
});
export const OpaqueCursorSchema = Type.String({ format: "opaque-cursor" });
export const SourceAssetKeySchema = Type.String({
  format: "opaque-source-asset-key",
});
export const InviteCodeSchema = Type.String({
  pattern: "^[0-9A-HJKMNP-TV-Z]{8}$",
});
export const LocalTimeSchema = Type.String({
  pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
});
export const IanaTimeZoneSchema = Type.String({ format: "iana-time-zone" });
export const DecimalSequenceSchema = Type.String({
  pattern: "^(?:0|[1-9]\\d*)$",
});

export const DecimalBytesSchema = (maximum: 524_288 | 52_428_800) =>
  Type.String({
    pattern: decimalPattern(maximum),
    "x-crewroll-maximum": maximum,
  });
export const DecimalLimitSchema = Type.String({
  pattern: decimalPattern(100),
  "x-crewroll-maximum": 100,
});
export const Base64ExactSchema = (decodedBytes: number) => {
  const encodedLength = Math.ceil(decodedBytes / 3) * 4;
  return Type.String({
    contentEncoding: "base64",
    minLength: encodedLength,
    maxLength: encodedLength,
    pattern: exactBase64Pattern(decodedBytes),
    "x-crewroll-decodedBytes": decodedBytes,
  });
};
export const Base64MaxSchema = (maximum: 4_096 | 65_536) => {
  const maximumEncodedLength = Math.ceil(maximum / 3) * 4;
  return Type.Union(
    [
      Type.String({
        contentEncoding: "base64",
        minLength: 4,
        maxLength: maximumEncodedLength - 4,
        pattern: BASE64_PATTERN,
      }),
      Base64ExactSchema(maximum),
    ],
    { "x-crewroll-maxDecodedBytes": maximum },
  );
};

export const P256PublicKeySchema = Base64ExactSchema(65);
export const X25519PublicKeySchema = Base64ExactSchema(32);

export const KeyEnvelopeSchema = ClosedObject({
  keyEpoch: Type.Literal(1),
  algorithmVersion: Type.Literal(1),
  wrappedKey: Base64ExactSchema(148),
});
export type KeyEnvelope = Static<typeof KeyEnvelopeSchema>;

export const BearerAuthorizationSchema = Type.String({
  pattern: "^Bearer [^\\s]+$",
});
export const DeviceRegistrationHeadersSchema = ClosedObject({
  authorization: BearerAuthorizationSchema,
  "idempotency-key": UuidSchema,
});
export type DeviceRegistrationHeaders = Static<
  typeof DeviceRegistrationHeadersSchema
>;

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
