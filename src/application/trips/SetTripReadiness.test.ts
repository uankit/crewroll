import {
  ProblemCodeSchema,
  type ProblemCode,
  type TripResponse,
} from "@crewroll/contracts";

import type { TripView } from "../../domain/trips/model";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import type {
  AcceptedTripMutationResponsePort,
  TripApiPort,
  TripMutationJournalPort,
  TripMutationJournalRecord,
} from "./ports";
import { createSetTripReadiness } from "./SetTripReadiness";

const tripId = "0191a203-227b-7011-9213-141516171819";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
const scope = { clerkSubject: "user_crewroll", deviceId };

function response(fullPhotoLibraryAccess = true): TripResponse {
  return {
    id: tripId,
    version: 2,
    name: "Ladakh",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: deviceId,
    currentMembershipId: membershipId,
    keyEpoch: 1,
    tripKeyEnvelope: null,
    members: [
      {
        membershipId,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess },
        nominatedDevice: {
          deviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
          e2eeKeyVersion: 1,
        },
      },
    ],
  };
}

function harness() {
  const events: string[] = [];
  const api = {
    getTrip: jest.fn(),
    setTripReadiness: jest.fn(async () => {
      events.push("api");
      return response();
    }),
  } as unknown as jest.Mocked<TripApiPort>;
  const journal = {
    save: jest.fn(async (_scope, _record) => void events.push("save")),
    load: jest.fn(async (_scope) => null as TripMutationJournalRecord | null),
    clear: jest.fn(async (_scope, _commandId) => void events.push("clear")),
  } satisfies jest.Mocked<TripMutationJournalPort>;
  const afterAccepted = {
    afterAccepted: jest.fn(async (_input) => void events.push("cut")),
  } satisfies jest.Mocked<AcceptedTripMutationResponsePort>;
  const service = createSetTripReadiness({
    afterAccepted,
    api,
    deviceId,
    journal,
    random: {
      getBytes: async () => Uint8Array.from({ length: 16 }, (_, i) => i),
    },
    scope,
  });
  return { afterAccepted, api, events, journal, service };
}

describe("SetTripReadiness", () => {
  it("exhaustively applies canonical server disposition to publish and replay", async () => {
    const terminal = new Set<ProblemCode>([
      "AUTH_REQUIRED",
      "AUTH_INVALID",
      "DEVICE_NOT_OWNED",
      "DEVICE_REVOKED",
      "DEVICE_NOT_PARTICIPANT",
      "IDEMPOTENCY_CONFLICT",
      "INVALID_REQUEST",
      "RATE_LIMITED",
      "MEMBERSHIP_FROZEN",
      "NOT_FOUND",
      "CONFLICT",
    ]);
    const codes = ProblemCodeSchema.anyOf.map((candidate) => candidate.const);
    for (const code of codes) {
      for (const replay of [false, true]) {
        const { api, journal, service } = harness();
        if (replay) {
          journal.load.mockResolvedValue({
            version: 1,
            kind: "SET_READINESS",
            tripId,
            commandId,
            body: { fullPhotoLibraryAccess: true },
          });
        }
        api.setTripReadiness.mockRejectedValueOnce(
          new CrewRollApiProblem(code, { status: 409 }),
        );
        const result = replay
          ? service.replayPendingMutation()
          : service.publish(tripId, true);
        await expect(result).rejects.toMatchObject({ code });
        expect(journal.clear).toHaveBeenCalledTimes(terminal.has(code) ? 1 : 0);
      }
    }
  });
  it("saves before mutation, validates before cut, then compare-clears", async () => {
    const { afterAccepted, api, events, journal, service } = harness();
    const view = await service.publish(tripId, true);
    expect(view).toMatchObject<Partial<TripView>>({ id: tripId, version: 2 });
    expect(api.setTripReadiness).toHaveBeenCalledWith(
      deviceId,
      commandId,
      tripId,
      { fullPhotoLibraryAccess: true },
    );
    expect(journal.save).toHaveBeenCalledWith(scope, {
      version: 1,
      kind: "SET_READINESS",
      tripId,
      commandId,
      body: { fullPhotoLibraryAccess: true },
    });
    expect(afterAccepted.afterAccepted).toHaveBeenCalledWith({
      kind: "SET_READINESS",
      commandId,
    });
    expect(journal.clear).toHaveBeenCalledWith(scope, commandId);
    expect(events).toEqual(["save", "api", "cut", "clear"]);
  });

  it("replays an exact retained command without new randomness or GET", async () => {
    const { api, journal, service } = harness();
    journal.load.mockResolvedValue({
      version: 1,
      kind: "SET_READINESS",
      tripId,
      commandId,
      body: { fullPhotoLibraryAccess: true },
    });
    await service.replayPendingMutation();
    expect(api.setTripReadiness).toHaveBeenCalledWith(
      deviceId,
      commandId,
      tripId,
      { fullPhotoLibraryAccess: true },
    );
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(journal.save).not.toHaveBeenCalled();
  });

  it("does not cut or clear a malformed accepted response", async () => {
    const { afterAccepted, api, journal, service } = harness();
    api.setTripReadiness.mockResolvedValue({
      ...response(),
      privateProviderField: "secret",
    } as TripResponse);
    await expect(service.publish(tripId, true)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(afterAccepted.afterAccepted).not.toHaveBeenCalled();
    expect(journal.clear).not.toHaveBeenCalled();
  });

  it.each([
    ["local auth absence", new CrewRollApiProblem("AUTH_REQUIRED"), false],
    [
      "terminal server auth",
      new CrewRollApiProblem("AUTH_REQUIRED", { status: 401 }),
      true,
    ],
    [
      "malformed server 5xx",
      new CrewRollApiProblem("AUTH_REQUIRED", { status: 500 }),
      false,
    ],
  ] as const)(
    "handles %s without unsafe journal deletion",
    async (_label, error, clears) => {
      const { api, journal, service } = harness();
      api.setTripReadiness.mockRejectedValueOnce(error);
      await expect(service.publish(tripId, true)).rejects.toMatchObject({
        code: error.code,
      });
      expect(journal.clear).toHaveBeenCalledTimes(clears ? 1 : 0);
    },
  );

  it("retains the journal for spoofed structural server provenance", async () => {
    const { api, journal, service } = harness();
    api.setTripReadiness.mockRejectedValueOnce({
      kind: "API_PROBLEM",
      code: "AUTH_REQUIRED",
      serverStatus: 401,
    });
    await expect(service.publish(tripId, true)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(journal.clear).not.toHaveBeenCalled();
  });

  it("retains replay for an unknown problem code and malformed success", async () => {
    for (const failure of [
      new CrewRollApiProblem("FUTURE_PROBLEM" as ProblemCode, { status: 409 }),
      null,
    ]) {
      const { afterAccepted, api, journal, service } = harness();
      journal.load.mockResolvedValue({
        version: 1,
        kind: "SET_READINESS",
        tripId,
        commandId,
        body: { fullPhotoLibraryAccess: true },
      });
      if (failure === null) {
        api.setTripReadiness.mockResolvedValueOnce({
          ...response(),
          malformed: true,
        } as TripResponse);
      } else {
        api.setTripReadiness.mockRejectedValueOnce(failure);
      }
      await expect(service.replayPendingMutation()).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      expect(journal.clear).not.toHaveBeenCalled();
      expect(afterAccepted.afterAccepted).not.toHaveBeenCalled();
    }
  });
});
