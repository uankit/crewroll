import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

interface SafeLoggerEnvironment {
  readonly logLevel:
    "debug" | "error" | "fatal" | "info" | "silent" | "trace" | "warn";
  readonly nodeEnvironment: "development" | "production" | "test";
}

type ValueValidator = (value: unknown) => boolean;

const serviceName = "crewroll-control-plane";
const stableTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const uppercaseCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const methodPattern = /^[A-Z]{3,10}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const traceIdPattern = /^[0-9a-f]{32}$/iu;
const spanIdPattern = /^[0-9a-f]{16}$/iu;
const knownRouteTemplates = new Set([
  "/documentation",
  "/documentation/*",
  "/health/live",
  "/health/ready",
  "/unmatched",
  "/v1/devices",
  "/v1/devices/:deviceId",
  "/v1/devices/:deviceId/push-token",
  "/v1/profile",
  "/v1/account",
  "/v1/account/terms",
  "/v1/account/deletion",
  "/v1/account/deletions/:requestId",
  "/v1/account/reports",
  "/v1/account/blocks",
  "/v1/account/blocks/:userId",
  "/v1/trips",
  "/v1/trips/:tripId",
  "/v1/trips/create-outcome",
  "/v1/trips/invite-preview",
  "/v1/trips/join-requests",
  "/v1/trips/:tripId/join-requests/:membershipId/approval",
  "/v1/trips/:tripId/join-requests/:membershipId",
  "/v1/trips/:tripId/readiness",
  "/v1/trips/:tripId/start",
  "/v1/trips/:tripId/lifecycle",
  "/v1/trips/:tripId/continuity",
  "/v1/trips/:tripId/transfer-state",
  "/v1/trips/:tripId/drained",
  "/v1/trips/:tripId/previews",
  "/v1/assets/upload-sessions",
  "/v1/assets/:assetId/preview",
  "/v1/assets/:assetId/commit",
  "/v1/deliveries/pending",
  "/v1/deliveries/:deliveryId/download-session",
  "/v1/deliveries/:deliveryId/saved-receipt",
  "/v1/local-media/object",
  "/webhooks/clerk",
]);

function isBoundedString(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

function isNonnegativeFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const valueValidators: Readonly<Record<string, ValueValidator>> = {
  appVersion: (value) => isBoundedString(value, stableTokenPattern),
  attempt: isNonnegativeFiniteNumber,
  blockerCode: (value) => isBoundedString(value, uppercaseCodePattern),
  buildVersion: (value) => isBoundedString(value, stableTokenPattern),
  code: (value) => isBoundedString(value, uppercaseCodePattern),
  count: isNonnegativeFiniteNumber,
  durationMs: isNonnegativeFiniteNumber,
  event: (value) => isBoundedString(value, stableTokenPattern),
  method: (value) => isBoundedString(value, methodPattern),
  module: (value) => isBoundedString(value, stableTokenPattern),
  networkClass: (value) => isBoundedString(value, stableTokenPattern),
  ready: (value) => typeof value === "boolean",
  requestId: (value) => isBoundedString(value, uuidPattern),
  retryCode: (value) => isBoundedString(value, uppercaseCodePattern),
  route: (value) => typeof value === "string" && knownRouteTemplates.has(value),
  spanId: (value) => isBoundedString(value, spanIdPattern),
  statusCode: isNonnegativeFiniteNumber,
  traceId: (value) => isBoundedString(value, traceIdPattern),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterAllowedFields(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || input instanceof Error) return {};

  try {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const validator = valueValidators[key];
      if (validator?.(value) === true) filtered[key] = value;
    }
    return filtered;
  } catch {
    return {};
  }
}

const forbiddenRedactionPaths = [
  "authorization",
  "body",
  "cookie",
  "encryptedManifest",
  "err",
  "error",
  "hash",
  "headers",
  "objectKey",
  "path",
  "pushToken",
  "query",
  "req",
  "res",
  "signedUrl",
  "url",
  "wrappedKey",
] as const;

export function createSafeLogger(
  environment: SafeLoggerEnvironment,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    base: {},
    formatters: {
      bindings(bindings) {
        return {
          environment: environment.nodeEnvironment,
          service: serviceName,
          ...filterAllowedFields(bindings),
        };
      },
      log: filterAllowedFields,
    },
    hooks: {
      logMethod(args, method) {
        const payload = filterAllowedFields(args[0]);
        method.apply(this, [payload]);
      },
    },
    level: environment.logLevel,
    redact: {
      paths: [...forbiddenRedactionPaths],
      remove: true,
    },
    serializers: {},
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}
