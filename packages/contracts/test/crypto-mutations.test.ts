import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  encodeManifestAssociatedData,
  encodeMediaAssociatedData,
} from "../crypto/aad.js";
import { BinaryWriter } from "../crypto/binary.js";
import { sha256 } from "../crypto/checksums.js";
import {
  ManifestReadError,
  assertManifestDescriptorMatches,
  encodeManifestPlaintext,
  readEncryptedManifest,
  type ManifestPlaintext,
} from "../crypto/manifest.js";
import {
  MediaReadError,
  iterateMediaFrames,
  readMediaBlob,
} from "../crypto/media.js";
import {
  MANIFEST_KDF_CONTEXT,
  MANIFEST_KDF_SUBKEY_ID,
  MEDIA_PLAINTEXT_FRAME_BYTES,
  SECRETSTREAM_HEADER_BYTES,
  SECRETSTREAM_TAG_FINAL,
  SECRETSTREAM_TAG_MESSAGE,
} from "../crypto/protocol.js";
import {
  EnvelopeReadError,
  decodeCanonicalBase64,
  openEnvelopeForContext,
  type VectorCryptoProvider,
} from "../crypto/vectors/tooling/verify.js";

const vectorDirectory = new URL("../crypto/vectors/v1/", import.meta.url);

type MediaIndex = Readonly<{
  file: string;
  variant: "PREVIEW" | "ORIGINAL";
  plaintextBytes: number;
  ciphertextBytes: number;
  streamKeyBase64: string;
  plaintextSha256Base64: string;
  ciphertextSha256Base64: string;
}>;

type EnvelopeIndex = Readonly<{
  file: string;
  kind: "OWNER_SELF" | "OWNER_RECIPIENT" | "FIRST_IMPORT_SUBSTITUTION";
  recipientDeviceId: string;
  recipientPublicKeyBase64: string;
}>;

type VectorIndex = Readonly<{
  context: Readonly<{
    tripId: string;
    assetId: string;
    ownerDeviceId: string;
    recipientDeviceId: string;
    recipientE2eeKeyVersion: number;
  }>;
  secrets: Readonly<{
    tripKeyBase64: string;
    contentRootBase64: string;
    ownerSecretKeyBase64: string;
    recipientSecretKeyBase64: string;
  }>;
  media: readonly MediaIndex[];
  manifest: Readonly<{ file: string }>;
  envelopes: readonly EnvelopeIndex[];
}>;

const cryptoProvider: VectorCryptoProvider = {
  ready: sodium.ready,
  get secretstreamKeyBytes() {
    return sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES;
  },
  get secretstreamHeaderBytes() {
    return sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  },
  get secretstreamAuthBytes() {
    return sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  },
  get secretstreamTagMessage() {
    return sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  },
  get secretstreamTagFinal() {
    return sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  },
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
  createSha256: () => {
    const hash = createHash("sha256");
    return {
      update: (bytes) => void hash.update(bytes),
      digest: () => new Uint8Array(hash.digest()),
    };
  },
  initPull: (header, key) =>
    sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key),
  pull: (state, ciphertext, aad) =>
    sodium.crypto_secretstream_xchacha20poly1305_pull(
      state as ReturnType<
        typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull
      >,
      ciphertext,
      aad,
    ),
  deriveFromKey: (length, subkeyId, context, key) =>
    sodium.crypto_kdf_derive_from_key(length, subkeyId, context, key),
  decrypt: (ciphertext, aad, nonce, key) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      key,
    ),
  boxSealOpen: (ciphertext, publicKey, secretKey) => {
    try {
      return sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
    } catch {
      return false;
    }
  },
};

let index: VectorIndex;
let tripKey: Uint8Array;
let previewAad: Uint8Array;
let manifestAad: Uint8Array;
let encryptedManifest: Uint8Array;
let manifestPlaintext: Uint8Array;
let decodedManifest: ManifestPlaintext;
let manifestNonce: Uint8Array;
let recipientEnvelope: Uint8Array;
let recipientPublicKey: Uint8Array;
let recipientSecretKey: Uint8Array;
let recipientEnvelopePlaintext: Uint8Array;

function decode(value: string, label: string): Uint8Array {
  return decodeCanonicalBase64(value, label);
}

async function fixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(path, vectorDirectory)));
}

