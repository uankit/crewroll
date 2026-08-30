import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  CreateTripBodySchema,
  CreateTripOutcomeBodySchema,
  CreateTripOutcomeResponseSchema,
  DateTimeSchema,
  DeviceRegistrationHeadersSchema,
  DeviceResponseSchema,
  MobileCommandHeadersSchema,
  RegisterDeviceBodySchema,
  TripResponseSchema,
  UpdatePushTokenBodySchema,
  installCrewRollFormats,
} from "@crewroll/contracts";
import {
  validClerkCommandHeaders,
  validImmediateTripBody,
  validRegisterDeviceBody,
  validRegistrationHeaders,
  validTripResponse,
  validUpdatePushTokenBody,
} from "@crewroll/contracts/fixtures/http";

import { controlPlaneWorkspace } from "../src/index.js";

const LEAP_DAY = "2028-02-29T12:00:00.000Z";

describe("compiled CrewRoll contracts in the control-plane TypeBox instance", () => {
  it("installs contract formats at composition so Value and TypeCompiler accept valid input", () => {
    expect(controlPlaneWorkspace.apiVersion).toBe("v1");
    const validTrip = { ...validImmediateTripBody(), endsAt: LEAP_DAY };

    expect(Value.Check(DateTimeSchema, LEAP_DAY)).toBe(true);
    expect(Value.Check(CreateTripBodySchema, validTrip)).toBe(true);
    expect(TypeCompiler.Compile(DateTimeSchema).Check(LEAP_DAY)).toBe(true);
    expect(TypeCompiler.Compile(CreateTripBodySchema).Check(validTrip)).toBe(
      true,
    );
  });

  it("compiles the complete API-002 bootstrap surface from shared contracts", () => {
    const cases = [
      [DeviceRegistrationHeadersSchema, validRegistrationHeaders()],
      [MobileCommandHeadersSchema, validClerkCommandHeaders()],
      [RegisterDeviceBodySchema, validRegisterDeviceBody()],
      [
        DeviceResponseSchema,
        {
          backgroundBearer: `crb_${"A".repeat(43)}`,
          backgroundBearerExpiresAt: "2026-09-29T12:00:00.000Z",
          deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
        },
      ],
      [UpdatePushTokenBodySchema, validUpdatePushTokenBody()],
    ] as const;

    for (const [schema, fixture] of cases) {
      expect(Value.Check(schema, fixture)).toBe(true);
      expect(TypeCompiler.Compile(schema).Check(fixture)).toBe(true);
    }
  });

  it("compiles the authoritative create outcome and preserves Unicode code-point name limits", () => {
    const trip = validImmediateTripBody();
    const outcomeBody = { tripId: trip.tripId };
    const committed = {
      outcome: "COMMITTED",
      trip: validTripResponse(),
    } as const;
    const bodyCompiler = TypeCompiler.Compile(CreateTripOutcomeBodySchema);
    const createTripCompiler = TypeCompiler.Compile(CreateTripBodySchema);
    const responseCompiler = TypeCompiler.Compile(
      CreateTripOutcomeResponseSchema,
    );

    expect(bodyCompiler.Check(outcomeBody)).toBe(true);
    expect(responseCompiler.Check(committed)).toBe(true);
    expect(responseCompiler.Check({ outcome: "TERMINAL_NOT_COMMITTED" })).toBe(
      true,
    );
    expect(responseCompiler.Check({ outcome: "STILL_UNKNOWN" })).toBe(true);
    expect(
      Value.Check(CreateTripBodySchema, { ...trip, name: "🛶".repeat(80) }),
    ).toBe(true);
    expect(createTripCompiler.Check({ ...trip, name: "🛶".repeat(80) })).toBe(
      true,
    );
    expect(
      Value.Check(CreateTripBodySchema, { ...trip, name: "🛶".repeat(81) }),
    ).toBe(false);
    expect(createTripCompiler.Check({ ...trip, name: "🛶".repeat(81) })).toBe(
      false,
    );
  });

  it("compiles identical Unicode name limits for direct and committed trip responses", () => {
    const trip = validTripResponse();
    const responseCompiler = TypeCompiler.Compile(TripResponseSchema);
    const outcomeCompiler = TypeCompiler.Compile(
      CreateTripOutcomeResponseSchema,
    );
    const cases = [
      [responseCompiler, (name: string) => ({ ...trip, name })],
      [
        outcomeCompiler,
        (name: string) => ({
          outcome: "COMMITTED",
          trip: { ...trip, name },
        }),
      ],
    ] as const;

    for (const [compiler, project] of cases) {
      expect(compiler.Check(project("🛶".repeat(80)))).toBe(true);
      expect(compiler.Check(project(`${"a".repeat(79)}🛶`))).toBe(true);
      expect(compiler.Check(project("🛶".repeat(81)))).toBe(false);
      expect(compiler.Check(project("\uD800"))).toBe(false);
      expect(compiler.Check(project("\uDC00"))).toBe(false);
    }
  });

  it("exposes an idempotent installer with the complete semantic format set", () => {
    const installed = new Map<string, (value: string) => boolean>();
    let writes = 0;
    const registry = {
      Get(name: string) {
        return installed.get(name);
      },
      Set(name: string, validator: (value: string) => boolean) {
        writes += 1;
        installed.set(name, validator);
      },
    };

    installCrewRollFormats(registry);
    const firstEntries = new Map(installed);
    installCrewRollFormats(registry);

    expect(writes).toBe(6);
    expect(installed).toEqual(firstEntries);
    expect(installed.get("date-time")?.(LEAP_DAY)).toBe(true);
    expect(installed.get("date-time")?.("2028-02-30T12:00:00.000Z")).toBe(
      false,
    );
    expect(
      installed.get("uuid")?.("018f0d98-76fa-7d1a-b4b4-1f742c2e3120"),
    ).toBe(true);
    expect(installed.get("uuid")?.("not-a-uuid")).toBe(false);
    expect(installed.get("uri")?.("https://api.crewroll.example/v1")).toBe(
      true,
    );
    expect(installed.get("uri")?.("not a uri")).toBe(false);
    expect(installed.get("iana-time-zone")?.("Asia/Kolkata")).toBe(true);
    expect(installed.get("iana-time-zone")?.("Mars/Olympus")).toBe(false);
    expect(installed.get("opaque-cursor")?.("cursor_1234")).toBe(true);
    expect(installed.get("opaque-cursor")?.("bad cursor")).toBe(false);
    expect(
      installed.get("opaque-source-asset-key")?.(
        "src_01J6D4M4KB8J8G3AZXJ3PZV1Z9XY",
      ),
    ).toBe(true);
    expect(
      installed.get("opaque-source-asset-key")?.("file:///photo.jpg"),
    ).toBe(false);
  });
});
