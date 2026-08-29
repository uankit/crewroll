import { describe, expect, it } from "vitest";

import {
  buildBackgroundCredentialFrame,
  createHmacBackgroundCredentialIssuer,
} from "../../src/platform/crypto/hmacBackgroundCredentialIssuer.js";
import { DomainError } from "../../src/shared/errors/domainError.js";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const userId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3110";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const expiresAt = new Date("2026-08-30T00:00:00.000Z");
const expirySeconds = 1_788_048_000;

describe("createHmacBackgroundCredentialIssuer", () => {
  it("pins the exact v1 frame, bearer, and persisted bearer hash", () => {
    const frame = buildBackgroundCredentialFrame({
      deviceId,
      expiresAt,
      userId,
    });
    expect(Buffer.from(frame).toString("hex")).toBe(
      "43524557524f4c4c2d4241434b47524f554e442d563100018f0d9876fa7d1ab4b41f742c2e3110018f0d9876fa7d1ab4b41f742c2e3120000000006a937280",
    );
    expect(frame).toHaveLength(63);

    const issuer = createHmacBackgroundCredentialIssuer(key);
    const credential = issuer.issue({ deviceId, expiresAt, userId });

    expect(credential.bearer).toBe(
      "crb_BhBNJyJCz0x1mWN-ZkEPh-9guCIrgmWJZl40iINazj0",
    );
    expect(credential.bearer).toMatch(/^crb_[A-Za-z0-9_-]{43}$/u);
    expect(credential.bearer).toHaveLength(47);
    expect(Buffer.from(credential.bearerHash).toString("hex")).toBe(
      "26bd74a35f4f08a9381f20791db90d1855d4ca3ceee174a34220c6bee844a0be",
    );
  });

  it("is deterministic while separating user, device, and expiry inputs", () => {
    const issuer = createHmacBackgroundCredentialIssuer(key);
    const original = issuer.issue({ deviceId, expiresAt, userId });
    const replay = issuer.issue({ deviceId, expiresAt, userId });
    const variants = [
      issuer.issue({
        deviceId,
        expiresAt,
        userId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3111",
      }),
      issuer.issue({
        deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3121",
        expiresAt,
        userId,
      }),
      issuer.issue({
        deviceId,
        expiresAt: new Date(expiresAt.getTime() + 1_000),
        userId,
      }),
    ];

    expect(replay).toEqual(original);
    for (const variant of variants) {
      expect(variant.bearer).not.toBe(original.bearer);
      expect(variant.bearerHash).not.toEqual(original.bearerHash);
    }
  });

  it.each([
    new Date(expiresAt.getTime() + 1),
    new Date(Number.NaN),
    new Date(-1_000),
  ])("rejects non-whole-second or out-of-range expiry %s", (invalidExpiry) => {
    const issuer = createHmacBackgroundCredentialIssuer(key);

    expect(() =>
      issuer.issue({ deviceId, expiresAt: invalidExpiry, userId }),
    ).toThrowError(DomainError);
    try {
      issuer.issue({ deviceId, expiresAt: invalidExpiry, userId });
    } catch (error) {
      expect((error as DomainError).kind).toBe("INTERNAL_ERROR");
      expect(String(error)).not.toContain(String(invalidExpiry));
    }
  });

  it("encodes the expiry as unsigned 64-bit big-endian seconds", () => {
    const frame = buildBackgroundCredentialFrame({
      deviceId,
      expiresAt,
      userId,
    });
    expect(Buffer.from(frame).readBigUInt64BE(55)).toBe(BigInt(expirySeconds));
  });
});