function digest(bytes: Uint8Array): Uint8Array {
  return sha256(bytes, cryptoProvider.createSha256);
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const writer = new BinaryWriter();
  for (const part of parts) {
    writer.writeBytes(part);
  }
  return writer.toUint8Array();
}

function flipped(bytes: Uint8Array, offset: number): Uint8Array {
  const result = bytes.slice();
  result[offset] = (result[offset] as number) ^ 1;
  return result;
}

function writeUint32(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const result = bytes.slice();
  new DataView(result.buffer, result.byteOffset, result.byteLength).setUint32(
    offset,
    value,
    false,
  );
  return result;
}

function mediaRecord(
  variant: "PREVIEW" | "ORIGINAL",
  size: number,
): MediaIndex {
  const record = index.media.find(
    (candidate) =>
      candidate.variant === variant && candidate.plaintextBytes === size,
  );
  if (record === undefined) {
    throw new Error(`missing ${variant} ${size} media fixture`);
  }
  return record;
}

type MediaOverrides = Readonly<{
  streamKey?: Uint8Array;
  aad?: Uint8Array;
  expectedCiphertextBytes?: bigint;
  expectedCiphertextSha256?: Uint8Array;
  expectedPlaintextSha256?: Uint8Array;
}>;

async function readMutatedMedia(
  blob: Uint8Array,
  record: MediaIndex,
  overrides: MediaOverrides = {},
) {
  return readMediaBlob({
    crypto: cryptoProvider,
    blob,
    streamKey:
      overrides.streamKey ?? decode(record.streamKeyBase64, "stream key"),
    aad:
      overrides.aad ??
      encodeMediaAssociatedData({
        tripId: index.context.tripId,
        assetId: index.context.assetId,
        variant: record.variant,
        keyEpoch: 1,
        formatVersion: 1,
      }),
    expectedCiphertextBytes:
      overrides.expectedCiphertextBytes ?? BigInt(blob.byteLength),
    expectedCiphertextSha256:
      overrides.expectedCiphertextSha256 ?? digest(blob),
    expectedPlaintextSha256:
      overrides.expectedPlaintextSha256 ??
      decode(record.plaintextSha256Base64, "plaintext SHA-256"),
  });
}

async function expectMediaFailure(
  operation: Promise<unknown>,
  category: MediaReadError["category"],
): Promise<void> {
  let released: unknown;
  let caught: unknown;
  try {
    released = await operation;
  } catch (error) {
    caught = error;
  }
  expect(released).toBeUndefined();
  expect(caught).toBeInstanceOf(MediaReadError);
  expect((caught as MediaReadError).category).toBe(category);
}

type OracleFrame = Readonly<{ plaintext: Uint8Array; tag: number }>;

function oracleMediaBlob(
  frames: readonly OracleFrame[],
  aad = previewAad,
  key = decode(mediaRecord("PREVIEW", 1).streamKeyBase64, "preview key"),
): Uint8Array {
  const { state, header } =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const writer = new BinaryWriter().writeBytes(header);
  for (const frame of frames) {
    const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      frame.plaintext,
      aad,
      frame.tag,
    );
    writer.writeUint32(ciphertext.byteLength).writeBytes(ciphertext);
  }
  return writer.toUint8Array();
}

type FrameRecord =
  ReturnType<typeof iterateMediaFrames> extends Generator<infer RecordType>
    ? RecordType
    : never;

function rebuildMedia(
  blob: Uint8Array,
  records: readonly FrameRecord[],
): Uint8Array {
  const writer = new BinaryWriter().writeBytes(
    blob.subarray(0, SECRETSTREAM_HEADER_BYTES),
  );
  for (const record of records) {
    writer.writeBytes(record.framedBytes);
  }
  return writer.toUint8Array();
}

function manifestKey(key = tripKey): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(
    32,
    MANIFEST_KDF_SUBKEY_ID,
    MANIFEST_KDF_CONTEXT,
    key,
  );
}

function encryptManifestMutation(
  plaintext: Uint8Array,
  aad = manifestAad,
  key = tripKey,
  nonce = manifestNonce,
): Uint8Array {
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    manifestKey(key),
  );
  return join([nonce, ciphertext]);
}

async function expectManifestFailure(
  operation: Promise<unknown>,
  category: ManifestReadError["category"],
): Promise<void> {
  let released: unknown;
  let caught: unknown;
  try {
    released = await operation;
  } catch (error) {
    caught = error;
  }
  expect(released).toBeUndefined();
  expect(caught).toBeInstanceOf(ManifestReadError);
  expect((caught as ManifestReadError).category).toBe(category);
}

