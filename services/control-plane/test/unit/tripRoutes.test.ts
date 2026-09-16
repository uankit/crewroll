import {
  validApproveJoinRequestBody,
  validCreateJoinRequestBody,
  validImmediateTripBody,
  validSetTripReadinessBody,
  validStartTripBody,
  validTripResponse,
} from "@crewroll/contracts/fixtures/http";
import type {
  CreateTripBody,
  MembershipResponse,
  TripContinuity,
} from "@crewroll/contracts";
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
import { createCreateTrip } from "../../src/modules/trips/createTrip.js";
import type { TripRouteDependencies } from "../../src/modules/trips/tripRoutes.js";
import type {
  ForegroundTripActor,
  TripPolicyProblemCode,
  TripPolicyResult,
} from "../../src/modules/trips/types.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import { createTestDependencies } from "../support/fakes.js";
import { createLocalClerkFixture } from "../support/http.js";
import { createTripTestHarness } from "../support/tripFakes.js";

const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const otherDeviceId = "550e8400-e29b-41d4-a716-446655440099";
const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const membershipId = "018f0d98-76fa-4d1a-b4b4-1f742c2e3140";
const idempotencyKey = "018f0d98-76fa-4d1a-b4b4-1f742c2e3170";
const actor: ForegroundTripActor = {
  clerkSubject: "user_route_subject",
  deviceId,
  userId: "018f0d98-76fa-4d1a-b4b4-1f742c2e3110",
};

const membership: MembershipResponse = {
  deviceId,
  keyEpoch: 1,
  membershipId,
  status: "PENDING_KEY",
  tripId,
  tripKeyEnvelope: null,
};

function success<Value>(value: Value): TripPolicyResult<Value> {
  return { ok: true, value };
}

function problem(code: TripPolicyProblemCode): TripPolicyResult<never> {
  // Deliberately do not supply the code's expected status. Routes must unwrap
  // by code and delegate status selection to the centralized mapper.
  return { ok: false, problem: { code, status: 500 } };
}

interface RouteHarness {
  readonly dependencies: TripRouteDependencies;
  readonly execute: {
    readonly approve: MockedFunction<
      TripRouteDependencies["approveJoinRequest"]["execute"]
    >;
    readonly create: MockedFunction<
      TripRouteDependencies["createTrip"]["execute"]
    >;
    readonly get: MockedFunction<TripRouteDependencies["getTrip"]["execute"]>;
    readonly join: MockedFunction<
      TripRouteDependencies["requestJoin"]["execute"]
    >;
    readonly outcome: MockedFunction<
      TripRouteDependencies["resolveCreateTripOutcome"]["execute"]
    >;
    readonly readiness: MockedFunction<
      TripRouteDependencies["setTripReadiness"]["execute"]
    >;
    readonly reject: MockedFunction<
      TripRouteDependencies["rejectJoinRequest"]["execute"]
    >;
    readonly start: MockedFunction<
      TripRouteDependencies["startTrip"]["execute"]
    >;
  };
  readonly resolveActor: MockedFunction<
    TripRouteDependencies["resolveForegroundActor"]
  >;
}

