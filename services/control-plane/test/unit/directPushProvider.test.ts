import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compactVerify, exportPKCS8, generateKeyPair } from "jose";
import {
  createDirectPushProvider,
  type DirectPushConfiguration,
} from "../../src/platform/push/directPushProvider.js";

const now = new Date("2026-11-12T03:00:00Z");
const hint = {
  type: "crewroll.sync.v1" as const,
  tripId: "01990000-0000-7000-8000-000000000001",
  deviceId: crypto.randomUUID(),
  eventId: crypto.randomUUID(),
};
const input = {
  platform: "ios" as const,
  token: "a1".repeat(32),
  hint,
  expiresAt: new Date(now.getTime() + 3_600_000),
};
let apns: NonNullable<DirectPushConfiguration["apns"]>;
let firebaseServiceAccountJson: string;
let applePublicKey: CryptoKey;
let googlePublicKey: CryptoKey;
function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string")
    throw new Error("Expected JSON string body");
  return JSON.parse(init.body) as unknown;
}
beforeAll(async () => {
  const apple = await generateKeyPair("ES256", { extractable: true });
  const google = await generateKeyPair("RS256", { extractable: true });
  applePublicKey = apple.publicKey;
  googlePublicKey = google.publicKey;
  apns = {
    teamId: "TEAMID1234",
    keyId: "APPLEKEY01",
    bundleId: "app.crewroll.mobile",
    environment: "production",
    privateKey: await exportPKCS8(apple.privateKey),
  };
  firebaseServiceAccountJson = JSON.stringify({
    project_id: "crewroll-test",
    client_email: "push@crewroll-test.iam.gserviceaccount.com",
    private_key: await exportPKCS8(google.privateKey),
    token_uri: "https://attacker.invalid/token",
  });
});
afterEach(() => vi.useRealTimers());

