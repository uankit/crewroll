import { describe, expect, it } from "vitest";

import { createHmacInviteCodeHasher } from "../../src/platform/crypto/hmacInviteCodeHasher.js";
import type { InviteCodeHasher } from "../../src/modules/trips/ports/inviteCodeHasher.js";
import { normalizeInviteCode } from "../../src/modules/trips/tripPolicy.js";
import type {
  NormalizedInviteCode,
  TripPolicyResult,
} from "../../src/modules/trips/types.js";

const KEY = "fixed-test-invite-key";
const CODE = "ABCD2345";
const EXPECTED =
  "04e62ae40b14150a29d8329a571007103ef524828ee7e915a06253e2989ee942";

function valueOf<Value>(result: TripPolicyResult<Value>): Value {
  if (!result.ok)
    throw new Error(`Unexpected policy problem: ${result.problem.code}`);
  return result.value;
}

describe("HMAC invite-code adapter", () => {
  it("pins HMAC-SHA-256 over normalized ASCII to one fixed vector", () => {
    const hasher: InviteCodeHasher = createHmacInviteCodeHasher(KEY);
    const digest = hasher.hash(valueOf(normalizeInviteCode(CODE)));

    expect(digest).toHaveLength(32);
    expect(Buffer.from(digest).toString("hex")).toBe(EXPECTED);
    expect(
      Buffer.from(
        hasher.hash(valueOf(normalizeInviteCode("ABCD2346"))),
      ).toString("hex"),
    ).not.toBe(EXPECTED);
  });

  it("returns independent digest copies without serializing key, code, or hash", () => {
    const hasher = createHmacInviteCodeHasher(KEY);
    const code = valueOf(normalizeInviteCode(CODE));
    const first = hasher.hash(code);
    const firstMutable = first as Uint8Array;
    firstMutable.fill(0);
    const second = hasher.hash(code);

    expect(Buffer.from(second).toString("hex")).toBe(EXPECTED);
    const inspected = JSON.stringify(hasher);
    expect(inspected).not.toContain(KEY);
    expect(inspected).not.toContain(CODE);
    expect(inspected).not.toContain(EXPECTED);
  });

  it.each([undefined, "", "   "])(
    "fails closed for missing or empty key with only the configuration key name",
    (key) => {
      let thrown: unknown;
      try {
        createHmacInviteCodeHasher(key);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("INVITE_CODE_HMAC_KEY");
      if (key !== undefined && key.length > 0) {
        expect(JSON.stringify(thrown)).not.toContain(key);
      }
    },
  );

  it("rejects a forged noncanonical code without leaking key, code, or hash", () => {
    const hasher = createHmacInviteCodeHasher(KEY);
    const forged = "abcd2345" as NormalizedInviteCode;
    let thrown: unknown;
    try {
      hasher.hash(forged);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const inspected = `${String(thrown)} ${JSON.stringify(thrown)}`;
    expect(inspected).not.toContain(KEY);
    expect(inspected).not.toContain(forged);
    expect(inspected).not.toContain(EXPECTED);
  });
});
