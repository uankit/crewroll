import { describe, expect, it, vi } from "vitest";

import { createClerkWebhookService } from "../../src/modules/identity/clerkWebhookService.js";

describe("Clerk webhook service", () => {
  it("verifies raw bytes then atomically applies the minimal event", async () => {
    const raw = Buffer.from('{"type":"user.deleted"}');
    const event = {
      clerkSubject: "user_deleted_subject",
      displayName: null,
      eventId: "evt_deleted_1",
      eventType: "user.deleted",
    };
    const verify = vi.fn().mockResolvedValue(event);
    const applyWebhook = vi.fn().mockResolvedValue("applied");
    const service = createClerkWebhookService({
      clock: { now: () => new Date("2026-08-30T08:00:00.000Z") },
      ids: { uuid: () => "018f0d98-76fa-7d1a-b4b4-1f742c2e3188" },
      unitOfWork: { applyWebhook },
      verifier: { verify },
    });

    await expect(
      service.handle(raw, {
        svixId: "evt_deleted_1",
        svixSignature: "signature-canary",
        svixTimestamp: "1788076800",
      }),
    ).resolves.toEqual({ received: true });
    expect(verify).toHaveBeenCalledWith(raw, {
      svixId: "evt_deleted_1",
      svixSignature: "signature-canary",
      svixTimestamp: "1788076800",
    });
    expect(applyWebhook).toHaveBeenCalledWith(
      event,
      "018f0d98-76fa-7d1a-b4b4-1f742c2e3188",
      new Date("2026-08-30T08:00:00.000Z"),
    );
  });

  it("does not allocate a tombstone ID for non-deletion events", async () => {
    const uuid = vi.fn();
    const applyWebhook = vi.fn().mockResolvedValue("replay");
    const service = createClerkWebhookService({
      clock: { now: () => new Date("2026-08-30T08:00:00.000Z") },
      ids: { uuid },
      unitOfWork: { applyWebhook },
      verifier: {
        verify: () =>
          Promise.resolve({
            clerkSubject: "user_updated_subject",
            displayName: "Updated member",
            eventId: "evt_updated_1",
            eventType: "user.updated",
          }),
      },
    });
    await service.handle(Buffer.from("{}"), {
      svixId: "evt_updated_1",
      svixSignature: "sig",
      svixTimestamp: "1788076800",
    });
    expect(uuid).not.toHaveBeenCalled();
    expect(applyWebhook).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.any(Date),
    );
  });
});
