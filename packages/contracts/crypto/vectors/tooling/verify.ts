import {
  encodeManifestAssociatedData,
  encodeMediaAssociatedData,
} from "../../aad.js";
import { BinaryReader, assertExactObject } from "../../binary.js";
import { checksumsEqual, sha256 } from "../../checksums.js";
import {
  encodeManifestPlaintext,
  readEncryptedManifest,
  type ManifestCryptoProvider,
  type ManifestPlaintext,
} from "../../manifest.js";
import {
  calculateMediaLayout,
  readMediaBlob,
  type MediaCryptoProvider,
} from "../../media.js";
import {
  MANIFEST_KDF_CONTEXT,
  MANIFEST_KDF_SUBKEY_ID,
  MEDIA_KDF_CONTEXT,
  MEDIA_KDF_SUBKEY_IDS,
  TRIP_ENVELOPE_CIPHERTEXT_BYTES,
  TRIP_ENVELOPE_DOMAIN,
  TRIP_ENVELOPE_PLAINTEXT_BYTES,
  type ObjectVariant,
} from "../../protocol.js";
import { FIXTURE_PLAINTEXT_PATTERN, fixturePlaintext } from "./plaintext.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

type JsonRecord = Record<string, unknown>;

type MediaIndex = Readonly<{
  file: string;
  variant: ObjectVariant;
  plaintextBytes: number;
  frameCount: number;
  ciphertextBytes: number;
  headerBase64: string;
  streamKeyBase64: string;
  plaintextSha256Base64: string;
  ciphertextSha256Base64: string;
}>;

type EnvelopeIndex = Readonly<{
  file: string;
  kind: "OWNER_SELF" | "OWNER_RECIPIENT" | "FIRST_IMPORT_SUBSTITUTION";
  ciphertextBytes: number;
  wrappedKeyBase64: string;
  recipientPublicKeyBase64: string;
  expectedTripKeyBase64: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  recipientE2eeKeyVersion: number;
  residualAnonymousSubstitution: boolean;
}>;

type VectorIndex = Readonly<{
  generator: JsonRecord;
  protocol: JsonRecord;
  context: Readonly<{
    tripId: string;
    assetId: string;
    ownerDeviceId: string;
    recipientDeviceId: string;
    recipientE2eeKeyVersion: number;
  }>;
  secrets: Readonly<{
    tripKeyBase64: string;
    substitutedTripKeyBase64: string;
    contentRootBase64: string;
    ownerSeedBase64: string;
    ownerSecretKeyBase64: string;
    recipientSeedBase64: string;
    recipientSecretKeyBase64: string;
  }>;
  aad: Readonly<{
    previewBase64: string;
    originalBase64: string;
    manifestBase64: string;
  }>;
  media: readonly MediaIndex[];
  manifest: Readonly<{
    file: string;
    plaintextBytes: number;
    ciphertextBytes: number;
    nonceBase64: string;
    plaintextSha256Base64: string;
    capturedAtMs: number;
    filename: string;
    previewMediaFile: string;
    originalMediaFile: string;
  }>;
  envelopes: readonly EnvelopeIndex[];
  inventory: Readonly<Record<string, string>>;
}>;

export type VectorCryptoProvider = MediaCryptoProvider &
  ManifestCryptoProvider &
  Readonly<{
    boxSealOpen: (
      ciphertext: Uint8Array,
      recipientPublicKey: Uint8Array,
      recipientSecretKey: Uint8Array,
    ) => Uint8Array | false;
  }>;

export type VerifiedVectorSet = Readonly<{
  binaryFileCount: number;
  mediaCount: number;
  envelopeCount: number;
  substitutionTripKey: Uint8Array;
}>;

