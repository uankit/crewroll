import type { VerifiedClerkWebhookEvent } from "./clerkWebhookVerifier.js";

export interface IdentityUnitOfWork {
  applyWebhook(
    event: VerifiedClerkWebhookEvent,
    candidateUserId: string | null,
    now: Date,
  ): Promise<"applied" | "replay">;
}
