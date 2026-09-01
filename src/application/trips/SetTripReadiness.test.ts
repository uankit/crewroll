import type { TripResponse } from "@crewroll/contracts";

import type { TripView } from "../../domain/trips/model";
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
});
