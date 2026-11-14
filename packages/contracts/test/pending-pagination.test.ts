import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PendingDeliveriesQuerySchema,
  PendingDeliveriesResponseSchema,
} from "../openapi/index.js";

const tripId = "01990000-0000-7000-8000-000000000001";

describe("bounded pending-original pagination contract", () => {
  it("retains the legacy empty query and items-only response", () => {
    expect(Value.Check(PendingDeliveriesQuerySchema, {})).toBe(true);
    expect(Value.Check(PendingDeliveriesResponseSchema, { items: [] })).toBe(
      true,
    );
  });

  it("accepts trip-scoped head and continuation queries", () => {
    expect(Value.Check(PendingDeliveriesQuerySchema, { tripId })).toBe(true);
    expect(
      Value.Check(PendingDeliveriesQuerySchema, { tripId, after: "A_0-z" }),
    ).toBe(true);
    expect(
      Value.Check(PendingDeliveriesResponseSchema, {
        items: [],
        nextCursor: null,
        hasMore: false,
      }),
    ).toBe(true);
  });

  it.each([
    { after: "abc" },
    { tripId: "not-a-trip" },
    { tripId, after: "" },
    { tripId, after: "A".repeat(513) },
    { tripId, after: "abc=" },
    { tripId, after: "abc/def" },
    { tripId, after: 123 },
    { tripId, extra: true },
  ])("rejects unscoped, malformed or open queries %#", (query) => {
    expect(Value.Check(PendingDeliveriesQuerySchema, query)).toBe(false);
  });

  it("rejects unbounded or malformed response continuations", () => {
    for (const fields of [
      { nextCursor: "A".repeat(513), hasMore: true },
      { nextCursor: "abc=", hasMore: true },
      { nextCursor: null, hasMore: "false" },
      { nextCursor: null, hasMore: false, extra: true },
    ])
      expect(
        Value.Check(PendingDeliveriesResponseSchema, { items: [], ...fields }),
      ).toBe(false);
  });
});
