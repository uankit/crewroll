import {
  TripTransferStateSchema,
  TripDrainBodySchema,
  type TripDrainBody,
  type TripTransferState,
} from "@crewroll/contracts";
import {
  AssetIdSchema,
  ClosedObject,
  CommitAssetBodySchema,
  CommitAssetResponseSchema,
  CreateDownloadSessionBodySchema,
  CreateUploadSessionBodySchema,
  DateTimeSchema,
  DeliveryIdSchema,
  DeviceIdSchema,
  DownloadSessionResponseSchema,
  MobileCommandHeadersSchema,
  MobileQueryHeadersSchema,
  SavedReceiptBodySchema,
  SavedReceiptResponseSchema,
  TripIdSchema,
  UploadSessionResponseSchema,
  type CommitAssetBody,
  type CreateDownloadSessionBody,
  type CreateUploadSessionBody,
  type SavedReceiptBody,
  PublishPreviewBodySchema,
  PublishPreviewResponseSchema,
  PreviewDownloadResponseSchema,
  PreviewFeedQuerySchema,
  PreviewFeedResponseSchema,
  type PublishPreviewBody,
} from "@crewroll/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MediaActor, MediaService } from "./index.js";
import type { LocalCiphertextGateway } from "./ports/localCiphertextGateway.js";

export interface MediaRouteDependencies {
  readonly lifecycle?: {
    read(actor: MediaActor, tripId: string): Promise<TripTransferState>;
    drained(
      actor: MediaActor,
      tripId: string,
      observedVersion: number,
    ): Promise<TripTransferState>;
  };
  readonly localObjects?: LocalCiphertextGateway;
  readonly service: MediaService;
  readonly authenticator: {
    authenticate(input: {
      authorization: string | undefined;
      headerDeviceId: string;
    }): Promise<MediaActor>;
  };
}

