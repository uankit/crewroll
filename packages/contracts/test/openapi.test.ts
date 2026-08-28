import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument, serializeOpenApiDocument } from "../generator/openapi.js";

const generatedUrl = new URL("../generated/crewroll.openapi.json", import.meta.url);

describe("canonical OpenAPI artifact", () => {
  it("regenerates byte-for-byte deterministically", async () => {
    const first = serializeOpenApiDocument(createOpenApiDocument());
    const second = serializeOpenApiDocument(createOpenApiDocument());
    const committed = await readFile(fileURLToPath(generatedUrl), "utf8");
    expect(first).toBe(second);
    expect(first).toBe(committed);
  });

  it("contains only the canonical v1 routes and header variants", () => {
    const document = createOpenApiDocument();
    expect(Object.keys(document.paths)).toEqual([
      "/v1/devices",
      "/v1/devices/{deviceId}/push-token",
      "/v1/devices/{deviceId}",
      "/v1/trips",
      "/v1/trips/join-requests",
      "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
      "/v1/trips/{tripId}/join-requests/{membershipId}",
      "/v1/trips/{tripId}/start",
      "/v1/trips/{tripId}/end",
      "/v1/trips/{tripId}",
      "/v1/trips/{tripId}/reconciliation",
      "/v1/assets/upload-sessions",
      "/v1/assets/{assetId}/commit",
      "/v1/sync",
      "/v1/deliveries/{deliveryId}/download-session",
      "/v1/deliveries/{deliveryId}/saved-receipt",
    ]);
    const json = JSON.stringify(document);
    expect(json).not.toContain("X-CrewRoll-Response-Version");
    expect(json).not.toContain("/pause");
    expect(json).not.toContain("media-bytes");
  });
});
