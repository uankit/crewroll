import { describe, expect, it } from "vitest";
import {
  parsePushConfiguration,
  resolvePushDispatchConfiguration,
} from "../../src/config/pushConfiguration.js";

describe("explicit push configuration", () => {
  it("supports platform-by-platform rollout with an explicit APNs environment", () => {
    const apns = {
      bundleId: "app.crewroll.mobile",
      keyId: "APPLEKEY01",
      teamId: "TEAMID1234",
      privateKey: "private-key-placeholder",
      environment: "production",
    };
    expect(parsePushConfiguration(JSON.stringify({ apns }))).toEqual({ apns });
    expect(
      parsePushConfiguration(
        JSON.stringify({ apns: { ...apns, environment: "guess" } }),
      ),
    ).toBeNull();
    const missing: Record<string, unknown> = { ...apns };
    delete missing.environment;
    expect(
      parsePushConfiguration(JSON.stringify({ apns: missing })),
    ).toBeNull();
  });
  it("fails closed without throwing credential values for malformed, empty or oversized input", () => {
    for (const value of [
      undefined,
      "",
      "secret-bad-json",
      "{}",
      "[]",
      JSON.stringify({ unknown: "secret" }),
      "x".repeat(65_537),
    ])
      expect(parsePushConfiguration(value)).toBeNull();
  });

  it("keeps disabled rollout usable without credentials and fails closed when enabled", () => {
    for (const enabled of [undefined, "false", "TRUE", "1"])
      expect(resolvePushDispatchConfiguration(enabled, undefined)).toEqual({
        kind: "DISABLED",
      });
    for (const credentials of [undefined, "", "secret-malformed-json", "{}"])
      expect(resolvePushDispatchConfiguration("true", credentials)).toEqual({
        kind: "MISSING",
      });
    const credentials = JSON.stringify({
      firebaseServiceAccountJson: "service-account-placeholder",
    });
    expect(resolvePushDispatchConfiguration("false", credentials)).toEqual({
      kind: "DISABLED",
    });
    expect(resolvePushDispatchConfiguration("true", credentials)).toEqual({
      kind: "READY",
      configuration: {
        firebaseServiceAccountJson: "service-account-placeholder",
      },
    });
  });
});
