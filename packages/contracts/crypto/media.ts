import { BinaryReader, assertUint64 } from "./binary.js";
import { checksumsEqual, type Sha256Factory } from "./checksums.js";
import {
  CHECKSUM_BYTES,
  MEDIA_AAD_BYTES,
  MEDIA_FRAME_LENGTH_PREFIX_BYTES,
  MEDIA_MAX_CIPHERTEXT_FRAME_BYTES,
  MEDIA_MIN_CIPHERTEXT_FRAME_BYTES,
  MEDIA_PLAINTEXT_FRAME_BYTES,
  SECRETSTREAM_AUTH_BYTES,
  SECRETSTREAM_HEADER_BYTES,
  SECRETSTREAM_KEY_BYTES,
  SECRETSTREAM_TAG_FINAL,
  SECRETSTREAM_TAG_MESSAGE,
} from "./protocol.js";

const UINT64_MAX = (1n << 64n) - 1n;
const FRAME_BYTES = BigInt(MEDIA_PLAINTEXT_FRAME_BYTES);
const FRAME_STORAGE_OVERHEAD = BigInt(
  MEDIA_FRAME_LENGTH_PREFIX_BYTES + SECRETSTREAM_AUTH_BYTES,
);

export type MediaReadFailureCategory =
  "STRUCTURE" | "AUTHENTICATION" | "CHECKSUM";

export class MediaReadError extends Error {
  readonly category: MediaReadFailureCategory;

  constructor(category: MediaReadFailureCategory, message: string) {
    super(message);
    this.name = "MediaReadError";
    this.category = category;
  }
}

export type MediaLayout = Readonly<{
  plaintextBytes: bigint;
  frameCount: bigint;
  ciphertextBytes: bigint;
}>;

export type MediaFrameRecord = Readonly<{
  index: number;
  prefixOffset: number;
  ciphertextOffset: number;
  ciphertextLength: number;
  ciphertext: Uint8Array;
  framedBytes: Uint8Array;
  isLast: boolean;
}>;

export type ReadMediaBlobInput = Readonly<{
  crypto: MediaCryptoProvider;
  blob: Uint8Array;
  streamKey: Uint8Array;
  aad: Uint8Array;
  expectedCiphertextBytes: bigint;
  expectedCiphertextSha256: Uint8Array;
  expectedPlaintextSha256: Uint8Array;
}>;

export type MediaCryptoProvider = Readonly<{
  ready: Promise<unknown>;
  secretstreamKeyBytes: number;
  secretstreamHeaderBytes: number;
  secretstreamAuthBytes: number;
  secretstreamTagMessage: number;
  secretstreamTagFinal: number;
  createSha256: Sha256Factory;
  initPull: (header: Uint8Array, key: Uint8Array) => unknown;
  pull: (
    state: unknown,
    ciphertext: Uint8Array,
    aad: Uint8Array,
  ) => { message: Uint8Array; tag: number } | false;
}>;

export type MediaReadResult = Readonly<{
  frameCount: number;
  plaintextBytes: bigint;
  plaintextSha256: Uint8Array;
  ciphertextSha256: Uint8Array;
}>;

