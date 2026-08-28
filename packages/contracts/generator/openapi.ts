import {
  ApproveJoinRequestBodySchema,
  CommitAssetBodySchema,
  CommitAssetResponseSchema,
  CreateDownloadSessionBodySchema,
  CreateJoinRequestBodySchema,
  CreateTripBodySchema,
  CreateUploadSessionBodySchema,
  DeviceResponseSchema,
  DownloadSessionResponseSchema,
  EndTripBodySchema,
  InviteResponseSchema,
  MembershipResponseSchema,
  ProblemDetailsSchema,
  ReconciliationQuerySchema,
  ReconciliationResponseSchema,
  RegisterDeviceBodySchema,
  SavedReceiptBodySchema,
  SavedReceiptResponseSchema,
  StartTripBodySchema,
  SyncResponseSchema,
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

const schemaRef = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string, description = "Success") => ({
  description,
  content: { "application/json": { schema: schemaRef(name) } },
});
const requestBody = (name: string) => ({
  required: true,
  content: { "application/json": { schema: schemaRef(name) } },
});
const problemResponses = {
  "400": response("ProblemDetails", "Invalid request"),
  "401": response("ProblemDetails", "Authentication required"),
  "403": response("ProblemDetails", "Forbidden"),
  "404": response("ProblemDetails", "Not found"),
  "409": response("ProblemDetails", "Conflict"),
};

const authorizationHeader = {
  name: "Authorization",
  in: "header",
  required: true,
  schema: { type: "string", pattern: "^Bearer [^\\s]+$" },
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
const registrationHeaders = [authorizationHeader, idempotencyHeader];
const commandHeaders = [authorizationHeader, deviceHeader, idempotencyHeader];
const queryHeaders = [authorizationHeader, deviceHeader];
const pathId = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});

const operation = (
  operationId: string,
  parameters: readonly unknown[],
  responses: Record<string, unknown>,
  bodyName?: string,
) => ({
  operationId,
  parameters,
  ...(bodyName ? { requestBody: requestBody(bodyName) } : {}),
  responses: { ...responses, ...problemResponses },
});

function componentSchemas(): Record<string, unknown> {
  return {
    DeviceRegistrationHeaders: publicObjectSchemas.DeviceRegistrationHeadersSchema,
    MobileCommandHeaders: publicObjectSchemas.MobileCommandHeadersSchema,
    MobileQueryHeaders: publicObjectSchemas.MobileQueryHeadersSchema,
    RegisterDeviceBody: RegisterDeviceBodySchema,
    DeviceResponse: DeviceResponseSchema,
    UpdatePushTokenBody: UpdatePushTokenBodySchema,
    CreateTripBody: CreateTripBodySchema,
    TripResponse: TripResponseSchema,
    InviteResponse: InviteResponseSchema,
    CreateJoinRequestBody: CreateJoinRequestBodySchema,
    MembershipResponse: MembershipResponseSchema,
    ApproveJoinRequestBody: ApproveJoinRequestBodySchema,
    StartTripBody: StartTripBodySchema,
    EndTripBody: EndTripBodySchema,
    CreateUploadSessionBody: CreateUploadSessionBodySchema,
    UploadSessionResponse: UploadSessionResponseSchema,
    CommitAssetBody: CommitAssetBodySchema,
    CommitAssetResponse: CommitAssetResponseSchema,
    SyncResponse: SyncResponseSchema,
    CreateDownloadSessionBody: CreateDownloadSessionBodySchema,
    DownloadSessionResponse: DownloadSessionResponseSchema,
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
      "/v1/devices": {
        post: operation("registerDevice", registrationHeaders, { "201": response("DeviceResponse", "Registered") }, "RegisterDeviceBody"),
      },
      "/v1/devices/{deviceId}/push-token": {
        patch: operation("updatePushToken", [...commandHeaders, pathId("deviceId")], { "204": { description: "Updated" } }, "UpdatePushTokenBody"),
      },
      "/v1/devices/{deviceId}": {
        delete: operation("revokeDevice", [...commandHeaders, pathId("deviceId")], { "204": { description: "Revoked" } }),
      },
      "/v1/trips": {
        post: operation("createTrip", commandHeaders, { "201": response("TripResponse", "Created") }, "CreateTripBody"),
      },
      "/v1/trips/join-requests": {
        post: operation("createJoinRequest", commandHeaders, { "201": response("MembershipResponse", "Requested") }, "CreateJoinRequestBody"),
      },
      "/v1/trips/{tripId}/join-requests/{membershipId}/approval": {
        put: operation("approveJoinRequest", [...commandHeaders, pathId("tripId"), pathId("membershipId")], { "200": response("MembershipResponse") }, "ApproveJoinRequestBody"),
      },
      "/v1/trips/{tripId}/join-requests/{membershipId}": {
        delete: operation("rejectJoinRequest", [...commandHeaders, pathId("tripId"), pathId("membershipId")], { "204": { description: "Rejected" } }),
      },
      "/v1/trips/{tripId}/start": {
        post: operation("startTrip", [...commandHeaders, pathId("tripId")], { "200": response("TripResponse") }, "StartTripBody"),
      },
      "/v1/trips/{tripId}/end": {
        post: operation("endTrip", [...commandHeaders, pathId("tripId")], { "200": response("TripResponse") }, "EndTripBody"),
      },
      "/v1/trips/{tripId}": {
        get: operation("getTrip", [...queryHeaders, pathId("tripId")], { "200": response("TripResponse") }),
      },
      "/v1/trips/{tripId}/reconciliation": {
        get: operation("getReconciliation", [...queryHeaders, pathId("tripId"), {
          name: "cursor", in: "query", required: false, schema: { type: "string", format: "opaque-cursor" },
        }, {
          name: "limit", in: "query", required: false, schema: { type: "string", format: "decimal-max-100" },
        }], { "200": response("ReconciliationResponse") }),
      },
      "/v1/assets/upload-sessions": {
        post: operation("createUploadSession", commandHeaders, { "201": response("UploadSessionResponse", "Created") }, "CreateUploadSessionBody"),
      },
      "/v1/assets/{assetId}/commit": {
        post: operation("commitAsset", [...commandHeaders, pathId("assetId")], { "200": response("CommitAssetResponse") }, "CommitAssetBody"),
      },
      "/v1/sync": {
        get: operation("sync", [...queryHeaders, {
          name: "cursor", in: "query", required: false, schema: { type: "string", format: "opaque-cursor" },
        }, {
          name: "limit", in: "query", required: false, schema: { type: "string", format: "decimal-max-100" },
        }], { "200": response("SyncResponse") }),
      },
      "/v1/deliveries/{deliveryId}/download-session": {
        post: operation("createDownloadSession", [...commandHeaders, pathId("deliveryId")], { "201": response("DownloadSessionResponse", "Created") }, "CreateDownloadSessionBody"),
      },
      "/v1/deliveries/{deliveryId}/saved-receipt": {
        put: operation("saveReceipt", [...commandHeaders, pathId("deliveryId")], { "200": response("SavedReceiptResponse") }, "SavedReceiptBody"),
      },
    },
    components: {
      securitySchemes: {
        ClerkBearer: { type: "http", scheme: "bearer", bearerFormat: "Clerk" },
        BackgroundDeviceBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
      },
      schemas: componentSchemas(),
    },
  };
}

export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
