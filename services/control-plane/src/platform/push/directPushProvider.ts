import { importPKCS8, SignJWT } from "jose";
import type {
  PushProvider,
  PushSendResult,
} from "../../modules/push/ports/pushDispatch.js";

export interface DirectPushConfiguration {
  readonly apns?:
    | {
        readonly bundleId: string;
        readonly keyId: string;
        readonly teamId: string;
        readonly privateKey: string;
        readonly environment: "sandbox" | "production";
      }
    | undefined;
  readonly firebaseServiceAccountJson?: string | undefined;
}

const oauthOrigin = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const unavailable = (): PushSendResult => ({
  kind: "retry",
  code: "PROVIDER_UNAVAILABLE",
});
const configuration = (): PushSendResult => ({
  kind: "retry",
  code: "PROVIDER_CONFIGURATION",
});
// Bounded caches contain only completed credential values, never request-owned
// I/O promises, sockets, user state or database handles. Secret rotation changes
// the digest key, and old values expire. APNs forbids frequent provider JWT updates.
const credentials = new Map<string, { value: string; expires: number }>();
async function credentialKey(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function cache(key: string, token: { value: string; expires: number }) {
  credentials.set(key, token);
  while (credentials.size > 8)
    credentials.delete(credentials.keys().next().value!);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Deadline covers headers and streaming body. Provider bodies are never logged. */
async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("Provider request aborted");
    while (true) {
      const next = await reader.read();
      if (signal.aborted) throw new Error("Provider request aborted");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) throw new Error("Provider response exceeded limit");
      chunks.push(next.value);
    }
    if (!size) return {};
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return object(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid provider response");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function retryAfter(response: Response, now: Date): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now.getTime()) / 1_000);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(3_600, seconds)
    : undefined;
}

/** Native APNs/FCM only. Worker production fetch negotiates through Cloudflare's
 * proxy; local workerd cannot prove live APNs HTTP/2 delivery. Inject fetch in tests. */
export function createDirectPushProvider(
  config: DirectPushConfiguration,
  options: { readonly fetch?: typeof fetch; readonly now?: () => Date } = {},
): PushProvider {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let apnsJwt: { value: string; expires: number } | undefined;
  let googleToken: { value: string; expires: number } | undefined;
  let googlePending: Promise<string> | undefined;

  async function requestJson(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    const controller = new AbortController();
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          response = await send(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal,
          });
          return {
            response,
            body: await boundedJson(response, controller.signal),
          };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Provider deadline exceeded"));
          }, 8_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // An aborted real fetch errors its stream; cancel an injected unlocked
      // body too. Never wait for cleanup to settle a hostile response stream.
      if (controller.signal.aborted && response?.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
    }
  }

  async function googleAccessToken(): Promise<string> {
    const key = await credentialKey(["fcm", config.firebaseServiceAccountJson]);
    googleToken ??= credentials.get(key);
    if (googleToken && googleToken.expires > now().getTime() + 60_000)
      return googleToken.value;
    if (googlePending) return googlePending;
    googlePending = (async () => {
      const account = object(
        JSON.parse(config.firebaseServiceAccountJson ?? "{}"),
      );
      if (
        typeof account.project_id !== "string" ||
        !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(account.project_id) ||
        typeof account.client_email !== "string" ||
        !/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(account.client_email) ||
        typeof account.private_key !== "string"
      )
        throw new Error("Push configuration unavailable");
      const seconds = Math.floor(now().getTime() / 1_000);
      const assertion = await new SignJWT({ scope: FCM_SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(account.client_email)
        .setAudience(oauthOrigin)
        .setIssuedAt(seconds)
        .setExpirationTime(seconds + 3_600)
        .sign(await importPKCS8(account.private_key, "RS256"));
      const { response, body } = await requestJson(oauthOrigin, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      });
      if (
        response.status !== 200 ||
        typeof body.access_token !== "string" ||
        body.access_token.length === 0 ||
        body.access_token.length > 8_192 ||
        body.token_type !== "Bearer" ||
        typeof body.expires_in !== "number" ||
        body.expires_in < 60 ||
        body.expires_in > 3_600
      )
        throw new Error("Push authentication unavailable");
      googleToken = {
        value: body.access_token,
        expires: now().getTime() + body.expires_in * 1_000,
      };
      cache(key, googleToken);
      return googleToken.value;
    })();
    try {
      return await googlePending;
    } finally {
      googlePending = undefined;
    }
  }

  return {
    async send(input): Promise<PushSendResult> {
      const current = now();
      if (input.expiresAt <= current)
        return { kind: "permanent", code: "PROVIDER_REJECTED" };
      const ttl = Math.max(
        1,
        Math.min(
          3_600,
          Math.floor((input.expiresAt.getTime() - current.getTime()) / 1_000),
        ),
      );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${input.hint.deviceId}:${input.hint.tripId}`),
      );
      const collapse = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (input.platform === "ios") {
        const apns = config.apns;
        if (
          !apns ||
          !/^[A-Za-z0-9]{10}$/.test(apns.teamId) ||
          !/^[A-Za-z0-9]{10}$/.test(apns.keyId) ||
          !/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(apns.bundleId)
        )
          return configuration();
        if (!/^[0-9a-f]{2,4096}$/i.test(input.token) || input.token.length % 2)
          return { kind: "invalid-token" };
        try {
          const key = await credentialKey(["apns", apns]);
          apnsJwt ??= credentials.get(key);
          if (!apnsJwt || apnsJwt.expires <= current.getTime()) {
            const seconds = Math.floor(current.getTime() / 1_000);
            apnsJwt = {
              value: await new SignJWT({})
                .setProtectedHeader({ alg: "ES256", kid: apns.keyId })
                .setIssuer(apns.teamId)
                .setIssuedAt(seconds)
                .sign(await importPKCS8(apns.privateKey, "ES256")),
              expires: current.getTime() + 20 * 60_000,
            };
            cache(key, apnsJwt);
          }
          const origin =
            apns.environment === "production"
              ? "https://api.push.apple.com"
              : "https://api.sandbox.push.apple.com";
          const { response, body } = await requestJson(
            `${origin}/3/device/${input.token}`,
            {
              method: "POST",
              headers: {
                authorization: `bearer ${apnsJwt.value}`,
                "apns-topic": apns.bundleId,
                "apns-push-type": "background",
                "apns-priority": "5",
                "apns-id": input.hint.eventId,
                "apns-collapse-id": collapse,
                "apns-expiration": String(
                  Math.floor(input.expiresAt.getTime() / 1_000),
                ),
                "content-type": "application/json",
              },
              body: JSON.stringify({
                aps: { "content-available": 1 },
                ...input.hint,
              }),
            },
          );
          if (response.status === 200) return { kind: "accepted" };
          if (
            response.status === 410 &&
            ["Unregistered", "ExpiredToken"].includes(String(body.reason))
          ) {
            return typeof body.timestamp === "number" &&
              Number.isSafeInteger(body.timestamp) &&
              body.timestamp >= 0 &&
              body.timestamp <= current.getTime()
              ? {
                  kind: "invalid-token",
                  invalidatedAt: new Date(body.timestamp),
                }
              : unavailable();
          }
          // BadDeviceToken also means a sandbox/production mismatch. Never erase
          // a valid registration because deployment chose the wrong environment.
          if (
            [401, 403].includes(response.status) ||
            body.reason === "DeviceTokenNotForTopic" ||
            body.reason === "BadDeviceToken"
          ) {
            if (body.reason === "ExpiredProviderToken") {
              apnsJwt = undefined;
              credentials.delete(key);
            }
            return configuration();
          }
          if (response.status === 429 || response.status >= 500)
            return {
              kind: "retry",
              code: "PROVIDER_UNAVAILABLE",
              retryAfterSeconds: Math.max(
                response.status >= 500 ? 900 : 60,
                retryAfter(response, current) ?? 0,
              ),
            };
          return { kind: "permanent", code: "PROVIDER_REJECTED" };
        } catch {
          return unavailable();
        }
      }
      if (!config.firebaseServiceAccountJson) return configuration();
      try {
        const account = object(JSON.parse(config.firebaseServiceAccountJson));
        if (
          typeof account.project_id !== "string" ||
          !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(account.project_id)
        )
          return configuration();
        const token = await googleAccessToken();
        const { response, body } = await requestJson(
          `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token: input.token,
                data: input.hint,
                android: {
                  priority: "NORMAL",
                  ttl: `${ttl}s`,
                  collapse_key: collapse,
                  restricted_package_name: "com.uankit53.airmesh",
                },
              },
            }),
          },
        );
        if (response.status === 200 && typeof body.name === "string")
          return { kind: "accepted" };
        const details = object(body.error).details;
        const fcm = Array.isArray(details)
          ? details
              .map(object)
              .find(
                (value) =>
                  value["@type"] ===
                  "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              )
          : undefined;
        if (response.status === 404 && fcm?.errorCode === "UNREGISTERED")
          return { kind: "invalid-token" };
        if (response.status === 401 || response.status === 403) {
          googleToken = undefined;
          credentials.delete(
            await credentialKey(["fcm", config.firebaseServiceAccountJson]),
          );
          return configuration();
        }
        if (response.status === 429 || response.status >= 500)
          return {
            kind: "retry",
            code: "PROVIDER_UNAVAILABLE",
            retryAfterSeconds: Math.max(60, retryAfter(response, current) ?? 0),
          };
        return { kind: "permanent", code: "PROVIDER_REJECTED" };
      } catch {
        return unavailable();
      }
    },
  };
}