function toUint64(value: number | bigint, label: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a nonnegative safe integer`);
    }
    return BigInt(value);
  }
  return assertUint64(value, label);
}

function requireWidth(bytes: Uint8Array, width: number, label: string): void {
  if (bytes.byteLength !== width) {
    throw new MediaReadError(
      "STRUCTURE",
      `${label} must be exactly ${width} bytes`,
    );
  }
}

function assertSodiumConstants(crypto: MediaCryptoProvider): void {
  const bindings = [
    [crypto.secretstreamKeyBytes, SECRETSTREAM_KEY_BYTES, "secretstream key"],
    [
      crypto.secretstreamHeaderBytes,
      SECRETSTREAM_HEADER_BYTES,
      "secretstream header",
    ],
    [
      crypto.secretstreamAuthBytes,
      SECRETSTREAM_AUTH_BYTES,
      "secretstream overhead",
    ],
    [crypto.secretstreamTagMessage, SECRETSTREAM_TAG_MESSAGE, "MESSAGE tag"],
    [crypto.secretstreamTagFinal, SECRETSTREAM_TAG_FINAL, "FINAL tag"],
  ] as const;

  for (const [actual, expected, label] of bindings) {
    if (actual !== expected) {
      throw new Error(`${label} binding does not match CrewRoll format v1`);
    }
  }
}

export function calculateMediaLayout(
  plaintextBytes: number | bigint,
): MediaLayout {
  const canonicalPlaintextBytes = toUint64(plaintextBytes, "plaintextBytes");
  const frameCount =
    canonicalPlaintextBytes === 0n
      ? 1n
      : (canonicalPlaintextBytes + FRAME_BYTES - 1n) / FRAME_BYTES;
  const ciphertextBytes =
    BigInt(SECRETSTREAM_HEADER_BYTES) +
    canonicalPlaintextBytes +
    frameCount * FRAME_STORAGE_OVERHEAD;
  if (ciphertextBytes > UINT64_MAX) {
    throw new RangeError("framed media length exceeds uint64");
  }
  return {
    plaintextBytes: canonicalPlaintextBytes,
    frameCount,
    ciphertextBytes,
  };
}

export function* iterateMediaFrames(
  blob: Uint8Array,
): Generator<MediaFrameRecord> {
  if (blob.byteLength < SECRETSTREAM_HEADER_BYTES) {
    throw new MediaReadError("STRUCTURE", "media header is truncated");
  }

  const reader = new BinaryReader(blob);
  reader.readBytes(SECRETSTREAM_HEADER_BYTES);
  if (reader.remaining === 0) {
    throw new MediaReadError("STRUCTURE", "media blob contains no frame");
  }

  let index = 0;
  while (reader.remaining > 0) {
    if (reader.remaining < MEDIA_FRAME_LENGTH_PREFIX_BYTES) {
      throw new MediaReadError("STRUCTURE", "media length prefix is truncated");
    }
    const prefixOffset = reader.offset;
    const ciphertextLength = reader.readUint32();
    if (
      ciphertextLength < MEDIA_MIN_CIPHERTEXT_FRAME_BYTES ||
      ciphertextLength > MEDIA_MAX_CIPHERTEXT_FRAME_BYTES
    ) {
      throw new MediaReadError(
        "STRUCTURE",
        `media ciphertext length ${ciphertextLength} is outside v1 bounds`,
      );
    }
    if (reader.remaining < ciphertextLength) {
      throw new MediaReadError("STRUCTURE", "media ciphertext is truncated");
    }
    const ciphertextOffset = reader.offset;
    const ciphertext = reader.readBytes(ciphertextLength);
    yield {
      index,
      prefixOffset,
      ciphertextOffset,
      ciphertextLength,
      ciphertext,
      framedBytes: blob.subarray(prefixOffset, reader.offset),
      isLast: reader.remaining === 0,
    };
    index += 1;
  }
}

export async function readMediaBlob(
  input: ReadMediaBlobInput,
): Promise<MediaReadResult> {
  requireWidth(input.streamKey, SECRETSTREAM_KEY_BYTES, "stream key");
  requireWidth(input.aad, MEDIA_AAD_BYTES, "media AAD");
  requireWidth(
    input.expectedCiphertextSha256,
    CHECKSUM_BYTES,
    "ciphertext SHA-256",
  );
  requireWidth(
    input.expectedPlaintextSha256,
    CHECKSUM_BYTES,
    "plaintext SHA-256",
  );
  assertUint64(input.expectedCiphertextBytes, "expectedCiphertextBytes");
  if (BigInt(input.blob.byteLength) !== input.expectedCiphertextBytes) {
    throw new MediaReadError("CHECKSUM", "ciphertext length disagrees");
  }

  const records = [...iterateMediaFrames(input.blob)];
  const ciphertextHasher = input.crypto.createSha256();
  ciphertextHasher.update(input.blob.subarray(0, SECRETSTREAM_HEADER_BYTES));
  for (const record of records) {
    ciphertextHasher.update(record.framedBytes);
  }
  const ciphertextSha256 = ciphertextHasher.digest();
  if (!checksumsEqual(ciphertextSha256, input.expectedCiphertextSha256)) {
    throw new MediaReadError("CHECKSUM", "ciphertext SHA-256 disagrees");
  }

  await input.crypto.ready;
  assertSodiumConstants(input.crypto);
  let pullState: unknown;
  try {
    pullState = input.crypto.initPull(
      input.blob.subarray(0, SECRETSTREAM_HEADER_BYTES),
      input.streamKey,
    );
  } catch {
    throw new MediaReadError(
      "AUTHENTICATION",
      "secretstream header initialization failed",
    );
  }

  const plaintextHasher = input.crypto.createSha256();
  let plaintextBytes = 0n;
  let sawFinal = false;
  for (const record of records) {
    let pulled: { message: Uint8Array; tag: number } | false;
    try {
      pulled = input.crypto.pull(pullState, record.ciphertext, input.aad);
    } catch {
      pulled = false;
    }
    if (pulled === false) {
      throw new MediaReadError(
        "AUTHENTICATION",
        `secretstream frame ${record.index} failed authentication`,
      );
    }

    if (pulled.tag === SECRETSTREAM_TAG_MESSAGE) {
      if (pulled.message.byteLength !== MEDIA_PLAINTEXT_FRAME_BYTES) {
        throw new MediaReadError(
          "STRUCTURE",
          "non-final media frame is not exactly 256 KiB",
        );
      }
      if (record.isLast) {
        throw new MediaReadError(
          "STRUCTURE",
          "media stream ends without FINAL",
        );
      }
    } else if (pulled.tag === SECRETSTREAM_TAG_FINAL) {
      if (!record.isLast) {
        throw new MediaReadError(
          "STRUCTURE",
          "media FINAL is not at exact EOF",
        );
      }
      if (pulled.message.byteLength > MEDIA_PLAINTEXT_FRAME_BYTES) {
        throw new MediaReadError("STRUCTURE", "final media frame is oversized");
      }
      sawFinal = true;
    } else {
      throw new MediaReadError(
        "STRUCTURE",
        `secretstream tag ${pulled.tag} is forbidden in format v1`,
      );
    }

    plaintextHasher.update(pulled.message);
    plaintextBytes += BigInt(pulled.message.byteLength);
  }

  if (!sawFinal) {
    throw new MediaReadError("STRUCTURE", "media stream has no FINAL tag");
  }
  const plaintextSha256 = plaintextHasher.digest();
  if (!checksumsEqual(plaintextSha256, input.expectedPlaintextSha256)) {
    throw new MediaReadError("CHECKSUM", "plaintext SHA-256 disagrees");
  }

  return {
    frameCount: records.length,
    plaintextBytes,
    plaintextSha256,
    ciphertextSha256,
  };
}