function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonRecord {
  return assertExactObject(value, keys, label);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function exactLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is not an allowed value`);
  }
  return value as T;
}

function parseMedia(value: unknown, index: number): MediaIndex {
  const item = record(
    value,
    [
      "file",
      "variant",
      "plaintextBytes",
      "frameCount",
      "ciphertextBytes",
      "headerBase64",
      "streamKeyBase64",
      "plaintextSha256Base64",
      "ciphertextSha256Base64",
    ],
    `media[${index}]`,
  );
  return {
    file: stringValue(item.file, "media file"),
    variant: exactLiteral(
      item.variant,
      ["PREVIEW", "ORIGINAL"],
      "media variant",
    ),
    plaintextBytes: integer(item.plaintextBytes, "media plaintextBytes"),
    frameCount: integer(item.frameCount, "media frameCount"),
    ciphertextBytes: integer(item.ciphertextBytes, "media ciphertextBytes"),
    headerBase64: stringValue(item.headerBase64, "media headerBase64"),
    streamKeyBase64: stringValue(item.streamKeyBase64, "media streamKeyBase64"),
    plaintextSha256Base64: stringValue(
      item.plaintextSha256Base64,
      "media plaintextSha256Base64",
    ),
    ciphertextSha256Base64: stringValue(
      item.ciphertextSha256Base64,
      "media ciphertextSha256Base64",
    ),
  };
}

function parseEnvelope(value: unknown, index: number): EnvelopeIndex {
  const item = record(
    value,
    [
      "file",
      "kind",
      "ciphertextBytes",
      "wrappedKeyBase64",
      "recipientPublicKeyBase64",
      "expectedTripKeyBase64",
      "senderDeviceId",
      "recipientDeviceId",
      "recipientE2eeKeyVersion",
      "residualAnonymousSubstitution",
    ],
    `envelopes[${index}]`,
  );
  return {
    file: stringValue(item.file, "envelope file"),
    kind: exactLiteral(
      item.kind,
      ["OWNER_SELF", "OWNER_RECIPIENT", "FIRST_IMPORT_SUBSTITUTION"],
      "envelope kind",
    ),
    ciphertextBytes: integer(item.ciphertextBytes, "envelope ciphertextBytes"),
    wrappedKeyBase64: stringValue(
      item.wrappedKeyBase64,
      "envelope wrappedKeyBase64",
    ),
    recipientPublicKeyBase64: stringValue(
      item.recipientPublicKeyBase64,
      "envelope recipientPublicKeyBase64",
    ),
    expectedTripKeyBase64: stringValue(
      item.expectedTripKeyBase64,
      "envelope expectedTripKeyBase64",
    ),
    senderDeviceId: stringValue(item.senderDeviceId, "envelope senderDeviceId"),
    recipientDeviceId: stringValue(
      item.recipientDeviceId,
      "envelope recipientDeviceId",
    ),
    recipientE2eeKeyVersion: integer(
      item.recipientE2eeKeyVersion,
      "envelope recipientE2eeKeyVersion",
    ),
    residualAnonymousSubstitution: booleanValue(
      item.residualAnonymousSubstitution,
      "envelope residualAnonymousSubstitution",
    ),
  };
}

function parseIndex(bytes: Uint8Array): VectorIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes)) as unknown;
  } catch {
    throw new TypeError("vector index must be valid UTF-8 JSON");
  }
  const root = record(
    parsed,
    [
      "schemaVersion",
      "fixtureOnly",
      "generator",
      "protocol",
      "context",
      "secrets",
      "aad",
      "media",
      "manifest",
      "envelopes",
      "inventory",
    ],
    "vector index",
  );
  if (root.schemaVersion !== 1 || root.fixtureOnly !== true) {
    throw new TypeError("vector index must be fixture-only schema 1");
  }
  const generator = record(
    root.generator,
    [
      "name",
      "rng",
      "rngInstalledBeforeSodiumInit",
      "entropyTapeBytes",
      "entropyTapeSha256",
      "entropyBytesConsumed",
      "libsodiumVersion",
      "swiftSodiumVersion",
      "swiftSodiumTagObject",
      "swiftSodiumCommit",
      "swiftSodiumArchiveSha256",
      "license",
    ],
    "generator provenance",
  );
  const protocol = record(
    root.protocol,
    [
      "formatVersion",
      "keyEpoch",
      "mediaKdfContext",
      "previewSubkeyId",
      "originalSubkeyId",
      "manifestKdfContext",
      "manifestSubkeyId",
      "plaintextFrameBytes",
      "plaintextPattern",
    ],
    "protocol",
  );
  const context = record(
    root.context,
    [
      "tripId",
      "assetId",
      "ownerDeviceId",
      "recipientDeviceId",
      "recipientE2eeKeyVersion",
    ],
    "context",
  );
  const secrets = record(
    root.secrets,
    [
      "fixtureOnly",
      "tripKeyBase64",
      "substitutedTripKeyBase64",
      "contentRootBase64",
      "ownerSeedBase64",
      "ownerSecretKeyBase64",
      "recipientSeedBase64",
      "recipientSecretKeyBase64",
    ],
    "secrets",
  );
  if (secrets.fixtureOnly !== true) {
    throw new TypeError("vector secrets must be marked fixture-only");
  }
  const aad = record(
    root.aad,
    ["previewBase64", "originalBase64", "manifestBase64"],
    "AAD index",
  );
  if (!Array.isArray(root.media) || !Array.isArray(root.envelopes)) {
    throw new TypeError("media and envelopes must be arrays");
  }
  const manifest = record(
    root.manifest,
    [
      "file",
      "plaintextBytes",
      "ciphertextBytes",
      "nonceBase64",
      "plaintextSha256Base64",
      "capturedAtMs",
      "filename",
      "previewMediaFile",
      "originalMediaFile",
    ],
    "manifest index",
  );
  const inventoryRecord = assertExactObject(
    root.inventory,
    Object.keys(root.inventory as JsonRecord),
    "inventory",
  );
  const inventory: Record<string, string> = {};
  for (const [path, digest] of Object.entries(inventoryRecord)) {
    inventory[path] = stringValue(digest, `inventory ${path}`);
  }
  return {
    generator,
    protocol,
    context: {
      tripId: stringValue(context.tripId, "tripId"),
      assetId: stringValue(context.assetId, "assetId"),
      ownerDeviceId: stringValue(context.ownerDeviceId, "ownerDeviceId"),
      recipientDeviceId: stringValue(
        context.recipientDeviceId,
        "recipientDeviceId",
      ),
      recipientE2eeKeyVersion: integer(
        context.recipientE2eeKeyVersion,
        "recipientE2eeKeyVersion",
      ),
    },
    secrets: {
      tripKeyBase64: stringValue(secrets.tripKeyBase64, "tripKeyBase64"),
      substitutedTripKeyBase64: stringValue(
        secrets.substitutedTripKeyBase64,
        "substitutedTripKeyBase64",
      ),
      contentRootBase64: stringValue(
        secrets.contentRootBase64,
        "contentRootBase64",
      ),
      ownerSeedBase64: stringValue(secrets.ownerSeedBase64, "ownerSeedBase64"),
      ownerSecretKeyBase64: stringValue(
        secrets.ownerSecretKeyBase64,
        "ownerSecretKeyBase64",
      ),
      recipientSeedBase64: stringValue(
        secrets.recipientSeedBase64,
        "recipientSeedBase64",
      ),
      recipientSecretKeyBase64: stringValue(
        secrets.recipientSecretKeyBase64,
        "recipientSecretKeyBase64",
      ),
    },
    aad: {
      previewBase64: stringValue(aad.previewBase64, "previewBase64"),
      originalBase64: stringValue(aad.originalBase64, "originalBase64"),
      manifestBase64: stringValue(aad.manifestBase64, "manifestBase64"),
    },
    media: root.media.map(parseMedia),
    manifest: {
      file: stringValue(manifest.file, "manifest file"),
      plaintextBytes: integer(
        manifest.plaintextBytes,
        "manifest plaintextBytes",
      ),
      ciphertextBytes: integer(
        manifest.ciphertextBytes,
        "manifest ciphertextBytes",
      ),
      nonceBase64: stringValue(manifest.nonceBase64, "manifest nonceBase64"),
      plaintextSha256Base64: stringValue(
        manifest.plaintextSha256Base64,
        "manifest plaintextSha256Base64",
      ),
      capturedAtMs: integer(manifest.capturedAtMs, "manifest capturedAtMs"),
      filename: stringValue(manifest.filename, "manifest filename"),
      previewMediaFile: stringValue(
        manifest.previewMediaFile,
        "manifest previewMediaFile",
      ),
      originalMediaFile: stringValue(
        manifest.originalMediaFile,
        "manifest originalMediaFile",
      ),
    },
    envelopes: root.envelopes.map(parseEnvelope),
    inventory,
  };
}

export function decodeCanonicalBase64(
  value: string,
  label: string,
): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new TypeError(`${label} is not canonical padded Base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError(`${label} is not valid Base64`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const spelling = btoa(String.fromCharCode(...bytes));
  if (spelling !== value) {
    throw new TypeError(`${label} has noncanonical pad bits`);
  }
  return bytes;
}

function hexDigest(bytes: Uint8Array, crypto: VectorCryptoProvider): string {
  return [...sha256(bytes, crypto.createSha256)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

function requireFile(tree: FixtureTree, path: string): Uint8Array {
  const bytes = tree.get(path);
  if (bytes === undefined) {
    throw new Error(`vector file ${path} is missing`);
  }
  return bytes;
}

export type FixtureTree = ReadonlyMap<string, Uint8Array>;

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    throw new TypeError("envelope UUID must be canonical lowercase");
  }
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16),
  );
}

