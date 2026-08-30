import type { IdGenerator } from "../../shared/ids/idGenerator.js";
import type { Clock } from "../../shared/time/clock.js";
import type {
  ClerkWebhookHeaders,
  ClerkWebhookVerifier,
} from "./ports/clerkWebhookVerifier.js";
import type { IdentityUnitOfWork } from "./ports/identityUnitOfWork.js";

export interface ClerkWebhookServiceDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: IdentityUnitOfWork;
  readonly verifier: ClerkWebhookVerifier;
}

export function createClerkWebhookService(
  dependencies: ClerkWebhookServiceDependencies,
) {
  return {
    async handle(rawBody: Readonly<Uint8Array>, headers: ClerkWebhookHeaders) {
      const event = await dependencies.verifier.verify(rawBody, headers);
      const candidateUserId =
        event.eventType === "user.deleted" ? dependencies.ids.uuid() : null;
      await dependencies.unitOfWork.applyWebhook(
        event,
        candidateUserId,
        dependencies.clock.now(),
      );
      return { received: true as const };
    },
  };
}
