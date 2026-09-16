import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app/buildApp.js";
import { createSyncProfile } from "../../src/modules/identity/syncProfile.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import { createTestDependencies } from "../support/fakes.js";
import { createLocalClerkFixture } from "../support/http.js";

describe("authenticated profile sync", () => {
  const apps: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("reads the canonical name and writes only the authenticated identity", async () => {
    const synchronizeProfile = vi.fn().mockResolvedValue(undefined);
    const getUser = vi
      .fn()
      .mockResolvedValue({ clerkSubject: "user_a", displayName: "Riya Shah" });
    const now = new Date("2026-09-16T00:00:00Z");
    const service = createSyncProfile({
      directory: { getUser },
      repository: { synchronizeProfile },
      clock: { now: () => now },
      ids: { uuid: () => "user-id" },
    });
    await expect(service.execute("user_a")).resolves.toEqual({
      displayName: "Riya Shah",
    });
    expect(getUser).toHaveBeenCalledWith("user_a");
    expect(synchronizeProfile).toHaveBeenCalledWith(
      "user_a",
      "Riya Shah",
      "user-id",
      now,
    );
    getUser.mockResolvedValueOnce({
      clerkSubject: "user_b",
      displayName: "Other",
    });
    await expect(service.execute("user_a")).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
    expect(synchronizeProfile).toHaveBeenCalledTimes(1);
  });

  it("uses a Clerk bearer, rejects caller-supplied names and IDs, and never caches the response", async () => {
    const clerk = await createLocalClerkFixture();
    const execute = vi.fn().mockResolvedValue({ displayName: "Riya" });
    const app = buildApp({
      ...createTestDependencies().dependencies,
      profile: { tokenVerifier: clerk.verifier, syncProfile: { execute } },
    });
    apps.push(app);
    const authorization = `Bearer ${await clerk.sign()}`;
    const response = await app.inject({
      method: "PUT",
      url: "/v1/profile",
      headers: { authorization },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ displayName: "Riya" });
    expect(execute).toHaveBeenCalledWith("user_route_subject");
    for (const payload of [
      { displayName: "Someone else" },
      { clerkSubject: "other" },
    ]) {
      const invalid = await app.inject({
        method: "PUT",
        url: "/v1/profile",
        headers: { authorization },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }
    for (const headers of [
      {},
      { authorization: `Bearer crb_${"a".repeat(43)}` },
    ]) {
      const denied = await app.inject({
        method: "PUT",
        url: "/v1/profile",
        headers,
        payload: {},
      });
      expect(denied.statusCode).toBe(401);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockRejectedValueOnce(new DomainError("AUTH_INVALID"));
    const deleted = await app.inject({
      method: "PUT",
      url: "/v1/profile",
      headers: { authorization },
      payload: {},
    });
    expect(deleted.statusCode).toBe(401);
  });
});