function readManifestMutation(
  blob: Uint8Array,
  key = tripKey,
  aad = manifestAad,
) {
  return readEncryptedManifest({
    crypto: cryptoProvider,
    encryptedManifest: blob,
    tripKey: key,
    aad,
  });
}

function envelopeInput(ciphertext = recipientEnvelope) {
  return {
    crypto: cryptoProvider,
    ciphertext,
    recipientPublicKey,
    recipientSecretKey,
    expectedTripId: index.context.tripId,
    expectedSenderDeviceId: index.context.ownerDeviceId,
    expectedRecipientDeviceId: index.context.recipientDeviceId,
    expectedRecipientE2eeKeyVersion: index.context.recipientE2eeKeyVersion,
  } as const;
}

function expectEnvelopeFailure(
  operation: () => unknown,
  category: EnvelopeReadError["category"],
): void {
  let released: unknown;
  let caught: unknown;
  try {
    released = operation();
  } catch (error) {
    caught = error;
  }
  expect(released).toBeUndefined();
  expect(caught).toBeInstanceOf(EnvelopeReadError);
  expect((caught as EnvelopeReadError).category).toBe(category);
}

beforeAll(async () => {
  await sodium.ready;
  index = JSON.parse(
    await readFile(new URL("index.json", vectorDirectory), "utf8"),
  ) as VectorIndex;
  tripKey = decode(index.secrets.tripKeyBase64, "trip key");
  previewAad = encodeMediaAssociatedData({
    tripId: index.context.tripId,
    assetId: index.context.assetId,
    variant: "PREVIEW",
    keyEpoch: 1,
    formatVersion: 1,
  });
  manifestAad = encodeManifestAssociatedData({
    tripId: index.context.tripId,
    assetId: index.context.assetId,
    keyEpoch: 1,
    formatVersion: 1,
  });
  encryptedManifest = await fixture(index.manifest.file);
  manifestNonce = encryptedManifest.subarray(0, 24).slice();
  manifestPlaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    encryptedManifest.subarray(24),
    manifestAad,
    manifestNonce,
    manifestKey(),
  );
  decodedManifest = await readManifestMutation(encryptedManifest);

  const recipient = index.envelopes.find(
    (envelope) => envelope.kind === "OWNER_RECIPIENT",
  );
  if (recipient === undefined) {
    throw new Error("missing owner-recipient envelope fixture");
  }
  recipientEnvelope = await fixture(recipient.file);
  recipientPublicKey = decode(
    recipient.recipientPublicKeyBase64,
    "recipient public key",
  );
  recipientSecretKey = decode(
    index.secrets.recipientSecretKeyBase64,
    "recipient secret key",
  );
  recipientEnvelopePlaintext = sodium.crypto_box_seal_open(
    recipientEnvelope,
    recipientPublicKey,
    recipientSecretKey,
  );
});

