import { z } from "zod";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);
const nonemptySecretSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

const sourceSchema = z.object({
  APNS_BUNDLE_ID: nonemptySecretSchema.optional(),
  APNS_KEY_ID: nonemptySecretSchema.optional(),
  APNS_PRIVATE_KEY: nonemptySecretSchema.optional(),
  APNS_TEAM_ID: nonemptySecretSchema.optional(),
  AWS_REGION: nonemptySecretSchema.optional(),
  BACKGROUND_CREDENTIAL_HMAC_KEY_V1: nonemptySecretSchema.optional(),
  CLERK_AUTHORIZED_PARTIES_JSON: nonemptySecretSchema.optional(),
  CLERK_ISSUER: nonemptySecretSchema.optional(),
  CLERK_SECRET_KEY: nonemptySecretSchema.optional(),
  CLERK_WEBHOOK_SECRET: nonemptySecretSchema.optional(),
  DATABASE_URL: z.string().trim().min(1).refine(isPostgresUrl),
  FIREBASE_SERVICE_ACCOUNT_JSON: nonemptySecretSchema
    .refine(isJsonObject)
    .optional(),
  HOST: z.string().trim().min(1),
  INVITE_CODE_HMAC_KEY: nonemptySecretSchema.optional(),
  KMS_PUSH_TOKEN_KEY_ID: nonemptySecretSchema.optional(),
  LOG_LEVEL: logLevelSchema,
  MEDIA_BUCKET: nonemptySecretSchema.optional(),
  NODE_ENV: nodeEnvironmentSchema,
  PORT: z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
});

const productionOnlyKeys = [
  "APNS_BUNDLE_ID",
  "APNS_KEY_ID",
  "APNS_PRIVATE_KEY",
  "APNS_TEAM_ID",
  "AWS_REGION",
  "BACKGROUND_CREDENTIAL_HMAC_KEY_V1",
  "CLERK_AUTHORIZED_PARTIES_JSON",
  "CLERK_ISSUER",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SECRET",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "INVITE_CODE_HMAC_KEY",
  "KMS_PUSH_TOKEN_KEY_ID",
  "MEDIA_BUCKET",
] as const;

export type NodeEnvironment = z.infer<typeof nodeEnvironmentSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export interface Environment {
  readonly apnsBundleId: string | undefined;
  readonly apnsKeyId: string | undefined;
  readonly apnsPrivateKey: string | undefined;
  readonly apnsTeamId: string | undefined;
  readonly awsRegion: string | undefined;
  readonly backgroundCredentialHmacKeyV1: Uint8Array | undefined;
  readonly clerkAuthorizedParties: readonly string[];
  readonly clerkIssuer: string | undefined;
  readonly clerkSecretKey: string | undefined;
  readonly clerkWebhookSecret: string | undefined;
  readonly databaseUrl: string;
  readonly debugCorsOrigins: readonly string[];
  readonly firebaseServiceAccountJson: string | undefined;
  readonly host: string;
  readonly inviteCodeHmacKey: string | undefined;
  readonly kmsPushTokenKeyId: string | undefined;
  readonly logLevel: LogLevel;
  readonly mediaBucket: string | undefined;
  readonly nodeEnvironment: NodeEnvironment;
  readonly port: number;
}

export class EnvironmentError extends Error {
  readonly invalidKeys: readonly string[];

  constructor(invalidKeys: readonly string[]) {
    const sortedKeys = [...new Set(invalidKeys)].sort();
    super(`Invalid environment keys: ${sortedKeys.join(", ")}`);
    this.name = "EnvironmentError";
    this.invalidKeys = Object.freeze(sortedKeys);
  }
}

function parseDebugCorsOrigins(
  input: string | undefined,
): readonly string[] | undefined {
  if (input === undefined) return [];

  const origins: string[] = [];
  for (const item of input.split(",")) {
    const candidate = item.trim();
    if (candidate.length === 0) return undefined;

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return undefined;
    }

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    origins.push(url.origin);
  }

  return new Set(origins).size === origins.length ? origins : undefined;
}

function parseCanonicalBase64Key(
  input: string | undefined,
): Buffer | undefined {
  if (input === undefined) return undefined;
  try {
    const decoded = Buffer.from(input, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== input) {
      return undefined;
    }
    return Buffer.from(decoded);
  } catch {
    return undefined;
  }
}

