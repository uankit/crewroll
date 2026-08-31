import { normalizeInviteCode, sessionUiStore } from "./sessionUiStore";

describe("sessionUiStore", () => {
  beforeEach(() => {
    sessionUiStore.getState().clear();
  });

  it("retains only a normalized eight-character invite code", () => {
    expect(normalizeInviteCode("  abcd2345  ")).toBe("ABCD2345");
    expect(sessionUiStore.getState().setPendingInvite("  abcd2345  ")).toBe(
      true,
    );
    expect(sessionUiStore.getState().pendingInviteCode).toBe("ABCD2345");
  });

  it.each([
    "",
    "ABC",
    "ABCD23456",
    "ABCDI234",
    "ABCDL234",
    "ABCDO234",
    "ABCDU234",
    "ABCD-234",
  ])("rejects invalid invite intent %p without retaining it", (value) => {
    expect(sessionUiStore.getState().setPendingInvite(value)).toBe(false);
    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
  });

  it("clears the ephemeral intent and exposes no secret or error fields", () => {
    sessionUiStore.getState().setPendingInvite("ABCD2345");
    sessionUiStore.getState().clear();

    expect(sessionUiStore.getState().pendingInviteCode).toBeNull();
    expect(Object.keys(sessionUiStore.getState()).sort()).toEqual([
      "clear",
      "pendingInviteCode",
      "setPendingInvite",
    ]);
    expect(JSON.stringify(sessionUiStore.getState())).not.toMatch(
      /token|envelope|problem|error|detail|authorization|request.?id/i,
    );
  });
});
