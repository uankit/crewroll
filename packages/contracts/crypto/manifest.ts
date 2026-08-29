import {
  BinaryReader,
  BinaryWriter,
  assertExactObject,
  assertUint32,
  assertUint64,
} from "./binary.js";
import { checksumsEqual } from "./checksums.js";
import {
  CHECKSUM_BYTES,
  CONTENT_ROOT_BYTES,
  KDF_CONTEXT_BYTES,
  MANIFEST_AAD_BYTES,
  MANIFEST_AUTH_BYTES,
  MANIFEST_CIPHERTEXT_MAX_BYTES,
  MANIFEST_CIPHERTEXT_MIN_BYTES,
  MANIFEST_KDF_CONTEXT,
  MANIFEST_KDF_SUBKEY_ID,
  MANIFEST_KEY_BYTES,
  MANIFEST_NONCE_BYTES,
  MANIFEST_PLAINTEXT_DOMAIN,
  MANIFEST_PLAINTEXT_MAX_BYTES,
  MANIFEST_PLAINTEXT_MIN_BYTES,
  VARIANT_CODES,
  type ObjectVariant,
} from "./protocol.js";

const MANIFEST_KEYS = [
  "contentRoot",
  "capturedAtMs",
  "filename",
  "preview",
  "original",
] as const;
const DESCRIPTOR_KEYS = [
  "variant",
  "mime",
  "pixelWidth",
  "pixelHeight",
  "plaintextBytes",
  "plaintextSha256",
  "ciphertextBytes",
  "ciphertextSha256",
] as const;
const LAST_MILLISECOND_YEAR_9999 = 253_402_300_799_999n;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type ManifestVariantDescriptor = Readonly<{
  variant: ObjectVariant;
  mime: string;
  pixelWidth: number;
  pixelHeight: number;
  plaintextBytes: bigint;
  plaintextSha256: Uint8Array;
  ciphertextBytes: bigint;
  ciphertextSha256: Uint8Array;
}>;

export type ManifestPlaintext = Readonly<{
  contentRoot: Uint8Array;
  capturedAtMs: bigint | null;
  filename: string | null;
  preview: ManifestVariantDescriptor;
  original: ManifestVariantDescriptor;
}>;

export type ManifestCryptoProvider = Readonly<{
  ready: Promise<unknown>;
  kdfContextBytes: number;
  kdfKeyBytes: number;
  aeadKeyBytes: number;
  aeadNonceBytes: number;
  aeadAuthBytes: number;
  deriveFromKey: (
    length: number,
    subkeyId: number,
    context: string,
    key: Uint8Array,
  ) => Uint8Array;
  decrypt: (
    ciphertext: Uint8Array,
    associatedData: Uint8Array,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ) => Uint8Array;
}>;

export type ReadEncryptedManifestInput = Readonly<{
  crypto: ManifestCryptoProvider;
  encryptedManifest: Uint8Array;
  tripKey: Uint8Array;
  aad: Uint8Array;
}>;

export type ManifestReadFailureCategory =
  "STRUCTURE" | "AUTHENTICATION" | "SEMANTIC" | "CHECKSUM";

export class ManifestReadError extends Error {
  readonly category: ManifestReadFailureCategory;

  constructor(category: ManifestReadFailureCategory, message: string) {
    super(message);
    this.name = "ManifestReadError";
    this.category = category;
  }
}

export function assertManifestDescriptorMatches(
  actual: ManifestVariantDescriptor,
  expected: ManifestVariantDescriptor,
): void {
  if (
    actual.variant !== expected.variant ||
    actual.mime !== expected.mime ||
    actual.pixelWidth !== expected.pixelWidth ||
    actual.pixelHeight !== expected.pixelHeight ||
    actual.plaintextBytes !== expected.plaintextBytes ||
    actual.ciphertextBytes !== expected.ciphertextBytes ||
    !checksumsEqual(actual.plaintextSha256, expected.plaintextSha256) ||
    !checksumsEqual(actual.ciphertextSha256, expected.ciphertextSha256)
  ) {
    throw new ManifestReadError(
      "CHECKSUM",
      `${actual.variant.toLowerCase()} descriptor disagrees with media`,
    );
  }
}

