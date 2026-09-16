import { describe, expect, it } from "vitest";
import { createOwnerInviteVault } from "../../src/platform/crypto/ownerInviteVault.js";

describe("owner invite storage", () => {
  it("uses authenticated randomized ciphertext scoped to the trip", () => {
    const vault = createOwnerInviteVault("test-only-secret");
    const first = vault.seal("trip-a", "ABCD2345");
    const second = vault.seal("trip-a", "ABCD2345");
    expect(first).not.toEqual(second);
    expect(Buffer.from(first).includes(Buffer.from("ABCD2345"))).toBe(false);
    expect(vault.open("trip-a", first)).toBe("ABCD2345");
    expect(() => vault.open("trip-b", first)).toThrow();
    expect(() =>
      createOwnerInviteVault("other-secret").open("trip-a", first),
    ).toThrow();
    const corrupt = Uint8Array.from(first);
    corrupt[15] = corrupt[15]! ^ 1;
    expect(() => vault.open("trip-a", corrupt)).toThrow();
    expect(() => vault.open("trip-a", first.subarray(1))).toThrow();
  });
});
