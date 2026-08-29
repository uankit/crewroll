import { beforeAll, describe, expect, it, vi } from "vitest";

import { createRemoteJoseClerkTokenVerifier } from "../../src/platform/clerk/joseClerkTokenVerifier.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import {
  createClerkJwtKey,
  signClerkJwt,
  type ClerkJwtKey,
} from "../support/clerkJwt.js";

const issuer = "https://clerk.example.test";
const jwksUrl = "https://clerk.example.test/.well-known/jwks.json";
const now = new Date("2026-08-30T00:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
let keyA: ClerkJwtKey;
let keyB: ClerkJwtKey;

beforeAll(async () => {
  [keyA, keyB] = await Promise.all([
    createClerkJwtKey("key-a"),
    createClerkJwtKey("key-b"),
  ]);
});

function responseFor(keys: readonly ClerkJwtKey[]): Response {
  return Response.json({ keys: keys.map((key) => key.publicJwk) });
}

function expectInvalid(error: unknown) {
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).kind).toBe("AUTH_INVALID");
}

describe("remote Clerk JWKS policy", () => {
  it("caches one resolver, enforces cooldown rotation, and refreshes after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let servedKeys = [keyA];
    const fetchImplementation = vi.fn((url: string) => {
      expect(url).toBe(jwksUrl);
      return Promise.resolve(responseFor(servedKeys));
    });
    const verifier = createRemoteJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => new Date(Date.now()) },
      fetchImplementation,
      issuer,
    });
    const tokenA = await signClerkJwt({ issuer, key: keyA, nowSeconds });
    const tokenB = await signClerkJwt({
      claims: { exp: nowSeconds + 2_000 },
      issuer,
      key: keyB,
      nowSeconds,
    });

    await expect(verifier.verify(`Bearer ${tokenA}`)).resolves.toBeDefined();
    await expect(verifier.verify(`Bearer ${tokenA}`)).resolves.toBeDefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    servedKeys = [keyB];
    await verifier.verify(`Bearer ${tokenB}`).catch(expectInvalid);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_001);
    await expect(verifier.verify(`Bearer ${tokenB}`)).resolves.toBeDefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(600_001);
    await expect(verifier.verify(`Bearer ${tokenB}`)).resolves.toBeDefined();
    await expect(verifier.verify(`Bearer ${tokenB}`)).resolves.toBeDefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("aborts a stalled fetch at five seconds and maps it safely", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(5_000);
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              new DOMException("The operation timed out", "TimeoutError"),
            ),
          milliseconds,
        );
        return controller.signal;
      });
    const fetchImplementation = vi.fn(
      async (url: string, options: { signal: AbortSignal }) => {
        expect(url).toBe(jwksUrl);
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("timeout-provider-canary-3d928a")),
          );
        });
      },
    );
    const verifier = createRemoteJoseClerkTokenVerifier({
      authorizedParties: [],
      clock: { now: () => new Date(Date.now()) },
      fetchImplementation,
      issuer,
    });
    const token = await signClerkJwt({ issuer, key: keyA, nowSeconds });
    const pending = verifier
      .verify(`Bearer ${token}`)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_001);
    const error = await pending;
    expectInvalid(error);
    expect(String(error)).not.toContain("timeout-provider-canary");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it.each([
    new Response("provider-body-canary-c10dd1", { status: 503 }),
    new Response("not-json-provider-body-canary-bdd042", {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
    Response.json({ keys: "not-an-array-provider-canary-255632" }),
  ])(
    "maps malformed and non-success JWKS responses without leakage",
    async (response) => {
      const fetchImplementation = vi.fn((url: string) => {
        expect(url).toBe(jwksUrl);
        return Promise.resolve(response.clone());
      });
      const verifier = createRemoteJoseClerkTokenVerifier({
        authorizedParties: [],
        clock: { now: () => now },
        fetchImplementation,
        issuer,
      });
      const token = await signClerkJwt({ issuer, key: keyA, nowSeconds });

      const error = await verifier
        .verify(`Bearer ${token}`)
        .catch((caught: unknown) => caught);
      expectInvalid(error);
      expect(String(error)).not.toContain("provider");
    },
  );

  it("shares cache within one adapter and isolates independently built adapters", async () => {
    const fetchImplementation = vi.fn((url: string) => {
      expect(url).toBe(jwksUrl);
      return Promise.resolve(responseFor([keyA]));
    });
    const options = {
      authorizedParties: [] as const,
      clock: { now: () => now },
      fetchImplementation,
      issuer,
    };
    const first = createRemoteJoseClerkTokenVerifier(options);
    const token = await signClerkJwt({ issuer, key: keyA, nowSeconds });

    await first.verify(`Bearer ${token}`);
    await first.verify(`Bearer ${token}`);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const second = createRemoteJoseClerkTokenVerifier(options);
    await second.verify(`Bearer ${token}`);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