function requireBytes(
  value: unknown,
  width: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== width) {
    throw new TypeError(`${label} must be exactly ${width} bytes`);
  }
  return value;
}

function capturedAt(value: unknown): bigint | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "bigint") {
    throw new TypeError("capturedAtMs must be a bigint or null");
  }
  assertUint64(value, "capturedAtMs");
  if (value === 0n || value > LAST_MILLISECOND_YEAR_9999) {
    throw new RangeError("capturedAtMs is outside the v1 calendar range");
  }
  return value;
}

function assertWellFormedUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailingCodeUnit = value.charCodeAt(index + 1);
      if (
        !Number.isInteger(trailingCodeUnit) ||
        trailingCodeUnit < 0xdc00 ||
        trailingCodeUnit > 0xdfff
      ) {
        throw new TypeError("filename must contain only Unicode scalar values");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("filename must contain only Unicode scalar values");
    }
  }
}

function filenameBytes(value: unknown): Uint8Array {
  if (value === null) {
    return new Uint8Array();
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("filename must be a nonempty string or null");
  }
  assertWellFormedUnicodeScalarString(value);
  if (value.normalize("NFC") !== value) {
    throw new TypeError("filename must already be NFC-normalized");
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return (
        character === "/" ||
        character === "\\" ||
        codePoint <= 0x1f ||
        codePoint === 0x7f
      );
    })
  ) {
    throw new TypeError("filename must be a display-only basename");
  }
  const bytes = utf8Encoder.encode(value);
  if (bytes.byteLength > 255) {
    throw new RangeError("filename exceeds 255 UTF-8 bytes");
  }
  return bytes;
}

function canonicalMime(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("MIME must be a string");
  }
  const bytes = utf8Encoder.encode(value);
  if (
    bytes.byteLength < 3 ||
    bytes.byteLength > 127 ||
    !MIME_PATTERN.test(value)
  ) {
    throw new TypeError("MIME must be canonical lowercase type/subtype ASCII");
  }
  return value;
}

function positiveUint32(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${label} must be a number`);
  }
  const checked = assertUint32(value, label);
  if (checked === 0) {
    throw new RangeError(`${label} must be positive`);
  }
  return checked;
}

function uint64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be a bigint`);
  }
  return assertUint64(value, label);
}

function descriptor(
  value: unknown,
  expectedVariant: ObjectVariant,
): ManifestVariantDescriptor {
  const record = assertExactObject(
    value,
    DESCRIPTOR_KEYS,
    `${expectedVariant.toLowerCase()} descriptor`,
  );
  if (record.variant !== expectedVariant) {
    throw new TypeError(
      `${expectedVariant.toLowerCase()} descriptor has the wrong variant`,
    );
  }
  const ciphertextBytes = uint64(record.ciphertextBytes, "ciphertextBytes");
  if (ciphertextBytes < 45n) {
    throw new RangeError("ciphertextBytes must be at least 45");
  }
  return {
    variant: expectedVariant,
    mime: canonicalMime(record.mime),
    pixelWidth: positiveUint32(record.pixelWidth, "pixelWidth"),
    pixelHeight: positiveUint32(record.pixelHeight, "pixelHeight"),
    plaintextBytes: uint64(record.plaintextBytes, "plaintextBytes"),
    plaintextSha256: requireBytes(
      record.plaintextSha256,
      CHECKSUM_BYTES,
      "plaintextSha256",
    ),
    ciphertextBytes,
    ciphertextSha256: requireBytes(
      record.ciphertextSha256,
      CHECKSUM_BYTES,
      "ciphertextSha256",
    ),
  };
}