export type EnvelopeContext = Readonly<{
  tripId: Uint8Array;
  senderDeviceId: Uint8Array;
  recipientDeviceId: Uint8Array;
  tripKey: Uint8Array;
}>;

export type EnvelopeReadFailureCategory =
  "STRUCTURE" | "AUTHENTICATION" | "SEMANTIC_CONTEXT";

export class EnvelopeReadError extends Error {
  readonly category: EnvelopeReadFailureCategory;

  constructor(category: EnvelopeReadFailureCategory, message: string) {
    super(message);
    this.name = "EnvelopeReadError";
    this.category = category;
  }
}

export type OpenEnvelopeForContextInput = Readonly<{
  crypto: Pick<VectorCryptoProvider, "boxSealOpen">;
  ciphertext: Uint8Array;
  recipientPublicKey: Uint8Array;
  recipientSecretKey: Uint8Array;
  expectedTripId: string;
  expectedSenderDeviceId: string;
  expectedRecipientDeviceId: string;
  expectedRecipientE2eeKeyVersion: number;
}>;

export function parseEnvelopePlaintext(plaintext: Uint8Array): EnvelopeContext {
  if (plaintext.byteLength !== TRIP_ENVELOPE_PLAINTEXT_BYTES) {
    throw new Error("envelope plaintext must be exactly 100 bytes");
  }
  const reader = new BinaryReader(plaintext);
  if (utf8.decode(reader.readBytes(8)) !== TRIP_ENVELOPE_DOMAIN) {
    throw new Error("envelope domain disagrees");
  }
  if (reader.readUint32() !== 1) {
    throw new Error("envelope algorithm version disagrees");
  }
  const tripId = reader.readBytes(16).slice();
  if (reader.readUint32() !== 1) {
    throw new Error("envelope key epoch disagrees");
  }
  const senderDeviceId = reader.readBytes(16).slice();
  const recipientDeviceId = reader.readBytes(16).slice();
  if (reader.readUint32() !== 1) {
    throw new Error("envelope recipient key version disagrees");
  }
  const tripKey = reader.readBytes(32).slice();
  reader.assertEnd();
  return { tripId, senderDeviceId, recipientDeviceId, tripKey };
}

