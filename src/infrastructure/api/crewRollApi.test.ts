import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  CreateTripOutcomeResponse,
  ProblemCode,
  StartTripBody,
  SetTripReadinessBody,
  TripResponse,
} from "@crewroll/contracts";
import { ProblemCodeSchema } from "@crewroll/contracts";
import type { SessionTokenSource } from "../../application/auth/ports";

import { CrewRollApiProblem as ApplicationCrewRollApiProblem } from "../../application/problems/crewRollApiProblem";
import {
  createCrewRollApi,
  CrewRollApiProblem,
  CrewRollTransportProblem,
} from "./crewRollApi";

const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const commandId = "5a95305d-c558-4c79-b78c-a075be7bff84";
const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";

const createBody = {
  endsAt: "2026-09-02T12:00:00.000Z",
  inviteCode: "ABCD2345",
  name: "Weekend",
  ownerDeviceId: deviceId,
  ownerKeyEnvelope: {
    algorithmVersion: 1,
    keyEpoch: 1,
    protocolVersion: 1,
    recipientDeviceId: deviceId,
    recipientE2eeKeyVersion: 1,
    senderDeviceId: deviceId,
    wrappedKey:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  },
  release: { mode: "IMMEDIATE" },
  tripId,
} as CreateTripBody;

const joinBody = { deviceId, inviteCode: "ABCD2345" } as CreateJoinRequestBody;
const approvalBody = {
  algorithmVersion: 1,
  keyEpoch: 1,
  wrappedKey: "opaque-wrapped-key",
} as ApproveJoinRequestBody;
const startBody = { expectedVersion: 3 } as StartTripBody;
const readinessBody = {
  fullPhotoLibraryAccess: true,
} as SetTripReadinessBody;
const membershipId = "5a95305d-c558-4c79-b78c-a075be7bff85";
const requestId = "5a95305d-c558-4c79-b78c-a075be7bff86";

it("bounds a stalled token lookup and never sends a late authenticated request", async () => {
  let resolve!: (token: string) => void;
  const fetcher = jest.fn(async () => new Response("{}"));
  const api = createCrewRollApi({
    apiBaseUrl: "https://api.example",
    fetch: fetcher,
    timeoutMs: 20,
    sessionTokenSource: {
      getToken: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    },
  });
  await expect(api.listTrips(deviceId)).rejects.toBeInstanceOf(
    CrewRollTransportProblem,
  );
  resolve("late-token");
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
});

it("aborts a stalled network call without replaying an uncertain mutation", async () => {
  let signal: AbortSignal | undefined;
  const fetcher = jest.fn(async (request: Request) => {
    signal = request.signal;
    return new Promise<Response>(() => {});
  });
  const api = createCrewRollApi({
    apiBaseUrl: "https://api.example",
    fetch: fetcher as typeof fetch,
    timeoutMs: 20,
    sessionTokenSource: { getToken: async () => "token" },
  });
  await expect(
    api.createTrip(deviceId, commandId, createBody),
  ).rejects.toBeInstanceOf(CrewRollTransportProblem);
  expect(signal?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0].headers.get("Idempotency-Key")).toBe(
    commandId,
  );
});

it("bounds a stalled response body, not just connection establishment", async () => {
  const stalled = new Response("{}");
  stalled.text = () => new Promise<string>(() => {});
  const api = createCrewRollApi({
    apiBaseUrl: "https://api.example",
    fetch: (async () => stalled) as typeof fetch,
    timeoutMs: 20,
    sessionTokenSource: { getToken: async () => "token" },
  });
  await expect(api.listTrips(deviceId)).rejects.toBeInstanceOf(
    CrewRollTransportProblem,
  );
});
const createOutcomeBody = { tripId } as const;
const tripResponse: TripResponse = {
  currentMembershipId: membershipId,
  endsAt: "2026-09-02T12:00:00.000Z",
  id: tripId,
  keyEpoch: 1,
  members: [
    {
      displayName: "Owner",
      membershipId,
      nominatedDevice: {
        deviceId,
        e2eeKeyAlgorithm: "X25519",
        e2eeKeyVersion: 1,
        e2eePublicKey: `${"A".repeat(43)}=`,
      },
      readiness: { fullPhotoLibraryAccess: false },
      role: "OWNER",
      status: "ACTIVE",
    },
  ],
  name: "Weekend",
  ownerDeviceId: deviceId,
  release: { mode: "IMMEDIATE" },
  startsAt: null,
  status: "LOBBY",
  tripKeyEnvelope: {
    algorithmVersion: 1,
    keyEpoch: 1,
    wrappedKey: createBody.ownerKeyEnvelope.wrappedKey,
  },
  version: 1,
};

