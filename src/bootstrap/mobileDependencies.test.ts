import { createMobileDependencies } from "./mobileDependencies";

const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const commandId = "5a95305d-c558-4c79-b78c-a075be7bff84";
const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";

function requestFrom(call: unknown[] | undefined): Request {
  const [input, init] = call ?? [];
  return input instanceof Request
    ? input
    : new Request(input as RequestInfo, init as RequestInit);
}

describe("mobile production dependencies", () => {
  it("wires the real generated CrewRoll adapter through the shared trip port", async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ outcome: "STILL_UNKNOWN" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    const getToken = jest.fn(async () => "clerk-session");
    const dependencies = createMobileDependencies({
      apiBaseUrl: "https://api.crewroll.app",
      fetch: fetchMock as unknown as typeof fetch,
      sessionTokenSource: { getToken },
    });

    await expect(
      dependencies.tripApi.resolveCreateTripOutcome(deviceId, commandId, {
        tripId,
      }),
    ).resolves.toEqual({ outcome: "STILL_UNKNOWN" });

    expect(dependencies.tripApi).toBe(dependencies.deviceRegistration);
    expect(getToken).toHaveBeenCalledTimes(1);
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
});
