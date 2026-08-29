import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import { createSafeLogger } from "../../src/shared/observability/safeLogger.js";

const requestId = "9a8c65b7-113f-44d0-86df-3f8d455f4d55";

function captureLogger() {
  let output = "";
  const destination: DestinationStream = {
    write(message) {
      output += message;
    },
  };
  const logger = createSafeLogger(
    { logLevel: "trace", nodeEnvironment: "test" },
    destination,
  );
  return {
    logger,
    records(): Record<string, unknown>[] {
      return output
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    serialized(): string {
      return output;
    },
  };
}

describe("createSafeLogger", () => {
  it.each([
    "/v1/devices",
    "/v1/devices/:deviceId/push-token",
    "/v1/devices/:deviceId",
    "/webhooks/clerk",
  ])("allows the static route template %s", (route) => {
    const capture = captureLogger();

    capture.logger.info({ event: "http.request.completed", route });

    expect(capture.records()[0]).toHaveProperty("route", route);
  });
  it("serializes fixed bindings and approved scalar runtime fields", () => {
    const capture = captureLogger();

    capture.logger.info(
      {
        appVersion: "1.2.3",
        code: "INTERNAL_ERROR",
        count: 3,
        durationMs: 12.5,
        environment: "production",
        event: "http.request.completed",
        method: "GET",
        module: "api",
        networkClass: "wifi",
        ready: true,
        requestId,
        route: "/health/ready",
        service: "caller-controlled-service",
        statusCode: 200,
      },
      "caller message must never serialize",
    );

    expect(capture.records()).toEqual([
      expect.objectContaining({
        appVersion: "1.2.3",
        code: "INTERNAL_ERROR",
        count: 3,
        durationMs: 12.5,
        environment: "test",
        event: "http.request.completed",
        level: 30,
        method: "GET",
        module: "api",
        networkClass: "wifi",
        ready: true,
        requestId,
        route: "/health/ready",
        service: "crewroll-control-plane",
        statusCode: 200,
      }),
    ]);
    const [record] = capture.records();
    expect(record).not.toHaveProperty("msg");
    expect(record).not.toHaveProperty("pid");
    expect(record).not.toHaveProperty("hostname");
  });

  it("removes secret canaries from the final newline-delimited JSON", () => {
    const capture = captureLogger();
    const canaries = {
      authorization: "authorization-canary-87f6c1",
      body: "body-canary-af3462",
      caller: "caller-message-canary-ca7108",
      cookie: "cookie-canary-671fe9",
      encryptedManifest: "manifest-canary-f194c2",
      error: "error-canary-641fa3",
      hash: "hash-canary-43f1a8",
      objectKey: "object-key-canary-d091f1",
      pushToken: "push-token-canary-931de0",
      signedUrl: "signed-url-canary-43d818",
      wrappedKey: "wrapped-key-canary-4d3d6e",
      backgroundBearer: "background-bearer-canary-8a3512",
      clerkBearer: "clerk-bearer-canary-bc66df",
      clerkSubject: "user_clerk-subject-canary-34dd67",
      devicePath: "device-path-canary-004ac8",
      fingerprint: "fingerprint-canary-82f2db",
      kmsBlob: "kms-blob-canary-6f67cd",
      nonce: "nonce-canary-6b5d35",
      p256PublicKey: "p256-public-key-canary-3fa6ca",
      providerException: "provider-exception-canary-9aec2e",
      rawBody: "raw-body-canary-5f920d",
      x25519PublicKey: "x25519-public-key-canary-c673c4",
    } as const;

    capture.logger.error(
      {
        authorization: `Bearer ${canaries.authorization}`,
        backgroundBearer: canaries.backgroundBearer,
        body: { value: canaries.body },
        cookie: canaries.cookie,
        encryptedManifest: canaries.encryptedManifest,
        clerkBearer: canaries.clerkBearer,
        clerkSubject: canaries.clerkSubject,
        err: new Error(canaries.error),
        error: new Error(canaries.error),
        event: "http.request.failed",
        hash: canaries.hash,
        fingerprint: canaries.fingerprint,
        headers: { cookie: canaries.cookie },
        objectKey: canaries.objectKey,
        kmsBlob: canaries.kmsBlob,
        nonce: canaries.nonce,
        p256PublicKey: canaries.p256PublicKey,
        providerException: new Error(canaries.providerException),
        pushToken: canaries.pushToken,
        query: { token: canaries.authorization },
        req: { body: canaries.body },
        requestId,
        res: { body: canaries.body },
        rawBody: canaries.rawBody,
        route: `/v1/devices/${canaries.devicePath}`,
        signedUrl: `https://objects.example.test/${canaries.signedUrl}`,
        wrappedKey: canaries.wrappedKey,
        x25519PublicKey: canaries.x25519PublicKey,
      },
      canaries.caller,
    );
    capture.logger.error(new Error(canaries.error), canaries.caller);
    capture.logger.warn(canaries.caller);

    const serialized = capture.serialized();
    for (const canary of Object.values(canaries)) {
      expect(serialized).not.toContain(canary);
    }
    for (const forbiddenKey of [
      "authorization",
      "backgroundBearer",
      "body",
      "clerkBearer",
      "clerkSubject",
      "cookie",
      "encryptedManifest",
      "err",
      "error",
      "fingerprint",
      "hash",
      "headers",
      "kmsBlob",
      "nonce",
      "objectKey",
      "p256PublicKey",
      "providerException",
      "pushToken",
      "query",
      "rawBody",
      "req",
      "res",
      "signedUrl",
      "wrappedKey",
      "x25519PublicKey",
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`);
    }
  });

  it("drops malformed values even when their keys are approved", () => {
    const capture = captureLogger();
    const invalidCanary = "invalid-approved-field-canary-13cc8a";

    capture.logger.info({
      attempt: -1,
      code: `not-valid-${invalidCanary}`,
      count: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
      event: { nested: invalidCanary },
      method: `get-${invalidCanary}`,
      ready: invalidCanary,
      requestId: invalidCanary,
      route: `/health/live?secret=${invalidCanary}`,
      statusCode: -500,
      traceId: invalidCanary,
    });

    const [record] = capture.records();
    expect(record).toEqual(
      expect.objectContaining({
        environment: "test",
        level: 30,
        service: "crewroll-control-plane",
      }),
    );
    for (const key of [
      "attempt",
      "code",
      "count",
      "durationMs",
      "event",
      "method",
      "ready",
      "requestId",
      "route",
      "statusCode",
      "traceId",
    ]) {
      expect(record).not.toHaveProperty(key);
    }
    expect(capture.serialized()).not.toContain(invalidCanary);
  });

  it("filters child bindings through the same deny-by-default boundary", () => {
    const capture = captureLogger();
    const secretCanary = "child-binding-canary-df8f03";
    const child = capture.logger.child({
      authorization: secretCanary,
      module: "health",
      requestId,
    });

    child.info({ event: "health.ready.completed", ready: true });

    expect(capture.records()).toEqual([
      expect.objectContaining({
        environment: "test",
        event: "health.ready.completed",
        module: "health",
        ready: true,
        requestId,
        service: "crewroll-control-plane",
      }),
    ]);
    expect(capture.serialized()).not.toContain(secretCanary);
  });
});
