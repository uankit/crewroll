import { createHash } from "node:crypto";

import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";

import { encodeMediaAssociatedData } from "../crypto/aad.js";
import { BinaryWriter } from "../crypto/binary.js";
import { sha256 } from "../crypto/checksums.js";
import {
  MediaReadError,
  calculateMediaLayout,
  iterateMediaFrames,
  readMediaBlob,
  type MediaCryptoProvider,
} from "../crypto/media.js";
import {
  MEDIA_PLAINTEXT_FRAME_BYTES,
  SECRETSTREAM_TAG_FINAL,
  SECRETSTREAM_TAG_MESSAGE,
} from "../crypto/protocol.js";

const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const assetId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const aad = encodeMediaAssociatedData({
  tripId,
  assetId,
  variant: "PREVIEW",
  keyEpoch: 1,
  formatVersion: 1,
});
const streamKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const cryptoProvider: MediaCryptoProvider = {
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
  createSha256: () => {
    const hash = createHash("sha256");
    return {
      update: (bytes) => void hash.update(bytes),
      digest: () => new Uint8Array(hash.digest()),
    };
  },
  initPull: (header, key) =>
    sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key),
  pull: (state, ciphertext, associatedData) =>
    sodium.crypto_secretstream_xchacha20poly1305_pull(
      state as ReturnType<
        typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull
      >,
      ciphertext,
      associatedData,
    ),
};

function digest(bytes: Uint8Array): Uint8Array {
  return sha256(bytes, cryptoProvider.createSha256);
}

function plaintextPattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 29 + 17) & 0xff);
}

type OracleFrame = Readonly<{ plaintext: Uint8Array; tag: number }>;

