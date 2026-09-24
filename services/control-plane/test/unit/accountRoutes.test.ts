import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_TERMS_VERSION } from "@crewroll/contracts";
import { buildApp } from "../../src/app/buildApp.js";
import type { AccountService } from "../../src/modules/account/ports/accountService.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import { createTestDependencies } from "../support/fakes.js";
import { createLocalClerkFixture } from "../support/http.js";

describe("account HTTP boundary", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  async function setup() {
    const clerk = await createLocalClerkFixture();
    const requestId = "7ac7e2fc-b02c-4093-b4d2-121be406a6b7";
    const service = {
      policy: vi.fn(() =>
        Promise.resolve({
          accepted: false,
          termsVersion: ACCOUNT_TERMS_VERSION,
        }),
      ),
      acceptTerms: vi.fn(() =>
        Promise.resolve({
          accepted: true,
          termsVersion: ACCOUNT_TERMS_VERSION,
        }),
      ),
      requestDeletion: vi.fn(() =>
        Promise.resolve({
          requestId,
          status: "PENDING" as const,
        }),
      ),
      deletionStatus: vi.fn(() =>
        Promise.resolve({
          requestId,
          status: "COMPLETE" as const,
        }),
      ),
      report: vi.fn(() => Promise.resolve({ reportId: requestId })),
      block: vi.fn(async () => {}),
      blockedMembers: vi.fn(() => Promise.resolve({ items: [] })),
      unblock: vi.fn(async () => {}),
      guard: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    } satisfies AccountService;
    const app = buildApp({
      ...createTestDependencies().dependencies,
      account: { service, tokenVerifier: clerk.verifier },
    });
    apps.push(app);
    await app.ready();
    return {
      app,
      service,
      requestId,
      headers: { authorization: `Bearer ${await clerk.sign()}` },
    };
  }
  it("rejects anonymous changes and invalid consent or deletion bodies", async () => {
    const { app, headers, service } = await setup();
    expect(
      (await app.inject({ method: "GET", url: "/v1/account" })).statusCode,
    ).toBe(401);
    for (const [url, payload] of [
      ["/v1/account/terms", { termsVersion: "old" }],
      ["/v1/account/deletion", { confirmation: "YES" }],
    ] as const) {
      expect(
        (
          await app.inject({
            method: url.endsWith("terms") ? "PUT" : "POST",
            url,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(service.acceptTerms).not.toHaveBeenCalled();
    expect(service.requestDeletion).not.toHaveBeenCalled();
  });
  it("accepts explicit consent and returns a deletion receipt that remains readable after sign-out", async () => {
    const { app, headers, requestId } = await setup();
    const consent = await app.inject({
      method: "PUT",
      url: "/v1/account/terms",
      headers,
      payload: { termsVersion: ACCOUNT_TERMS_VERSION },
    });
    expect(consent.json()).toEqual({
      accepted: true,
      termsVersion: ACCOUNT_TERMS_VERSION,
    });
    const deletion = await app.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers,
      payload: { confirmation: "DELETE" },
    });
    expect(deletion.statusCode).toBe(202);
    expect(deletion.json()).toEqual({ requestId, status: "PENDING" });
    const receipt = await app.inject({
      method: "GET",
      url: `/v1/account/deletions/${requestId}`,
    });
    expect(receipt.json()).toEqual({ requestId, status: "COMPLETE" });
  });
  it("returns a retry hint without leaking report or provider details", async () => {
    const { app, headers, service } = await setup();
    service.policy.mockRejectedValueOnce(new DomainError("RATE_LIMITED"));
    const response = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.json<{ code: string }>().code).toBe("RATE_LIMITED");
  });
});
