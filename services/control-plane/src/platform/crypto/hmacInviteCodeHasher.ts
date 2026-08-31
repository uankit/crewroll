import { createHmac, timingSafeEqual } from "node:crypto";

const CONFIGURATION_KEY = "INVITE_CODE_HMAC_KEY";
const NORMALIZED_INVITE_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

function configurationError(): never {
  throw new Error(CONFIGURATION_KEY);
}

function invalidCode(): never {
  throw new Error("Invalid invite code");
}

export function createHmacInviteCodeHasher(key: string | undefined) {
  if (key === undefined || key.trim().length === 0) return configurationError();
  const ownedKey = Buffer.from(key, "utf8");
  return Object.freeze({
    hash(normalizedCode: string) {
      if (!NORMALIZED_INVITE_CODE.test(normalizedCode)) return invalidCode();
      let digest: Buffer | undefined;
      try {
        digest = createHmac("sha256", ownedKey)
          .update(normalizedCode, "ascii")
          .digest();
        return Uint8Array.from(digest);
      } finally {
        digest?.fill(0);
      }
    },
    matches(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
      if (left.byteLength !== 32 || right.byteLength !== 32) return false;
      const ownedLeft = Buffer.from(left);
      const ownedRight = Buffer.from(right);
      try {
        return timingSafeEqual(ownedLeft, ownedRight);
      } finally {
        ownedLeft.fill(0);
        ownedRight.fill(0);
      }
    },
  });
}
