import { describe, expect, it } from "vitest";

import { EnvironmentError, loadEnvironment } from "../../src/config/env.js";

const developmentEnvironment = {
  DATABASE_URL: "postgresql://crewroll:local@127.0.0.1:5432/crewroll",
  HOST: "127.0.0.1",
  LOG_LEVEL: "info",
  NODE_ENV: "development",
  PORT: "3000",
} satisfies NodeJS.ProcessEnv;

const productionProviderEnvironment = {
  APNS_BUNDLE_ID: "com.uankit53.crewroll",
  APNS_KEY_ID: "apns_key",
  APNS_PRIVATE_KEY: "apns_private_key",
  APNS_TEAM_ID: "apns_team",
  AWS_REGION: "ap-south-1",
  BACKGROUND_CREDENTIAL_HMAC_KEY_V1: Buffer.alloc(32, 0xa5).toString("base64"),
  CLERK_AUTHORIZED_PARTIES_JSON: '["https://app.crewroll.example"]',
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_SECRET_KEY: "clerk_secret",
  CLERK_WEBHOOK_SECRET: "clerk_webhook_secret",
  FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"crewroll"}',
  INVITE_CODE_HMAC_KEY: "invite_hmac_key",
  KMS_PUSH_TOKEN_KEY_ID: "kms_push_key",
  MEDIA_BUCKET: "crewroll-media",
} satisfies NodeJS.ProcessEnv;

const productionOnlyKeys = Object.keys(productionProviderEnvironment).sort();

function captureEnvironmentError(source: NodeJS.ProcessEnv): EnvironmentError {
  try {
    loadEnvironment(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentError);
    return error as EnvironmentError;
  }
  throw new Error("Expected environment parsing to fail");
}

