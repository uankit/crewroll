import { ClosedObject } from "@crewroll/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

interface ClerkWebhookCommand {
  handle(
    rawBody: Readonly<Uint8Array>,
    headers: {
      readonly svixId: string | undefined;
      readonly svixSignature: string | undefined;
      readonly svixTimestamp: string | undefined;
    },
  ): Promise<{ readonly received: true }>;
}

export interface ClerkWebhookRouteDependencies {
  readonly webhookService: ClerkWebhookCommand;
}

const ReceivedSchema = ClosedObject({ received: Type.Literal(true) });

export function clerkWebhookRoutes(
  app: FastifyInstance,
  dependencies: ClerkWebhookRouteDependencies,
): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.post<{ Body: Buffer }>(
    "/webhooks/clerk",
    { schema: { response: { 200: ReceivedSchema } } },
    async (request) =>
      dependencies.webhookService.handle(request.body, {
        svixId: request.headers["svix-id"] as string | undefined,
        svixSignature: request.headers["svix-signature"] as string | undefined,
        svixTimestamp: request.headers["svix-timestamp"] as string | undefined,
      }),
  );
}
