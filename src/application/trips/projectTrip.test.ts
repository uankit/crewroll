import type { TripResponse } from "@crewroll/contracts";

import { startBlockerFor } from "../../domain/trips/startEligibility";
import { projectTrip } from "./projectTrip";

const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const ownerMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const memberMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
const ownerDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const memberDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160";
const privateKeyMaterial = "private-wrapped-key-material";
const privatePublicKey = "private-public-key-material";

function nominatedDevice(deviceId: string) {
  return {
    deviceId,
    e2eeKeyAlgorithm: "X25519" as const,
    e2eePublicKey: privatePublicKey,
    e2eeKeyVersion: 1 as const,
  };
}

function ownerResponse(): TripResponse {
  return {
    id: tripId,
    version: 3,
    name: "Weekend",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId,
    currentMembershipId: ownerMembershipId,
    keyEpoch: 1,
    tripKeyEnvelope: {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: privateKeyMaterial,
    },
    members: [
      {
        membershipId: ownerMembershipId,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess: true },
        nominatedDevice: nominatedDevice(ownerDeviceId),
      },
      {
        membershipId: memberMembershipId,
        role: "MEMBER",
        displayName: "Member",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess: true },
        nominatedDevice: nominatedDevice(memberDeviceId),
      },
    ],
  };
}

function memberResponse(): TripResponse {
  const response = ownerResponse();
  response.currentMembershipId = memberMembershipId;
  response.tripKeyEnvelope = null;
  response.members[0]!.nominatedDevice = null;
  return response;
}

describe("trip projection", () => {
  it("copies only the explicit safe trip and member fields", () => {
    const response = ownerResponse() as TripResponse & {
      commandId: string;
      inviteCode: string;
      privateMetadata: { requestId: string };
    };
    response.commandId = "private-command";
    response.inviteCode = "PRIVATE1";
    response.privateMetadata = { requestId: "private-request" };
    Object.assign(response.release, { privateScheduleMetadata: "private" });
    Object.assign(response.members[0]!, {
      wrappedKey: "private-member-wrapped-key",
      privateMemberMetadata: "private-member",
    });

    const view = projectTrip(response, ownerDeviceId);

    expect(view).toEqual({
      id: tripId,
      version: 3,
      name: "Weekend",
      status: "LOBBY",
      release: { mode: "IMMEDIATE" },
      startsAt: null,
      endsAt: "2026-09-02T12:00:00.000Z",
      ownerDeviceId,
      currentMembershipId: ownerMembershipId,
      members: [
        {
          membershipId: ownerMembershipId,
          role: "OWNER",
          displayName: "Owner",
          status: "ACTIVE",
          fullPhotoLibraryAccess: true,
          deviceState: "AVAILABLE",
          isCurrentMember: true,
        },
        {
          membershipId: memberMembershipId,
          role: "MEMBER",
          displayName: "Member",
          status: "ACTIVE",
          fullPhotoLibraryAccess: true,
          deviceState: "AVAILABLE",
          isCurrentMember: false,
        },
      ],
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        "currentMembershipId",
        "endsAt",
        "id",
        "members",
        "name",
        "ownerDeviceId",
        "release",
        "startsAt",
        "status",
        "version",
      ].sort(),
    );
    expect(Object.keys(view.members[0]!).sort()).toEqual(
      [
        "deviceState",
        "displayName",
        "fullPhotoLibraryAccess",
        "isCurrentMember",
        "membershipId",
        "role",
        "status",
      ].sort(),
    );
    expect(JSON.stringify(view)).not.toMatch(
      /tripKeyEnvelope|wrappedKey|keyEpoch|e2ee|inviteCode|commandId|private/i,
    );
  });

  it("does not mislabel another member's redacted device as missing", () => {
    const view = projectTrip(memberResponse(), memberDeviceId);

    expect(
      view.members.find((member) => member.role === "OWNER")?.deviceState,
    ).toBe("NOT_DISCLOSED");
    expect(
      view.members.find((member) => member.isCurrentMember)?.deviceState,
    ).toBe("AVAILABLE");
    expect(startBlockerFor(view)).toBe("OWNER_ONLY");
  });

  it("labels the non-owner caller's own null nomination as missing", () => {
    const response = memberResponse();
    response.members[1]!.nominatedDevice = null;

    const view = projectTrip(response, memberDeviceId);

    expect(view.members[0]!.deviceState).toBe("NOT_DISCLOSED");
    expect(view.members[1]!.deviceState).toBe("MISSING");
  });

  it("labels every owner-visible null nomination as missing", () => {
    const response = ownerResponse();
    response.members[0]!.nominatedDevice = null;
    response.members[1]!.nominatedDevice = null;

    expect(
      projectTrip(response, ownerDeviceId).members.map(
        (member) => member.deviceState,
      ),
    ).toEqual(["MISSING", "MISSING"]);
  });

  it("resolves caller authority by currentMembershipId rather than device fields", () => {
    const response = memberResponse();
    response.ownerDeviceId = memberDeviceId;
    response.members[0]!.nominatedDevice = null;

    const view = projectTrip(response, memberDeviceId);

    expect(view.members[0]!.deviceState).toBe("NOT_DISCLOSED");
    expect(startBlockerFor(view)).toBe("OWNER_ONLY");
  });

  it("rejects an unresolved current membership", () => {
    const response = ownerResponse();
    response.currentMembershipId = "missing-membership";

    expect(() => projectTrip(response, ownerDeviceId)).toThrow(
      "Trip response does not contain the current membership.",
    );
  });

  it("rejects a self-disclosed nomination for a different local device", () => {
    expect(() => projectTrip(ownerResponse(), memberDeviceId)).toThrow(
      "Trip response nominates a different current device.",
    );
  });

  it("rejects an empty wire member array", () => {
    const response = ownerResponse();
    response.members = [];

    expect(() => projectTrip(response, ownerDeviceId)).toThrow(
      "Trip response requires at least one member.",
    );
  });

  it("copies the complete Nightly release branch without retaining wire aliases", () => {
    const response = ownerResponse();
    response.release = {
      mode: "NIGHTLY",
      timeZone: "Asia/Kolkata",
      localTime: "22:30",
    };

    const view = projectTrip(response, ownerDeviceId);
    response.name = "Changed";
    response.release.timeZone = "Europe/Paris";
    response.members[0]!.displayName = "Changed owner";
    response.members.push({
      membershipId: "late-member",
      role: "MEMBER",
      displayName: "Late member",
      status: "ACTIVE",
      readiness: { fullPhotoLibraryAccess: true },
      nominatedDevice: nominatedDevice("late-device"),
    });

    expect(view.name).toBe("Weekend");
    expect(view.release).toEqual({
      mode: "NIGHTLY",
      timeZone: "Asia/Kolkata",
      localTime: "22:30",
    });
    expect(view.members.map((member) => member.displayName)).toEqual([
      "Owner",
      "Member",
    ]);
  });
});
