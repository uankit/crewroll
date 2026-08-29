import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";

import { encodeManifestAssociatedData } from "../crypto/aad.js";
import { BinaryReader, BinaryWriter } from "../crypto/binary.js";
import {
  ManifestReadError,
  decodeManifestPlaintext,
  encodeManifestPlaintext,
  readEncryptedManifest,
  type ManifestCryptoProvider,
  type ManifestPlaintext,
} from "../crypto/manifest.js";
import {
  MANIFEST_KDF_CONTEXT,
  MANIFEST_KDF_SUBKEY_ID,
} from "../crypto/protocol.js";

const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const assetId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const manifestAad = encodeManifestAssociatedData({
  tripId,
  assetId,
  keyEpoch: 1,
  formatVersion: 1,
});
const tripKey = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);
const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0x40 + index);
const contentRoot = Uint8Array.from({ length: 32 }, (_, index) => index);
const previewPlaintextHash = Uint8Array.from(
  { length: 32 },
  (_, index) => 0x20 + index,
);
const previewCiphertextHash = Uint8Array.from(
  { length: 32 },
  (_, index) => 0x40 + index,
);
const originalPlaintextHash = Uint8Array.from(
  { length: 32 },
  (_, index) => 0x60 + index,
);
const originalCiphertextHash = Uint8Array.from(
  { length: 32 },
  (_, index) => 0x80 + index,
);

const canonicalManifest: ManifestPlaintext = {
  contentRoot,
  capturedAtMs: 1_777_777_777_777n,
  filename: "Caf\u00e9.jpg",
  preview: {
    variant: "PREVIEW",
    mime: "image/jpeg",
    pixelWidth: 320,
    pixelHeight: 240,
    plaintextBytes: 1n,
    plaintextSha256: previewPlaintextHash,
    ciphertextBytes: 46n,
    ciphertextSha256: previewCiphertextHash,
  },
  original: {
    variant: "ORIGINAL",
    mime: "video/mp4",
    pixelWidth: 1_920,
    pixelHeight: 1_080,
    plaintextBytes: 262_145n,
    plaintextSha256: originalPlaintextHash,
    ciphertextBytes: 262_211n,
    ciphertextSha256: originalCiphertextHash,
  },
};

const cryptoProvider: ManifestCryptoProvider = {
  ready: sodium.ready,
  get kdfContextBytes() {
    return sodium.crypto_kdf_CONTEXTBYTES;
  },
  get kdfKeyBytes() {
    return sodium.crypto_kdf_KEYBYTES;
  },
  get aeadKeyBytes() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
  },
  get aeadNonceBytes() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  },
  get aeadAuthBytes() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
  },
  deriveFromKey: (length, subkeyId, context, key) =>
    sodium.crypto_kdf_derive_from_key(length, subkeyId, context, key),
  decrypt: (ciphertext, associatedData, publicNonce, key) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData,
      publicNonce,
      key,
    ),
};

function encryptOracle(plaintext: Uint8Array): Uint8Array {
  const manifestKey = sodium.crypto_kdf_derive_from_key(
    32,
    MANIFEST_KDF_SUBKEY_ID,
    MANIFEST_KDF_CONTEXT,
    tripKey,
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    manifestAad,
    null,
    nonce,
    manifestKey,
  );
  return new BinaryWriter()
    .writeBytes(nonce)
    .writeBytes(ciphertext)
    .toUint8Array();
}

function containsSequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (
    let offset = 0;
    offset <= haystack.byteLength - needle.byteLength;
    offset += 1
  ) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

beforeAll(async () => {
  await sodium.ready;
});

