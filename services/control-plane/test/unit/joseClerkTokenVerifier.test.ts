import { createLocalJWKSet, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { DomainError } from "../../src/shared/errors/domainError.js";
import {
  createJoseClerkTokenVerifier,
  createRemoteClerkKeyResolver,
} from "../../src/platform/clerk/joseClerkTokenVerifier.js";
import { createClerkJwtKey, signClerkJwt } from "../support/clerkJwt.js";

const issuer = "https://clerk.example.test";
const now = new Date("2026-08-30T00:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

function expectAuthKind(
  error: unknown,
  kind: "AUTH_INVALID" | "AUTH_REQUIRED",
) {
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).kind).toBe(kind);
}

describe("createJoseClerkTokenVerifier", () => {
  it("reuses public keys across request verifiers, rejects invalid tokens, and refreshes expired keys", async () => {
    const key = await createClerkJwtKey("key-a");
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(Response.json({ keys: [key.publicJwk] })),
    );
    const resolver = createRemoteClerkKeyResolver({
      issuer,
      fetchImplementation,
    });
    const verifier = () =>
      createJoseClerkTokenVerifier({
        authorizedParties: [],
        clock: { now: () => new Date() },
        issuer,
        resolver,
      });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const token = await signClerkJwt({ issuer, key, nowSeconds });
      await expect(verifier().verify(`Bearer ${token}`)).resolves.toMatchObject(
        { clerkSubject: "user_crewroll_subject" },
      );
      await expect(verifier().verify(`Bearer ${token}`)).resolves.toBeDefined();
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      const wrongIssuer = await signClerkJwt({
        issuer,
        key,
        nowSeconds,
        claims: { iss: "https://wrong.example.test" },
      });
      await expect(
        verifier().verify(`Bearer ${wrongIssuer}`),
      ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
      vi.setSystemTime(new Date(now.getTime() + 601_000));
      await expect(verifier().verify(`Bearer ${token}`)).rejects.toMatchObject({
        kind: "AUTH_INVALID",
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      const fresh = await signClerkJwt({
        issuer,
        key,
        nowSeconds: nowSeconds + 601,
      });
      await expect(verifier().verify(`Bearer ${fresh}`)).resolves.toBeDefined();
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("accepts an ordinary RS256 session JWT with exact issuer and no audience", async () => {
    const key = await createClerkJwtKey("key-a");
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
    });
    const token = await signClerkJwt({ issuer, key, nowSeconds });

    await expect(verifier.verify(`Bearer ${token}`)).resolves.toEqual({
      clerkSubject: "user_crewroll_subject",
    });
    for (const aud of ["unrelated", ["one", "two"]]) {
      const tokenWithAudience = await signClerkJwt({
        claims: { aud },
        issuer,
        key,
        nowSeconds,
      });
      await expect(
        verifier.verify(`Bearer ${tokenWithAudience}`),
      ).resolves.toEqual({ clerkSubject: "user_crewroll_subject" });
    }
  });

  it.each([undefined, []] as const)(
    "requires one authorization header: %j",
    async (header) => {
      const key = await createClerkJwtKey("key-a");
      const verifier = createJoseClerkTokenVerifier({
        authorizedParties: [],
        clock: { now: () => now },
        issuer,
        resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
      });

      await verifier
        .verify(header)
        .catch((error: unknown) => expectAuthKind(error, "AUTH_REQUIRED"));
    },
  );

  it.each([
    "",
    "Basic abc",
    "Bearer",
    "Bearer ",
    "bearer abc",
    "Bearer abc def",
    "Bearer å",
    ["Bearer one", "Bearer two"],
  ])("rejects malformed or duplicate authorization %j", async (header) => {
    const key = await createClerkJwtKey("key-a");
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
    });

    await verifier
      .verify(header)
      .catch((error: unknown) => expectAuthKind(error, "AUTH_INVALID"));
  });

  it("rejects a token over 8192 ASCII bytes before key resolution", async () => {
    const resolver = vi.fn();
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver,
    });

    await verifier
      .verify(`Bearer ${"a".repeat(8193)}`)
      .catch((error: unknown) => expectAuthKind(error, "AUTH_INVALID"));
    expect(resolver).not.toHaveBeenCalled();
  });

  it("enforces RS256, the exact issuer, and successful key resolution", async () => {
    const goodKey = await createClerkJwtKey("good");
    const wrongKey = await createClerkJwtKey("wrong");
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver: createLocalJWKSet({ keys: [goodKey.publicJwk] }),
    });
    const wrongIssuer = await signClerkJwt({
      claims: { iss: "https://other.example.test" },
      issuer,
      key: goodKey,
      nowSeconds,
    });
    const missingIssuer = await signClerkJwt({
      claims: { iss: undefined },
      issuer,
      key: goodKey,
      nowSeconds,
    });
    const wrongSignature = await signClerkJwt({
      issuer,
      key: wrongKey,
      nowSeconds,
    });
    const { privateKey } = await generateKeyPair("ES256");
    const wrongAlgorithm = await new SignJWT({
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: issuer,
      nbf: nowSeconds,
      sub: "user_subject",
    })
      .setProtectedHeader({ alg: "ES256" })
      .sign(privateKey);

    for (const token of [
      wrongIssuer,
      missingIssuer,
      wrongSignature,
      wrongAlgorithm,
    ]) {
      await verifier
        .verify(`Bearer ${token}`)
        .catch((error: unknown) => expectAuthKind(error, "AUTH_INVALID"));
    }
  });

  it.each([
    [undefined, [], true],
    ["https://app.crewroll.example", ["https://app.crewroll.example"], true],
    ["https://other.example", ["https://app.crewroll.example"], false],
    [
      "https://app.crewroll.example.evil",
      ["https://app.crewroll.example"],
      false,
    ],
    ["*", ["https://app.crewroll.example"], false],
    [42, ["https://app.crewroll.example"], false],
    ["https://app.crewroll.example", [], false],
  ] as const)(
    "handles azp %j by exact configured membership",
    async (azp, parties, valid) => {
      const key = await createClerkJwtKey("key-a");
      const verifier = createJoseClerkTokenVerifier({
        authorizedParties: parties,
        clock: { now: () => now },
        issuer,
        resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
      });
      const token = await signClerkJwt({
        claims: { azp },
        issuer,
        key,
        nowSeconds,
      });

      if (valid) {
        await expect(verifier.verify(`Bearer ${token}`)).resolves.toBeDefined();
      } else {
        await verifier
          .verify(`Bearer ${token}`)
          .catch((error: unknown) => expectAuthKind(error, "AUTH_INVALID"));
      }
    },
  );

  it.each([
    { exp: nowSeconds - 6 },
    { nbf: nowSeconds + 6 },
    { iat: undefined },
    { nbf: undefined },
    { exp: undefined },
    { iat: nowSeconds + 6 },
    { iat: nowSeconds + 0.5 },
    { nbf: nowSeconds + 0.5 },
    { exp: nowSeconds + 0.5 },
    { exp: nowSeconds, iat: nowSeconds },
    { exp: nowSeconds, nbf: nowSeconds },
  ])("rejects invalid NumericDate relationships %j", async (claims) => {
    const key = await createClerkJwtKey("key-a");
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
    });
    const token = await signClerkJwt({ claims, issuer, key, nowSeconds });

    await verifier
      .verify(`Bearer ${token}`)
      .catch((error: unknown) => expectAuthKind(error, "AUTH_INVALID"));
  });

  it("accepts temporal boundaries inside five-second tolerance", async () => {
    const key = await createClerkJwtKey("key-a");
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
    });
    for (const claims of [
      { exp: nowSeconds - 4, iat: nowSeconds - 20, nbf: nowSeconds - 20 },
      { iat: nowSeconds + 5, nbf: nowSeconds + 5 },
    ]) {
      const token = await signClerkJwt({ claims, issuer, key, nowSeconds });
      await expect(verifier.verify(`Bearer ${token}`)).resolves.toBeDefined();
    }
  });

  it.each([undefined, "", "contains\u0000nul", "x".repeat(256), 42])(
    "rejects an invalid Clerk subject %j",
    async (sub) => {
      const key = await createClerkJwtKey("key-a");
      const verifier = createJoseClerkTokenVerifier({
        authorizedParties: [],
        clock: { now: () => now },
        issuer,
        resolver: createLocalJWKSet({ keys: [key.publicJwk] }),
      });
      const token = await signClerkJwt({
        claims: { sub },
        issuer,
        key,
        nowSeconds,
      });

      await verifier
        .verify(`Bearer ${token}`)
        .catch((error: unknown) => expectAuthKind(error, "AUTH_INVALID"));
    },
  );

  it("maps a resolver exception without exposing it or using global fetch", async () => {
    const providerCanary = "resolver-provider-canary-1be268";
    const fetchTrap = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("global-network-must-not-run"));
    const key = await createClerkJwtKey("key-a");
    const verifier = createJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => now },
      issuer,
      resolver: async () => Promise.reject(new Error(providerCanary)),
    });
    const token = await signClerkJwt({ issuer, key, nowSeconds });

    const error = await verifier
      .verify(`Bearer ${token}`)
      .catch((caught: unknown) => caught);
    expectAuthKind(error, "AUTH_INVALID");
    expect(String(error)).not.toContain(providerCanary);
    expect(fetchTrap).not.toHaveBeenCalled();
    fetchTrap.mockRestore();
  });
});
