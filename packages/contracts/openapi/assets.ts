import { Type, type Static } from "@sinclair/typebox";

import {
  Base64ExactSchema,
  Base64MaxSchema,
  ClosedObject,
  DateTimeSchema,
  DecimalBytesSchema,
  SourceAssetKeySchema,
  UriSchema,
} from "./common.js";
import { AssetIdSchema, TripIdSchema, UploadSessionIdSchema } from "./ids.js";

const ChecksumSchema = Base64ExactSchema(32);

export const PreviewUploadObjectSchema = ClosedObject({
  variant: Type.Literal("PREVIEW"),
  ciphertextBytes: DecimalBytesSchema(524_288),
  checksumSha256: ChecksumSchema,
});
export const OriginalUploadObjectSchema = ClosedObject({
  variant: Type.Literal("ORIGINAL"),
  ciphertextBytes: DecimalBytesSchema(52_428_800),
  checksumSha256: ChecksumSchema,
});

export const CreateUploadSessionBodySchema = ClosedObject({
  tripId: TripIdSchema,
  assetId: AssetIdSchema,
  sourceAssetKey: SourceAssetKeySchema,
  capturedAt: DateTimeSchema,
  formatVersion: Type.Literal(1),
  keyEpoch: Type.Literal(1),
  encryptedManifest: Base64MaxSchema(65_536),
  objects: Type.Tuple([PreviewUploadObjectSchema, OriginalUploadObjectSchema]),
});
export type CreateUploadSessionBody = Static<
  typeof CreateUploadSessionBodySchema
>;

const PresignedUploadFields = {
  url: UriSchema,
  uploadedEtag: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  requiredHeaders: ClosedObject({
    "content-length": Type.String({ pattern: "^(?:0|[1-9]\\d*)$" }),
    "content-type": Type.Literal("application/octet-stream"),
    "x-amz-checksum-sha256": Base64ExactSchema(32),
    "if-none-match": Type.Literal("*"),
  }),
} as const;
export const PresignedPreviewUploadObjectSchema = ClosedObject({
  variant: Type.Literal("PREVIEW"),
  ...PresignedUploadFields,
});
export const PresignedOriginalUploadObjectSchema = ClosedObject({
  variant: Type.Literal("ORIGINAL"),
  ...PresignedUploadFields,
});

export const UploadSessionResponseSchema = ClosedObject({
  uploadSessionId: UploadSessionIdSchema,
  assetId: AssetIdSchema,
  expiresAt: DateTimeSchema,
  objects: Type.Tuple([
    PresignedPreviewUploadObjectSchema,
    PresignedOriginalUploadObjectSchema,
  ]),
});
export type UploadSessionResponse = Static<typeof UploadSessionResponseSchema>;

export const CommittedPreviewObjectSchema = ClosedObject({
  variant: Type.Literal("PREVIEW"),
  etag: Type.String({ minLength: 1, maxLength: 256 }),
});
export const CommittedOriginalObjectSchema = ClosedObject({
  variant: Type.Literal("ORIGINAL"),
  etag: Type.String({ minLength: 1, maxLength: 256 }),
});

export const CommitAssetBodySchema = ClosedObject({
  uploadSessionId: UploadSessionIdSchema,
  objects: Type.Tuple([
    CommittedPreviewObjectSchema,
    CommittedOriginalObjectSchema,
  ]),
});
export type CommitAssetBody = Static<typeof CommitAssetBodySchema>;

export const CommitAssetResponseSchema = ClosedObject({
  assetId: AssetIdSchema,
  committedAt: DateTimeSchema,
  sequence: Type.String({ pattern: "^(?:0|[1-9]\\d*)$" }),
});
export type CommitAssetResponse = Static<typeof CommitAssetResponseSchema>;
