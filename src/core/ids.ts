import { SHA256_HEX_LENGTH } from "./constants";
import {
  issue,
  parseFailure,
  parseSuccess,
  type ParseResult,
} from "./validation";

declare const coreIdBrand: unique symbol;
type CoreId<Kind extends string> = string & {
  readonly [coreIdBrand]: Kind;
};

export type TripId = CoreId<"TripId">;
export type MemberId = CoreId<"MemberId">;
export type DeviceId = CoreId<"DeviceId">;
export type MediaId = CoreId<"MediaId">;
export type ResourceId = CoreId<"ResourceId">;
export type ReplicaReceiptId = CoreId<"ReplicaReceiptId">;
export type OperationId = CoreId<"OperationId">;
export type InviteId = CoreId<"InviteId">;
export type MessageId = CoreId<"MessageId">;
export type RequestId = CoreId<"RequestId">;
export type TransferId = CoreId<"TransferId">;

export type Sha256Hex = string & { readonly [coreIdBrand]: "Sha256Hex" };
export type IdentityPublicKey = string & {
  readonly [coreIdBrand]: "IdentityPublicKey";
};

const CORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function parseCoreId<Kind extends string>(
  value: unknown,
  kind: Kind,
): ParseResult<CoreId<Kind>> {
  if (typeof value !== "string") {
    return parseFailure([
      issue("$", "INVALID_TYPE", `${kind} must be a string.`),
    ]);
  }
  if (!CORE_ID_PATTERN.test(value)) {
    return parseFailure([
      issue(
        "$",
        "INVALID_ID",
        `${kind} must be 8-128 URL-safe identifier characters.`,
      ),
    ]);
  }
  return parseSuccess(value as CoreId<Kind>);
}

export const parseTripId = (value: unknown): ParseResult<TripId> =>
  parseCoreId(value, "TripId");
export const parseMemberId = (value: unknown): ParseResult<MemberId> =>
  parseCoreId(value, "MemberId");
export const parseDeviceId = (value: unknown): ParseResult<DeviceId> =>
  parseCoreId(value, "DeviceId");
export const parseMediaId = (value: unknown): ParseResult<MediaId> =>
  parseCoreId(value, "MediaId");
export const parseResourceId = (value: unknown): ParseResult<ResourceId> =>
  parseCoreId(value, "ResourceId");
export const parseReplicaReceiptId = (
  value: unknown,
): ParseResult<ReplicaReceiptId> => parseCoreId(value, "ReplicaReceiptId");
export const parseOperationId = (value: unknown): ParseResult<OperationId> =>
  parseCoreId(value, "OperationId");
export const parseInviteId = (value: unknown): ParseResult<InviteId> =>
  parseCoreId(value, "InviteId");
export const parseMessageId = (value: unknown): ParseResult<MessageId> =>
  parseCoreId(value, "MessageId");
export const parseRequestId = (value: unknown): ParseResult<RequestId> =>
  parseCoreId(value, "RequestId");
export const parseTransferId = (value: unknown): ParseResult<TransferId> =>
  parseCoreId(value, "TransferId");

export function parseSha256Hex(value: unknown): ParseResult<Sha256Hex> {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return parseFailure([
      issue(
        "$",
        "INVALID_SHA256",
        `Expected a lowercase ${SHA256_HEX_LENGTH}-character SHA-256 hex digest.`,
      ),
    ]);
  }
  return parseSuccess(value as Sha256Hex);
}

export function parseIdentityPublicKey(
  value: unknown,
): ParseResult<IdentityPublicKey> {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return parseFailure([
      issue(
        "$",
        "INVALID_PUBLIC_KEY",
        "Identity public key must be 32-256 base64url characters.",
      ),
    ]);
  }
  return parseSuccess(value as IdentityPublicKey);
}

export function sameId(left: string, right: string): boolean {
  return left === right;
}
