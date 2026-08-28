import { Type, type Static } from "@sinclair/typebox";

import {
  Base64ExactSchema,
  Base64MaxSchema,
  ClosedObject,
  DateTimeSchema,
  DecimalBytesSchema,
  UriSchema,
} from "./common.js";
import { DeliveryStatusSchema } from "./enums.js";
import { AssetIdSchema, DeliveryIdSchema } from "./ids.js";

export const CreateDownloadSessionBodySchema = ClosedObject({
  variants: Type.Array(Type.Union([Type.Literal("PREVIEW"), Type.Literal("ORIGINAL")]), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
  }),
});
export type CreateDownloadSessionBody = Static<typeof CreateDownloadSessionBodySchema>;

const DownloadObjectFields = {
  url: UriSchema,
  checksumSha256: Base64ExactSchema(32),
} as const;
export const PreviewDownloadObjectSchema = ClosedObject({
  variant: Type.Literal("PREVIEW"),
  ciphertextBytes: DecimalBytesSchema(524_288),
  ...DownloadObjectFields,
});
export const OriginalDownloadObjectSchema = ClosedObject({
  variant: Type.Literal("ORIGINAL"),
  ciphertextBytes: DecimalBytesSchema(52_428_800),
  ...DownloadObjectFields,
});

export const DownloadSessionResponseSchema = ClosedObject({
  deliveryId: DeliveryIdSchema,
  assetId: AssetIdSchema,
  expiresAt: DateTimeSchema,
  encryptedManifest: Base64MaxSchema(65_536),
  objects: Type.Array(Type.Union([PreviewDownloadObjectSchema, OriginalDownloadObjectSchema]), {
    minItems: 1,
    maxItems: 2,
  }),
});
export type DownloadSessionResponse = Static<typeof DownloadSessionResponseSchema>;

export const SavedReceiptBodySchema = ClosedObject({
  assetId: AssetIdSchema,
  savedAt: DateTimeSchema,
  engineRevision: Type.Integer({ minimum: 0 }),
});
export type SavedReceiptBody = Static<typeof SavedReceiptBodySchema>;

export const SavedReceiptResponseSchema = ClosedObject({
  deliveryId: DeliveryIdSchema,
  status: DeliveryStatusSchema,
  acceptedAt: DateTimeSchema,
});
export type SavedReceiptResponse = Static<typeof SavedReceiptResponseSchema>;
