import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BinaryReader,
  BinaryWriter,
  assertUint32,
  assertUint64,
} from "../crypto/binary.js";
import {
  encodeManifestAssociatedData,
  encodeMediaAssociatedData,
} from "../crypto/aad.js";
import {
  CHECKSUM_BYTES,
  CONTENT_ROOT_BYTES,
  ENCRYPTION_FORMAT_VERSION,
  INITIAL_KEY_EPOCH,
  KDF_CONTEXT_BYTES,
  MANIFEST_AAD_BYTES,
  MANIFEST_AUTH_BYTES,
  MANIFEST_CIPHERTEXT_MAX_BYTES,
  MANIFEST_CIPHERTEXT_MIN_BYTES,
  MANIFEST_KDF_CONTEXT,
  MANIFEST_KDF_SUBKEY_ID,
  MANIFEST_KEY_BYTES,
  MANIFEST_NONCE_BYTES,
  MANIFEST_PLAINTEXT_MAX_BYTES,
  MANIFEST_PLAINTEXT_MIN_BYTES,
  MEDIA_AAD_BYTES,
  MEDIA_FRAME_LENGTH_PREFIX_BYTES,
  MEDIA_KDF_CONTEXT,
  MEDIA_KDF_SUBKEY_IDS,
  MEDIA_PLAINTEXT_FRAME_BYTES,
  SECRETSTREAM_AUTH_BYTES,
  SECRETSTREAM_HEADER_BYTES,
  SECRETSTREAM_KEY_BYTES,
  SECRETSTREAM_TAG_FINAL,
  SECRETSTREAM_TAG_MESSAGE,
  VARIANT_CODES,
} from "../crypto/protocol.js";

const tripId = "018F0D98-76FA-7D1A-B4B4-1F742C2E3130";
const assetId = "018F0D98-76FA-7D1A-B4B4-1F742C2E3140";
const canonicalTripId = tripId.toLowerCase();
const canonicalAssetId = assetId.toLowerCase();

describe("CrewRoll encrypted-photo protocol constants", () => {
  it("publishes the complete language-neutral v1 wire contract", async () => {
    const specification = await readFile(
      new URL("../crypto/FORMAT_V1.md", import.meta.url),
      "utf8",
    );

    for (const requiredText of [
      "CRROLL-AAD-V1\\0",
      "CRROLL-MAN-V1\\0",
      "CRROLL01",
      "CRMANF01",
      "95 bytes",
      "94 bytes",
      "262,144 bytes",
      "TAG_FINAL",
      "complete framed media blob",
      "241 through 744 bytes",
      "281 through 784 bytes",
      "No fallback algorithm",
      "No nested key wrap",
    ]) {
      expect(specification).toContain(requiredText);
    }
  });

  it("pins the v1 key hierarchy and official primitive widths", () => {
    expect(ENCRYPTION_FORMAT_VERSION).toBe(1);
    expect(INITIAL_KEY_EPOCH).toBe(1);
    expect(CONTENT_ROOT_BYTES).toBe(32);
    expect(SECRETSTREAM_KEY_BYTES).toBe(32);
    expect(SECRETSTREAM_HEADER_BYTES).toBe(24);
    expect(SECRETSTREAM_AUTH_BYTES).toBe(17);
    expect(SECRETSTREAM_TAG_MESSAGE).toBe(0x00);
    expect(SECRETSTREAM_TAG_FINAL).toBe(0x03);
    expect(MEDIA_PLAINTEXT_FRAME_BYTES).toBe(262_144);
    expect(MANIFEST_KEY_BYTES).toBe(32);
    expect(MANIFEST_NONCE_BYTES).toBe(24);
    expect(MANIFEST_AUTH_BYTES).toBe(16);
    expect(CHECKSUM_BYTES).toBe(32);
  });

  it("pins KDF contexts, subkey IDs, variants, and AAD widths", () => {
    expect(KDF_CONTEXT_BYTES).toBe(8);
    expect(MEDIA_KDF_CONTEXT).toBe("CRROLL01");
    expect(MEDIA_KDF_SUBKEY_IDS).toEqual({ PREVIEW: 1, ORIGINAL: 2 });
    expect(MANIFEST_KDF_CONTEXT).toBe("CRMANF01");
    expect(MANIFEST_KDF_SUBKEY_ID).toBe(1);
    expect(VARIANT_CODES).toEqual({ PREVIEW: 1, ORIGINAL: 2 });
    expect(MEDIA_AAD_BYTES).toBe(95);
    expect(MANIFEST_AAD_BYTES).toBe(94);
  });

  it("pins manifest bounds and exact canonical media size formulas", () => {
    expect(MANIFEST_PLAINTEXT_MIN_BYTES).toBe(241);
    expect(MANIFEST_PLAINTEXT_MAX_BYTES).toBe(744);
    expect(MANIFEST_CIPHERTEXT_MIN_BYTES).toBe(281);
    expect(MANIFEST_CIPHERTEXT_MAX_BYTES).toBe(784);

    const framedBytes = (plaintextBytes: number): number => {
      const frameCount = Math.max(
        1,
        Math.ceil(plaintextBytes / MEDIA_PLAINTEXT_FRAME_BYTES),
      );
      return (
        SECRETSTREAM_HEADER_BYTES +
        frameCount *
          (MEDIA_FRAME_LENGTH_PREFIX_BYTES + SECRETSTREAM_AUTH_BYTES) +
        plaintextBytes
      );
    };

    expect(framedBytes(0)).toBe(45);
    expect(framedBytes(1)).toBe(46);
    expect(framedBytes(262_144)).toBe(262_189);
    expect(framedBytes(262_145)).toBe(262_211);
  });
});

