import type {
  CreateJoinRequestBody,
  CreateTripBody,
} from "@crewroll/contracts";

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

function requestFrom(call: unknown[] | undefined): Request {
  const [input, init] = call ?? [];
  return input instanceof Request
    ? input
    : new Request(input as RequestInfo, init as RequestInit);
}

function apiWith(
  fetchMock: jest.Mock,
  getToken: () => Promise<string> = async () => "clerk-session",
) {
  return createCrewRollApi({
    apiBaseUrl: "https://api.crewroll.app",
    fetch: fetchMock as unknown as typeof fetch,
    sessionTokenSource: { getToken },
  });
}

describe("CrewRoll API boundary", () => {
  it("uses a Clerk bearer and exact trip command headers", async () => {
    const fetchMock = jest.fn(async () => response({ id: tripId }));
    const api = apiWith(fetchMock);

    await api.createTrip(deviceId, commandId, createBody);

    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(request.headers.get("Authorization")).toBe("Bearer clerk-session");
    expect(request.headers.get("X-CrewRoll-Device-Id")).toBe(deviceId);
    expect(request.headers.get("Idempotency-Key")).toBe(commandId);
  });

  it("never returns RFC 9457 detail to callers", async () => {
    const fetchMock = jest.fn(async () =>
      response(
        { code: "INVITE_INVALID", detail: "invite hash row 91 did not match" },
        400,
        "application/problem+json",
      ),
    );
    const api = apiWith(fetchMock);

    await expect(
      api.requestJoin(deviceId, commandId, joinBody),
    ).rejects.toEqual(new CrewRollApiProblem("INVITE_INVALID"));
  });

  it("fails closed before fetch when the Clerk session is absent", async () => {
    const fetchMock = jest.fn();
    const api = apiWith(fetchMock, async () => "");

    await expect(api.getTrip(deviceId, tripId)).rejects.toEqual(
      new CrewRollApiProblem("AUTH_REQUIRED"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps aborted transport once without retaining a provider cause or retrying", async () => {
    const fetchMock = jest.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    const api = apiWith(fetchMock);

    await expect(api.getTrip(deviceId, tripId)).rejects.toEqual(
      new CrewRollTransportProblem(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