describe("canonical manifest plaintext", () => {
  it("encodes every field positionally and round-trips at exact EOF", () => {
    const encoded = encodeManifestPlaintext(canonicalManifest);
    const reader = new BinaryReader(encoded);

    expect(new TextDecoder().decode(reader.readBytes(8))).toBe("CRMANP1\0");
    expect(reader.readUint32()).toBe(1);
    expect(reader.readBytes(32)).toEqual(contentRoot);
    expect(reader.readUint8()).toBe(1);
    expect(reader.readUint64()).toBe(1_777_777_777_777n);
    const filenameLength = reader.readUint16();
    expect(filenameLength).toBe(9);
    expect(new TextDecoder().decode(reader.readBytes(filenameLength))).toBe(
      "Caf\u00e9.jpg",
    );
    expect(reader.readUint8()).toBe(1);

    expect(decodeManifestPlaintext(encoded)).toEqual(canonicalManifest);
  });

  it("uses exactly preview then original and keeps the root only in plaintext", () => {
    const decoded = decodeManifestPlaintext(
      encodeManifestPlaintext(canonicalManifest),
    );
    expect(decoded.preview.variant).toBe("PREVIEW");
    expect(decoded.original.variant).toBe("ORIGINAL");
    expect(decoded.contentRoot).toEqual(contentRoot);
    expect(Object.keys(decoded)).not.toContain("wrappedContentKey");
  });

  it("pins exact plaintext bounds 241 through 744 bytes", () => {
    const minimal: ManifestPlaintext = {
      ...canonicalManifest,
      capturedAtMs: null,
      filename: null,
      preview: { ...canonicalManifest.preview, mime: "a/b" },
      original: { ...canonicalManifest.original, mime: "a/b" },
    };
    const maximumMime = `a/${"b".repeat(125)}`;
    const maximum: ManifestPlaintext = {
      ...canonicalManifest,
      filename: "x".repeat(255),
      preview: { ...canonicalManifest.preview, mime: maximumMime },
      original: { ...canonicalManifest.original, mime: maximumMime },
    };

    expect(encodeManifestPlaintext(minimal)).toHaveLength(241);
    expect(encodeManifestPlaintext(maximum)).toHaveLength(744);
    expect(decodeManifestPlaintext(encodeManifestPlaintext(minimal))).toEqual(
      minimal,
    );
    expect(decodeManifestPlaintext(encodeManifestPlaintext(maximum))).toEqual(
      maximum,
    );
  });

  it.each([
    ["zero capture time", { capturedAtMs: 0n }],
    ["year-10000 capture time", { capturedAtMs: 253_402_300_800_000n }],
    ["empty filename", { filename: "" }],
    ["decomposed filename", { filename: "Cafe\u0301.jpg" }],
    ["path filename", { filename: "folder/photo.jpg" }],
    ["control filename", { filename: "photo\u0001.jpg" }],
  ])("rejects a noncanonical %s", (_label, replacement) => {
    expect(() =>
      encodeManifestPlaintext({ ...canonicalManifest, ...replacement }),
    ).toThrow();
  });

  it("rejects isolated UTF-16 surrogates and preserves a valid astral pair", () => {
    for (const filename of ["photo-\ud800.jpg", "\ud800", "photo-\udc00.jpg"]) {
      expect(() =>
        encodeManifestPlaintext({ ...canonicalManifest, filename }),
      ).toThrow(/Unicode scalar/i);
    }

    const astral: ManifestPlaintext = {
      ...canonicalManifest,
      filename: "photo-\ud83d\udcf8.jpg",
    };
    expect(decodeManifestPlaintext(encodeManifestPlaintext(astral))).toEqual(
      astral,
    );
  });

  it.each([
    ["uppercase MIME", { mime: "image/JPEG" }],
    ["parameterized MIME", { mime: "image/jpeg;quality=80" }],
    ["zero width", { pixelWidth: 0 }],
    ["negative plaintext length", { plaintextBytes: -1n }],
    ["short plaintext hash", { plaintextSha256: new Uint8Array(31) }],
    ["short ciphertext blob", { ciphertextBytes: 44n }],
    ["wrong descriptor variant", { variant: "ORIGINAL" }],
  ])("rejects a noncanonical preview descriptor: %s", (_label, replacement) => {
    expect(() =>
      encodeManifestPlaintext({
        ...canonicalManifest,
        preview: { ...canonicalManifest.preview, ...replacement },
      }),
    ).toThrow();
  });

  it("rejects invalid UTF-8, length overrun, and descriptor order on decode", () => {
    const encoded = encodeManifestPlaintext(canonicalManifest);
    const invalidUtf8 = encoded.slice();
    invalidUtf8[55] = 0xff;

    const filenameOverrun = encoded.slice();
    filenameOverrun[53] = 0xff;
    filenameOverrun[54] = 0xff;

    const reversed = encoded.slice();
    reversed[64] = 2;

    expect(() => decodeManifestPlaintext(invalidUtf8)).toThrow(/UTF-8/i);
    expect(() => decodeManifestPlaintext(filenameOverrun)).toThrow(
      /truncated/i,
    );
    expect(() => decodeManifestPlaintext(reversed)).toThrow(/preview/i);
  });
});

describe("encrypted manifest reader", () => {
  it("reads nonce || combined ciphertext with exact AAD and derived key", async () => {
    const plaintext = encodeManifestPlaintext(canonicalManifest);
    const encrypted = encryptOracle(plaintext);

    expect(encrypted).toHaveLength(plaintext.byteLength + 24 + 16);
    expect(encrypted.subarray(0, 24)).toEqual(nonce);
    expect(encrypted).toHaveLength(plaintext.byteLength + 40);
    expect(containsSequence(encrypted, contentRoot)).toBe(false);

    await expect(
      readEncryptedManifest({
        crypto: cryptoProvider,
        encryptedManifest: encrypted,
        tripKey,
        aad: manifestAad,
      }),
    ).resolves.toEqual(canonicalManifest);
  });

  it("pins encrypted bounds 281 through 784 bytes", () => {
    const minimal: ManifestPlaintext = {
      ...canonicalManifest,
      capturedAtMs: null,
      filename: null,
      preview: { ...canonicalManifest.preview, mime: "a/b" },
      original: { ...canonicalManifest.original, mime: "a/b" },
    };
    const maximumMime = `a/${"b".repeat(125)}`;
    const maximum: ManifestPlaintext = {
      ...canonicalManifest,
      filename: "x".repeat(255),
      preview: { ...canonicalManifest.preview, mime: maximumMime },
      original: { ...canonicalManifest.original, mime: maximumMime },
    };

    expect(encryptOracle(encodeManifestPlaintext(minimal))).toHaveLength(281);
    expect(encryptOracle(encodeManifestPlaintext(maximum))).toHaveLength(784);
  });

  it("rejects the wrong key, AAD, nonce, and outer extension", async () => {
    const encrypted = encryptOracle(encodeManifestPlaintext(canonicalManifest));
    const wrongAad = manifestAad.slice();
    wrongAad[20] = (wrongAad[20] as number) ^ 1;
    const wrongNonce = encrypted.slice();
    wrongNonce[0] = (wrongNonce[0] as number) ^ 1;

    for (const input of [
      {
        encryptedManifest: encrypted,
        tripKey: new Uint8Array(32),
        aad: manifestAad,
      },
      { encryptedManifest: encrypted, tripKey, aad: wrongAad },
      { encryptedManifest: wrongNonce, tripKey, aad: manifestAad },
      {
        encryptedManifest: Uint8Array.from([...encrypted, 0]),
        tripKey,
        aad: manifestAad,
      },
    ]) {
      await expect(
        readEncryptedManifest({ crypto: cryptoProvider, ...input }),
      ).rejects.toBeInstanceOf(ManifestReadError);
    }
  });
});