function writeDescriptor(
  writer: BinaryWriter,
  value: ManifestVariantDescriptor,
): void {
  const mime = utf8Encoder.encode(value.mime);
  writer
    .writeUint8(VARIANT_CODES[value.variant])
    .writeUint8(mime.byteLength)
    .writeBytes(mime)
    .writeUint32(value.pixelWidth)
    .writeUint32(value.pixelHeight)
    .writeUint64(value.plaintextBytes)
    .writeBytes(value.plaintextSha256)
    .writeUint64(value.ciphertextBytes)
    .writeBytes(value.ciphertextSha256);
}

export function encodeManifestPlaintext(value: unknown): Uint8Array {
  const record = assertExactObject(value, MANIFEST_KEYS, "manifest plaintext");
  const root = requireBytes(
    record.contentRoot,
    CONTENT_ROOT_BYTES,
    "contentRoot",
  );
  const capture = capturedAt(record.capturedAtMs);
  const filename = filenameBytes(record.filename);
  const preview = descriptor(record.preview, "PREVIEW");
  const original = descriptor(record.original, "ORIGINAL");

  const writer = new BinaryWriter(MANIFEST_PLAINTEXT_MAX_BYTES)
    .writeAscii(MANIFEST_PLAINTEXT_DOMAIN)
    .writeUint32(1)
    .writeBytes(root)
    .writeUint8(capture === null ? 0 : 1)
    .writeUint64(capture ?? 0n)
    .writeUint16(filename.byteLength)
    .writeBytes(filename);
  writeDescriptor(writer, preview);
  writeDescriptor(writer, original);
  const encoded = writer.toUint8Array();
  if (
    encoded.byteLength < MANIFEST_PLAINTEXT_MIN_BYTES ||
    encoded.byteLength > MANIFEST_PLAINTEXT_MAX_BYTES
  ) {
    throw new RangeError("manifest plaintext is outside v1 bounds");
  }
  return encoded;
}

function ascii(bytes: Uint8Array): string {
  for (const byte of bytes) {
    if (byte > 0x7f) {
      throw new ManifestReadError(
        "STRUCTURE",
        "ASCII field contains non-ASCII",
      );
    }
  }
  return String.fromCharCode(...bytes);
}

function readFilename(reader: BinaryReader): string | null {
  const length = reader.readUint16();
  if (length === 0) {
    return null;
  }
  const bytes = reader.readBytes(length);
  let value: string;
  try {
    value = fatalUtf8Decoder.decode(bytes);
  } catch {
    throw new ManifestReadError("STRUCTURE", "filename is not valid UTF-8");
  }
  filenameBytes(value);
  return value;
}

function readDescriptor(
  reader: BinaryReader,
  expectedVariant: ObjectVariant,
): ManifestVariantDescriptor {
  const variant = reader.readUint8();
  if (variant !== VARIANT_CODES[expectedVariant]) {
    throw new ManifestReadError(
      "STRUCTURE",
      `expected ${expectedVariant.toLowerCase()} descriptor`,
    );
  }
  const mimeLength = reader.readUint8();
  const mime = ascii(reader.readBytes(mimeLength));
  return descriptor(
    {
      variant: expectedVariant,
      mime,
      pixelWidth: reader.readUint32(),
      pixelHeight: reader.readUint32(),
      plaintextBytes: reader.readUint64(),
      plaintextSha256: reader.readBytes(CHECKSUM_BYTES).slice(),
      ciphertextBytes: reader.readUint64(),
      ciphertextSha256: reader.readBytes(CHECKSUM_BYTES).slice(),
    },
    expectedVariant,
  );
}