function oracleBlob(frames: readonly OracleFrame[]): Uint8Array {
  const { state, header } =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(streamKey);
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

function canonicalOracleBlob(plaintext: Uint8Array): Uint8Array {
  if (plaintext.byteLength === 0) {
    return oracleBlob([{ plaintext, tag: SECRETSTREAM_TAG_FINAL }]);
  }
  const frames: OracleFrame[] = [];
  for (
    let offset = 0;
    offset < plaintext.byteLength;
    offset += MEDIA_PLAINTEXT_FRAME_BYTES
  ) {
    const chunk = plaintext.subarray(
      offset,
      Math.min(offset + MEDIA_PLAINTEXT_FRAME_BYTES, plaintext.byteLength),
    );
    const isFinal = offset + chunk.byteLength === plaintext.byteLength;
    frames.push({
      plaintext: chunk,
      tag: isFinal ? SECRETSTREAM_TAG_FINAL : SECRETSTREAM_TAG_MESSAGE,
    });
  }
  return oracleBlob(frames);
}

async function readCanonical(
  blob: Uint8Array,
  plaintext: Uint8Array,
): Promise<Awaited<ReturnType<typeof readMediaBlob>>> {
  return readMediaBlob({
    crypto: cryptoProvider,
    blob,
    streamKey,
    aad,
    expectedCiphertextBytes: BigInt(blob.byteLength),
    expectedCiphertextSha256: digest(blob),
    expectedPlaintextSha256: digest(plaintext),
  });
}

beforeAll(async () => {
  await sodium.ready;
});

describe("canonical media sizing and framing", () => {
  it.each([
    [0, 1n, 45n],
    [1, 1n, 46n],
    [262_144, 1n, 262_189n],
    [262_145, 2n, 262_211n],
  ])(
    "calculates %i plaintext bytes as %s frame(s) and %s blob bytes",
    (plaintextBytes, frameCount, ciphertextBytes) => {
      expect(calculateMediaLayout(plaintextBytes)).toEqual({
        plaintextBytes: BigInt(plaintextBytes),
        frameCount,
        ciphertextBytes,
      });
    },
  );

  it.each([0, 1, 262_144, 262_145])(
    "reads a canonical %i-byte oracle stream",
    async (plaintextBytes) => {
      const plaintext = plaintextPattern(plaintextBytes);
      const blob = canonicalOracleBlob(plaintext);
      const expected = calculateMediaLayout(plaintextBytes);

      expect(BigInt(blob.byteLength)).toBe(expected.ciphertextBytes);
      const result = await readCanonical(blob, plaintext);
      expect(result).toMatchObject({
        plaintextBytes: BigInt(plaintextBytes),
        frameCount: Number(expected.frameCount),
      });
      expect(result.plaintextSha256).toEqual(digest(plaintext));
      expect(result.ciphertextSha256).toEqual(digest(blob));
    },
  );

  it("uses one empty final frame and makes an exact multiple final without an extra frame", async () => {
    const emptyBlob = canonicalOracleBlob(new Uint8Array());
    expect([...iterateMediaFrames(emptyBlob)]).toHaveLength(1);
    expect((await readCanonical(emptyBlob, new Uint8Array())).frameCount).toBe(
      1,
    );

    const full = plaintextPattern(MEDIA_PLAINTEXT_FRAME_BYTES);
    const fullBlob = canonicalOracleBlob(full);
    expect([...iterateMediaFrames(fullBlob)]).toHaveLength(1);
    expect((await readCanonical(fullBlob, full)).frameCount).toBe(1);
  });

  it("uses 4-byte BE ciphertext lengths and full non-final plaintext chunks", async () => {
    const plaintext = plaintextPattern(MEDIA_PLAINTEXT_FRAME_BYTES + 1);
    const blob = canonicalOracleBlob(plaintext);
    const records = [...iterateMediaFrames(blob)];

    expect(records.map((record) => record.ciphertextLength)).toEqual([
      262_161, 18,
    ]);
    expect([...blob.subarray(24, 28)]).toEqual([0, 4, 0, 17]);
    expect((await readCanonical(blob, plaintext)).frameCount).toBe(2);
  });

  it("hashes the complete blob including header and length prefixes", () => {
    const blob = canonicalOracleBlob(plaintextPattern(1));
    const ciphertextOnly = [...iterateMediaFrames(blob)].map(
      (frame) => frame.ciphertext,
    );

    expect(digest(blob)).not.toEqual(
      digest(Uint8Array.from(ciphertextOnly.flatMap((bytes) => [...bytes]))),
    );
  });
});

describe("fail-closed media reader", () => {
  it.each([
    ["short header", new Uint8Array(23)],
    ["no frame", new Uint8Array(24)],
    ["partial prefix", new Uint8Array(26)],
  ])("rejects %s", async (_label, blob) => {
    await expect(
      readMediaBlob({
        crypto: cryptoProvider,
        blob,
        streamKey,
        aad,
        expectedCiphertextBytes: BigInt(blob.byteLength),
        expectedCiphertextSha256: digest(blob),
        expectedPlaintextSha256: digest(new Uint8Array()),
      }),
    ).rejects.toBeInstanceOf(MediaReadError);
  });

  it("accepts only MESSAGE and FINAL tags with canonical lengths", async () => {
    const forbiddenTagBlob = oracleBlob([
      { plaintext: new Uint8Array(), tag: 1 },
    ]);
    const shortMessageBlob = oracleBlob([
      { plaintext: Uint8Array.of(1), tag: SECRETSTREAM_TAG_MESSAGE },
      { plaintext: new Uint8Array(), tag: SECRETSTREAM_TAG_FINAL },
    ]);

    await expect(
      readCanonical(forbiddenTagBlob, new Uint8Array()),
    ).rejects.toMatchObject({ category: "STRUCTURE" });
    await expect(
      readCanonical(shortMessageBlob, Uint8Array.of(1)),
    ).rejects.toMatchObject({ category: "STRUCTURE" });
  });

  it("requires FINAL at exact EOF", async () => {
    const missingFinal = oracleBlob([
      {
        plaintext: plaintextPattern(MEDIA_PLAINTEXT_FRAME_BYTES),
        tag: SECRETSTREAM_TAG_MESSAGE,
      },
    ]);
    const earlyFinal = oracleBlob([
      { plaintext: Uint8Array.of(1), tag: SECRETSTREAM_TAG_FINAL },
      { plaintext: Uint8Array.of(2), tag: SECRETSTREAM_TAG_FINAL },
    ]);

    await expect(
      readCanonical(
        missingFinal,
        plaintextPattern(MEDIA_PLAINTEXT_FRAME_BYTES),
      ),
    ).rejects.toMatchObject({ category: "STRUCTURE" });
    await expect(
      readCanonical(earlyFinal, Uint8Array.of(1, 2)),
    ).rejects.toMatchObject({ category: "STRUCTURE" });
  });

  it("rejects authentication and final checksum disagreement without a result", async () => {
    const plaintext = plaintextPattern(1);
    const blob = canonicalOracleBlob(plaintext);
    const corrupted = blob.slice();
    const finalIndex = corrupted.length - 1;
    corrupted[finalIndex] = (corrupted[finalIndex] as number) ^ 1;

    await expect(
      readMediaBlob({
        crypto: cryptoProvider,
        blob: corrupted,
        streamKey,
        aad,
        expectedCiphertextBytes: BigInt(corrupted.byteLength),
        expectedCiphertextSha256: digest(corrupted),
        expectedPlaintextSha256: digest(plaintext),
      }),
    ).rejects.toMatchObject({ category: "AUTHENTICATION" });

    await expect(
      readMediaBlob({
        crypto: cryptoProvider,
        blob,
        streamKey,
        aad,
        expectedCiphertextBytes: BigInt(blob.byteLength),
        expectedCiphertextSha256: digest(blob),
        expectedPlaintextSha256: new Uint8Array(32),
      }),
    ).rejects.toMatchObject({ category: "CHECKSUM" });
  });
});