describe("AAD mutations", () => {
  it("normalizes UUID case but rejects malformed UUIDs and non-exact objects", () => {
    const lowercase = encodeMediaAssociatedData({
      tripId: index.context.tripId,
      assetId: index.context.assetId,
      variant: "PREVIEW",
      keyEpoch: 1,
      formatVersion: 1,
    });
    const uppercase = encodeMediaAssociatedData({
      tripId: index.context.tripId.toUpperCase(),
      assetId: index.context.assetId.toUpperCase(),
      variant: "PREVIEW",
      keyEpoch: 1,
      formatVersion: 1,
    });
    expect(uppercase).toEqual(lowercase);

    expect(() =>
      encodeMediaAssociatedData({
        tripId: index.context.tripId.replaceAll("-", ""),
        assetId: index.context.assetId,
        variant: "PREVIEW",
        keyEpoch: 1,
        formatVersion: 1,
      }),
    ).toThrow(/UUID/u);
    expect(() =>
      encodeMediaAssociatedData({
        tripId: index.context.tripId,
        assetId: index.context.assetId,
        variant: "PREVIEW",
        keyEpoch: 1,
      }),
    ).toThrow(/missing formatVersion/u);
    expect(() =>
      encodeMediaAssociatedData({
        tripId: index.context.tripId,
        assetId: index.context.assetId,
        variant: "PREVIEW",
        keyEpoch: 1,
        formatVersion: 1,
        fallbackVersion: 0,
      }),
    ).toThrow(/unexpected field/u);
  });

  it("authenticates trip, asset, variant, epoch, format, order, endian, width, and every byte", async () => {
    const record = mediaRecord("PREVIEW", 1);
    const blob = await fixture(record.file);
    const swappedIds = previewAad.slice();
    const trip = swappedIds.slice(14, 50);
    swappedIds.set(swappedIds.subarray(50, 86), 14);
    swappedIds.set(trip, 50);
    const epochLittleEndian = previewAad.slice();
    epochLittleEndian.set(Uint8Array.of(1, 0, 0, 0), 87);
    const formatLittleEndian = previewAad.slice();
    formatLittleEndian.set(Uint8Array.of(1, 0, 0, 0), 91);
    const cases = [
      ["wrong trip", flipped(previewAad, 14)],
      ["wrong asset", flipped(previewAad, 50)],
      ["wrong variant", flipped(previewAad, 86)],
      ["wrong epoch", flipped(previewAad, 90)],
      ["wrong format", flipped(previewAad, 94)],
      ["field order", swappedIds],
      ["epoch byte order", epochLittleEndian],
      ["format byte order", formatLittleEndian],
      ["missing byte", previewAad.subarray(0, previewAad.byteLength - 1)],
      ["extra byte", join([previewAad, Uint8Array.of(0)])],
      ["single domain bit", flipped(previewAad, 0)],
    ] as const;

    for (const [_label, aad] of cases) {
      await expectMediaFailure(
        readMutatedMedia(blob, record, { aad }),
        aad.byteLength === previewAad.byteLength
          ? "AUTHENTICATION"
          : "STRUCTURE",
      );
    }
  });
});