describe("Trip routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  let authorization: string;
  let clerkVerifier: Awaited<
    ReturnType<typeof createLocalClerkFixture>
  >["verifier"];

  beforeEach(async () => {
    const clerk = await createLocalClerkFixture();
    authorization = `Bearer ${await clerk.sign()}`;
    clerkVerifier = clerk.verifier;
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function routeHarness(): RouteHarness {
    const create = vi
      .fn<TripRouteDependencies["createTrip"]["execute"]>()
      .mockResolvedValue(success(validTripResponse()));
    const outcome = vi
      .fn<TripRouteDependencies["resolveCreateTripOutcome"]["execute"]>()
      .mockResolvedValue(
        success({ outcome: "COMMITTED", trip: validTripResponse() }),
      );
    const join = vi
      .fn<TripRouteDependencies["requestJoin"]["execute"]>()
      .mockResolvedValue(success(membership));
    const approve = vi
      .fn<TripRouteDependencies["approveJoinRequest"]["execute"]>()
      .mockResolvedValue(
        success({
          ...membership,
          status: "ACTIVE",
          tripKeyEnvelope: validApproveJoinRequestBody(),
        }),
      );
    const reject = vi
      .fn<TripRouteDependencies["rejectJoinRequest"]["execute"]>()
      .mockResolvedValue(success(undefined));
    const readiness = vi
      .fn<TripRouteDependencies["setTripReadiness"]["execute"]>()
      .mockResolvedValue(
        success(
          validTripResponse({ fullPhotoLibraryAccess: true, version: 2 }),
        ),
      );
    const start = vi
      .fn<TripRouteDependencies["startTrip"]["execute"]>()
      .mockResolvedValue(
        success({
          ...validTripResponse({ fullPhotoLibraryAccess: true, version: 3 }),
          status: "ACTIVE",
        }),
      );
    const get = vi
      .fn<TripRouteDependencies["getTrip"]["execute"]>()
      .mockResolvedValue(success(validTripResponse()));
    const resolveActor = vi
      .fn<TripRouteDependencies["resolveForegroundActor"]>()
      .mockResolvedValue(actor);
    return {
      dependencies: {
        approveJoinRequest: { execute: approve },
        createTrip: { execute: create },
        getTrip: { execute: get },
        previewInvite: {
          execute: vi.fn().mockResolvedValue(problem("INVITE_INVALID")),
        },
        rejectJoinRequest: { execute: reject },
        requestJoin: { execute: join },
        resolveCreateTripOutcome: { execute: outcome },
        resolveForegroundActor: resolveActor,
        setTripReadiness: { execute: readiness },
        startTrip: { execute: start },
        tokenVerifier: clerkVerifier,
      },
      execute: {
        approve,
        create,
        get,
        join,
        outcome,
        readiness,
        reject,
        start,
      },
      resolveActor,
    };
  }

  function app(harness = routeHarness()) {
    const fixture = createTestDependencies();
    const instance = buildApp({
      ...fixture.dependencies,
      trips: harness.dependencies,
    });
    apps.push(instance);
    return { fixture, harness, instance };
  }

  it("previews an invite without an idempotency header or a join mutation", async () => {
    const { instance, harness } = app();
    const value = {
      tripId,
      name: "Goa",
      startsAt: null,
      endsAt: "2030-01-02T00:00:00Z",
      hostDisplayName: "Riya",
      members: [{ displayName: "Riya", role: "OWNER" as const }],
    };
    const preview = vi
      .spyOn(harness.dependencies.previewInvite, "execute")
      .mockResolvedValue(success(value));
    const response = await instance.inject({
      method: "POST",
      url: "/v1/trips/invite-preview",
      headers: { authorization, "x-crewroll-device-id": deviceId },
      payload: { inviteCode: "ABCD2345" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(value);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(harness.execute.join).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledWith({
      actor,
      inviteCode: "ABCD2345",
    });
    const unauthenticated = await instance.inject({
      method: "POST",
      url: "/v1/trips/invite-preview",
      headers: { "x-crewroll-device-id": deviceId },
      payload: { inviteCode: "ABCD2345" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const invalid = await instance.inject({
      method: "POST",
      url: "/v1/trips/invite-preview",
      headers: { authorization, "x-crewroll-device-id": deviceId },
      payload: { inviteCode: "ABCD2345", includeKeys: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  function commandHeaders(overrides: Record<string, string> = {}) {
    return {
      authorization,
      "idempotency-key": idempotencyKey,
      "x-crewroll-device-id": deviceId,
      ...overrides,
    };
  }

  it("exposes continuity only through the account-authenticated device and disables caching", async () => {
    const harness = routeHarness();
    const value: TripContinuity = {
      tripId,
      version: 4,
      tripName: "Goa weekend",
      status: "ACTIVE",
      hostDisplayName: "Asha",
      onThisDevice: true,
      syncFrom: "2030-01-01T10:00:00.000Z",
      ownerInviteCode: "ABCD2345",
      deviceRequest: null,
      approvalRequests: [],
    };
    const read = vi.fn().mockResolvedValue(value);
    const change = vi.fn().mockResolvedValue(value);
    const { instance } = app({
      ...harness,
      dependencies: { ...harness.dependencies, continuity: { read, change } },
    });
    const response = await instance.inject({
      method: "GET",
      url: `/v1/trips/${tripId}/continuity`,
      headers: { authorization, "x-crewroll-device-id": deviceId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(value);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(read).toHaveBeenCalledWith(actor, tripId);
    const denied = await instance.inject({
      method: "GET",
      url: `/v1/trips/${tripId}/continuity`,
      headers: {
        "x-crewroll-device-id": deviceId,
        authorization: `Bearer crb_${"A".repeat(43)}`,
      },
    });
    expect(denied.statusCode).toBe(401);
    expect(read).toHaveBeenCalledTimes(1);
    const mutation = await instance.inject({
      method: "POST",
      url: `/v1/trips/${tripId}/continuity`,
      headers: commandHeaders(),
      payload: { action: "REQUEST_DEVICE", expectedVersion: 4 },
    });
    expect(mutation.statusCode).toBe(200);
    expect(mutation.headers["cache-control"]).toBe("no-store");
    expect(change).toHaveBeenCalledWith(actor, tripId, {
      action: "REQUEST_DEVICE",
      expectedVersion: 4,
    });
    const invalid = await instance.inject({
      method: "POST",
      url: `/v1/trips/${tripId}/continuity`,
      headers: commandHeaders(),
      payload: {
        action: "REQUEST_DEVICE",
        expectedVersion: 4,
        autoApprove: true,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(change).toHaveBeenCalledTimes(1);
  });

  function queryHeaders(overrides: Record<string, string> = {}) {
    return {
      authorization,
      "x-crewroll-device-id": deviceId,
      ...overrides,
    };
  }

  it("dispatches exactly the eight accepted methods and typed success shapes", async () => {
    const { harness, instance } = app();
    const createBody = validImmediateTripBody();
    const joinBody = validCreateJoinRequestBody();
    const approvalBody = validApproveJoinRequestBody();
    const readinessBody = validSetTripReadinessBody();
    const startBody = validStartTripBody();

    const responses = await Promise.all([
      instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: createBody,
        url: "/v1/trips",
      }),
      instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: { tripId },
        url: "/v1/trips/create-outcome",
      }),
      instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: joinBody,
        url: "/v1/trips/join-requests",
      }),
      instance.inject({
        headers: commandHeaders(),
        method: "PUT",
        payload: approvalBody,
        url: `/v1/trips/${tripId}/join-requests/${membershipId}/approval`,
      }),
      instance.inject({
        headers: commandHeaders(),
        method: "DELETE",
        url: `/v1/trips/${tripId}/join-requests/${membershipId}`,
      }),
      instance.inject({
        headers: commandHeaders(),
        method: "PUT",
        payload: readinessBody,
        url: `/v1/trips/${tripId}/readiness`,
      }),
      instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: startBody,
        url: `/v1/trips/${tripId}/start`,
      }),
      instance.inject({
        headers: queryHeaders(),
        method: "GET",
        url: `/v1/trips/${tripId}`,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 200, 201, 200, 204, 200, 200, 200,
    ]);
    expect(responses[0].json()).toEqual(validTripResponse());
    expect(responses[1].json()).toEqual({
      outcome: "COMMITTED",
      trip: validTripResponse(),
    });
    expect(responses[2].json()).toEqual(membership);
    expect(responses[4].body).toBe("");

    expect(harness.execute.create).toHaveBeenCalledWith({
      actor,
      body: createBody,
      idempotencyKey,
    });
    expect(harness.execute.outcome).toHaveBeenCalledWith({
      actor,
      idempotencyKey,
      tripId,
    });
    expect(harness.execute.join).toHaveBeenCalledWith({
      actor,
      body: joinBody,
      idempotencyKey,
    });
    expect(harness.execute.approve).toHaveBeenCalledWith({
      actor,
      body: approvalBody,
      idempotencyKey,
      membershipId,
      tripId,
    });
    expect(harness.execute.reject).toHaveBeenCalledWith({
      actor,
      idempotencyKey,
      membershipId,
      tripId,
    });
    expect(harness.execute.readiness).toHaveBeenCalledWith({
      actor,
      body: readinessBody,
      idempotencyKey,
      tripId,
    });
    expect(harness.execute.start).toHaveBeenCalledWith({
      actor,
      body: startBody,
      idempotencyKey,
      tripId,
    });
    expect(harness.execute.get).toHaveBeenCalledWith({ actor, tripId });
    expect(harness.resolveActor).toHaveBeenCalledTimes(8);
  });

  it("does not expose an implicit HEAD route for Trip polling", async () => {
    const { harness, instance } = app();

    const response = await instance.inject({
      headers: queryHeaders(),
      method: "HEAD",
      url: `/v1/trips/${tripId}`,
    });

    expect(harness.execute.get).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
  });

  it.each([
    { outcome: "TERMINAL_NOT_COMMITTED" as const },
    { outcome: "STILL_UNKNOWN" as const },
    { outcome: "COMMITTED" as const, trip: validTripResponse() },
  ])("returns the closed create outcome variant $outcome", async (value) => {
    const harness = routeHarness();
    harness.execute.outcome.mockResolvedValueOnce(success(value));
    const { instance } = app(harness);
    const response = await instance.inject({
      headers: commandHeaders(),
      method: "POST",
      payload: { tripId },
      url: "/v1/trips/create-outcome",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(value);
    expect(harness.execute.get).not.toHaveBeenCalled();
  });

  it("verifies bearer before schema, actor resolution, or domain work", async () => {
    const harness = routeHarness();
    const { instance } = app(harness);
    const missing = await instance.inject({
      headers: { "x-crewroll-device-id": "not-a-uuid" },
      method: "POST",
      payload: { secret: "invalid-body-canary" },
      url: "/v1/trips",
    });
    const invalid = await instance.inject({
      headers: {
        authorization: "Bearer invalid-token",
        "x-crewroll-device-id": "not-a-uuid",
      },
      method: "POST",
      payload: { secret: "invalid-body-canary" },
      url: "/v1/trips",
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ code: "AUTH_INVALID" });
    expect(harness.resolveActor).not.toHaveBeenCalled();
    expect(harness.execute.create).not.toHaveBeenCalled();
  });

  it("runs schema before the foreground actor pre-handler", async () => {
    const harness = routeHarness();
    const { instance } = app(harness);
    const response = await instance.inject({
      headers: {
        authorization,
        "idempotency-key": idempotencyKey,
        "x-crewroll-device-id": "not-a-uuid",
      },
      method: "POST",
      payload: validImmediateTripBody(),
      url: "/v1/trips",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(harness.resolveActor).not.toHaveBeenCalled();
    expect(harness.execute.create).not.toHaveBeenCalled();
  });

  it.each([
    ["AUTH_INVALID", 401],
    ["DEVICE_NOT_OWNED", 403],
    ["DEVICE_REVOKED", 409],
  ] as const)(
    "maps foreground %s before service or invite work",
    async (kind, status) => {
      const harness = routeHarness();
      harness.resolveActor.mockRejectedValueOnce(new DomainError(kind));
      const { instance } = app(harness);
      const response = await instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: validCreateJoinRequestBody(),
        url: "/v1/trips/join-requests",
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code: kind, status });
      expect(harness.execute.join).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "ownerDeviceId",
      { ...validImmediateTripBody(), ownerDeviceId: otherDeviceId },
    ],
    ["deviceId", { ...validCreateJoinRequestBody(), deviceId: otherDeviceId }],
  ] as const)(
    "rejects a mismatched body %s before command execution",
    async (field, body) => {
      const harness = routeHarness();
      const { instance } = app(harness);
      const response = await instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: body,
        url:
          field === "ownerDeviceId" ? "/v1/trips" : "/v1/trips/join-requests",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "DEVICE_NOT_OWNED" });
      expect(harness.execute.create).not.toHaveBeenCalled();
      expect(harness.execute.join).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes generic UUID transport fields before equality and dispatch", async () => {
    const harness = routeHarness();
    const { instance } = app(harness);
    const createBody = {
      ...validImmediateTripBody(),
      ownerDeviceId: deviceId.toUpperCase(),
    };
    const joinBody = {
      ...validCreateJoinRequestBody(),
      deviceId: deviceId.toUpperCase(),
    };

    const create = await instance.inject({
      headers: commandHeaders({
        "idempotency-key": idempotencyKey.toUpperCase(),
        "x-crewroll-device-id": deviceId.toUpperCase(),
      }),
      method: "POST",
      payload: createBody,
      url: "/v1/trips",
    });
    const join = await instance.inject({
      headers: commandHeaders({
        "idempotency-key": idempotencyKey.toUpperCase(),
        "x-crewroll-device-id": deviceId.toUpperCase(),
      }),
      method: "POST",
      payload: joinBody,
      url: "/v1/trips/join-requests",
    });
    const approve = await instance.inject({
      headers: commandHeaders({
        "idempotency-key": idempotencyKey.toUpperCase(),
        "x-crewroll-device-id": deviceId.toUpperCase(),
      }),
      method: "PUT",
      payload: validApproveJoinRequestBody(),
      url: `/v1/trips/${tripId}/join-requests/${membershipId.toUpperCase()}/approval`,
    });

    expect([create.statusCode, join.statusCode, approve.statusCode]).toEqual([
      201, 201, 200,
    ]);
    expect(harness.resolveActor).toHaveBeenCalledWith({
      clerkSubject: actor.clerkSubject,
      deviceId,
    });
    expect(harness.execute.create).toHaveBeenCalledWith({
      actor,
      body: { ...createBody, ownerDeviceId: deviceId },
      idempotencyKey,
    });
    expect(harness.execute.join).toHaveBeenCalledWith({
      actor,
      body: { ...joinBody, deviceId },
      idempotencyKey,
    });
    expect(harness.execute.approve).toHaveBeenCalledWith({
      actor,
      body: validApproveJoinRequestBody(),
      idempotencyKey,
      membershipId,
      tripId,
    });
  });

  it.each([
    ["POST", "/v1/trips", validImmediateTripBody()],
    ["POST", "/v1/trips/create-outcome", { tripId }],
    ["POST", "/v1/trips/join-requests", validCreateJoinRequestBody()],
    [
      "PUT",
      `/v1/trips/${tripId}/join-requests/${membershipId}/approval`,
      validApproveJoinRequestBody(),
    ],
    ["DELETE", `/v1/trips/${tripId}/join-requests/${membershipId}`, undefined],
    ["PUT", `/v1/trips/${tripId}/readiness`, validSetTripReadinessBody()],
    ["POST", `/v1/trips/${tripId}/start`, validStartTripBody()],
  ] as const)(
    "requires idempotency for %s %s",
    async (method, url, payload) => {
      const harness = routeHarness();
      const { instance } = app(harness);
      const response = await instance.inject({
        headers: queryHeaders(),
        method,
        ...(payload === undefined ? {} : { payload }),
        url,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      for (const command of Object.values(harness.execute)) {
        expect(command).not.toHaveBeenCalled();
      }
    },
  );

  it("allows GET without an idempotency key", async () => {
    const harness = routeHarness();
    const { instance } = app(harness);
    const response = await instance.inject({
      headers: queryHeaders(),
      method: "GET",
      url: `/v1/trips/${tripId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(harness.execute.get).toHaveBeenCalledOnce();
  });

  it.each([
    ["AUTH_REQUIRED", 401],
    ["AUTH_INVALID", 401],
    ["DEVICE_NOT_OWNED", 403],
    ["DEVICE_REVOKED", 409],
    ["DEVICE_NOT_PARTICIPANT", 403],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["INVALID_REQUEST", 400],
    ["RATE_LIMITED", 429],
    ["ACTIVE_TRIP_EXISTS", 409],
    ["TRIP_ID_CONFLICT", 409],
    ["TRIP_DURATION_INVALID", 400],
    ["INVITE_CODE_CONFLICT", 409],
    ["TRIP_FULL", 409],
    ["INVITE_INVALID", 404],
    ["TRIP_OWNER_REQUIRED", 403],
    ["MEMBERSHIP_FROZEN", 409],
    ["PENDING_JOIN_REQUESTS", 409],
    ["KEY_ENVELOPE_MISSING", 409],
    ["KEY_ENVELOPE_INVALID", 400],
    ["PHOTO_LIBRARY_ACCESS_REQUIRED", 409],
    ["TRIP_STATE_CONFLICT", 409],
    ["VERSION_CONFLICT", 409],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["INTERNAL_ERROR", 500],
  ] as const)(
    "unwraps %s by code through the centralized mapper",
    async (code, status) => {
      const harness = routeHarness();
      harness.execute.get.mockResolvedValueOnce(problem(code));
      const { instance } = app(harness);
      const response = await instance.inject({
        headers: queryHeaders(),
        method: "GET",
        url: `/v1/trips/${tripId}`,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code, status });
      expect(response.headers["content-type"]).toContain(
        "application/problem+json",
      );
    },
  );

  function appWithRealCreate() {
    const harness = routeHarness();
    const trip = createTripTestHarness();
    trip.setAuthoritativeNow(new Date("2026-08-30T12:00:00.000Z"));
    trip.setReauthorization({ actor, kind: "ACTIVE" });
    const hashedCodes: string[] = [];
    const generatedIds = [
      "550e8400-e29b-41d4-a716-446655440001",
      "550e8400-e29b-41d4-a716-446655440002",
    ];
    const realCreate = createCreateTrip({
      classifyConstraint: () => null,
      hasher: {
        hash(code) {
          hashedCodes.push(code);
          return new Uint8Array(32).fill(0xa5);
        },
      },
      ids: {
        uuid() {
          const id = generatedIds.shift();
          if (id === undefined) throw new Error("Unexpected route ID request");
          return id;
        },
      },
      unitOfWork: trip.unitOfWork,
    });
    return {
      ...app({
        ...harness,
        dependencies: { ...harness.dependencies, createTrip: realCreate },
      }),
      hashedCodes,
      trip,
    };
  }

  it.each([
    ["L", "L", 201],
    ["  Trip  ", "Trip", 201],
    ["A  B", "A  B", 201],
    ["🛶".repeat(80), "🛶".repeat(80), 201],
    [" ", undefined, 400],
    ["\u2003", undefined, 400],
    ["🛶".repeat(81), undefined, 400],
  ] as const)(
    "enforces create name boundary %#",
    async (name, expectedName, status) => {
      const { hashedCodes, instance, trip } = appWithRealCreate();
      const response = await instance.inject({
        headers: commandHeaders(),
        method: "POST",
        payload: { ...validImmediateTripBody(), name },
        url: "/v1/trips",
      });
      expect(response.statusCode).toBe(status);
      if (expectedName === undefined) {
        expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
        expect(hashedCodes).toEqual([]);
        expect(trip.state.trips.size).toBe(0);
      } else {
        expect(response.json()).toMatchObject({ name: expectedName });
      }
    },
  );

  it("canonicalizes create names before fingerprint replay", async () => {
    const { instance, trip } = appWithRealCreate();
    const first = await instance.inject({
      headers: commandHeaders(),
      method: "POST",
      payload: { ...validImmediateTripBody(), name: "  Trip  " },
      url: "/v1/trips",
    });
    const writes = trip.trace.filter((entry) => entry.startsWith("write."));
    const replay = await instance.inject({
      headers: commandHeaders(),
      method: "POST",
      payload: { ...validImmediateTripBody(), name: "Trip" },
      url: "/v1/trips",
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(trip.trace.filter((entry) => entry.startsWith("write."))).toEqual(
      writes,
    );
  });

  it("keeps bearer, body, invite, and envelope canaries out of logs/problems", async () => {
    const harness = routeHarness();
    harness.execute.create.mockResolvedValueOnce(problem("CONFLICT"));
    const { fixture, instance } = app(harness);
    const body: CreateTripBody = {
      ...validImmediateTripBody(),
      name: "private-route-name-canary",
    };
    const response = await instance.inject({
      headers: commandHeaders(),
      method: "POST",
      payload: body,
      url: "/v1/trips",
    });
    expect(response.statusCode).toBe(409);
    const serialized = `${response.body}\n${fixture.logs()}`;
    for (const canary of [
      authorization,
      body.inviteCode,
      body.name,
      body.ownerKeyEnvelope.wrappedKey,
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("rejects uppercase Trip IDs while accepting canonical lowercase v7", async () => {
    const harness = routeHarness();
    const { instance } = app(harness);
    const uppercase = await instance.inject({
      headers: queryHeaders(),
      method: "GET",
      url: `/v1/trips/${tripId.toUpperCase()}`,
    });
    const lowercase = await instance.inject({
      headers: queryHeaders(),
      method: "GET",
      url: `/v1/trips/${tripId}`,
    });
    expect(uppercase.statusCode).toBe(400);
    expect(lowercase.statusCode).toBe(200);
  });
});