export function mediaRoutes(
  app: FastifyInstance,
  dependencies: MediaRouteDependencies,
  done: (error?: Error) => void,
) {
  const commandHeaders = Type.Object(MobileCommandHeadersSchema.properties, {
    additionalProperties: true,
  });
  const queryHeaders = Type.Object(MobileQueryHeadersSchema.properties, {
    additionalProperties: true,
  });
  const actors = new WeakMap<FastifyRequest, MediaActor>();
  const authenticate = async (request: FastifyRequest) => {
    actors.set(
      request,
      await dependencies.authenticator.authenticate({
        authorization: request.headers.authorization,
        headerDeviceId: String(request.headers["x-crewroll-device-id"] ?? ""),
      }),
    );
  };
  const actor = (request: FastifyRequest) => actors.get(request)!;
  if (dependencies.localObjects) {
    const gateway = dependencies.localObjects;
    app.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, callback) => callback(null, payload),
    );
    app.put<{
      Querystring: { grant: string };
      Body: AsyncIterable<Uint8Array>;
    }>("/v1/local-media/object", async (request, reply) => {
      const result = await gateway.put(request.query.grant, request.body);
      return reply.header("ETag", result.etag).code(200).send();
    });
    app.get<{ Querystring: { grant: string } }>(
      "/v1/local-media/object",
      { exposeHeadRoute: false },
      async (request, reply) => {
        const result = await gateway.get(request.query.grant);
        return reply
          .header("ETag", result.etag)
          .header("Content-Length", result.bytes)
          .type("application/octet-stream")
          .send(result.body);
      },
    );
  }
  // Authentication happens before schema validation; no cache may retain
  // signed object URLs, member lists, or encrypted manifests.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  if (dependencies.lifecycle) {
    const lifecycle = dependencies.lifecycle;
    app.get<{ Params: { tripId: string } }>(
      "/v1/trips/:tripId/transfer-state",
      {
        preValidation: authenticate,
        schema: {
          headers: queryHeaders,
          params: ClosedObject({ tripId: TripIdSchema }),
          response: { 200: TripTransferStateSchema },
        },
      },
      (request) =>
        lifecycle.read(actor(request), request.params.tripId.toLowerCase()),
    );
    app.post<{ Params: { tripId: string }; Body: TripDrainBody }>(
      "/v1/trips/:tripId/drained",
      {
        preValidation: authenticate,
        schema: {
          headers: commandHeaders,
          params: ClosedObject({ tripId: TripIdSchema }),
          body: TripDrainBodySchema,
          response: { 200: TripTransferStateSchema },
        },
      },
      (request) =>
        lifecycle.drained(
          actor(request),
          request.params.tripId.toLowerCase(),
          request.body.observedVersion,
        ),
    );
  }
  app.post<{ Body: CreateUploadSessionBody }>(
    "/v1/assets/upload-sessions",
    {
      preValidation: authenticate,
      schema: {
        headers: commandHeaders,
        body: CreateUploadSessionBodySchema,
        response: { 201: UploadSessionResponseSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await dependencies.service.createUpload(actor(request), request.body),
        ),
  );
  app.post<{ Params: { assetId: string }; Body: PublishPreviewBody }>(
    "/v1/assets/:assetId/preview",
    {
      preValidation: authenticate,
      schema: {
        headers: commandHeaders,
        params: ClosedObject({ assetId: AssetIdSchema }),
        body: PublishPreviewBodySchema,
        response: { 200: PublishPreviewResponseSchema },
      },
    },
    (request) =>
      dependencies.service.publishPreview(
        actor(request),
        request.params.assetId.toLowerCase(),
        request.body,
      ),
  );
  app.get<{ Params: { assetId: string } }>(
    "/v1/assets/:assetId/preview",
    {
      exposeHeadRoute: false,
      preValidation: authenticate,
      schema: {
        headers: queryHeaders,
        params: ClosedObject({ assetId: AssetIdSchema }),
        response: { 200: PreviewDownloadResponseSchema },
      },
    },
    (request) =>
      dependencies.service.previewDownload(
        actor(request),
        request.params.assetId.toLowerCase(),
      ),
  );
  app.get<{ Params: { tripId: string }; Querystring: { after?: string } }>(
    "/v1/trips/:tripId/previews",
    {
      exposeHeadRoute: false,
      preValidation: authenticate,
      schema: {
        headers: queryHeaders,
        params: ClosedObject({ tripId: TripIdSchema }),
        querystring: PreviewFeedQuerySchema,
        response: { 200: PreviewFeedResponseSchema },
      },
    },
    (request) =>
      dependencies.service.previewFeed(
        actor(request),
        request.params.tripId.toLowerCase(),
        request.query.after ?? "0",
      ),
  );
  app.post<{ Params: { assetId: string }; Body: CommitAssetBody }>(
    "/v1/assets/:assetId/commit",
    {
      preValidation: authenticate,
      schema: {
        headers: commandHeaders,
        params: ClosedObject({ assetId: AssetIdSchema }),
        body: CommitAssetBodySchema,
        response: { 200: CommitAssetResponseSchema },
      },
    },
    async (request) =>
      dependencies.service.commit(
        actor(request),
        request.params.assetId.toLowerCase(),
        request.body,
      ),
  );
  app.get(
    "/v1/deliveries/pending",
    {
      exposeHeadRoute: false,
      preValidation: authenticate,
      schema: {
        headers: queryHeaders,
        response: {
          200: ClosedObject({
            items: Type.Array(
              ClosedObject({
                deliveryId: DeliveryIdSchema,
                assetId: AssetIdSchema,
                tripId: TripIdSchema,
                sourceDeviceId: DeviceIdSchema,
                committedAt: DateTimeSchema,
              }),
              { maxItems: 100 },
            ),
          }),
        },
      },
    },
    async (request) => dependencies.service.pending(actor(request)),
  );
  app.post<{ Params: { deliveryId: string }; Body: CreateDownloadSessionBody }>(
    "/v1/deliveries/:deliveryId/download-session",
    {
      preValidation: authenticate,
      schema: {
        headers: commandHeaders,
        params: ClosedObject({ deliveryId: DeliveryIdSchema }),
        body: CreateDownloadSessionBodySchema,
        response: { 200: DownloadSessionResponseSchema },
      },
    },
    async (request) =>
      dependencies.service.download(
        actor(request),
        request.params.deliveryId.toLowerCase(),
        request.body,
      ),
  );
  app.post<{ Params: { deliveryId: string }; Body: SavedReceiptBody }>(
    "/v1/deliveries/:deliveryId/saved-receipt",
    {
      preValidation: authenticate,
      schema: {
        headers: commandHeaders,
        params: ClosedObject({ deliveryId: DeliveryIdSchema }),
        body: SavedReceiptBodySchema,
        response: { 200: SavedReceiptResponseSchema },
      },
    },
    async (request) =>
      dependencies.service.saved(
        actor(request),
        request.params.deliveryId.toLowerCase(),
        String(request.headers["idempotency-key"]),
        request.body,
      ),
  );
  done();
}
