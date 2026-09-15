import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";

import {
  validRegisterDeviceBody,
  validRegistrationHeaders,
} from "@crewroll/contracts/fixtures/http";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app/buildApp.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import type { IdGenerator } from "../../src/shared/ids/idGenerator.js";
import { createTestDependencies, fixedRequestId } from "../support/fakes.js";

const closeApps: (() => Promise<void>)[] = [];

it("Worker response serialization fails closed on unexpected fields", async () => {
  const { dependencies } = createTestDependencies({
    nodeEnvironment: "production",
  });
  const app = track(
    buildApp(dependencies, {
      isolateStartup: true,
      scheduledMediaCleanup: false,
    }),
  );
  app.get(
    "/response-proof",
    {
      schema: {
        response: {
          200: Type.Object(
            { visible: Type.String() },
            { additionalProperties: false },
          ),
        },
      },
    },
    () =>
      Promise.resolve({
        visible: "allowed",
        privateToken: "never-expose-this",
      }),
  );
  const result = await app.inject({ method: "GET", url: "/response-proof" });
  expect(result.statusCode).toBe(500);
  expect(result.body).not.toContain("never-expose-this");
});

it("Worker response serialization preserves valid union contracts", async () => {
  const { dependencies } = createTestDependencies({
    nodeEnvironment: "production",
  });
  const app = track(
    buildApp(dependencies, {
      isolateStartup: true,
      scheduledMediaCleanup: false,
    }),
  );
  app.get(
    "/response-proof",
    {
      schema: {
        response: {
          200: Type.Object(
            { result: Type.Union([Type.Literal("ok"), Type.Null()]) },
            { additionalProperties: false },
          ),
        },
      },
    },
    () => Promise.resolve({ result: "ok" }),
  );
  const result = await app.inject({ method: "GET", url: "/response-proof" });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ result: "ok" });
});

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
  it("isolates Clerk raw bytes without changing device JSON parsing", async () => {
    const fixture = createTestDependencies();
    const rawBody = Buffer.from(
      '{"type":"user.updated","data":{"id":"user_raw"}}',
    );
    let receivedBody: Readonly<Uint8Array> | undefined;
    let receivedHeaders: Record<string, string | undefined> | undefined;
    let receivedDeviceBody: unknown;
    const app = track(
      buildApp({
        ...fixture.dependencies,
        devices: {
          ...fixture.dependencies.devices,
          registerDevice: {
            execute: ({ body }) => {
              receivedDeviceBody = body;
              return Promise.resolve({
                backgroundBearer: `crb_${"A".repeat(43)}`,
                backgroundBearerExpiresAt: "2026-09-29T12:00:00.000Z",
                deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
              });
            },
          },
          tokenVerifier: {
            verify: () => Promise.resolve({ clerkSubject: "user_raw_parser" }),
          },
        },
        identity: {
          webhookService: {
            handle: (body, headers) => {
              receivedBody = body;
              receivedHeaders = headers;
              return Promise.resolve({ received: true });
            },
          },
        },
      }),
    );

    const webhook = await app.inject({
      headers: {
        "content-type": "application/json",
        "svix-id": "evt_raw",
        "svix-signature": "v1,signature",
        "svix-timestamp": "1788004800",
      },
      method: "POST",
      payload: rawBody,
      url: "/webhooks/clerk",
    });
    const device = await app.inject({
      headers: {
        ...validRegistrationHeaders(),
        "content-type": "application/json",
      },
      method: "POST",
      payload: validRegisterDeviceBody(),
      url: "/v1/devices",
    });

    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toEqual({ received: true });
    expect(Buffer.from(receivedBody ?? [])).toEqual(rawBody);
    expect(receivedHeaders).toEqual({
      svixId: "evt_raw",
      svixSignature: "v1,signature",
      svixTimestamp: "1788004800",
    });
    expect(device.statusCode).toBe(201);
    expect(receivedDeviceBody).toEqual(validRegisterDeviceBody());
  });

  it("rejects oversized Clerk bytes before verification", async () => {
    const fixture = createTestDependencies();
    let verificationCalls = 0;
    const app = track(
      buildApp({
        ...fixture.dependencies,
        identity: {
          webhookService: {
            handle: () => {
              verificationCalls += 1;
              return Promise.resolve({ received: true });
            },
          },
        },
      }),
    );

    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: Buffer.alloc(1_048_577, 0x78),
      url: "/webhooks/clerk",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(expectedProblem(400));
    expect(verificationCalls).toBe(0);
    expect(fixture.logs()).not.toContain("xxxxxxxxxxxxxxxx");
  });

  it("keeps the injected request-ID contract shared and dependency-free", () => {
    const ids: IdGenerator = { uuid: () => fixedRequestId };
    const sharedContract = readFileSync(
      new URL("../../src/shared/ids/idGenerator.ts", import.meta.url),
      "utf8",
    );
    const appDependencies = readFileSync(
      new URL("../../src/app/dependencies.ts", import.meta.url),
      "utf8",
    );
    const packageManifest = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );

    expect(ids.uuid()).toBe(fixedRequestId);
    expect(sharedContract).not.toContain("app/dependencies");
    expect(appDependencies).toContain("../shared/ids/idGenerator.js");
    expect(packageManifest).not.toMatch(/uuid|randomuuid/iu);
  });

  it.each(["AUTH_REQUIRED", "AUTH_INVALID"] as const)(
    "adds a Bearer challenge for %s only",
    async (kind) => {
      const fixture = createTestDependencies();
      const app = track(buildApp(fixture.dependencies));
      app.get(`/testing/${kind.toLowerCase()}`, () => {
        throw new DomainError(kind);
      });

      const response = await app.inject({
        method: "GET",
        url: `/testing/${kind.toLowerCase()}`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toMatchObject({ code: kind, status: 401 });
    },
  );

  it("does not add a Bearer challenge to non-authentication problems", async () => {
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));

    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.headers).not.toHaveProperty("www-authenticate");
  });
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

  it("maps Fastify body-too-large to a static invalid-request problem", async () => {
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));
    app.post("/testing/body-limit", () => ({ accepted: true }));
    const response = await app.inject({
      method: "POST",
      payload: { value: "x".repeat(1_048_577) },
      url: "/testing/body-limit",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(expectedProblem(400));
    expect(fixture.logs()).not.toContain("xxxxxxxxxxxxxxxx");
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

  it("publishes exactly the eight registered Trip operations and success statuses", async () => {
    const fixture = createTestDependencies();
    const app = track(buildApp(fixture.dependencies));
    await app.ready();
    const openapi = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    const expected = [
      ["/v1/trips", "post", "201"],
      ["/v1/trips/create-outcome", "post", "200"],
      ["/v1/trips/join-requests", "post", "201"],
      [
        "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
        "put",
        "200",
      ],
      ["/v1/trips/{tripId}/join-requests/{membershipId}", "delete", "204"],
      ["/v1/trips/{tripId}/readiness", "put", "200"],
      ["/v1/trips/{tripId}/start", "post", "200"],
      ["/v1/trips/{tripId}", "get", "200"],
    ] as const;

    expect(
      Object.keys(openapi.paths)
        .filter((path) => path.startsWith("/v1/trips"))
        .sort(),
    ).toEqual([...new Set(expected.map(([path]) => path))].sort());
    for (const [path, method, success] of expected) {
      expect(openapi.paths[path]?.[method]?.responses).toHaveProperty(success);
    }
    const serialized = JSON.stringify(openapi.paths);
    expect(serialized).not.toContain("/end");
    expect(serialized).not.toContain("reconciliation");
    expect(serialized).not.toContain("/media");
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