/**
 * Opens one anonymous sealed-box trip-key envelope and releases its key only
 * after the complete v1 inner context has been checked. A context-correct
 * sealed box can still contain a substituted key; sender authentication is a
 * separate protocol concern and is deliberately not inferred here.
 */
export function openEnvelopeForContext(
  input: OpenEnvelopeForContextInput,
): Uint8Array {
  if (input.ciphertext.byteLength !== TRIP_ENVELOPE_CIPHERTEXT_BYTES) {
    throw new EnvelopeReadError(
      "STRUCTURE",
      `envelope ciphertext must be exactly ${TRIP_ENVELOPE_CIPHERTEXT_BYTES} bytes`,
    );
  }
  if (
    input.recipientPublicKey.byteLength !== 32 ||
    input.recipientSecretKey.byteLength !== 32
  ) {
    throw new EnvelopeReadError(
      "STRUCTURE",
      "recipient sealed-box keys must each be exactly 32 bytes",
    );
  }
  if (input.expectedRecipientE2eeKeyVersion !== 1) {
    throw new EnvelopeReadError(
      "SEMANTIC_CONTEXT",
      "expected recipient key version must be 1 for format v1",
    );
  }

  let plaintext: Uint8Array | false;
  try {
    plaintext = input.crypto.boxSealOpen(
      input.ciphertext,
      input.recipientPublicKey,
      input.recipientSecretKey,
    );
  } catch {
    plaintext = false;
  }
  if (plaintext === false) {
    throw new EnvelopeReadError(
      "AUTHENTICATION",
      "envelope sealed-box authentication failed",
    );
  }

  let parsed: EnvelopeContext;
  try {
    parsed = parseEnvelopePlaintext(plaintext);
  } catch {
    throw new EnvelopeReadError(
      "SEMANTIC_CONTEXT",
      "envelope inner format or fixed context disagrees",
    );
  }
  if (
    !bytesEqual(parsed.tripId, uuidBytes(input.expectedTripId)) ||
    !bytesEqual(
      parsed.senderDeviceId,
      uuidBytes(input.expectedSenderDeviceId),
    ) ||
    !bytesEqual(
      parsed.recipientDeviceId,
      uuidBytes(input.expectedRecipientDeviceId),
    )
  ) {
    throw new EnvelopeReadError(
      "SEMANTIC_CONTEXT",
      "envelope inner identity context disagrees",
    );
  }
  return parsed.tripKey;
}