describe("media framing and authentication mutations", () => {
  it("rejects first, middle, and final header and ciphertext bits", async () => {
    const record = mediaRecord("PREVIEW", 262_145);
    const blob = await fixture(record.file);
    const records = [...iterateMediaFrames(blob)];
    const first = records[0];
    const final = records[1];
    if (first === undefined || final === undefined) {
      throw new Error("expected two-frame fixture");
    }
    const offsets = [
      0,
      12,
      23,
      first.ciphertextOffset,
      first.ciphertextOffset + Math.floor(first.ciphertextLength / 2),
      final.ciphertextOffset + final.ciphertextLength - 1,
    ];
    for (const offset of offsets) {
      await expectMediaFailure(
        readMutatedMedia(flipped(blob, offset), record),
        "AUTHENTICATION",
      );
    }
  });

  it("accepts only canonical 17 and 262161 prefixes in their valid positions", async () => {
    const emptyRecord = mediaRecord("PREVIEW", 0);
    const empty = await fixture(emptyRecord.file);
    expect(
      [...iterateMediaFrames(empty)].map((frame) => frame.ciphertextLength),
    ).toEqual([17]);
    await expect(readMutatedMedia(empty, emptyRecord)).resolves.toBeDefined();

    const fullRecord = mediaRecord("PREVIEW", 262_144);
    const full = await fixture(fullRecord.file);
    expect(
      [...iterateMediaFrames(full)].map((frame) => frame.ciphertextLength),
    ).toEqual([262_161]);
    await expect(readMutatedMedia(full, fullRecord)).resolves.toBeDefined();

    const oneRecord = mediaRecord("PREVIEW", 1);
    const one = await fixture(oneRecord.file);
    for (const value of [0, 16, 17, 262_161]) {
      await expectMediaFailure(
        readMutatedMedia(writeUint32(one, 24, value), oneRecord),
        "STRUCTURE",
      );
    }
    await expectMediaFailure(
      readMutatedMedia(writeUint32(full, 24, 262_162), fullRecord),
      "STRUCTURE",
    );
  });

  it("rejects partial headers, prefixes, frames, and every structural boundary cut", async () => {
    const record = mediaRecord("PREVIEW", 262_145);
    const blob = await fixture(record.file);
    const frames = [...iterateMediaFrames(blob)];
    const first = frames[0];
    const final = frames[1];
    if (first === undefined || final === undefined) {
      throw new Error("expected two-frame fixture");
    }
    const cuts = new Set([
      0,
      1,
      23,
      24,
      25,
      27,
      first.ciphertextOffset,
      first.ciphertextOffset + 1,
      first.ciphertextOffset + Math.floor(first.ciphertextLength / 2),
      first.ciphertextOffset + first.ciphertextLength - 1,
      first.ciphertextOffset + first.ciphertextLength,
      final.prefixOffset + 1,
      final.ciphertextOffset,
      final.ciphertextOffset + 1,
      final.ciphertextOffset + Math.floor(final.ciphertextLength / 2),
      blob.byteLength - 1,
    ]);
    for (const cut of cuts) {
      await expectMediaFailure(
        readMutatedMedia(blob.subarray(0, cut), record),
        "STRUCTURE",
      );
    }
  });

  it("rejects missing/early FINAL, trailing bytes, reorder, duplicate, omit-middle, and cross-variant frames", async () => {
    const full = Uint8Array.from(
      { length: MEDIA_PLAINTEXT_FRAME_BYTES },
      (_, offset) => (offset * 29 + 17) & 0xff,
    );
    const last = Uint8Array.of(0x5a);
    const missingFinal = oracleMediaBlob([
      { plaintext: full, tag: SECRETSTREAM_TAG_MESSAGE },
    ]);
    await expectMediaFailure(
      readMutatedMedia(missingFinal, mediaRecord("PREVIEW", 262_144), {
        expectedPlaintextSha256: digest(full),
      }),
      "STRUCTURE",
    );

    const earlyFinal = oracleMediaBlob([
      { plaintext: full, tag: SECRETSTREAM_TAG_FINAL },
      { plaintext: last, tag: SECRETSTREAM_TAG_FINAL },
    ]);
    await expectMediaFailure(
      readMutatedMedia(earlyFinal, mediaRecord("PREVIEW", 262_145)),
      "STRUCTURE",
    );

    const canonicalThree = oracleMediaBlob([
      { plaintext: full, tag: SECRETSTREAM_TAG_MESSAGE },
      { plaintext: full, tag: SECRETSTREAM_TAG_MESSAGE },
      { plaintext: last, tag: SECRETSTREAM_TAG_FINAL },
    ]);
    const records = [...iterateMediaFrames(canonicalThree)];
    const arrangements: readonly (readonly FrameRecord[])[] = [
      [
        records[2] as FrameRecord,
        records[1] as FrameRecord,
        records[0] as FrameRecord,
      ],
      [
        records[0] as FrameRecord,
        records[1] as FrameRecord,
        records[1] as FrameRecord,
        records[2] as FrameRecord,
      ],
      [records[0] as FrameRecord, records[2] as FrameRecord],
    ];
    for (const items of arrangements) {
      const mutation = rebuildMedia(canonicalThree, items);
      await expectMediaFailure(
        readMutatedMedia(mutation, mediaRecord("PREVIEW", 262_145)),
        "AUTHENTICATION",
      );
    }

    const preview = await fixture(mediaRecord("PREVIEW", 1).file);
    const original = await fixture(mediaRecord("ORIGINAL", 1).file);
    const crossVariant = rebuildMedia(preview, [
      ...iterateMediaFrames(original),
    ]);
    await expectMediaFailure(
      readMutatedMedia(crossVariant, mediaRecord("PREVIEW", 1)),
      "AUTHENTICATION",
    );
  });

  it("rejects short authenticated non-final frames and both forbidden tags", async () => {
    const shortMessage = oracleMediaBlob([
      { plaintext: Uint8Array.of(1), tag: SECRETSTREAM_TAG_MESSAGE },
    ]);
    await expectMediaFailure(
      readMutatedMedia(shortMessage, mediaRecord("PREVIEW", 1)),
      "STRUCTURE",
    );
    for (const tag of [
      sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_REKEY,
    ]) {
      const forbidden = oracleMediaBlob([{ plaintext: Uint8Array.of(1), tag }]);
      await expectMediaFailure(
        readMutatedMedia(forbidden, mediaRecord("PREVIEW", 1)),
        "STRUCTURE",
      );
    }
  });

  it("distinguishes wrong key, plaintext hash, ciphertext hash, and length", async () => {
    const record = mediaRecord("PREVIEW", 1);
    const blob = await fixture(record.file);
    await expectMediaFailure(
      readMutatedMedia(blob, record, {
        streamKey: flipped(decode(record.streamKeyBase64, "key"), 0),
      }),
      "AUTHENTICATION",
    );
    await expectMediaFailure(
      readMutatedMedia(blob, record, {
        expectedPlaintextSha256: new Uint8Array(32),
      }),
      "CHECKSUM",
    );
    await expectMediaFailure(
      readMutatedMedia(blob, record, {
        expectedCiphertextSha256: new Uint8Array(32),
      }),
      "CHECKSUM",
    );
    await expectMediaFailure(
      readMutatedMedia(blob, record, {
        expectedCiphertextBytes: BigInt(blob.byteLength + 1),
      }),
      "CHECKSUM",
    );
  });
});