describe("bounded binary helpers", () => {
  it("round-trips unsigned integers in big-endian order", () => {
    const bytes = new BinaryWriter()
      .writeUint8(0xab)
      .writeUint16(0xcdef)
      .writeUint32(0x12345678)
      .writeUint64(0x0123456789abcdefn)
      .toUint8Array();

    expect(bytes).toEqual(
      Uint8Array.from([
        0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x01, 0x23, 0x45, 0x67, 0x89,
        0xab, 0xcd, 0xef,
      ]),
    );

    const reader = new BinaryReader(bytes);
    expect(reader.readUint8()).toBe(0xab);
    expect(reader.readUint16()).toBe(0xcdef);
    expect(reader.readUint32()).toBe(0x12345678);
    expect(reader.readUint64()).toBe(0x0123456789abcdefn);
    reader.assertEnd();
  });

  it("rejects integer overflow, truncation, and trailing bytes", () => {
    for (const invalid of [-1, 2 ** 32, Number.NaN, 1.5]) {
      expect(() => assertUint32(invalid, "value")).toThrow();
    }
    for (const invalid of [-1n, 1n << 64n]) {
      expect(() => assertUint64(invalid, "value")).toThrow();
    }
    expect(() => new BinaryReader(Uint8Array.of(1)).readUint16()).toThrow(
      /truncated/i,
    );
    expect(() => new BinaryReader(Uint8Array.of(1)).assertEnd()).toThrow(
      /trailing/i,
    );
  });
});

describe("canonical associated data", () => {
  it("encodes media AAD as exactly 95 positional bytes", () => {
    const aad = encodeMediaAssociatedData({
      tripId,
      assetId,
      variant: "PREVIEW",
      keyEpoch: 1,
      formatVersion: 1,
    });

    expect(aad).toHaveLength(95);
    expect(new TextDecoder().decode(aad.subarray(0, 14))).toBe(
      "CRROLL-AAD-V1\0",
    );
    expect(new TextDecoder().decode(aad.subarray(14, 50))).toBe(
      canonicalTripId,
    );
    expect(new TextDecoder().decode(aad.subarray(50, 86))).toBe(
      canonicalAssetId,
    );
    expect([...aad.subarray(86)]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("encodes manifest AAD as exactly 94 positional bytes", () => {
    const aad = encodeManifestAssociatedData({
      tripId,
      assetId,
      keyEpoch: 1,
      formatVersion: 1,
    });

    expect(aad).toHaveLength(94);
    expect(new TextDecoder().decode(aad.subarray(0, 14))).toBe(
      "CRROLL-MAN-V1\0",
    );
    expect(new TextDecoder().decode(aad.subarray(14, 50))).toBe(
      canonicalTripId,
    );
    expect(new TextDecoder().decode(aad.subarray(50, 86))).toBe(
      canonicalAssetId,
    );
    expect([...aad.subarray(86)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("is independent of object property order and canonicalizes valid UUID case", () => {
    const canonical = encodeMediaAssociatedData({
      tripId: canonicalTripId,
      assetId: canonicalAssetId,
      variant: "ORIGINAL",
      keyEpoch: 1,
      formatVersion: 1,
    });
    const reordered = encodeMediaAssociatedData({
      formatVersion: 1,
      variant: "ORIGINAL",
      assetId,
      keyEpoch: 1,
      tripId,
    });

    expect(reordered).toEqual(canonical);
    expect(reordered[86]).toBe(2);
  });

  it.each([
    ["malformed trip UUID", { tripId: "not-a-uuid" }],
    ["malformed asset UUID", { assetId: `${canonicalAssetId}00` }],
    ["wrong variant", { variant: "THUMBNAIL" }],
    ["wrong epoch", { keyEpoch: 2 }],
    ["wrong version", { formatVersion: 2 }],
  ])("rejects %s", (_label, replacement) => {
    expect(() =>
      encodeMediaAssociatedData({
        tripId,
        assetId,
        variant: "PREVIEW",
        keyEpoch: 1,
        formatVersion: 1,
        ...replacement,
      }),
    ).toThrow();
  });

  it("rejects missing, extra, and forbidden semantic fields", () => {
    const canonical = {
      tripId,
      assetId,
      variant: "PREVIEW",
      keyEpoch: 1,
      formatVersion: 1,
    };
    const { assetId: _assetId, ...missing } = canonical;

    expect(() => encodeMediaAssociatedData(missing)).toThrow(/assetId/);
    for (const forbidden of [
      "mime",
      "filename",
      "capturedAt",
      "plaintextHash",
      "sourceAssetKey",
    ]) {
      expect(() =>
        encodeMediaAssociatedData({ ...canonical, [forbidden]: "forbidden" }),
      ).toThrow(/unexpected/i);
    }
    expect(() =>
      encodeManifestAssociatedData({
        tripId,
        assetId,
        keyEpoch: 1,
        formatVersion: 1,
        variant: "PREVIEW",
      }),
    ).toThrow(/unexpected/i);
  });
});
