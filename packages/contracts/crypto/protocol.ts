export const ENCRYPTION_FORMAT_VERSION = 1 as const;
export const INITIAL_KEY_EPOCH = 1 as const;
export const OBJECT_VARIANTS = ["PREVIEW", "ORIGINAL"] as const;
export const AAD_FIELDS = ["tripId", "assetId", "variant", "keyEpoch", "formatVersion"] as const;

export type EncryptionFormatVersion = typeof ENCRYPTION_FORMAT_VERSION;
export type KeyEpoch = typeof INITIAL_KEY_EPOCH;
export type ObjectVariant = (typeof OBJECT_VARIANTS)[number];
export type AssociatedDataField = (typeof AAD_FIELDS)[number];

export type AssociatedData = Readonly<{
  tripId: string;
  assetId: string;
  variant: ObjectVariant;
  keyEpoch: KeyEpoch;
  formatVersion: EncryptionFormatVersion;
}>;
