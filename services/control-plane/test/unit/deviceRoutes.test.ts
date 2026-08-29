import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import { buildApp } from "../../src/app/buildApp.js";
import type { DeviceRouteDependencies } from "../../src/modules/devices/deviceRoutes.js";
import { createTestDependencies } from "../support/fakes.js";
import { createLocalClerkFixture } from "../support/http.js";

const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const idempotencyKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3170";

describe("device routes", () => {
  const apps: { close(): Promise<void> }[] = [];
  let authorization: string;
  let dependencies: DeviceRouteDependencies;
  let sign: Awaited<ReturnType<typeof createLocalClerkFixture>>["sign"];
  let registerExecute: MockedFunction<
    DeviceRouteDependencies["registerDevice"]["execute"]
  >;

  beforeEach(async () => {
    const clerk = await createLocalClerkFixture();
    sign = clerk.sign;
    authorization = `Bearer ${await clerk.sign()}`;
    registerExecute = vi
      .fn<DeviceRouteDependencies["registerDevice"]["execute"]>()
      .mockResolvedValue({
        backgroundBearer: `crb_${"A".repeat(43)}`,
        backgroundBearerExpiresAt: "2026-09-29T06:00:00.000Z",
        deviceId,
      });
    dependencies = {
      registerDevice: {
        execute: registerExecute,
      },
      revokeDevice: { execute: vi.fn().mockResolvedValue(undefined) },
      tokenVerifier: clerk.verifier,
      updateDevicePushToken: {
        execute: vi.fn().mockResolvedValue(undefined),
      },
    };
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function app() {
    const fixture = createTestDependencies();
    const instance = buildApp({
      ...fixture.dependencies,
      devices: dependencies,
    });
    apps.push(instance);
    return { fixture, instance };
  }

  it("accepts an ordinary no-aud Clerk JWT and returns registration 201", async () => {
    const { instance } = app();
    const response = await instance.inject({
      headers: { authorization, "idempotency-key": idempotencyKey },
      method: "POST",
      payload: validRegisterDeviceBody(),
      url: "/v1/devices",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      backgroundBearer: `crb_${"A".repeat(43)}`,
      backgroundBearerExpiresAt: "2026-09-29T06:00:00.000Z",
      deviceId,
    });
    expect(registerExecute).toHaveBeenCalledWith({
      body: validRegisterDeviceBody(),
      clerkSubject: "user_route_subject",
      idempotencyKey,
    });
  });

  it.each([
    [
      "PATCH",
      `/v1/devices/${deviceId}/push-token`,
      { appVersion: "0.2.1", pushToken: null },
    ],
    ["DELETE", `/v1/devices/${deviceId}`, undefined],
  ] as const)("returns an empty 204 for %s", async (method, url, payload) => {
    const { instance } = app();
    const response = await instance.inject({
      headers: {
        authorization,
        "idempotency-key": idempotencyKey,
        "x-crewroll-device-id": deviceId,
      },
      method,
      ...(payload === undefined ? {} : { payload }),
      url,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("maps missing authorization to 401 and rejects a background bearer", async () => {
    const { instance } = app();
    const missing = await instance.inject({
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
      payload: validRegisterDeviceBody(),
      url: "/v1/devices",
    });
    const background = await instance.inject({
      headers: {
        authorization: `Bearer crb_${"A".repeat(43)}`,
        "idempotency-key": idempotencyKey,
      },
      method: "POST",
      payload: validRegisterDeviceBody(),
      url: "/v1/devices",
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(background.statusCode).toBe(401);
    expect(background.json()).toMatchObject({ code: "AUTH_INVALID" });
  });

  it("rejects an otherwise valid JWT with an unlisted azp", async () => {
    const { instance } = app();
    const response = await instance.inject({
      headers: {
        authorization: `Bearer ${await sign({ azp: "https://evil.example" })}`,
        "idempotency-key": idempotencyKey,
      },
      method: "POST",
      payload: validRegisterDeviceBody(),
      url: "/v1/devices",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTH_INVALID" });
  });

  it("keeps registration bodies closed and rejects a device actor header", async () => {
    const { instance } = app();
    const unknownBody = await instance.inject({
      headers: { authorization, "idempotency-key": idempotencyKey },
      method: "POST",
      payload: { ...validRegisterDeviceBody(), secretCanary: "never-store" },
      url: "/v1/devices",
    });
    const deviceActor = await instance.inject({
      headers: {
        authorization,
        "idempotency-key": idempotencyKey,
        "x-crewroll-device-id": deviceId,
      },
      method: "POST",
      payload: validRegisterDeviceBody(),
      url: "/v1/devices",
    });
    expect(unknownBody.statusCode).toBe(400);
    expect(unknownBody.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(deviceActor.statusCode).toBe(400);
    expect(deviceActor.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(registerExecute).not.toHaveBeenCalled();
  });

  it("rejects path/header mismatch before command execution", async () => {
    const { instance } = app();
    const response = await instance.inject({
      headers: {
        authorization,
        "idempotency-key": idempotencyKey,
        "x-crewroll-device-id": "018f0d98-76fa-7d1a-b4b4-1f742c2e3199",
      },
      method: "DELETE",
      url: `/v1/devices/${deviceId}`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "DEVICE_NOT_OWNED" });
  });

  it("publishes device routes in non-production Swagger without secret logs", async () => {
    const { fixture, instance } = app();
    await instance.ready();
    const openapi = JSON.stringify(instance.swagger());
    expect(openapi).toContain("/v1/devices");
    expect(openapi).toContain("/v1/devices/{deviceId}/push-token");
    expect(fixture.logs()).not.toContain(authorization);
  });
});