function assertProtocol(index: VectorIndex): void {
  const generator = index.generator;
  if (
    generator.name !== "CrewRollVectorGenerator" ||
    generator.rng !== "crewroll-fixture-v1-do-not-ship" ||
    generator.rngInstalledBeforeSodiumInit !== true ||
    generator.libsodiumVersion !== "1.0.22" ||
    generator.swiftSodiumVersion !== "0.11.0" ||
    generator.license !== "ISC"
  ) {
    throw new Error("vector generator provenance disagrees");
  }
  const protocol = index.protocol;
  if (
    protocol.formatVersion !== 1 ||
    protocol.keyEpoch !== 1 ||
    protocol.mediaKdfContext !== MEDIA_KDF_CONTEXT ||
    protocol.previewSubkeyId !== MEDIA_KDF_SUBKEY_IDS.PREVIEW ||
    protocol.originalSubkeyId !== MEDIA_KDF_SUBKEY_IDS.ORIGINAL ||
    protocol.manifestKdfContext !== MANIFEST_KDF_CONTEXT ||
    protocol.manifestSubkeyId !== MANIFEST_KDF_SUBKEY_ID ||
    protocol.plaintextFrameBytes !== 262_144 ||
    protocol.plaintextPattern !== FIXTURE_PLAINTEXT_PATTERN
  ) {
    throw new Error("vector protocol constants disagree");
  }
}

function descriptorMatchesMedia(
  descriptor: ManifestPlaintext["preview"],
  media: MediaIndex,
): boolean {
  return (
    descriptor.variant === media.variant &&
    descriptor.plaintextBytes === BigInt(media.plaintextBytes) &&
    descriptor.ciphertextBytes === BigInt(media.ciphertextBytes) &&
    checksumsEqual(
      descriptor.plaintextSha256,
      decodeCanonicalBase64(media.plaintextSha256Base64, "plaintext SHA-256"),
    ) &&
    checksumsEqual(
      descriptor.ciphertextSha256,
      decodeCanonicalBase64(media.ciphertextSha256Base64, "ciphertext SHA-256"),
    )
  );
}

