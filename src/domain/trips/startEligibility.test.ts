import type { MemberView, StartBlocker, TripView } from "./model";
import { memberStatuses, startBlockerFor } from "./startEligibility";

function member(overrides: Partial<MemberView> = {}): MemberView {
  return {
    membershipId: "owner-membership",
    role: "OWNER",
    displayName: "Owner",
    status: "ACTIVE",
    fullPhotoLibraryAccess: true,
    deviceState: "AVAILABLE",
    isCurrentMember: true,
    ...overrides,
  };
}

function trip(overrides: Partial<TripView> = {}): TripView {
  return {
    id: "trip-id",
    version: 3,
    name: "Weekend",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: "owner-device",
    currentMembershipId: "owner-membership",
    members: [member()],
    ...overrides,
  };
}

describe("trip Start eligibility", () => {
  it("models only the two statuses admitted by TripResponse members", () => {
    expect(memberStatuses).toEqual(["ACTIVE", "PENDING_KEY"]);
  });

  it("rejects an empty member projection", () => {
    expect(() => startBlockerFor(trip({ members: [] }))).toThrow(
      "Trip view requires at least one member.",
    );
  });

  it("returns OWNER_ONLY before inspecting trip or member state", () => {
    expect(
      startBlockerFor(
        trip({
          status: "ACTIVE",
          currentMembershipId: "member-membership",
          members: [
            member({
              isCurrentMember: false,
              deviceState: "NOT_DISCLOSED",
            }),
            member({
              membershipId: "member-membership",
              role: "MEMBER",
              displayName: "Member",
              status: "PENDING_KEY",
              fullPhotoLibraryAccess: false,
              deviceState: "MISSING",
              isCurrentMember: true,
            }),
          ],
        }),
      ),
    ).toBe("OWNER_ONLY");
  });

  it.each<readonly [TripView["status"], StartBlocker]>([
    ["ACTIVE", "NOT_LOBBY"],
    ["ENDING", "NOT_LOBBY"],
    ["COMPLETE", "NOT_LOBBY"],
    ["INCOMPLETE_EXPIRED", "NOT_LOBBY"],
    ["CANCELLED", "NOT_LOBBY"],
  ])("blocks Start when trip status is %s", (status, expected) => {
    expect(
      startBlockerFor(
        trip({
          status,
          members: [
            member({
              status: "PENDING_KEY",
              fullPhotoLibraryAccess: false,
              deviceState: "MISSING",
            }),
          ],
        }),
      ),
    ).toBe(expected);
  });

  it.each<
    readonly [
      MemberView["status"],
      boolean,
      MemberView["deviceState"],
      StartBlocker,
    ]
  >([
    ["PENDING_KEY", false, "MISSING", "MEMBER_PENDING_KEY"],
    ["ACTIVE", false, "MISSING", "MEMBER_NEEDS_FULL_ACCESS"],
    ["ACTIVE", true, "MISSING", "MEMBER_DEVICE_MISSING"],
    ["ACTIVE", true, "NOT_DISCLOSED", "MEMBER_DEVICE_MISSING"],
  ])(
    "blocks Start for %s/readiness %s/device %s",
    (status, fullPhotoLibraryAccess, deviceState, expected) => {
      expect(
        startBlockerFor(
          trip({
            members: [member({ status, fullPhotoLibraryAccess, deviceState })],
          }),
        ),
      ).toBe(expected);
    },
  );

  it.each<
    readonly [
      MemberView["status"],
      boolean,
      MemberView["deviceState"],
      StartBlocker,
    ]
  >([
    ["PENDING_KEY", false, "MISSING", "MEMBER_PENDING_KEY"],
    ["ACTIVE", false, "MISSING", "MEMBER_NEEDS_FULL_ACCESS"],
    ["ACTIVE", true, "MISSING", "MEMBER_DEVICE_MISSING"],
  ])(
    "checks every participant for %s/readiness %s/device %s",
    (status, fullPhotoLibraryAccess, deviceState, expected) => {
      expect(
        startBlockerFor(
          trip({
            members: [
              member(),
              member({
                membershipId: "member-membership",
                role: "MEMBER",
                displayName: "Member",
                status,
                fullPhotoLibraryAccess,
                deviceState,
                isCurrentMember: false,
              }),
            ],
          }),
        ),
      ).toBe(expected);
    },
  );

  it("returns no blocker for a valid two-member Immediate lobby", () => {
    expect(
      startBlockerFor(
        trip({
          members: [
            member(),
            member({
              membershipId: "member-membership",
              role: "MEMBER",
              displayName: "Member",
              isCurrentMember: false,
            }),
          ],
        }),
      ),
    ).toBeNull();
  });
});
