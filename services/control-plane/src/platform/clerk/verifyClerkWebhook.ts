import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks";

import type {
  ClerkWebhookVerifier,
  VerifiedClerkWebhookEvent,
} from "../../modules/identity/ports/clerkWebhookVerifier.js";
import { DomainError } from "../../shared/errors/domainError.js";
import { requireClerkSubject } from "../../shared/auth/clerkSubject.js";
import { normalizeDisplayName } from "../../shared/identity/normalizeDisplayName.js";
import type { Clock } from "../../shared/time/clock.js";

interface Options {
  readonly clock: Clock;
  readonly signingSecret: string;
  readonly verifyImplementation?: (
    request: Request,
    options: { readonly signingSecret: string },
  ) => Promise<WebhookEvent>;
}

function invalidRequest(): never {
  throw new DomainError("INVALID_REQUEST");
}

function subjectFrom(input: unknown): string {
  try {
    return requireClerkSubject(input);
  } catch {
    return invalidRequest();
  }
}

function projectVerifiedEvent(
  eventId: string,
  input: unknown,
): VerifiedClerkWebhookEvent {
  if (typeof input !== "object" || input === null) return invalidRequest();
  const event = input as { readonly data?: unknown; readonly type?: unknown };
  if (
    typeof event.type !== "string" ||
    event.type.length < 1 ||
    event.type.length > 128 ||
    typeof event.data !== "object" ||
    event.data === null
  ) {
    return invalidRequest();
  }
  if (event.type === "user.updated") {
    const data = event.data as Record<string, unknown>;
    return {
      clerkSubject: subjectFrom(data.id),
      displayName: normalizeDisplayName({
        firstName: typeof data.first_name === "string" ? data.first_name : null,
        fullName: null,
        lastName: typeof data.last_name === "string" ? data.last_name : null,
        username: typeof data.username === "string" ? data.username : null,
      }),
      eventId,
      eventType: event.type,
    };
  }
  if (event.type === "user.deleted") {
    const data = event.data as Record<string, unknown>;
    return {
      clerkSubject: subjectFrom(data.id),
      displayName: null,
      eventId,
      eventType: event.type,
    };
  }
  return {
    clerkSubject: null,
    displayName: null,
    eventId,
    eventType: event.type,
  };
}

export function createClerkWebhookVerifier({
  clock,
  signingSecret,
  verifyImplementation = verifyWebhook,
}: Options): ClerkWebhookVerifier {
  if (signingSecret.trim().length === 0)
    throw new DomainError("INTERNAL_ERROR");
  return {
    async verify(rawBody, headers) {
      const { svixId, svixSignature, svixTimestamp } = headers;
      if (
        svixId === undefined ||
        svixId.length === 0 ||
        svixSignature === undefined ||
        svixSignature.length === 0 ||
        svixTimestamp === undefined ||
        !/^\d+$/u.test(svixTimestamp)
      ) {
        throw new DomainError("AUTH_INVALID");
      }
      const timestamp = Number(svixTimestamp);
      const now = Math.floor(clock.now().getTime() / 1_000);
      if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) {
        throw new DomainError("AUTH_INVALID");
      }
      const body = Buffer.from(rawBody);
      try {
        const request = new Request("https://crewroll.invalid/webhooks/clerk", {
          body,
          headers: {
            "content-type": "application/json",
            "svix-id": svixId,
            "svix-signature": svixSignature,
            "svix-timestamp": svixTimestamp,
          },
          method: "POST",
        });
        let verified: WebhookEvent;
        try {
          verified = await verifyImplementation(request, { signingSecret });
        } catch {
          throw new DomainError("AUTH_INVALID");
        }
        return projectVerifiedEvent(svixId, verified);
      } finally {
        body.fill(0);
      }
    },
  };
}