function mediaFixtureName(
  variant: ObjectVariant,
  plaintextBytes: number,
): string {
  const sizeName = new Map<number, string>([
    [0, "empty"],
    [1, "one"],
    [262_144, "exact-chunk"],
    [262_145, "chunk-plus-one"],
  ]).get(plaintextBytes);
  if (sizeName === undefined) {
    throw new Error(`unsupported vector plaintext size ${plaintextBytes}`);
  }
  return `media-${sizeName}-${variant.toLowerCase()}.bin`;
}

export async function verifyVectorSet(
  tree: FixtureTree,
  crypto: VectorCryptoProvider,
): Promise<VerifiedVectorSet> {
  const index = parseIndex(requireFile(tree, "index.json"));
  const inventoryPaths = Object.keys(index.inventory).sort();
  const expectedPaths = ["README.md", "index.json", ...inventoryPaths].sort();
  const actualPaths = [...tree.keys()].sort();
  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error("vector directory contains missing or uninventoried files");
  }
  if (inventoryPaths.length !== 12) {
    throw new Error("vector inventory must contain 12 binary fixtures");
  }
  for (const path of inventoryPaths) {
    const expected = index.inventory[path];
    if (expected === undefined || !/^[0-9a-f]{64}$/u.test(expected)) {
      throw new Error(`inventory digest for ${path} is malformed`);
    }
    if (hexDigest(requireFile(tree, path), crypto) !== expected) {
      throw new Error(`inventory digest for ${path} disagrees`);
    }
  }

  assertProtocol(index);
  const tripKey = decodeCanonicalBase64(
    index.secrets.tripKeyBase64,
    "trip key",
  );
  const substitutedTripKey = decodeCanonicalBase64(
    index.secrets.substitutedTripKeyBase64,
    "substituted trip key",
  );
  const contentRoot = decodeCanonicalBase64(
    index.secrets.contentRootBase64,
    "content root",
  );
  const expectedAad: Record<ObjectVariant, Uint8Array> = {
    PREVIEW: encodeMediaAssociatedData({
      tripId: index.context.tripId,
      assetId: index.context.assetId,
      variant: "PREVIEW",
      keyEpoch: 1,
      formatVersion: 1,
    }),
    ORIGINAL: encodeMediaAssociatedData({
      tripId: index.context.tripId,
      assetId: index.context.assetId,
      variant: "ORIGINAL",
      keyEpoch: 1,
      formatVersion: 1,
    }),
  };
  for (const variant of ["PREVIEW", "ORIGINAL"] as const) {
    const indexed = decodeCanonicalBase64(
      variant === "PREVIEW"
        ? index.aad.previewBase64
        : index.aad.originalBase64,
      `${variant} AAD`,
    );
    if (!bytesEqual(indexed, expectedAad[variant])) {
      throw new Error(`${variant} AAD disagrees`);
    }
  }

  if (index.media.length !== 8) {
    throw new Error("vector set must contain eight media fixtures");
  }
  const mediaByFile = new Map<string, MediaIndex>();
  for (const media of index.media) {
    if (mediaByFile.has(media.file)) {
      throw new Error(`duplicate media fixture ${media.file}`);
    }
    mediaByFile.set(media.file, media);
    const expectedName = mediaFixtureName(media.variant, media.plaintextBytes);
    if (media.file !== expectedName) {
      throw new Error(`media fixture name ${media.file} is noncanonical`);
    }
    const expectedLayout = calculateMediaLayout(media.plaintextBytes);
    if (
      media.frameCount !== Number(expectedLayout.frameCount) ||
      media.ciphertextBytes !== Number(expectedLayout.ciphertextBytes)
    ) {
      throw new Error(`media layout for ${media.file} disagrees`);
    }
    const derivedKey = crypto.deriveFromKey(
      32,
      MEDIA_KDF_SUBKEY_IDS[media.variant],
      MEDIA_KDF_CONTEXT,
      contentRoot,
    );
    if (
      !bytesEqual(
        derivedKey,
        decodeCanonicalBase64(media.streamKeyBase64, "stream key"),
      )
    ) {
      throw new Error(`stream key for ${media.file} disagrees`);
    }
    const blob = requireFile(tree, media.file);
    if (
      blob.byteLength !== media.ciphertextBytes ||
      !bytesEqual(
        blob.subarray(0, 24),
        decodeCanonicalBase64(media.headerBase64, "secretstream header"),
      )
    ) {
      throw new Error(`media header/length for ${media.file} disagrees`);
    }
    const plaintext = fixturePlaintext(media.plaintextBytes);
    if (
      !checksumsEqual(
        sha256(plaintext, crypto.createSha256),
        decodeCanonicalBase64(media.plaintextSha256Base64, "plaintext hash"),
      )
    ) {
      throw new Error(`plaintext pattern for ${media.file} disagrees`);
    }
    await readMediaBlob({
      crypto,
      blob,
      streamKey: derivedKey,
      aad: expectedAad[media.variant],
      expectedCiphertextBytes: BigInt(media.ciphertextBytes),
      expectedCiphertextSha256: decodeCanonicalBase64(
        media.ciphertextSha256Base64,
        "ciphertext hash",
      ),
      expectedPlaintextSha256: decodeCanonicalBase64(
        media.plaintextSha256Base64,
        "plaintext hash",
      ),
    });
  }
  for (const variant of ["PREVIEW", "ORIGINAL"] as const) {
    for (const size of [0, 1, 262_144, 262_145]) {
      const expectedFile = mediaFixtureName(variant, size);
      if (!mediaByFile.has(expectedFile)) {
        throw new Error(`missing ${variant} ${size} vector`);
      }
    }
  }

  const manifestAad = encodeManifestAssociatedData({
    tripId: index.context.tripId,
    assetId: index.context.assetId,
    keyEpoch: 1,
    formatVersion: 1,
  });
  if (
    !bytesEqual(
      manifestAad,
      decodeCanonicalBase64(index.aad.manifestBase64, "manifest AAD"),
    )
  ) {
    throw new Error("manifest AAD disagrees");
  }
  const encryptedManifest = requireFile(tree, index.manifest.file);
  if (
    encryptedManifest.byteLength !== index.manifest.ciphertextBytes ||
    !bytesEqual(
      encryptedManifest.subarray(0, 24),
      decodeCanonicalBase64(index.manifest.nonceBase64, "manifest nonce"),
    )
  ) {
    throw new Error("manifest outer framing disagrees");
  }
  const manifest = await readEncryptedManifest({
    crypto,
    encryptedManifest,
    tripKey,
    aad: manifestAad,
  });
  if (
    !bytesEqual(manifest.contentRoot, contentRoot) ||
    manifest.capturedAtMs !== BigInt(index.manifest.capturedAtMs) ||
    manifest.filename !== index.manifest.filename
  ) {
    throw new Error("manifest private fields disagree");
  }
  const previewMedia = mediaByFile.get(index.manifest.previewMediaFile);
  const originalMedia = mediaByFile.get(index.manifest.originalMediaFile);
  if (
    previewMedia === undefined ||
    originalMedia === undefined ||
    !descriptorMatchesMedia(manifest.preview, previewMedia) ||
    !descriptorMatchesMedia(manifest.original, originalMedia)
  ) {
    throw new Error("manifest descriptors disagree with media");
  }
  const reencodedManifest = encodeManifestPlaintext(manifest);
  if (
    reencodedManifest.byteLength !== index.manifest.plaintextBytes ||
    !checksumsEqual(
      sha256(reencodedManifest, crypto.createSha256),
      decodeCanonicalBase64(
        index.manifest.plaintextSha256Base64,
        "manifest plaintext hash",
      ),
    )
  ) {
    throw new Error("manifest plaintext inventory disagrees");
  }

  if (index.envelopes.length !== 3) {
    throw new Error("vector set must contain three envelopes");
  }
  const ownerSecretKey = decodeCanonicalBase64(
    index.secrets.ownerSecretKeyBase64,
    "owner secret key",
  );
  const recipientSecretKey = decodeCanonicalBase64(
    index.secrets.recipientSecretKeyBase64,
    "recipient secret key",
  );
  let canonicalEnvelopeTripKey: Uint8Array | undefined;
  let verifiedSubstitution: Uint8Array | undefined;
  const seenEnvelopeKinds = new Set<string>();
  for (const envelope of index.envelopes) {
    if (seenEnvelopeKinds.has(envelope.kind)) {
      throw new Error(`duplicate envelope kind ${envelope.kind}`);
    }
    seenEnvelopeKinds.add(envelope.kind);
    const ciphertext = requireFile(tree, envelope.file);
    const indexedCiphertext = decodeCanonicalBase64(
      envelope.wrappedKeyBase64,
      "wrapped key",
    );
    if (
      ciphertext.byteLength !== TRIP_ENVELOPE_CIPHERTEXT_BYTES ||
      envelope.ciphertextBytes !== TRIP_ENVELOPE_CIPHERTEXT_BYTES ||
      envelope.wrappedKeyBase64.length !== 200 ||
      !bytesEqual(ciphertext, indexedCiphertext)
    ) {
      throw new Error(`${envelope.kind} envelope outer bytes disagree`);
    }
    const publicKey = decodeCanonicalBase64(
      envelope.recipientPublicKeyBase64,
      "recipient public key",
    );
    const secretKey =
      envelope.recipientDeviceId === index.context.ownerDeviceId
        ? ownerSecretKey
        : recipientSecretKey;
    const plaintext = crypto.boxSealOpen(ciphertext, publicKey, secretKey);
    if (plaintext === false) {
      throw new Error(`${envelope.kind} envelope authentication failed`);
    }
    const parsedEnvelope = parseEnvelopePlaintext(plaintext);
    const expectedTripKey = decodeCanonicalBase64(
      envelope.expectedTripKeyBase64,
      "expected envelope trip key",
    );
    if (
      !bytesEqual(parsedEnvelope.tripId, uuidBytes(index.context.tripId)) ||
      !bytesEqual(
        parsedEnvelope.senderDeviceId,
        uuidBytes(index.context.ownerDeviceId),
      ) ||
      !bytesEqual(
        parsedEnvelope.recipientDeviceId,
        uuidBytes(envelope.recipientDeviceId),
      ) ||
      envelope.senderDeviceId !== index.context.ownerDeviceId ||
      envelope.recipientE2eeKeyVersion !== 1 ||
      !bytesEqual(parsedEnvelope.tripKey, expectedTripKey)
    ) {
      throw new Error(`${envelope.kind} inner context disagrees`);
    }
    if (envelope.kind === "FIRST_IMPORT_SUBSTITUTION") {
      if (
        envelope.residualAnonymousSubstitution !== true ||
        !bytesEqual(expectedTripKey, substitutedTripKey) ||
        bytesEqual(expectedTripKey, tripKey)
      ) {
        throw new Error("substitution envelope residual-risk result disagrees");
      }
      verifiedSubstitution = expectedTripKey;
    } else {
      if (
        envelope.residualAnonymousSubstitution ||
        !bytesEqual(expectedTripKey, tripKey)
      ) {
        throw new Error("canonical envelope trip key disagrees");
      }
      canonicalEnvelopeTripKey ??= expectedTripKey;
      if (!bytesEqual(canonicalEnvelopeTripKey, expectedTripKey)) {
        throw new Error("canonical envelopes contain different trip keys");
      }
    }
  }
  if (verifiedSubstitution === undefined) {
    throw new Error("substitution residual-risk fixture is missing");
  }
  return {
    binaryFileCount: inventoryPaths.length,
    mediaCount: index.media.length,
    envelopeCount: index.envelopes.length,
    substitutionTripKey: verifiedSubstitution,
  };
}
