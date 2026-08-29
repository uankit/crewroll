import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  CreateTripBodySchema,
  DateTimeSchema,
  installCrewRollFormats,
} from "@crewroll/contracts";
import { validImmediateTripBody } from "@crewroll/contracts/fixtures/http";

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
