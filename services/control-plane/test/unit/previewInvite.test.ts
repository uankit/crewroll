import { describe, expect, it, vi } from "vitest";
import { createPreviewInvite } from "../../src/modules/trips/previewInvite.js";
import type { InvitePreviewRecord } from "../../src/modules/trips/ports/tripUnitOfWork.js";
const actor = {
  userId: "10000000-0000-4000-8000-000000000001",
  deviceId: "10000000-0000-4000-8000-000000000002",
  clerkSubject: "user_preview",
};
const data: InvitePreviewRecord = {
  tripId: "01990000-0000-7000-8000-000000000001",
  name: "Goa",
  startsAt: null,
  endsAt: new Date("2026-09-20T12:00:00Z"),
  members: [
    { displayName: "Riya", role: "OWNER" },
    { displayName: "Arjun", role: "MEMBER" },
  ],
};
function harness(value: InvitePreviewRecord | null = data) {
  const readInvitePreview = vi.fn().mockResolvedValue(value);
  const hash = vi.fn(() => new Uint8Array([1, 2, 3]));
  return {
    readInvitePreview,
    hash,
    command: createPreviewInvite({
      unitOfWork: { readInvitePreview },
      hasher: { hash },
    }),
  };
}
describe("read-only invite preview", () => {
  it("validates canonical codes before hashing and exposes only safe trip names and roles", async () => {
    const h = harness();
    const result = await h.command.execute({ actor, inviteCode: "ABCD2345" });
    expect(h.hash).toHaveBeenCalledWith("ABCD2345");
    expect(h.readInvitePreview).toHaveBeenCalledWith(
      actor,
      new Uint8Array([1, 2, 3]),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        ...data,
        endsAt: data.endsAt.toISOString(),
        hostDisplayName: "Riya",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /deviceId|userId|key|inviteCode/i,
    );
  });
  it("does no database lookup for malformed codes", async () => {
    const h = harness();
    expect(
      await h.command.execute({ actor, inviteCode: "ABCI2345" }),
    ).toMatchObject({ ok: false, problem: { code: "INVITE_INVALID" } });
    expect(h.readInvitePreview).not.toHaveBeenCalled();
  });
  it("treats unavailable codes uniformly", async () => {
    expect(
      await harness(null).command.execute({ actor, inviteCode: "ABCD2345" }),
    ).toMatchObject({ ok: false, problem: { code: "INVITE_INVALID" } });
  });
  it("never leaks an internal lookup exception", async () => {
    const h = harness();
    h.readInvitePreview.mockRejectedValue(
      new Error("private database details"),
    );
    const result = await h.command.execute({ actor, inviteCode: "ABCD2345" });
    expect(result).toMatchObject({
      ok: false,
      problem: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