describe("manifest mutations", () => {
  it("rejects nonce, key, AAD, ciphertext truncation, and extension as authentication failures", async () => {
    const authCases = [
      [flipped(encryptedManifest, 0), tripKey, manifestAad],
      [flipped(encryptedManifest, 12), tripKey, manifestAad],
      [flipped(encryptedManifest, 23), tripKey, manifestAad],
      [encryptedManifest, flipped(tripKey, 0), manifestAad],
      [encryptedManifest, tripKey, flipped(manifestAad, 0)],
      [
        encryptedManifest.subarray(0, encryptedManifest.byteLength - 1),
        tripKey,
        manifestAad,
      ],
      [join([encryptedManifest, Uint8Array.of(0)]), tripKey, manifestAad],
    ] as const;
    for (const [blob, key, aad] of authCases) {
      await expectManifestFailure(
        readManifestMutation(blob, key, aad),
        "AUTHENTICATION",
      );
    }
  });

  it("distinguishes authenticated semantic domain/schema mutations", async () => {
    const domain = flipped(manifestPlaintext, 0);
    const schema = manifestPlaintext.slice();
    schema[11] = 2;
    await expectManifestFailure(
      readManifestMutation(encryptManifestMutation(domain)),
      "SEMANTIC",
    );
    await expectManifestFailure(
      readManifestMutation(encryptManifestMutation(schema)),
      "SEMANTIC",
    );
  });

  it("rejects noncanonical filenames/MIME, invalid UTF-8, and length overrun structurally", async () => {
    const pathFilename = manifestPlaintext.slice();
    pathFilename[55] = 0x2f;
    const invalidUtf8 = manifestPlaintext.slice();
    invalidUtf8[55] = 0xff;
    const lengthOverrun = manifestPlaintext.slice();
    lengthOverrun[53] = 0xff;
    lengthOverrun[54] = 0xff;
    const uppercaseMime = manifestPlaintext.slice();
    uppercaseMime[66] = 0x49;
    const decomposedName = new TextEncoder().encode("Cafe\u0301.jpg");
    const decomposed = join([
      manifestPlaintext.subarray(0, 53),
      Uint8Array.of(0, decomposedName.byteLength),
      decomposedName,
      manifestPlaintext.subarray(64),
    ]);
    for (const plaintext of [
      pathFilename,
      invalidUtf8,
      lengthOverrun,
      uppercaseMime,
      decomposed,
    ]) {
      await expectManifestFailure(
        readManifestMutation(encryptManifestMutation(plaintext)),
        "STRUCTURE",
      );
    }
  });

  it("rejects every invalid capture flag/value pairing", async () => {
    const absentWithValue = manifestPlaintext.slice();
    absentWithValue[44] = 0;
    const presentWithZero = manifestPlaintext.slice();
    presentWithZero.fill(0, 45, 53);
    const unknownFlag = manifestPlaintext.slice();
    unknownFlag[44] = 2;
    for (const plaintext of [absentWithValue, presentWithZero, unknownFlag]) {
      await expectManifestFailure(
        readManifestMutation(encryptManifestMutation(plaintext)),
        "STRUCTURE",
      );
    }
  });

  it("rejects duplicate, missing, reversed, and unknown descriptors", async () => {
    const duplicate = manifestPlaintext.slice();
    duplicate[164] = 1;
    const reversed = manifestPlaintext.slice();
    reversed[64] = 2;
    const unknown = manifestPlaintext.slice();
    unknown[64] = 3;
    const missing = manifestPlaintext.subarray(0, 164);
    for (const plaintext of [duplicate, reversed, unknown, missing]) {
      await expectManifestFailure(
        readManifestMutation(encryptManifestMutation(plaintext)),
        "STRUCTURE",
      );
    }
  });

  it("classifies authenticated descriptor byte/hash/length disagreements as final checksum failures", async () => {
    const mutations: readonly Partial<ManifestPlaintext["preview"]>[] = [
      { plaintextBytes: decodedManifest.preview.plaintextBytes + 1n },
      { ciphertextBytes: decodedManifest.preview.ciphertextBytes + 1n },
      {
        plaintextSha256: flipped(decodedManifest.preview.plaintextSha256, 0),
      },
      {
        ciphertextSha256: flipped(decodedManifest.preview.ciphertextSha256, 31),
      },
    ];
    for (const replacement of mutations) {
      const plaintext = encodeManifestPlaintext({
        ...decodedManifest,
        preview: { ...decodedManifest.preview, ...replacement },
      });
      const opened = await readManifestMutation(
        encryptManifestMutation(plaintext),
      );
      expect(() =>
        assertManifestDescriptorMatches(
          opened.preview,
          decodedManifest.preview,
        ),
      ).toThrowError(expect.objectContaining({ category: "CHECKSUM" }));
    }
  });
});

