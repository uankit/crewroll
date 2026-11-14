import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app/buildApp.js";
import { createDependencyReadinessProbe } from "../../src/shared/observability/dependencyReadiness.js";
import { createTestDependencies } from "../support/fakes.js";

afterEach(() => vi.useRealTimers());

describe("essential dependency readiness", () => {
  it("accepts a missing storage HEAD and checks both dependencies exactly once", async () => {
    vi.useFakeTimers();
    const database = vi.fn(() => Promise.resolve());
    const storage = vi.fn(() => Promise.resolve(null));
    await expect(
      createDependencyReadinessProbe({ database, storage }).check(),
    ).resolves.toBeUndefined();
    expect(database).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts both probes without serializing their latency", async () => {
    let releaseDatabase!: () => void;
    let releaseStorage!: () => void;
    const database = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDatabase = resolve;
        }),
    );
    const storage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStorage = resolve;
        }),
    );
    const checking = createDependencyReadinessProbe({
      database,
      storage,
    }).check();
    await Promise.resolve();
    expect(database).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
    releaseDatabase();
    releaseStorage();
    await checking;
  });

  it.each(["database", "storage"] as const)(
    "returns a sanitized HTTP 503 when %s throws",
    async (failed) => {
      const secret = "provider-secret-signed-grant-canary";
      const fixture = createTestDependencies();
      const readiness = createDependencyReadinessProbe({
        database: () =>
          failed === "database"
            ? Promise.reject(new Error(secret))
            : Promise.resolve(),
        storage: () =>
          failed === "storage"
            ? Promise.reject(new Error(secret))
            : Promise.resolve(null),
      });
      const app = buildApp({ ...fixture.dependencies, readiness });
      try {
        const live = await app.inject({ method: "GET", url: "/health/live" });
        expect(live.statusCode).toBe(200);
        const response = await app.inject({
          method: "GET",
          url: "/health/ready",
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({
          status: 503,
          detail: "Required service dependencies are unavailable.",
        });
        expect(response.body).not.toContain(secret);
        expect(fixture.logs()).not.toContain(secret);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["database", "storage"] as const)(
    "bounds a hanging %s probe and consumes a late rejection",
    async (slow) => {
      vi.useFakeTimers();
      let rejectLate!: (error: Error) => void;
      const pending = new Promise<void>((_resolve, reject) => {
        rejectLate = reject;
      });
      const probe = createDependencyReadinessProbe({
        database: () => (slow === "database" ? pending : Promise.resolve()),
        storage: () => (slow === "storage" ? pending : Promise.resolve(null)),
      });
      const outcome = expect(probe.check()).rejects.toThrow(
        "Dependencies not ready",
      );
      await vi.advanceTimersByTimeAsync(2_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
      rejectLate(new Error("late-provider-secret"));
      await Promise.resolve();
    },
  );

  it("sanitizes synchronous provider failure and releases its deadline timer", async () => {
    vi.useFakeTimers();
    await expect(
      createDependencyReadinessProbe({
        database: () => Promise.resolve(),
        storage: () => {
          throw new Error("synchronous-provider-secret");
        },
      }).check(),
    ).rejects.toThrow(/^Dependencies not ready$/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
