import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createClerkWebhookVerifier } from "../../src/platform/clerk/verifyClerkWebhook.js";

const secretBytes = Buffer.alloc(32, 0x4a);
const secret = `whsec_${secretBytes.toString("base64")}`;
const now = new Date();
const timestamp = Math.floor(now.getTime() / 1_000);
const eventId = "evt_identity_001";
const raw = Buffer.from(
  JSON.stringify({
    data: {
      first_name: " Ada ",
      id: "user_webhook_subject",
      last_name: " Lovelace ",
    },
    type: "user.updated",
  }),
);

function signature(body: Uint8Array, at = timestamp): string {
  const signed = Buffer.concat([
    Buffer.from(`${eventId}.${at}.`),
    Buffer.from(body),
  ]);
  return `v1,${createHmac("sha256", secretBytes).update(signed).digest("base64")}`;
}

function headers(at = timestamp, body: Uint8Array = raw) {
  return {
    svixId: eventId,
    svixSignature: signature(body, at),
    svixTimestamp: String(at),
  };
}

describe("Clerk webhook verifier", () => {
  it("verifies original raw bytes and returns only a minimal event", async () => {
    const verifier = createClerkWebhookVerifier({
      clock: { now: () => now },
      signingSecret: secret,
    });
    await expect(verifier.verify(raw, headers())).resolves.toEqual({
      clerkSubject: "user_webhook_subject",
      displayName: "Ada Lovelace",
      eventId,
      eventType: "user.updated",
    });
  });

  it.each(["svixId", "svixTimestamp", "svixSignature"] as const)(
    "rejects missing %s without provider detail",
    async (missing) => {
      const verifier = createClerkWebhookVerifier({
        clock: { now: () => now },
        signingSecret: secret,
      });
      const input = { ...headers(), [missing]: undefined };
      await expect(verifier.verify(raw, input)).rejects.toMatchObject({
        kind: "AUTH_INVALID",
        message: "CrewRoll domain error",
      });
    },
  );

  it("rejects bad signatures and one-byte raw mutations", async () => {
    const verifier = createClerkWebhookVerifier({
      clock: { now: () => now },
      signingSecret: secret,
    });
    await expect(
      verifier.verify(raw, { ...headers(), svixSignature: "v1,bad" }),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    const mutated = Buffer.from(raw);
    mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;
    await expect(verifier.verify(mutated, headers())).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
  });

  it("accepts five minutes exactly and rejects one second beyond", async () => {
    const verifier = createClerkWebhookVerifier({
      clock: { now: () => now },
      signingSecret: secret,
    });
    await expect(
      verifier.verify(raw, headers(timestamp - 300)),
    ).resolves.toMatchObject({ eventId });
    await expect(
      verifier.verify(raw, headers(timestamp - 301)),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
  });

  it("maps verified malformed user events to invalid request", async () => {
    const verifier = createClerkWebhookVerifier({
      clock: { now: () => now },
      signingSecret: secret,
      verifyImplementation: () =>
        Promise.resolve({
          data: { id: "" },
          type: "user.deleted",
        } as never),
    });
    await expect(verifier.verify(raw, headers())).rejects.toMatchObject({
      kind: "INVALID_REQUEST",
    });
  });

  it("collapses provider exceptions without their canary", async () => {
    const canary = "provider-webhook-canary-742f";
    const verifier = createClerkWebhookVerifier({
      clock: { now: () => now },
      signingSecret: secret,
      verifyImplementation: () => Promise.reject(new Error(canary)),
    });
    const error = await verifier
      .verify(raw, headers())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "AUTH_INVALID" });
    expect(String(error)).not.toContain(canary);
  });
});
