import type { CreateTripBody, StartTripBody } from "@crewroll/contracts";
import type { Client } from "openapi-fetch";

import type { MobilePaths } from "./generated";

function assertGeneratedClientContract(
  client: Client<MobilePaths>,
  deviceId: string,
  commandId: string,
  tripId: string,
  createBody: CreateTripBody,
  startBody: StartTripBody,
) {
  void client.POST("/v1/trips", {
    body: createBody,
    params: {
      header: {
        "Idempotency-Key": commandId,
        "X-CrewRoll-Device-Id": deviceId,
      },
    },
  });
  void client.GET("/v1/trips/{tripId}", {
    params: {
      header: { "X-CrewRoll-Device-Id": deviceId },
      path: { tripId },
    },
  });

  void client.GET(
    // @ts-expect-error Generated GET paths must reject POST-only paths.
    "/v1/trips/create-outcome",
    { params: { header: { "X-CrewRoll-Device-Id": deviceId } } },
  );
  void client.GET(
    "/v1/trips/{tripId}",
    // @ts-expect-error tripId is a required generated path parameter.
    { params: { header: { "X-CrewRoll-Device-Id": deviceId } } },
  );
  void client.POST("/v1/trips/{tripId}/start", {
    body: startBody,
    params: {
      // @ts-expect-error Both exact command headers are required.
      header: { "X-CrewRoll-Device-Id": deviceId },
      path: { tripId },
    },
  });
}

void assertGeneratedClientContract;
