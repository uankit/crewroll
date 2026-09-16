import {
  TripListResponseSchema,
  TripLifecycleBodySchema,
  TripTransferStateSchema,
  TripDrainBodySchema,
  ApproveJoinRequestBodySchema,
  CommitAssetBodySchema,
  CommitAssetResponseSchema,
  CreateDownloadSessionBodySchema,
  CreateJoinRequestBodySchema,
  CreateTripBodySchema,
  CreateTripOutcomeBodySchema,
  CreateTripOutcomeResponseSchema,
  CreateUploadSessionBodySchema,
  DeviceResponseSchema,
  DownloadSessionResponseSchema,
  PendingDeliveriesResponseSchema,
  EndTripBodySchema,
  InviteResponseSchema,
  InvitePreviewBodySchema,
  InvitePreviewResponseSchema,
  MembershipResponseSchema,
  ProblemDetailsSchema,
  ProfileResponseSchema,
  SyncProfileBodySchema,
  PublishPreviewBodySchema,
  PublishPreviewResponseSchema,
  PreviewDownloadResponseSchema,
  PreviewFeedResponseSchema,
  ReconciliationQuerySchema,
  ReconciliationResponseSchema,
  RegisterDeviceBodySchema,
  SavedReceiptBodySchema,
  SavedReceiptResponseSchema,
  SetTripReadinessBodySchema,
  StartTripBodySchema,
  SyncResponseSchema,
  TripIdSchema,
  TripResponseSchema,
  UpdatePushTokenBodySchema,
  UploadSessionResponseSchema,
  publicObjectSchemas,
} from "../openapi/index.js";

type JsonSchema = Readonly<Record<string, unknown>>;

export type OpenApiDocument = Readonly<{
  openapi: "3.1.0";
  info: Readonly<{ title: string; version: string }>;
  paths: Record<string, unknown>;
  components: Readonly<Record<string, unknown>>;
}>;

const schemaRef = (name: string): JsonSchema => ({
  $ref: `#/components/schemas/${name}`,
});
const response = (name: string, description = "Success") => ({
  description,
  content: { "application/json": { schema: schemaRef(name) } },
});
const problemResponse = (description: string) => ({
  description,
  content: {
    "application/problem+json": {
      schema: schemaRef("ProblemDetails"),
    },
  },
});
const requestBody = (name: string) => ({
  required: true,
  content: { "application/json": { schema: schemaRef(name) } },
});
const problemResponses = {
  "400": problemResponse("Invalid request"),
  "401": problemResponse("Authentication required"),
  "403": problemResponse("Forbidden"),
  "404": problemResponse("Not found"),
  "409": problemResponse("Conflict"),
  "429": problemResponse("Rate limited"),
  "500": problemResponse("Internal error"),
};