describe("direct privacy-safe push transports", () => {
  it("uses only a silent APNs hint, fixed HTTPS origin, priority5, bounded TTL and64byte collapse ID", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const provider = createDirectPushProvider(
      { apns },
      { fetch: transport, now: () => now },
    );
    await expect(provider.send(input)).resolves.toEqual({ kind: "accepted" });
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(`https://api.push.apple.com/3/device/${input.token}`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        "apns-topic": "app.crewroll.mobile",
        "apns-push-type": "background",
        "apns-priority": "5",
        "apns-id": hint.eventId,
      },
    });
    expect(jsonBody(init)).toEqual({
      aps: { "content-available": 1 },
      ...hint,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("apns-collapse-id")).toHaveLength(64);
    expect(headers.get("apns-expiration")).toBe(
      String(input.expiresAt.getTime() / 1_000),
    );
    const signed = await compactVerify(
      headers.get("authorization")!.slice(7),
      applePublicKey,
      { algorithms: ["ES256"] },
    );
    expect(signed.protectedHeader).toMatchObject({
      alg: "ES256",
      kid: apns.keyId,
    });
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(signed.payload),
    );
    expect(claims).toMatchObject({
      iss: apns.teamId,
      iat: now.getTime() / 1_000,
    });
  });

  it("reuses the APNs JWT across runtime instances without sharing request I/O promises", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 200 })),
      );
    await createDirectPushProvider(
      { apns },
      { fetch: transport, now: () => now },
    ).send(input);
    await createDirectPushProvider(
      { apns },
      { fetch: transport, now: () => new Date(now.getTime() + 60_000) },
    ).send(input);
    expect(
      new Headers(transport.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe(
      new Headers(transport.mock.calls[1]![1]?.headers).get("authorization"),
    );
  });

  it.each(["BadDeviceToken", "DeviceTokenNotForTopic"])(
    "does not erase a token for deployment/environment mismatch %s",
    async (reason) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ reason }, { status: 400 }));
      await expect(
        createDirectPushProvider(
          { apns },
          { fetch: transport, now: () => now },
        ).send(input),
      ).resolves.toEqual({ kind: "retry", code: "PROVIDER_CONFIGURATION" });
    },
  );

  it("recognizes explicit unregistration and honors Apple15minute5xx backoff", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { reason: "Unregistered", timestamp: now.getTime() },
          { status: 410 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ reason: "ServiceUnavailable" }, { status: 503 }),
      );
    const provider = createDirectPushProvider(
      { apns },
      { fetch: transport, now: () => now },
    );
    await expect(provider.send(input)).resolves.toEqual({
      kind: "invalid-token",
      invalidatedAt: now,
    });
    await expect(provider.send(input)).resolves.toEqual({
      kind: "retry",
      code: "PROVIDER_UNAVAILABLE",
      retryAfterSeconds: 900,
    });
  });

  it("does not follow credential-bearing redirects or accept an oversized provider response", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid" },
        }),
      )
      .mockResolvedValueOnce(new Response("x".repeat(16_385), { status: 200 }));
    const provider = createDirectPushProvider(
      { apns },
      { fetch: transport, now: () => now },
    );
    await expect(provider.send(input)).resolves.toMatchObject({
      kind: "permanent",
    });
    await expect(provider.send(input)).resolves.toMatchObject({
      kind: "retry",
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("times out and cancels a provider body that never completes", async () => {
    let begin!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => {
      begin();
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel,
          }),
          { status: 200 },
        ),
      );
    });
    vi.useFakeTimers();
    const result = createDirectPushProvider(
      { apns },
      { fetch: transport, now: () => now },
    ).send(input);
    await began;
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(result).resolves.toEqual({
      kind: "retry",
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("sends normal-priority FCM data only, uses the fixed OAuth origin and caches completed OAuth credentials", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        if (url === "https://oauth2.googleapis.com/token") {
          const body = init?.body;
          expect(body).toBeInstanceOf(URLSearchParams);
          if (!(body instanceof URLSearchParams))
            throw new Error("Expected OAuth form");
          const signed = await compactVerify(
            body.get("assertion")!,
            googlePublicKey,
            { algorithms: ["RS256"] },
          );
          expect(signed.protectedHeader.alg).toBe("RS256");
          const claims: unknown = JSON.parse(
            new TextDecoder().decode(signed.payload),
          );
          expect(claims).toMatchObject({
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token",
            iss: "push@crewroll-test.iam.gserviceaccount.com",
            iat: now.getTime() / 1_000,
            exp: now.getTime() / 1_000 + 3_600,
          });
          return Promise.resolve(
            Response.json({
              access_token: "oauth-access-token",
              token_type: "Bearer",
              expires_in: 3_600,
            }),
          );
        }
        expect(url).toBe(
          "https://fcm.googleapis.com/v1/projects/crewroll-test/messages:send",
        );
        expect(jsonBody(init)).toMatchObject({
          message: {
            token: "native-fcm-token",
            data: hint,
            android: {
              priority: "NORMAL",
              ttl: "3600s",
              restricted_package_name: "com.uankit53.airmesh",
            },
          },
        });
        expect(JSON.stringify(init?.body)).not.toMatch(
          /notification|title|sound/,
        );
        return Promise.resolve(
          Response.json({ name: "projects/crewroll-test/messages/one" }),
        );
      });
    const android = {
      ...input,
      platform: "android" as const,
      token: "native-fcm-token",
    };
    await expect(
      createDirectPushProvider(
        { firebaseServiceAccountJson },
        { fetch: transport, now: () => now },
      ).send(android),
    ).resolves.toEqual({ kind: "accepted" });
    await expect(
      createDirectPushProvider(
        { firebaseServiceAccountJson },
        { fetch: transport, now: () => now },
      ).send(android),
    ).resolves.toEqual({ kind: "accepted" });
    expect(
      transport.mock.calls.filter(
        ([url]) => url === "https://oauth2.googleapis.com/token",
      ),
    ).toHaveLength(1);
  });

  it("invalidates only explicit FCM unregistration, not generic payload or authentication failures", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation((url) => {
      if (url === "https://oauth2.googleapis.com/token")
        return Promise.resolve(
          Response.json({
            access_token: "access",
            token_type: "Bearer",
            expires_in: 3_600,
          }),
        );
      return Promise.resolve(
        Response.json(
          {
            error: {
              details: [
                {
                  "@type":
                    "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                  errorCode: "UNREGISTERED",
                },
              ],
            },
          },
          { status: 404 },
        ),
      );
    });
    const provider = createDirectPushProvider(
      { firebaseServiceAccountJson },
      { fetch: transport, now: () => now },
    );
    await expect(
      provider.send({
        ...input,
        platform: "android",
        token: "native-fcm-token",
      }),
    ).resolves.toEqual({ kind: "invalid-token" });
    transport.mockResolvedValueOnce(
      Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 }),
    );
    await expect(
      provider.send({
        ...input,
        platform: "android",
        token: "native-fcm-token",
      }),
    ).resolves.toEqual({ kind: "permanent", code: "PROVIDER_REJECTED" });
  });

  it("makes missing provider configuration explicit without network access", async () => {
    const transport = vi.fn<typeof fetch>();
    const provider = createDirectPushProvider(
      {},
      { fetch: transport, now: () => now },
    );
    await expect(provider.send(input)).resolves.toEqual({
      kind: "retry",
      code: "PROVIDER_CONFIGURATION",
    });
    await expect(
      provider.send({ ...input, platform: "android" }),
    ).resolves.toEqual({ kind: "retry", code: "PROVIDER_CONFIGURATION" });
    expect(transport).not.toHaveBeenCalled();
  });
});
