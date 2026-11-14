import { describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  PushSyncHintSchema,
  installCrewRollFormats,
} from "../openapi/index.js";

installCrewRollFormats(FormatRegistry);
const hint = {
  type: "crewroll.sync.v1",
  deviceId: "01990000-0000-7000-8000-000000000001",
  tripId: "01990000-0000-7000-8000-000000000002",
  eventId: "01990000-0000-7000-8000-000000000003",
};
describe("closed push wake hint", () => {
  it("accepts only the versioned opaque routing identifiers", () => {
    expect(Value.Check(PushSyncHintSchema, hint)).toBe(true);
    for (const key of Object.keys(hint)) {
      const missing: Record<string, unknown> = { ...hint };
      delete missing[key];
      expect(Value.Check(PushSyncHintSchema, missing)).toBe(false);
      expect(
        Value.Check(PushSyncHintSchema, { ...hint, [key]: "invalid" }),
      ).toBe(false);
    }
    for (const key of ["url", "photo", "token", "name", "userId"])
      expect(
        Value.Check(PushSyncHintSchema, { ...hint, [key]: "private" }),
      ).toBe(false);
  });
});