const deviceHeader = {
  name: "X-CrewRoll-Device-Id",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const registrationHeaders = [idempotencyHeader];
const commandHeaders = [deviceHeader, idempotencyHeader];
const queryHeaders = [deviceHeader];
const pathId = (
  name: string,
  schema: JsonSchema = { type: "string", format: "uuid" },
) => ({
  name,
  in: "path",
  required: true,
  schema,
});
const tripPathId = pathId("tripId", TripIdSchema);

const operation = (
  operationId: string,
  parameters: readonly unknown[],
  responses: Record<string, unknown>,
  bodyName?: string,
  securityScheme:
    "ClerkBearer" | "BackgroundDeviceBearer" = "BackgroundDeviceBearer",
) => ({
  operationId,
  security: [{ [securityScheme]: [] }],
  parameters,
  ...(bodyName ? { requestBody: requestBody(bodyName) } : {}),
  responses: { ...responses, ...problemResponses },
});

function componentSchemas(): Record<string, unknown> {
  return {
    ProfileResponse: ProfileResponseSchema,
    SyncProfileBody: SyncProfileBodySchema,
    DeviceRegistrationHeaders:
      publicObjectSchemas.DeviceRegistrationHeadersSchema,
    MobileCommandHeaders: publicObjectSchemas.MobileCommandHeadersSchema,
    MobileQueryHeaders: publicObjectSchemas.MobileQueryHeadersSchema,
    RegisterDeviceBody: RegisterDeviceBodySchema,
    DeviceResponse: DeviceResponseSchema,
    UpdatePushTokenBody: UpdatePushTokenBodySchema,
    CreateTripBody: CreateTripBodySchema,
    CreateTripOutcomeBody: CreateTripOutcomeBodySchema,
    CreateTripOutcomeResponse: CreateTripOutcomeResponseSchema,
    TripResponse: TripResponseSchema,
    InviteResponse: InviteResponseSchema,
    InvitePreviewBody: InvitePreviewBodySchema,
    InvitePreviewResponse: InvitePreviewResponseSchema,
    CreateJoinRequestBody: CreateJoinRequestBodySchema,
    MembershipResponse: MembershipResponseSchema,
    ApproveJoinRequestBody: ApproveJoinRequestBodySchema,
    SetTripReadinessBody: SetTripReadinessBodySchema,
    StartTripBody: StartTripBodySchema,
    EndTripBody: EndTripBodySchema,
    TripContinuity: publicObjectSchemas.TripContinuitySchema,
    TripContinuityBody: publicObjectSchemas.TripContinuityBodySchema,
    TripListResponse: TripListResponseSchema,
    TripLifecycleBody: TripLifecycleBodySchema,
    TripTransferState: TripTransferStateSchema,
    TripDrainBody: TripDrainBodySchema,
    CreateUploadSessionBody: CreateUploadSessionBodySchema,
    UploadSessionResponse: UploadSessionResponseSchema,
    CommitAssetBody: CommitAssetBodySchema,
    CommitAssetResponse: CommitAssetResponseSchema,
    PublishPreviewBody: PublishPreviewBodySchema,
    PublishPreviewResponse: PublishPreviewResponseSchema,
    PreviewDownloadResponse: PreviewDownloadResponseSchema,
    PreviewFeedResponse: PreviewFeedResponseSchema,
    SyncResponse: SyncResponseSchema,
    CreateDownloadSessionBody: CreateDownloadSessionBodySchema,
    DownloadSessionResponse: DownloadSessionResponseSchema,
    PendingDeliveriesResponse: PendingDeliveriesResponseSchema,
    SavedReceiptBody: SavedReceiptBodySchema,
    SavedReceiptResponse: SavedReceiptResponseSchema,
    ReconciliationQuery: ReconciliationQuerySchema,
    ReconciliationResponse: ReconciliationResponseSchema,
    SyncAvailablePushHint: publicObjectSchemas.SyncAvailablePushHintSchema,
    ProblemDetails: ProblemDetailsSchema,
  };
}

export function createOpenApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "CrewRoll Control Plane", version: "1.0.0" },
    paths: {
      "/v1/trips/{tripId}/continuity": {
        get: operation(
          "getTripContinuity",
          [...queryHeaders, pathId("tripId", TripIdSchema)],
          { "200": response("TripContinuity") },
          undefined,
          "ClerkBearer",
        ),
        post: operation(
          "changeTripContinuity",
          [...commandHeaders, pathId("tripId", TripIdSchema)],
          { "200": response("TripContinuity") },
          "TripContinuityBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}/lifecycle": {
        get: operation(
          "getTripLifecycle",
          [...queryHeaders, pathId("tripId", TripIdSchema)],
          { "200": response("TripTransferState") },
          undefined,
          "ClerkBearer",
        ),
        post: operation(
          "changeTripLifecycle",
          [...commandHeaders, pathId("tripId", TripIdSchema)],
          { "200": response("TripTransferState") },
          "TripLifecycleBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}/transfer-state": {
        get: operation(
          "getTripTransferState",
          [...queryHeaders, pathId("tripId", TripIdSchema)],
          { "200": response("TripTransferState") },
        ),
      },
      "/v1/trips/{tripId}/drained": {
        post: operation(
          "acknowledgeTripDrain",
          [...commandHeaders, pathId("tripId", TripIdSchema)],
          { "200": response("TripTransferState") },
          "TripDrainBody",
        ),
      },
      "/v1/profile": {
        put: operation(
          "syncProfile",
          [],
          { "200": response("ProfileResponse") },
          "SyncProfileBody",
          "ClerkBearer",
        ),
      },
      "/v1/devices": {
        post: operation(
          "registerDevice",
          registrationHeaders,
          { "201": response("DeviceResponse", "Registered") },
          "RegisterDeviceBody",
          "ClerkBearer",
        ),
      },
      "/v1/devices/{deviceId}/push-token": {
        patch: operation(
          "updatePushToken",
          [...commandHeaders, pathId("deviceId")],
          { "204": { description: "Updated" } },
          "UpdatePushTokenBody",
          "ClerkBearer",
        ),
      },
      "/v1/devices/{deviceId}": {
        delete: operation(
          "revokeDevice",
          [...commandHeaders, pathId("deviceId")],
          { "204": { description: "Revoked" } },
          undefined,
          "ClerkBearer",
        ),
      },
      "/v1/trips": {
        get: operation(
          "listTrips",
          queryHeaders,
          { "200": response("TripListResponse") },
          undefined,
          "ClerkBearer",
        ),
        post: operation(
          "createTrip",
          commandHeaders,
          { "201": response("TripResponse", "Created") },
          "CreateTripBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/create-outcome": {
        post: operation(
          "resolveCreateTripOutcome",
          commandHeaders,
          { "200": response("CreateTripOutcomeResponse") },
          "CreateTripOutcomeBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/invite-preview": {
        post: operation(
          "previewInvite",
          queryHeaders,
          { "200": response("InvitePreviewResponse") },
          "InvitePreviewBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/join-requests": {
        post: operation(
          "createJoinRequest",
          commandHeaders,
          { "201": response("MembershipResponse", "Requested") },
          "CreateJoinRequestBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}/join-requests/{membershipId}/approval": {
        put: operation(
          "approveJoinRequest",
          [...commandHeaders, tripPathId, pathId("membershipId")],
          { "200": response("MembershipResponse") },
          "ApproveJoinRequestBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}/join-requests/{membershipId}": {
        delete: operation(
          "rejectJoinRequest",
          [...commandHeaders, tripPathId, pathId("membershipId")],
          { "204": { description: "Rejected" } },
          undefined,
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}/readiness": {
        put: operation(
          "setTripReadiness",
          [...commandHeaders, tripPathId],
          { "200": response("TripResponse") },
          "SetTripReadinessBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}/start": {
        post: operation(
          "startTrip",
          [...commandHeaders, tripPathId],
          { "200": response("TripResponse") },
          "StartTripBody",
          "ClerkBearer",
        ),
      },
      "/v1/trips/{tripId}": {
        get: operation(
          "getTrip",
          [...queryHeaders, tripPathId],
          {
            "200": response("TripResponse"),
          },
          undefined,
          "ClerkBearer",
        ),
      },
      "/v1/assets/upload-sessions": {
        post: operation(
          "createUploadSession",
          commandHeaders,
          { "201": response("UploadSessionResponse", "Created") },
          "CreateUploadSessionBody",
        ),
      },
      "/v1/assets/{assetId}/commit": {
        post: operation(
          "commitAsset",
          [...commandHeaders, pathId("assetId")],
          { "200": response("CommitAssetResponse") },
          "CommitAssetBody",
        ),
      },
      "/v1/assets/{assetId}/preview": {
        post: operation(
          "publishPreview",
          [...commandHeaders, pathId("assetId")],
          { "200": response("PublishPreviewResponse") },
          "PublishPreviewBody",
        ),
        get: operation("getPreview", [...queryHeaders, pathId("assetId")], {
          "200": response("PreviewDownloadResponse"),
        }),
      },
      "/v1/trips/{tripId}/previews": {
        get: operation(
          "getPreviewFeed",
          [
            ...queryHeaders,
            tripPathId,
            {
              name: "after",
              in: "query",
              required: false,
              schema: { type: "string", pattern: "^(?:0|[1-9]\\d{0,18})$" },
            },
          ],
          { "200": response("PreviewFeedResponse") },
        ),
      },
      "/v1/deliveries/pending": {
        get: operation("getPendingDeliveries", queryHeaders, {
          "200": response("PendingDeliveriesResponse"),
        }),
      },
      "/v1/deliveries/{deliveryId}/download-session": {
        post: operation(
          "createDownloadSession",
          [...commandHeaders, pathId("deliveryId")],
          { "200": response("DownloadSessionResponse") },
          "CreateDownloadSessionBody",
        ),
      },
      "/v1/deliveries/{deliveryId}/saved-receipt": {
        post: operation(
          "saveReceipt",
          [...commandHeaders, pathId("deliveryId")],
          { "200": response("SavedReceiptResponse") },
          "SavedReceiptBody",
        ),
      },
    },
    components: {
      securitySchemes: {
        ClerkBearer: { type: "http", scheme: "bearer", bearerFormat: "Clerk" },
        BackgroundDeviceBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
        },
      },
      schemas: componentSchemas(),
    },
  };
}

export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
