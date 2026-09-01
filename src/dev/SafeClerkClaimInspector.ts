const MAX_TOKEN_LENGTH = 16_384;
const MAX_PAYLOAD_LENGTH = 8_192;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type SafeClerkClaimMetadata = Readonly<{
  issuer: string;
  authorizedParty: string | null;
}>;

function invalid(): never {
  throw new Error("INVALID_CLERK_CLAIMS");
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[(first >> 2) & 63];
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      result += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) result += alphabet[third & 63];
  }
  return result;
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) invalid();
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const canonical = value.replaceAll("-", "+").replaceAll("_", "/");
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of canonical) {
    const index = alphabet.indexOf(character);
    if (index < 0) invalid();
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  const decoded = Uint8Array.from(bytes);
  if (encodeBase64Url(decoded) !== value) invalid();
  return decoded;
}

function decodeBase64Url(value: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64UrlBytes(value),
    );
  } catch {
    return invalid();
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value.replace(/\/$/, "")
    );
  } catch {
    return false;
  }
}

function hasDuplicateJsonKeys(payload: string): boolean {
  const keys = payload.match(/"(?:\\.|[^"\\])*"\s*:/g) ?? [];
  const normalized = keys.map((key) => {
    try {
      const parsed: unknown = JSON.parse(key.replace(/\s*:$/, ""));
      return typeof parsed === "string" ? parsed : invalid();
    } catch {
      return invalid();
    }
  });
  return new Set(normalized).size !== normalized.length;
}

export function inspectClerkToken(token: string): SafeClerkClaimMetadata {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return invalid();
  }
  const segments = token.split(".");
  if (segments.length !== 3) return invalid();
  decodeBase64UrlBytes(segments[0] ?? "");
  decodeBase64UrlBytes(segments[2] ?? "");
  const encodedPayload = segments[1];
  if (
    encodedPayload === undefined ||
    encodedPayload.length > MAX_PAYLOAD_LENGTH
  ) {
    return invalid();
  }
  const payload = decodeBase64Url(encodedPayload);
  if (payload.length > MAX_PAYLOAD_LENGTH || hasDuplicateJsonKeys(payload)) {
    return invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid();
  }
  const claims = parsed as Record<string, unknown>;
  if (typeof claims.iss !== "string" || !isHttpsOrigin(claims.iss)) {
    return invalid();
  }
  if (
    Object.hasOwn(claims, "azp") &&
    (typeof claims.azp !== "string" || !isHttpsOrigin(claims.azp))
  ) {
    return invalid();
  }
  return Object.freeze({
    issuer: claims.iss,
    authorizedParty: typeof claims.azp === "string" ? claims.azp : null,
  });
}