describe("trip-key envelope mutations", () => {
  it("rejects a wrong recipient key and first/middle/final ciphertext bits", () => {
    const owner = index.envelopes.find(
      (envelope) => envelope.kind === "OWNER_SELF",
    );
    if (owner === undefined) {
      throw new Error("missing owner-self envelope fixture");
    }
    expectEnvelopeFailure(
      () =>
        openEnvelopeForContext({
          ...envelopeInput(),
          recipientPublicKey: decode(
            owner.recipientPublicKeyBase64,
            "owner public key",
          ),
          recipientSecretKey: decode(
            index.secrets.ownerSecretKeyBase64,
            "owner secret key",
          ),
        }),
      "AUTHENTICATION",
    );
    for (const offset of [
      0,
      Math.floor(recipientEnvelope.byteLength / 2),
      recipientEnvelope.byteLength - 1,
    ]) {
      expectEnvelopeFailure(
        () =>
          openEnvelopeForContext(
            envelopeInput(flipped(recipientEnvelope, offset)),
          ),
        "AUTHENTICATION",
      );
    }
  });

  it("rejects every authenticated inner context-field mutation", () => {
    const contextOffsets = [0, 11, 12, 31, 32, 48, 67] as const;
    for (const offset of contextOffsets) {
      const plaintext = flipped(recipientEnvelopePlaintext, offset);
      const ciphertext = sodium.crypto_box_seal(plaintext, recipientPublicKey);
      expectEnvelopeFailure(
        () => openEnvelopeForContext(envelopeInput(ciphertext)),
        "SEMANTIC_CONTEXT",
      );
    }
    expectEnvelopeFailure(
      () =>
        openEnvelopeForContext({
          ...envelopeInput(),
          expectedRecipientE2eeKeyVersion: 2,
        }),
      "SEMANTIC_CONTEXT",
    );
  });

  it("rejects every field-boundary truncation, one-byte extension, and wrong decoded length structurally", () => {
    const sealedBoxOverhead = 48;
    const innerBoundaries = [0, 8, 12, 28, 32, 48, 64, 68, 99] as const;
    for (const boundary of innerBoundaries) {
      expectEnvelopeFailure(
        () =>
          openEnvelopeForContext(
            envelopeInput(
              recipientEnvelope.subarray(0, sealedBoxOverhead + boundary),
            ),
          ),
        "STRUCTURE",
      );
    }
    expectEnvelopeFailure(
      () =>
        openEnvelopeForContext(
          envelopeInput(join([recipientEnvelope, Uint8Array.of(0)])),
        ),
      "STRUCTURE",
    );
    const wrongLengthBase64 = Buffer.from(
      recipientEnvelope.subarray(0, recipientEnvelope.byteLength - 1),
    ).toString("base64");
    expectEnvelopeFailure(
      () =>
        openEnvelopeForContext(
          envelopeInput(
            decodeCanonicalBase64(wrongLengthBase64, "short envelope"),
          ),
        ),
      "STRUCTURE",
    );
  });

  it("accepts only the named context-correct first-import substitution residual risk", async () => {
    const substitution = index.envelopes.find(
      (envelope) => envelope.kind === "FIRST_IMPORT_SUBSTITUTION",
    );
    if (substitution === undefined) {
      throw new Error("missing substitution envelope fixture");
    }
    const substitutedTripKey = openEnvelopeForContext({
      ...envelopeInput(await fixture(substitution.file)),
      recipientPublicKey: decode(
        substitution.recipientPublicKeyBase64,
        "substitution recipient public key",
      ),
    });
    expect(substitutedTripKey).toHaveLength(32);
    expect(substitutedTripKey).not.toEqual(tripKey);
  });
});