function response(
  body: unknown,
  status = 201,
  contentType = "application/json",
) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": contentType },
    status,
  });
}

function problemResponse(code: ProblemCode, status = 409) {
  return response(
    {
      code,
      detail: "private row and request context",
      instance: "/v1/trips/create-outcome",
      requestId,
      status,
      title: "Private provider detail",
      type: "https://crewroll.app/problems/private",
    },
    status,
    "application/problem+json",
  );
}

function requestFrom(call: unknown[] | undefined): Request {
  const [input, init] = call ?? [];
  return input instanceof Request
    ? input
    : new Request(input as RequestInfo, init as RequestInit);
}

function apiWith(
  fetchMock: jest.Mock,
  getToken: SessionTokenSource["getToken"] = async () => "clerk-session",
) {
  return createCrewRollApi({
    apiBaseUrl: "https://api.crewroll.app",
    fetch: fetchMock as unknown as typeof fetch,
    sessionTokenSource: { getToken },
  });
}

describe("CrewRoll API boundary", () => {
  it("refreshes an expired token once without changing the trip command or body", async () => {
    const requests: {
      authorization: string | null;
      command: string | null;
      body: unknown;
    }[] = [];
    const fetchMock = jest.fn(async (request: Request) => {
      requests.push({
        authorization: request.headers.get("Authorization"),
        command: request.headers.get("Idempotency-Key"),
        body: await request.json(),
      });
      return requests.length === 1
        ? problemResponse("AUTH_INVALID", 401)
        : response(tripResponse);
    });
    const getToken = jest.fn(async (options?: { skipCache: boolean }) =>
      options?.skipCache ? "fresh-token" : "expired-token",
    );
    await expect(
      apiWith(fetchMock, getToken).createTrip(deviceId, commandId, createBody),
    ).resolves.toEqual(tripResponse);
    expect(requests).toEqual([
      {
        authorization: "Bearer expired-token",
        command: commandId,
        body: createBody,
      },
      {
        authorization: "Bearer fresh-token",
        command: commandId,
        body: createBody,
      },
    ]);
    expect(getToken.mock.calls).toEqual([[], [{ skipCache: true }]]);
  });

  it("stops after one refreshed token is rejected", async () => {
    const fetchMock = jest.fn(async () => problemResponse("AUTH_INVALID", 401));
    const getToken = jest.fn(async () => "revoked-token");
    await expect(
      apiWith(fetchMock, getToken).getTrip(deviceId, tripId),
    ).rejects.toMatchObject({ code: "AUTH_INVALID", serverStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("keeps refresh network failures retryable instead of treating them as signed out", async () => {
    const fetchMock = jest.fn(async () => problemResponse("AUTH_INVALID", 401));
    const getToken = jest.fn(async (options?: { skipCache: boolean }) => {
      if (options?.skipCache) throw new Error("offline");
      return "expired-token";
    });
    await expect(
      apiWith(fetchMock, getToken).getTrip(deviceId, tripId),
    ).rejects.toBeInstanceOf(CrewRollTransportProblem);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for non-authentication failures", async () => {
    const fetchMock = jest.fn(async () => problemResponse("NOT_FOUND", 404));
    const getToken = jest.fn(async () => "valid-token");
    await expect(
      apiWith(fetchMock, getToken).getTrip(deviceId, tripId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("shares an outstanding refresh across concurrent expired requests", async () => {
    let finishRefresh!: (token: string) => void;
    const freshToken = new Promise<string>((resolve) => {
      finishRefresh = resolve;
    });
    const getToken = jest.fn(async (options?: { skipCache: boolean }) =>
      options?.skipCache ? freshToken : "expired-token",
    );
    const fetchMock = jest.fn(async (request: Request) =>
      request.headers.get("Authorization") === "Bearer expired-token"
        ? problemResponse("AUTH_INVALID", 401)
        : response(tripResponse, 200),
    );
    const api = apiWith(fetchMock, getToken);
    const requests = Promise.all([
      api.getTrip(deviceId, tripId),
      api.getTrip(deviceId, tripId),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      getToken.mock.calls.filter(([options]) => options?.skipCache),
    ).toHaveLength(1);
    finishRefresh("fresh-token");
    await expect(requests).resolves.toEqual([tripResponse, tripResponse]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not share a pending refresh with a different session token", async () => {
    const completions: ((token: string) => void)[] = [];
    let session = 0;
    const getToken = jest.fn(async (options?: { skipCache: boolean }) => {
      if (!options?.skipCache) return `expired-session-${++session}`;
      return new Promise<string>((resolve) => completions.push(resolve));
    });
    const fetchMock = jest.fn(async (request: Request) =>
      request.headers.get("Authorization")?.includes("expired-session")
        ? problemResponse("AUTH_INVALID", 401)
        : response(tripResponse, 200),
    );
    const api = apiWith(fetchMock, getToken);
    const requests = Promise.all([
      api.getTrip(deviceId, tripId),
      api.getTrip(deviceId, tripId),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completions).toHaveLength(2);
    completions.forEach((complete, index) =>
      complete(`fresh-session-${index}`),
    );
    await expect(requests).resolves.toEqual([tripResponse, tripResponse]);
  });

  it("uses the exact authoritative readiness request contract", async () => {
    const fetchMock = jest.fn(async () => response(tripResponse, 200));
    const api = apiWith(fetchMock);

    await api.setTripReadiness(deviceId, commandId, tripId, readinessBody);

    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      `https://api.crewroll.app/v1/trips/${tripId}/readiness`,
    );
    expect(request.headers.get("Authorization")).toBe("Bearer clerk-session");
    expect(request.headers.get("X-CrewRoll-Device-Id")).toBe(deviceId);
    expect(request.headers.get("Idempotency-Key")).toBe(commandId);
    await expect(request.json()).resolves.toEqual(readinessBody);
  });

  it("re-exports the application-owned API problem class", () => {
    expect(CrewRollApiProblem).toBe(ApplicationCrewRollApiProblem);
  });

  it("preserves an application-owned AUTH_REQUIRED failure before fetch", async () => {
    const fetchMock = jest.fn();
    const authRequired = new ApplicationCrewRollApiProblem("AUTH_REQUIRED");
    const api = apiWith(fetchMock, async () => {
      throw authRequired;
    });

    await expect(api.getTrip(deviceId, tripId)).rejects.toBe(authRequired);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks only an exact closed server problem with HTTP provenance", async () => {
    const api = apiWith(jest.fn(async () => problemResponse("NOT_FOUND", 404)));
    try {
      await api.getTrip(deviceId, tripId);
      throw new Error("expected problem");
    } catch (error) {
      expect(error).toBeInstanceOf(CrewRollApiProblem);
      expect((error as CrewRollApiProblem).serverStatus).toBe(404);
    }
  });

  it("accepts the control-plane mapper's about:blank ProblemDetails URI", async () => {
    const api = apiWith(
      jest.fn(async () =>
        response(
          {
            code: "AUTH_REQUIRED",
            detail: "Authentication is required",
            instance: "/v1/trips/current",
            requestId,
            status: 401,
            title: "Unauthorized",
            type: "about:blank",
          },
          401,
          "application/problem+json",
        ),
      ),
    );
    try {
      await api.getTrip(deviceId, tripId);
      throw new Error("expected problem");
    } catch (error) {
      expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
      expect((error as CrewRollApiProblem).serverStatus).toBe(401);
    }
  });

  it.each([
    ["code-only", { code: "NOT_FOUND" }, 404],
    [
      "body status mismatch",
      {
        code: "NOT_FOUND",
        detail: "private",
        instance: "/v1/trips/x",
        requestId,
        status: 404,
        title: "Not found",
        type: "https://crewroll.app/problems/not-found",
      },
      500,
    ],
  ])("fails closed for malformed %s problems", async (_label, body, status) => {
    const api = apiWith(
      jest.fn(async () => response(body, status, "application/problem+json")),
    );
    try {
      await api.getTrip(deviceId, tripId);
      throw new Error("expected problem");
    } catch (error) {
      expect(error).toEqual(new CrewRollApiProblem("INTERNAL_ERROR"));
      expect((error as CrewRollApiProblem).serverStatus).toBe(status);
    }
  });

  it("uses the exact authoritative create-outcome request contract", async () => {
    const fetchMock = jest.fn(async () =>
      response({ outcome: "STILL_UNKNOWN" }, 200),
    );
    const api = apiWith(fetchMock);

    await api.resolveCreateTripOutcome(deviceId, commandId, createOutcomeBody);

    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://api.crewroll.app/v1/trips/create-outcome",
    );
    expect(request.headers.get("Authorization")).toBe("Bearer clerk-session");
    expect(request.headers.get("X-CrewRoll-Device-Id")).toBe(deviceId);
    expect(request.headers.get("Idempotency-Key")).toBe(commandId);
    await expect(request.json()).resolves.toEqual({ tripId });
  });

  it("projects a persisted create command to the closed outcome body", async () => {
    const fetchMock = jest.fn(async () =>
      response({ outcome: "STILL_UNKNOWN" }, 200),
    );
    const api = apiWith(fetchMock);
    const persistedCreateCommand = {
      commandId,
      ownerInviteCode: "ABCD2345",
      tripId,
    };

    await api.resolveCreateTripOutcome(
      deviceId,
      commandId,
      persistedCreateCommand,
    );

    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(request.headers.get("Idempotency-Key")).toBe(commandId);
    await expect(request.json()).resolves.toEqual({ tripId });
  });

  it("returns every exact closed create-outcome variant", async () => {
    const outcomes: readonly CreateTripOutcomeResponse[] = [
      { outcome: "COMMITTED", trip: tripResponse },
      { outcome: "TERMINAL_NOT_COMMITTED" },
      { outcome: "STILL_UNKNOWN" },
    ];

    for (const outcome of outcomes) {
      const fetchMock = jest.fn(async () => response(outcome, 200));

      const result = await apiWith(fetchMock).resolveCreateTripOutcome(
        deviceId,
        commandId,
        createOutcomeBody,
      );

      expect(result).toEqual(outcome);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestFrom(fetchMock.mock.calls[0]).url).toBe(
        "https://api.crewroll.app/v1/trips/create-outcome",
      );
    }
  });

  it.each([
    ["80 astral characters", "🛶".repeat(80)],
    ["79 BMP and one astral character", `${"a".repeat(79)}🛶`],
  ])("accepts a COMMITTED trip name with %s", async (_caseName, name) => {
    const committed = {
      outcome: "COMMITTED",
      trip: { ...tripResponse, name },
    } as const;
    const fetchMock = jest.fn(async () => response(committed, 200));

    await expect(
      apiWith(fetchMock).resolveCreateTripOutcome(
        deviceId,
        commandId,
        createOutcomeBody,
      ),
    ).resolves.toEqual(committed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects create-outcome wire metadata without exposing it", async () => {
    const fetchMock = jest.fn(async () =>
      response(
        {
          outcome: "STILL_UNKNOWN",
          detail: "private row and request context",
          requestId,
          wireStatus: 200,
        },
        200,
      ),
    );

    try {
      await apiWith(fetchMock).resolveCreateTripOutcome(
        deviceId,
        commandId,
        createOutcomeBody,
      );
      throw new Error("expected closed response rejection");
    } catch (error) {
      expect(error).toEqual(new CrewRollApiProblem("INTERNAL_ERROR"));
      expect(error).not.toHaveProperty("detail");
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("requestId");
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("private row");
    }
  });

  it.each([
    [
      "nested private metadata",
      {
        ...tripResponse,
        detail: "private row and request context",
        requestId,
        wireStatus: 200,
      },
    ],
    [
      "a missing required field",
      (({ version: _version, ...tripWithoutVersion }) => tripWithoutVersion)(
        tripResponse,
      ),
    ],
  ])("rejects a COMMITTED trip with %s", async (_caseName, trip) => {
    const fetchMock = jest.fn(async () =>
      response({ outcome: "COMMITTED", trip }, 200),
    );

    try {
      await apiWith(fetchMock).resolveCreateTripOutcome(
        deviceId,
        commandId,
        createOutcomeBody,
      );
      throw new Error("expected malformed committed trip rejection");
    } catch (error) {
      expect(error).toEqual(new CrewRollApiProblem("INTERNAL_ERROR"));
      expect(error).not.toHaveProperty("detail");
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("requestId");
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("private row");
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves every canonical create-outcome problem without private fields", async () => {
    const codes = ProblemCodeSchema.anyOf.map(
      (candidate) => candidate.const,
    ) as ProblemCode[];

    for (const code of codes) {
      const fetchMock = jest.fn(async () => problemResponse(code));
      const api = apiWith(fetchMock);

      try {
        await api.resolveCreateTripOutcome(
          deviceId,
          commandId,
          createOutcomeBody,
        );
        throw new Error("expected create-outcome problem");
      } catch (error) {
        expect(error).toEqual(new CrewRollApiProblem(code));
        expect(error).not.toHaveProperty("detail");
        expect(error).not.toHaveProperty("status");
        expect(error).not.toHaveProperty("requestId");
        expect(error).not.toHaveProperty("instance");
        expect(error).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain("private row");
      }
    }
  });

  it("keeps getTrip 404 separate from authoritative create-outcome resolution", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(problemResponse("NOT_FOUND", 404))
      .mockResolvedValueOnce(response({ outcome: "STILL_UNKNOWN" }, 200));
    const api = apiWith(fetchMock);

    await expect(api.getTrip(deviceId, tripId)).rejects.toEqual(
      new CrewRollApiProblem("NOT_FOUND"),
    );
    await expect(
      api.resolveCreateTripOutcome(deviceId, commandId, createOutcomeBody),
    ).resolves.toEqual({ outcome: "STILL_UNKNOWN" });

    expect(fetchMock.mock.calls.map((call) => requestFrom(call).url)).toEqual([
      `https://api.crewroll.app/v1/trips/${tripId}`,
      "https://api.crewroll.app/v1/trips/create-outcome",
    ]);
  });

  it("uses a Clerk bearer and exact trip command headers", async () => {
    const fetchMock = jest.fn(async () => response({ id: tripId }));
    const api = apiWith(fetchMock);

    await api.createTrip(deviceId, commandId, createBody);

    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(request.headers.get("Authorization")).toBe("Bearer clerk-session");
    expect(request.headers.get("X-CrewRoll-Device-Id")).toBe(deviceId);
    expect(request.headers.get("Idempotency-Key")).toBe(commandId);
  });

  it("interpolates every required path parameter for trip operations", async () => {
    const fetchMock = jest.fn(async () => response({ id: tripId }, 200));
    const api = apiWith(fetchMock);

    await api.approveMember(
      deviceId,
      commandId,
      tripId,
      membershipId,
      approvalBody,
    );
    await api.startTrip(deviceId, commandId, tripId, startBody);
    await api.getTrip(deviceId, tripId);

    expect(
      fetchMock.mock.calls.map((call) => {
        const request = requestFrom(call);
        return { method: request.method, url: request.url };
      }),
    ).toEqual([
      {
        method: "PUT",
        url: `https://api.crewroll.app/v1/trips/${tripId}/join-requests/${membershipId}/approval`,
      },
      {
        method: "POST",
        url: `https://api.crewroll.app/v1/trips/${tripId}/start`,
      },
      {
        method: "GET",
        url: `https://api.crewroll.app/v1/trips/${tripId}`,
      },
    ]);
  });

  it("declines a join request with authenticated command headers and accepts only no-content success", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse("NOT_FOUND", 404));
    const api = apiWith(fetchMock);
    await expect(
      api.rejectMember(deviceId, commandId, tripId, membershipId),
    ).resolves.toBeUndefined();
    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(
      `https://api.crewroll.app/v1/trips/${tripId}/join-requests/${membershipId}`,
    );
    expect(request.headers.get("Authorization")).toBe("Bearer clerk-session");
    expect(request.headers.get("Idempotency-Key")).toBe(commandId);
    expect(request.headers.get("X-CrewRoll-Device-Id")).toBe(deviceId);
    await expect(
      api.rejectMember(deviceId, commandId, tripId, membershipId),
    ).rejects.toEqual(new CrewRollApiProblem("NOT_FOUND"));
  });

  it("never returns RFC 9457 detail to callers", async () => {
    const fetchMock = jest.fn(async () =>
      problemResponse("INVITE_INVALID", 400),
    );
    const api = apiWith(fetchMock);

    await expect(
      api.requestJoin(deviceId, commandId, joinBody),
    ).rejects.toEqual(new CrewRollApiProblem("INVITE_INVALID"));
  });

  it.each(["toString", "constructor", "__proto__", "not-a-problem-code"])(
    "maps non-canonical problem code %s to INTERNAL_ERROR",
    async (code) => {
      const fetchMock = jest.fn(async () =>
        response({ code }, 400, "application/problem+json"),
      );
      const api = apiWith(fetchMock);

      await expect(api.getTrip(deviceId, tripId)).rejects.toEqual(
        new CrewRollApiProblem("INTERNAL_ERROR"),
      );
    },
  );

  it("preserves every canonical problem code", async () => {
    const codes = [
      "AUTH_REQUIRED",
      "AUTH_INVALID",
      "DEVICE_NOT_OWNED",
      "DEVICE_REVOKED",
      "DEVICE_NOT_PARTICIPANT",
      "INSTALLATION_OWNED_BY_ANOTHER_USER",
      "IDEMPOTENCY_CONFLICT",
      "INVALID_REQUEST",
      "RATE_LIMITED",
      "ACTIVE_TRIP_EXISTS",
      "TRIP_ID_CONFLICT",
      "TRIP_DURATION_INVALID",
      "INVITE_CODE_CONFLICT",
      "TRIP_FULL",
      "INVITE_INVALID",
      "TRIP_OWNER_REQUIRED",
      "MEMBERSHIP_FROZEN",
      "PENDING_JOIN_REQUESTS",
      "KEY_ENVELOPE_MISSING",
      "KEY_ENVELOPE_INVALID",
      "PHOTO_LIBRARY_ACCESS_REQUIRED",
      "TRIP_STATE_CONFLICT",
      "VERSION_CONFLICT",
      "UPLOAD_EXPIRED",
      "OBJECT_MISMATCH",
      "CURSOR_EXPIRED",
      "NOT_FOUND",
      "CONFLICT",
      "INTERNAL_ERROR",
    ] as const;

    expect([...codes].sort()).toEqual(
      [...ProblemCodeSchema.anyOf.map((candidate) => candidate.const)].sort(),
    );

    for (const code of codes) {
      const fetchMock = jest.fn(async () => problemResponse(code, 400));
      const api = apiWith(fetchMock);
      await expect(api.getTrip(deviceId, tripId)).rejects.toEqual(
        new CrewRollApiProblem(code),
      );
    }
  });

  it("fails closed before fetch when the Clerk session is absent", async () => {
    const fetchMock = jest.fn();
    const api = apiWith(fetchMock, async () => "");

    await expect(api.getTrip(deviceId, tripId)).rejects.toEqual(
      new CrewRollApiProblem("AUTH_REQUIRED"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an aborted create-outcome request without retaining a cause or retrying", async () => {
    const fetchMock = jest.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    const api = apiWith(fetchMock);

    await expect(
      api.resolveCreateTripOutcome(deviceId, commandId, createOutcomeBody),
    ).rejects.toEqual(new CrewRollTransportProblem());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