describe("loadEnvironment", () => {
  it("parses the smallest development environment without reading globals", () => {
    const environment = loadEnvironment(developmentEnvironment);

    expect(environment).toMatchObject({
      databaseUrl: developmentEnvironment.DATABASE_URL,
      debugCorsOrigins: [],
      host: "127.0.0.1",
      logLevel: "info",
      nodeEnvironment: "development",
      port: 3000,
    });
    expect(environment.clerkSecretKey).toBeUndefined();
    expect(environment.backgroundCredentialHmacKeyV1).toBeUndefined();
    expect(environment.clerkAuthorizedParties).toEqual([]);
    expect(environment).not.toHaveProperty("clerkAudience");
    expect(environment.firebaseServiceAccountJson).toBeUndefined();
  });

  it.each(["development", "test", "production"] as const)(
    "accepts the %s runtime mode",
    (nodeEnvironment) => {
      const environment = loadEnvironment({
        ...developmentEnvironment,
        ...(nodeEnvironment === "production"
          ? productionProviderEnvironment
          : {}),
        NODE_ENV: nodeEnvironment,
      });

      expect(environment.nodeEnvironment).toBe(nodeEnvironment);
    },
  );

  it.each([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ] as const)("accepts the %s log level", (logLevel) => {
    const environment = loadEnvironment({
      ...developmentEnvironment,
      LOG_LEVEL: logLevel,
    });

    expect(environment.logLevel).toBe(logLevel);
  });

  it.each([
    ["1", 1],
    ["65535", 65535],
  ])("accepts port %s", (input, expected) => {
    expect(
      loadEnvironment({ ...developmentEnvironment, PORT: input }).port,
    ).toBe(expected);
  });

  it.each([
    ["NODE_ENV", "staging"],
    ["HOST", "   "],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "1.5"],
    ["PORT", "not-a-port"],
    ["LOG_LEVEL", "verbose"],
    ["DATABASE_URL", "mysql://database.example.test/crewroll"],
  ])("rejects invalid %s", (key, value) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      [key]: value,
    });

    expect(error.invalidKeys).toEqual([key]);
    expect(error.message).toBe(`Invalid environment keys: ${key}`);
    expect(error.message).not.toContain(value);
  });

  it.each(productionOnlyKeys)("requires %s in production", (missingKey) => {
    const source: NodeJS.ProcessEnv = {
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      NODE_ENV: "production",
    };
    delete source[missingKey];

    const error = captureEnvironmentError(source);

    expect(error.invalidKeys).toEqual([missingKey]);
  });

  it("owns a canonical 32-byte background credential HMAC key without serializing it", () => {
    const sourceKey = Buffer.alloc(32, 0x6b);
    const environment = loadEnvironment({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      BACKGROUND_CREDENTIAL_HMAC_KEY_V1: sourceKey.toString("base64"),
      NODE_ENV: "production",
    });

    expect(environment.backgroundCredentialHmacKeyV1).toEqual(sourceKey);
    expect(environment.backgroundCredentialHmacKeyV1).not.toBe(sourceKey);
    sourceKey.fill(0);
    expect(environment.backgroundCredentialHmacKeyV1).toEqual(
      Buffer.alloc(32, 0x6b),
    );
    expect(JSON.stringify(environment)).not.toContain(
      productionProviderEnvironment.BACKGROUND_CREDENTIAL_HMAC_KEY_V1,
    );
    expect(JSON.stringify(environment)).not.toContain("165");
  });

  it.each([
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    `${Buffer.alloc(32).toString("base64")}=`,
    Buffer.alloc(32).toString("base64url"),
    "not-base64",
  ])("rejects a malformed background credential HMAC key", (value) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      BACKGROUND_CREDENTIAL_HMAC_KEY_V1: value,
      NODE_ENV: "production",
    });

    expect(error.invalidKeys).toEqual(["BACKGROUND_CREDENTIAL_HMAC_KEY_V1"]);
    expect(error.message).not.toContain(value);
  });

  it.each([
    "http://clerk.example.test",
    "https://user:password@clerk.example.test",
    "https://clerk.example.test/",
    "https://clerk.example.test/path",
    "https://clerk.example.test?secret=value",
    "https://clerk.example.test#fragment",
  ])("rejects an unsafe production Clerk issuer origin", (value) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      CLERK_ISSUER: value,
      NODE_ENV: "production",
    });

    expect(error.invalidKeys).toEqual(["CLERK_ISSUER"]);
    expect(error.message).not.toContain(value);
  });

  it.each([
    "not-json",
    "{}",
    '"https://app.crewroll.example"',
    '["*"]',
    '["http://app.crewroll.example"]',
    '["https://user:password@app.crewroll.example"]',
    '["https://app.crewroll.example/"]',
    '["https://app.crewroll.example/path"]',
    '["https://app.crewroll.example?secret=value"]',
    '["https://app.crewroll.example#fragment"]',
    '["https://app.crewroll.example","https://app.crewroll.example"]',
    '[ "https://app.crewroll.example" ]',
  ])("rejects unsafe or non-canonical Clerk authorized parties", (value) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      CLERK_AUTHORIZED_PARTIES_JSON: value,
      NODE_ENV: "production",
    });

    expect(error.invalidKeys).toEqual(["CLERK_AUTHORIZED_PARTIES_JSON"]);
    expect(error.message).not.toContain(value);
  });

  it.each([
    ["[]", []],
    [
      '["https://app.crewroll.example","https://admin.crewroll.example:8443"]',
      ["https://app.crewroll.example", "https://admin.crewroll.example:8443"],
    ],
  ] as const)(
    "parses canonical Clerk authorized parties %s",
    (value, expected) => {
      const environment = loadEnvironment({
        ...developmentEnvironment,
        ...productionProviderEnvironment,
        CLERK_AUTHORIZED_PARTIES_JSON: value,
        NODE_ENV: "production",
      });

      expect(environment.clerkAuthorizedParties).toEqual(expected);
      expect(Object.isFrozen(environment.clerkAuthorizedParties)).toBe(true);
    },
  );

  it("ignores the retired Clerk audience input and exposes no audience seam", () => {
    const environment = loadEnvironment({
      ...developmentEnvironment,
      CLERK_AUDIENCE: "retired-audience-must-not-be-consumed",
    });

    expect(environment).not.toHaveProperty("clerkAudience");
    expect(JSON.stringify(environment)).not.toContain("retired-audience");
  });

  it.each(["not-json", "[]", '"scalar"', "null"])(
    "rejects Firebase service account JSON that is not an object",
    (value) => {
      const error = captureEnvironmentError({
        ...developmentEnvironment,
        ...productionProviderEnvironment,
        FIREBASE_SERVICE_ACCOUNT_JSON: value,
        NODE_ENV: "production",
      });

      expect(error.invalidKeys).toEqual(["FIREBASE_SERVICE_ACCOUNT_JSON"]);
      expect(error.message).not.toContain(value);
    },
  );

  it("normalizes an exact non-production browser origin list", () => {
    const environment = loadEnvironment({
      ...developmentEnvironment,
      DEBUG_CORS_ORIGINS: "https://debug.crewroll.test, http://127.0.0.1:19006",
    });

    expect(environment.debugCorsOrigins).toEqual([
      "https://debug.crewroll.test",
      "http://127.0.0.1:19006",
    ]);
  });

  it.each([
    "https://debug.crewroll.test,",
    "https://debug.crewroll.test,https://debug.crewroll.test",
    "https://user:password@debug.crewroll.test",
    "https://debug.crewroll.test/path",
    "https://debug.crewroll.test?token=secret",
    "https://debug.crewroll.test#fragment",
    "ftp://debug.crewroll.test",
  ])("rejects an unsafe debug origin list", (debugOrigins) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      DEBUG_CORS_ORIGINS: debugOrigins,
    });

    expect(error.invalidKeys).toEqual(["DEBUG_CORS_ORIGINS"]);
    expect(error.message).not.toContain(debugOrigins);
  });

  it("rejects a browser debug allowlist in production", () => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      DEBUG_CORS_ORIGINS: "https://debug.crewroll.test",
      NODE_ENV: "production",
    });

    expect(error.invalidKeys).toEqual(["DEBUG_CORS_ORIGINS"]);
  });

  it("reports only sorted unique invalid key names without secret values", () => {
    const secretCanary = "environment-secret-canary-5ea179";
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      DATABASE_URL: `mysql://${secretCanary}@database.example.test/crewroll`,
      DEBUG_CORS_ORIGINS: `https://${secretCanary}@debug.crewroll.test/path`,
      PORT: secretCanary,
    });

    expect(error.invalidKeys).toEqual([
      "DATABASE_URL",
      "DEBUG_CORS_ORIGINS",
      "PORT",
    ]);
    expect(error.message).toBe(
      "Invalid environment keys: DATABASE_URL, DEBUG_CORS_ORIGINS, PORT",
    );
    expect(error.message).not.toContain(secretCanary);
  });

  it("reports only sorted production key names when provider secrets are malformed", () => {
    const secretCanary = "provider-secret-canary-927ef1";
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      BACKGROUND_CREDENTIAL_HMAC_KEY_V1: secretCanary,
      CLERK_AUTHORIZED_PARTIES_JSON: `["https://${secretCanary}.example"]`,
      CLERK_ISSUER: `https://${secretCanary}.example/path`,
      CLERK_WEBHOOK_SECRET: secretCanary,
      KMS_PUSH_TOKEN_KEY_ID: "",
      NODE_ENV: "production",
    });

    expect(error.invalidKeys).toEqual([
      "BACKGROUND_CREDENTIAL_HMAC_KEY_V1",
      "CLERK_AUTHORIZED_PARTIES_JSON",
      "CLERK_ISSUER",
      "KMS_PUSH_TOKEN_KEY_ID",
    ]);
    expect(error.message).not.toContain(secretCanary);
    expect(JSON.stringify(error)).not.toContain(secretCanary);
  });
});