export function decodeManifestPlaintext(bytes: Uint8Array): ManifestPlaintext {
  if (
    bytes.byteLength < MANIFEST_PLAINTEXT_MIN_BYTES ||
    bytes.byteLength > MANIFEST_PLAINTEXT_MAX_BYTES
  ) {
    throw new ManifestReadError(
      "STRUCTURE",
      "manifest plaintext is outside v1 bounds",
    );
  }
  try {
    const reader = new BinaryReader(bytes);
    if (ascii(reader.readBytes(8)) !== MANIFEST_PLAINTEXT_DOMAIN) {
      throw new ManifestReadError("SEMANTIC", "manifest domain disagrees");
    }
    if (reader.readUint32() !== 1) {
      throw new ManifestReadError("SEMANTIC", "manifest schema disagrees");
    }
    const root = reader.readBytes(CONTENT_ROOT_BYTES).slice();
    const capturePresent = reader.readUint8();
    const capturedValue = reader.readUint64();
    let capturedAtMs: bigint | null;
    if (capturePresent === 0 && capturedValue === 0n) {
      capturedAtMs = null;
    } else if (capturePresent === 1) {
      capturedAtMs = capturedAt(capturedValue);
    } else {
      throw new ManifestReadError(
        "STRUCTURE",
        "capture flag/value pairing is invalid",
      );
    }
    const filename = readFilename(reader);
    const preview = readDescriptor(reader, "PREVIEW");
    const original = readDescriptor(reader, "ORIGINAL");
    reader.assertEnd();
    return { contentRoot: root, capturedAtMs, filename, preview, original };
  } catch (error) {
    if (error instanceof ManifestReadError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : "manifest parse failed";
    throw new ManifestReadError("STRUCTURE", message);
  }
}

function assertCryptoConstants(crypto: ManifestCryptoProvider): void {
  const bindings = [
    [crypto.kdfContextBytes, KDF_CONTEXT_BYTES, "KDF context"],
    [crypto.kdfKeyBytes, MANIFEST_KEY_BYTES, "KDF key"],
    [crypto.aeadKeyBytes, MANIFEST_KEY_BYTES, "manifest key"],
    [crypto.aeadNonceBytes, MANIFEST_NONCE_BYTES, "manifest nonce"],
    [crypto.aeadAuthBytes, MANIFEST_AUTH_BYTES, "manifest overhead"],
  ] as const;
  for (const [actual, expected, label] of bindings) {
    if (actual !== expected) {
      throw new Error(`${label} binding does not match CrewRoll format v1`);
    }
  }
}

export async function readEncryptedManifest(
  input: ReadEncryptedManifestInput,
): Promise<ManifestPlaintext> {
  if (
    input.encryptedManifest.byteLength < MANIFEST_CIPHERTEXT_MIN_BYTES ||
    input.encryptedManifest.byteLength > MANIFEST_CIPHERTEXT_MAX_BYTES
  ) {
    throw new ManifestReadError(
      "STRUCTURE",
      "encrypted manifest is outside v1 bounds",
    );
  }
  requireBytes(input.tripKey, MANIFEST_KEY_BYTES, "tripKey");
  requireBytes(input.aad, MANIFEST_AAD_BYTES, "manifest AAD");
  await input.crypto.ready;
  assertCryptoConstants(input.crypto);

  const nonce = input.encryptedManifest.subarray(0, MANIFEST_NONCE_BYTES);
  const ciphertext = input.encryptedManifest.subarray(MANIFEST_NONCE_BYTES);
  const manifestKey = input.crypto.deriveFromKey(
    MANIFEST_KEY_BYTES,
    MANIFEST_KDF_SUBKEY_ID,
    MANIFEST_KDF_CONTEXT,
    input.tripKey,
  );
  requireBytes(manifestKey, MANIFEST_KEY_BYTES, "derived manifest key");
  let plaintext: Uint8Array;
  try {
    plaintext = input.crypto.decrypt(ciphertext, input.aad, nonce, manifestKey);
  } catch {
    throw new ManifestReadError(
      "AUTHENTICATION",
      "encrypted manifest failed authentication",
    );
  }
  return decodeManifestPlaintext(plaintext);
}