function parseOrigin(input: string, requireHttps: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    (requireHttps
      ? url.protocol !== "https:"
      : !["http:", "https:"].includes(url.protocol)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    input !== url.origin
  ) {
    return undefined;
  }
  return url.origin;
}

function parseAuthorizedParties(
  input: string | undefined,
  requireHttps: boolean,
): readonly string[] | undefined {
  if (input === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const origins: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return undefined;
    const origin = parseOrigin(item, requireHttps);
    if (origin === undefined) return undefined;
    origins.push(origin);
  }
  if (
    new Set(origins).size !== origins.length ||
    JSON.stringify(origins) !== input
  ) {
    return undefined;
  }
  return origins;
}

export function loadEnvironment(source: NodeJS.ProcessEnv): Environment {
  const parsed = sourceSchema.safeParse(source);
  const invalidKeys = new Set<string>();

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string") invalidKeys.add(key);
    }
  }

  if (source.NODE_ENV === "production") {
    for (const key of productionOnlyKeys) {
      const value = source[key];
      if (value === undefined || value.trim().length === 0) {
        invalidKeys.add(key);
      }
    }
  }

  const debugCorsOrigins = parseDebugCorsOrigins(source.DEBUG_CORS_ORIGINS);
  if (
    debugCorsOrigins === undefined ||
    (source.NODE_ENV === "production" && debugCorsOrigins.length > 0)
  ) {
    invalidKeys.add("DEBUG_CORS_ORIGINS");
  }

  const isProduction = source.NODE_ENV === "production";
  const backgroundCredentialHmacKeyV1 = parseCanonicalBase64Key(
    source.BACKGROUND_CREDENTIAL_HMAC_KEY_V1,
  );
  if (
    source.BACKGROUND_CREDENTIAL_HMAC_KEY_V1 !== undefined &&
    backgroundCredentialHmacKeyV1 === undefined
  ) {
    invalidKeys.add("BACKGROUND_CREDENTIAL_HMAC_KEY_V1");
  }

  const clerkAuthorizedParties = parseAuthorizedParties(
    source.CLERK_AUTHORIZED_PARTIES_JSON,
    isProduction,
  );
  if (clerkAuthorizedParties === undefined) {
    invalidKeys.add("CLERK_AUTHORIZED_PARTIES_JSON");
  }

  if (
    isProduction &&
    source.CLERK_ISSUER !== undefined &&
    parseOrigin(source.CLERK_ISSUER, true) === undefined
  ) {
    invalidKeys.add("CLERK_ISSUER");
  }

  if (
    !parsed.success ||
    debugCorsOrigins === undefined ||
    invalidKeys.size > 0
  ) {
    throw new EnvironmentError([...invalidKeys]);
  }

  const normalizedClerkAuthorizedParties = clerkAuthorizedParties ?? [];

  const environment = {
    apnsBundleId: parsed.data.APNS_BUNDLE_ID,
    apnsKeyId: parsed.data.APNS_KEY_ID,
    apnsPrivateKey: parsed.data.APNS_PRIVATE_KEY,
    apnsTeamId: parsed.data.APNS_TEAM_ID,
    awsRegion: parsed.data.AWS_REGION,
    clerkAuthorizedParties: Object.freeze([
      ...normalizedClerkAuthorizedParties,
    ]),
    clerkIssuer: parsed.data.CLERK_ISSUER,
    clerkSecretKey: parsed.data.CLERK_SECRET_KEY,
    clerkWebhookSecret: parsed.data.CLERK_WEBHOOK_SECRET,
    databaseUrl: parsed.data.DATABASE_URL,
    debugCorsOrigins: Object.freeze([...debugCorsOrigins]),
    firebaseServiceAccountJson: parsed.data.FIREBASE_SERVICE_ACCOUNT_JSON,
    host: parsed.data.HOST,
    inviteCodeHmacKey: parsed.data.INVITE_CODE_HMAC_KEY,
    kmsPushTokenKeyId: parsed.data.KMS_PUSH_TOKEN_KEY_ID,
    logLevel: parsed.data.LOG_LEVEL,
    mediaBucket: parsed.data.MEDIA_BUCKET,
    nodeEnvironment: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
  } as Environment;
  Object.defineProperty(environment, "backgroundCredentialHmacKeyV1", {
    configurable: false,
    enumerable: false,
    value: backgroundCredentialHmacKeyV1,
    writable: false,
  });
  return Object.freeze(environment);
}
