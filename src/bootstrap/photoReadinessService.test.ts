import type { TripView } from "../domain/trips/model";
import { createPhotoReadinessService } from "./photoReadinessService";

const trip: TripView = {
  id: "01990000-0000-7000-8000-000000000001",
  version: 1,
  name: "Trip",
  status: "ACTIVE",
  release: { mode: "IMMEDIATE" },
  startsAt: null,
  endsAt: "2030-01-01T00:00:00.000Z",
  ownerDeviceId: "device",
  currentMembershipId: "member",
  members: [],
};
const full = {
  kind: "FULL" as const,
  fullPhotoLibraryAccess: true as const,
  canAskAgain: true,
};
function setup() {
  const photoPermission = {
    read: jest.fn(async () => full),
    request: jest.fn(async () => full),
    openSettings: jest.fn(),
  };
  const hydrate = jest.fn(async () => trip);
  const reconcile = jest.fn(async (current: TripView) => current);
  return {
    photoPermission,
    hydrate,
    reconcile,
    check: createPhotoReadinessService({ photoPermission, hydrate, reconcile }),
  };
}

it("rechecks the OS locally using the known trip without a trip fetch or a prompt", async () => {
  const { check, photoPermission, hydrate } = setup();
  const onPermission = jest.fn();
  await expect(
    check(trip.id, false, { knownTrip: trip, onPermission }),
  ).resolves.toEqual({ trip, permission: full });
  await check(trip.id, false, { knownTrip: trip });
  expect(photoPermission.read).toHaveBeenCalledTimes(2);
  expect(photoPermission.request).not.toHaveBeenCalled();
  expect(hydrate).not.toHaveBeenCalled();
  expect(onPermission).toHaveBeenCalledWith(full);
});

it("publishes the local permission even when the subsequent server refresh is offline", async () => {
  const { check, hydrate } = setup();
  const onPermission = jest.fn();
  hydrate.mockImplementationOnce(async () => {
    expect(onPermission).toHaveBeenCalledWith(full);
    throw new Error("offline");
  });
  await expect(check(trip.id, false, { onPermission })).rejects.toThrow(
    "offline",
  );
});

it("reuses granted photo access for a new trip without requesting it again", async () => {
  const { check, hydrate, photoPermission, reconcile } = setup();
  const nextTrip = { ...trip, id: "01990000-0000-7000-8000-000000000002" };
  hydrate.mockResolvedValue(nextTrip);
  await expect(check(nextTrip.id, false, { knownTrip: trip })).resolves.toEqual(
    { trip: nextTrip, permission: full },
  );
  expect(photoPermission.read).toHaveBeenCalledTimes(1);
  expect(photoPermission.request).not.toHaveBeenCalled();
  expect(reconcile).toHaveBeenCalledWith(nextTrip, true);
});

it("does not reuse another trip and requests permission only for an explicit action", async () => {
  const { check, hydrate, photoPermission } = setup();
  await check(trip.id, true, { knownTrip: { ...trip, id: "other-trip" } });
  expect(hydrate).toHaveBeenCalledWith(trip.id);
  expect(photoPermission.request).toHaveBeenCalledTimes(1);
  expect(photoPermission.read).not.toHaveBeenCalled();
});

it("stops before publishing readiness when the session rejects a stale local result", async () => {
  const { check, hydrate, reconcile } = setup();
  await expect(
    check(trip.id, false, {
      knownTrip: trip,
      onPermission() {
        throw new Error("session changed");
      },
    }),
  ).rejects.toThrow("session changed");
  expect(hydrate).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
});
