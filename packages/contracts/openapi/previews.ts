import { Type, type Static } from "@sinclair/typebox";
import { Base64MaxSchema, ClosedObject, DateTimeSchema } from "./common.js";
import {
  AssetIdSchema,
  DeviceIdSchema,
  MembershipIdSchema,
  UploadSessionIdSchema,
} from "./ids.js";
import { PreviewDownloadObjectSchema } from "./deliveries.js";

export const PublishPreviewBodySchema = ClosedObject({
  uploadSessionId: UploadSessionIdSchema,
  etag: Type.String({ minLength: 1, maxLength: 256 }),
});
export type PublishPreviewBody = Static<typeof PublishPreviewBodySchema>;
export const PublishPreviewResponseSchema = ClosedObject({
  assetId: AssetIdSchema,
  publishedAt: DateTimeSchema,
});
export type PublishPreviewResponse = Static<
  typeof PublishPreviewResponseSchema
>;
export const PreviewDownloadResponseSchema = ClosedObject({
  assetId: AssetIdSchema,
  sourceMembershipId: Type.Optional(MembershipIdSchema),
  expiresAt: DateTimeSchema,
  encryptedManifest: Base64MaxSchema(65_536),
  object: PreviewDownloadObjectSchema,
});
export type PreviewDownloadResponse = Static<
  typeof PreviewDownloadResponseSchema
>;
export const PreviewFeedQuerySchema = ClosedObject({
  after: Type.Optional(Type.String({ pattern: "^(?:0|[1-9]\\d{0,18})$" })),
});
export const PreviewFeedResponseSchema = ClosedObject({
  items: Type.Array(
    ClosedObject({
      sequence: Type.String({ pattern: "^[1-9]\\d*$" }),
      assetId: AssetIdSchema,
      sourceDeviceId: DeviceIdSchema,
      publishedAt: DateTimeSchema,
      download: PreviewDownloadResponseSchema,
    }),
    { maxItems: 20 },
  ),
  nextCursor: Type.String({ pattern: "^(?:0|[1-9]\\d*)$" }),
  hasMore: Type.Boolean(),
});
export type PreviewFeedResponse = Static<typeof PreviewFeedResponseSchema>;
