import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app/buildApp.js";
import { createTestDependencies, fixedRequestId } from "../support/fakes.js";

const closeApps: (() => Promise<void>)[] = [];

function track<T extends { close(): Promise<void> }>(app: T): T {
  closeApps.push(() => app.close());
  return app;
}

afterEach(async () => {
  await Promise.all(closeApps.splice(0).map((close) => close()));
});

function expectedProblem(
  status: 400 | 404 | 500 | 503,
): Record<string, unknown> {
  const definitions = {
    400: {
      code: "INVALID_REQUEST",
      detail: "The request could not be accepted.",
      title: "Invalid request",
    },
    404: {
      code: "NOT_FOUND",
      detail: "The requested resource was not found.",
      title: "Not found",
    },
    500: {
      code: "INTERNAL_ERROR",
      detail: "The service could not complete the request.",
      title: "Internal error",
    },
    503: {
      code: "INTERNAL_ERROR",
      detail: "Required service dependencies are unavailable.",
      title: "Service unavailable",
    },
  } as const;

  return {
    ...definitions[status],
    instance: `/problems/requests/${fixedRequestId}`,
    requestId: fixedRequestId,
    status,
    type: "about:blank",
  };
}

describe("buildApp", () => {
  it("ignores an inbound request ID and keeps liveness process-only", async () => {
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));

    const response = await app.inject({
      headers: { "x-request-id": "attacker-controlled-request-id" },
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toBe(fixedRequestId);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fixture.readiness.checks).toBe(0);
    expect(fixture.logs()).not.toContain("attacker-controlled-request-id");
  });

  it("reports PostgreSQL readiness success after exactly one probe", async () => {
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fixture.readiness.checks).toBe(1);
  });

  it("sanitizes PostgreSQL readiness failure as a 503 problem", async () => {
    const databaseCanary = "postgres-error-canary-fc5af2";
    const fixture = createTestDependencies({
      readinessFailure: new Error(databaseCanary),
    });
    const app = track(buildApp(fixture.dependencies));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(expectedProblem(503));
    expect(fixture.readiness.checks).toBe(1);
    expect(fixture.logs()).not.toContain(databaseCanary);
  });

  it("maps not-found, validation, and unexpected failures to closed problems", async () => {
    const exceptionCanary = "route-error-canary-40d8ef";
    const requestCanary = "request-body-canary-e6482d";
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));
    app.post(
      "/testing/validate",
      {
        schema: {
          body: {
            additionalProperties: false,
            properties: { name: { type: "string" } },
            required: ["name"],
            type: "object",
          },
        },
      },
      () => ({ accepted: true }),
    );
    app.get("/testing/fail", () => {
      throw new Error(exceptionCanary);
    });

    const notFound = await app.inject({ method: "GET", url: "/missing" });
    const invalid = await app.inject({
      method: "POST",
      payload: { unexpected: requestCanary },
      url: "/testing/validate",
    });
    const unexpected = await app.inject({
      method: "GET",
      url: "/testing/fail?token=query-canary",
    });

    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual(expectedProblem(404));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual(expectedProblem(400));
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toEqual(expectedProblem(500));
    for (const response of [notFound, invalid, unexpected]) {
      expect(response.headers["content-type"]).toContain(
        "application/problem+json",
      );
      expect(response.headers["x-request-id"]).toBe(fixedRequestId);
    }
    expect(fixture.logs()).not.toContain(exceptionCanary);
    expect(fixture.logs()).not.toContain(requestCanary);
    expect(fixture.logs()).not.toContain("query-canary");
  });

  it("adds Helmet headers and non-production documentation without health paths", async () => {
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const documentation = await app.inject({
      method: "GET",
      url: "/documentation/",
    });
    const openapi = JSON.stringify(app.swagger());

    expect(live.headers["x-content-type-options"]).toBe("nosniff");
    expect(live.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(documentation.statusCode).toBe(200);
    expect(documentation.headers["x-request-id"]).toBe(fixedRequestId);
    expect(documentation.headers["content-security-policy"]).toBeDefined();
    expect(openapi).not.toContain("/health/live");
    expect(openapi).not.toContain("/health/ready");
  });

  it("does not register documentation or CORS in production", async () => {
    const fixture = createTestDependencies({ nodeEnvironment: "production" });
    const app = track(buildApp(fixture.dependencies));

    const documentation = await app.inject({
      method: "GET",
      url: "/documentation/",
    });
    const native = await app.inject({ method: "GET", url: "/health/live" });
    const browser = await app.inject({
      headers: { origin: "https://debug.crewroll.test" },
      method: "GET",
      url: "/health/live",
    });

    expect(documentation.statusCode).toBe(404);
    expect(documentation.json()).toEqual(expectedProblem(404));
    expect(documentation.headers["x-request-id"]).toBe(fixedRequestId);
    expect(native.statusCode).toBe(200);
    expect(browser.statusCode).toBe(200);
    expect(browser.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("allows native requests and only the exact non-production debug origin", async () => {
    const fixture = createTestDependencies({
      debugCorsOrigins: "https://debug.crewroll.test",
    });
    const app = track(buildApp(fixture.dependencies));

    const native = await app.inject({ method: "GET", url: "/health/live" });
    const allowed = await app.inject({
      headers: { origin: "https://debug.crewroll.test" },
      method: "GET",
      url: "/health/live",
    });
    const preflight = await app.inject({
      headers: {
        "access-control-request-headers":
          "Authorization, Content-Type, X-CrewRoll-Device-Id, Idempotency-Key",
        "access-control-request-method": "GET",
        origin: "https://debug.crewroll.test",
      },
      method: "OPTIONS",
      url: "/health/live",
    });
    const rejected = await app.inject({
      headers: { origin: "https://unlisted.example.test" },
      method: "GET",
      url: "/health/live",
    });

    expect(native.statusCode).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://debug.crewroll.test",
    );
    expect(allowed.headers["access-control-expose-headers"]).toBe(
      "X-Request-Id",
    );
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toBe(
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, X-CrewRoll-Device-Id, Idempotency-Key",
    );
    expect(preflight.headers["access-control-max-age"]).toBe("600");
    expect(preflight.headers).not.toHaveProperty(
      "access-control-allow-credentials",
    );
    expect(rejected.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it.each([
    {
      incomingRequestId: "11111111-1111-4111-8111-111111111111",
      origin: "https://debug.crewroll.test",
      receivesAllowOrigin: true,
    },
    {
      incomingRequestId: "attacker-controlled-request-id",
      origin: "https://unlisted.example.test",
      receivesAllowOrigin: false,
    },
  ])(
    "adds a generated request ID to a $origin CORS preflight",
    async ({ incomingRequestId, origin, receivesAllowOrigin }) => {
      const fixture = createTestDependencies({
        debugCorsOrigins: "https://debug.crewroll.test",
      });
      const app = track(buildApp(fixture.dependencies));

      const response = await app.inject({
        headers: {
          "access-control-request-method": "GET",
          origin,
          "x-request-id": incomingRequestId,
        },
        method: "OPTIONS",
        url: "/health/live",
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["x-request-id"]).toBe(fixedRequestId);
      expect(response.headers["x-request-id"]).not.toBe(incomingRequestId);
      if (receivesAllowOrigin) {
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
      } else {
        expect(response.headers).not.toHaveProperty(
          "access-control-allow-origin",
        );
      }
    },
  );
});
