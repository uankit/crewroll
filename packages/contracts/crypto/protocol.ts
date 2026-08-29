export const ENCRYPTION_FORMAT_VERSION = 1 as const;
export const INITIAL_KEY_EPOCH = 1 as const;
export const OBJECT_VARIANTS = ["PREVIEW", "ORIGINAL"] as const;
export const VARIANT_CODES = { PREVIEW: 1, ORIGINAL: 2 } as const;
export const AAD_FIELDS = [
  "tripId",
  "assetId",
  "variant",
  "keyEpoch",
  "formatVersion",
] as const;

export const CONTENT_ROOT_BYTES = 32 as const;
export const CHECKSUM_BYTES = 32 as const;

export const KDF_CONTEXT_BYTES = 8 as const;
export const MEDIA_KDF_CONTEXT = "CRROLL01" as const;
export const MEDIA_KDF_SUBKEY_IDS = { PREVIEW: 1, ORIGINAL: 2 } as const;
export const MANIFEST_KDF_CONTEXT = "CRMANF01" as const;
export const MANIFEST_KDF_SUBKEY_ID = 1 as const;

export const SECRETSTREAM_KEY_BYTES = 32 as const;
export const SECRETSTREAM_HEADER_BYTES = 24 as const;
export const SECRETSTREAM_AUTH_BYTES = 17 as const;
export const SECRETSTREAM_TAG_MESSAGE = 0x00 as const;
export const SECRETSTREAM_TAG_FINAL = 0x03 as const;
export const MEDIA_PLAINTEXT_FRAME_BYTES = 262_144 as const;
export const MEDIA_FRAME_LENGTH_PREFIX_BYTES = 4 as const;
export const MEDIA_MIN_CIPHERTEXT_FRAME_BYTES = SECRETSTREAM_AUTH_BYTES;
export const MEDIA_MAX_CIPHERTEXT_FRAME_BYTES =
  MEDIA_PLAINTEXT_FRAME_BYTES + SECRETSTREAM_AUTH_BYTES;

export const MANIFEST_KEY_BYTES = 32 as const;
export const MANIFEST_NONCE_BYTES = 24 as const;
export const MANIFEST_AUTH_BYTES = 16 as const;
export const MANIFEST_PLAINTEXT_MIN_BYTES = 241 as const;
export const MANIFEST_PLAINTEXT_MAX_BYTES = 744 as const;
export const MANIFEST_CIPHERTEXT_MIN_BYTES = 281 as const;
export const MANIFEST_CIPHERTEXT_MAX_BYTES = 784 as const;

export const MEDIA_AAD_DOMAIN = "CRROLL-AAD-V1\0" as const;
export const MANIFEST_AAD_DOMAIN = "CRROLL-MAN-V1\0" as const;
export const MEDIA_AAD_BYTES = 95 as const;
export const MANIFEST_AAD_BYTES = 94 as const;

export const MANIFEST_PLAINTEXT_DOMAIN = "CRMANP1\0" as const;
export const TRIP_ENVELOPE_DOMAIN = "CRTKENV1" as const;
export const TRIP_ENVELOPE_PLAINTEXT_BYTES = 100 as const;
export const TRIP_ENVELOPE_CIPHERTEXT_BYTES = 148 as const;
export const TRIP_ENVELOPE_BASE64_CHARACTERS = 200 as const;

export type EncryptionFormatVersion = typeof ENCRYPTION_FORMAT_VERSION;
export type KeyEpoch = typeof INITIAL_KEY_EPOCH;
export type ObjectVariant = (typeof OBJECT_VARIANTS)[number];
export type VariantCode = (typeof VARIANT_CODES)[ObjectVariant];
export type AssociatedDataField = (typeof AAD_FIELDS)[number];

export type AssociatedData = Readonly<{
  tripId: string;
  assetId: string;
  variant: ObjectVariant;
  keyEpoch: KeyEpoch;
  formatVersion: EncryptionFormatVersion;
}>;
