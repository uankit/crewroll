import { describe, expect, it } from "vitest";

import {
  approveTripRequestFingerprint,
  createTripRequestFingerprint,
  joinTripRequestFingerprint,
  readinessTripRequestFingerprint,
  rejectTripRequestFingerprint,
  startTripRequestFingerprint,
} from "../../src/modules/trips/requestFingerprint.js";
import {
  canonicalTripName,
  normalizeInviteCode,
  validateTripRelease,
  validateTripWindow,
} from "../../src/modules/trips/tripPolicy.js";
import type {
  CanonicalTripName,
  CreateTripFingerprintInput,
  NormalizedInviteCode,
  TripPolicyResult,
  ValidatedTripRelease,
} from "../../src/modules/trips/types.js";

const TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const OTHER_TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3131";
const DEVICE_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const OTHER_DEVICE_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3121";
const MEMBERSHIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const OTHER_MEMBERSHIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3141";
const NOW = new Date("2026-08-30T12:00:00.000Z");

function valueOf<Value>(result: TripPolicyResult<Value>): Value {
  if (!result.ok)
    throw new Error(`Unexpected policy problem: ${result.problem.code}`);
  return result.value;
}

function hex(value: Readonly<Uint8Array>): string {
  return Buffer.from(value).toString("hex");
}

function changedByte(length: number, fill: number, index = 0): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  bytes[index] = bytes[index]! ^ 0xff;
  return bytes;
}

function expectDistinct(
  baseline: Readonly<Uint8Array>,
  variants: readonly Readonly<Uint8Array>[],
): void {
  expect(baseline).toHaveLength(32);
  for (const variant of variants) {
    expect(variant).toHaveLength(32);
    expect(hex(variant)).not.toBe(hex(baseline));
  }
}

function baseCreate(): CreateTripFingerprintInput {
  return {
    canonicalTripName: valueOf(canonicalTripName("Trip")),
    endsAt: valueOf(
      validateTripWindow({
        authoritativeNow: NOW,
        endsAt: new Date("2026-09-02T12:00:00.000Z"),
      }),
    ).endsAt,
    inviteCodeHmac: new Uint8Array(32).fill(0x11),
    ownerDeviceId: DEVICE_ID,
    ownerKeyEnvelope: new Uint8Array(148).fill(0x22),
    release: valueOf(
      validateTripRelease({
        localTime: "21:30",
        mode: "NIGHTLY",
        timeZone: "Asia/Kolkata",
      }),
    ),
    tripId: TRIP_ID,
  };
}

describe("Trip command request fingerprints", () => {
  it("pins every versioned length-framed command tuple", () => {
    expect({
      approve: hex(
        approveTripRequestFingerprint({
          algorithmVersion: 1,
          keyEpoch: 1,
          membershipId: MEMBERSHIP_ID,
          tripId: TRIP_ID,
          wrappedKey: new Uint8Array(148).fill(0x41),
        }),
      ),
      create: hex(createTripRequestFingerprint(baseCreate())),
      join: hex(
        joinTripRequestFingerprint({
          deviceId: DEVICE_ID,
          inviteCodeHmac: new Uint8Array(32).fill(0x31),
        }),
      ),
      readiness: hex(
        readinessTripRequestFingerprint({
          fullPhotoLibraryAccess: false,
          tripId: TRIP_ID,
        }),
      ),
      reject: hex(
        rejectTripRequestFingerprint({
          membershipId: MEMBERSHIP_ID,
          tripId: TRIP_ID,
        }),
      ),
      start: hex(
        startTripRequestFingerprint({ expectedVersion: 7, tripId: TRIP_ID }),
      ),
    }).toEqual({
      approve:
        "c1d661243f030a679ce4f8d6731e58f845b726cdfbb98729a6a6f064cff2cfd5",
      create:
        "afe55f5ad8f26b85f2a362294ebe113151c790bfef94d3d9ff1c2c2e702d4636",
      join: "a3cf51b306f0a48b708b427f253d2960a53c3bf61686b3d1047bf47af0d856b6",
      readiness:
        "b51065f478904132e13408dc0f6614d66258feab7d8c19383d378f33ca288676",
      reject:
        "4884216d29be718664088722633ed25e91eaafb7af59d2d2e0a9be77ce9acbcb",
      start: "5a58bc975dab2c1fe7e57098ee0fbfa6994ad2f79287523b83b7959819b95f1c",
    });
  });

  it("frames every create semantic field independently", () => {
    const input = baseCreate();
    const baseline = createTripRequestFingerprint(input);
    const alternateRelease = valueOf(
      validateTripRelease({
        localTime: "21:30",
        mode: "NIGHTLY",
        timeZone: "Asia/Tokyo",
      }),
    );
    const alternateLocalTime = valueOf(
      validateTripRelease({
        localTime: "21:31",
        mode: "NIGHTLY",
        timeZone: "Asia/Kolkata",
      }),
    );
    const alternateEndsAt = valueOf(
      validateTripWindow({
        authoritativeNow: NOW,
        endsAt: new Date(input.endsAt.getTime() + 1),
      }),
    ).endsAt;

    expectDistinct(baseline, [
      createTripRequestFingerprint({ ...input, tripId: OTHER_TRIP_ID }),
      createTripRequestFingerprint({
        ...input,
        canonicalTripName: valueOf(canonicalTripName("Trip  Room")),
      }),
      createTripRequestFingerprint({
        ...input,
        inviteCodeHmac: changedByte(32, 0x11),
      }),
      createTripRequestFingerprint({ ...input, release: alternateRelease }),
      createTripRequestFingerprint({
        ...input,
        release: alternateLocalTime,
      }),
      createTripRequestFingerprint({
        ...input,
        release: valueOf(validateTripRelease({ mode: "IMMEDIATE" })),
      }),
      createTripRequestFingerprint({ ...input, endsAt: alternateEndsAt }),
      createTripRequestFingerprint({
        ...input,
        ownerDeviceId: OTHER_DEVICE_ID,
      }),
      createTripRequestFingerprint({
        ...input,
        ownerKeyEnvelope: changedByte(148, 0x22),
      }),
    ]);
  });

  it("is stable across property insertion order and equivalent byte/date representations", () => {
    const input = baseCreate();
    const reordered = {
      tripId: input.tripId,
      release: { ...input.release },
      ownerKeyEnvelope: Buffer.from(input.ownerKeyEnvelope),
      ownerDeviceId: input.ownerDeviceId,
      inviteCodeHmac: Buffer.from(input.inviteCodeHmac),
      endsAt: valueOf(
        validateTripWindow({
          authoritativeNow: new Date("2026-08-30T17:30:00.000+05:30"),
          endsAt: new Date("2026-09-02T17:30:00.000+05:30"),
        }),
      ).endsAt,
      canonicalTripName: input.canonicalTripName,
    } satisfies CreateTripFingerprintInput;

    expect(hex(createTripRequestFingerprint(reordered))).toBe(
      hex(createTripRequestFingerprint(input)),
    );
  });

  it("uses only the canonical create name", () => {
    const input = baseCreate();
    const plain = valueOf(canonicalTripName("Trip"));
    const padded = valueOf(canonicalTripName("  Trip  "));
    const internal = valueOf(canonicalTripName("Trip  Room"));

    expect(plain).toBe(padded);
    expect(
      hex(createTripRequestFingerprint({ ...input, canonicalTripName: plain })),
    ).toBe(
      hex(
        createTripRequestFingerprint({ ...input, canonicalTripName: padded }),
      ),
    );
    expect(
      hex(
        createTripRequestFingerprint({
          ...input,
          canonicalTripName: internal,
        }),
      ),
    ).not.toBe(
      hex(createTripRequestFingerprint({ ...input, canonicalTripName: plain })),
    );
  });

  it("frames every join, approve, reject, readiness, and Start semantic field", () => {
    const hmac = new Uint8Array(32).fill(0x31);
    const join = joinTripRequestFingerprint({
      deviceId: DEVICE_ID,
      inviteCodeHmac: hmac,
    });
    expectDistinct(join, [
      joinTripRequestFingerprint({
        deviceId: OTHER_DEVICE_ID,
        inviteCodeHmac: hmac,
      }),
      joinTripRequestFingerprint({
        deviceId: DEVICE_ID,
        inviteCodeHmac: changedByte(32, 0x31),
      }),
    ]);

    const envelope = new Uint8Array(148).fill(0x41);
    const approve = approveTripRequestFingerprint({
      algorithmVersion: 1,
      keyEpoch: 1,
      membershipId: MEMBERSHIP_ID,
      tripId: TRIP_ID,
      wrappedKey: envelope,
    });
    expectDistinct(approve, [
      approveTripRequestFingerprint({
        algorithmVersion: 1,
        keyEpoch: 1,
        membershipId: MEMBERSHIP_ID,
        tripId: OTHER_TRIP_ID,
        wrappedKey: envelope,
      }),
      approveTripRequestFingerprint({
        algorithmVersion: 1,
        keyEpoch: 1,
        membershipId: OTHER_MEMBERSHIP_ID,
        tripId: TRIP_ID,
        wrappedKey: envelope,
      }),
      approveTripRequestFingerprint({
        algorithmVersion: 1,
        keyEpoch: 1,
        membershipId: MEMBERSHIP_ID,
        tripId: TRIP_ID,
        wrappedKey: changedByte(148, 0x41),
      }),
    ]);

    const reject = rejectTripRequestFingerprint({
      membershipId: MEMBERSHIP_ID,
      tripId: TRIP_ID,
    });
    expectDistinct(reject, [
      rejectTripRequestFingerprint({
        membershipId: MEMBERSHIP_ID,
        tripId: OTHER_TRIP_ID,
      }),
      rejectTripRequestFingerprint({
        membershipId: OTHER_MEMBERSHIP_ID,
        tripId: TRIP_ID,
      }),
    ]);

    const readiness = readinessTripRequestFingerprint({
      fullPhotoLibraryAccess: false,
      tripId: TRIP_ID,
    });
    expectDistinct(readiness, [
      readinessTripRequestFingerprint({
        fullPhotoLibraryAccess: false,
        tripId: OTHER_TRIP_ID,
      }),
      readinessTripRequestFingerprint({
        fullPhotoLibraryAccess: true,
        tripId: TRIP_ID,
      }),
    ]);

    const start = startTripRequestFingerprint({
      expectedVersion: 7,
      tripId: TRIP_ID,
    });
    expectDistinct(start, [
      startTripRequestFingerprint({
        expectedVersion: 7,
        tripId: OTHER_TRIP_ID,
      }),
      startTripRequestFingerprint({ expectedVersion: 8, tripId: TRIP_ID }),
    ]);
  });

  it("domain-separates all six command tuples", () => {
    const sharedTrip = TRIP_ID;
    const values = [
      createTripRequestFingerprint(baseCreate()),
      joinTripRequestFingerprint({
        deviceId: DEVICE_ID,
        inviteCodeHmac: new Uint8Array(32),
      }),
      approveTripRequestFingerprint({
        algorithmVersion: 1,
        keyEpoch: 1,
        membershipId: MEMBERSHIP_ID,
        tripId: sharedTrip,
        wrappedKey: new Uint8Array(148),
      }),
      rejectTripRequestFingerprint({
        membershipId: MEMBERSHIP_ID,
        tripId: sharedTrip,
      }),
      readinessTripRequestFingerprint({
        fullPhotoLibraryAccess: true,
        tripId: sharedTrip,
      }),
      startTripRequestFingerprint({ expectedVersion: 1, tripId: sharedTrip }),
    ].map(hex);
    expect(new Set(values)).toHaveLength(values.length);
  });

  it("does not accept or retain a raw invite canary", () => {
    const rawInviteCanary = "RAW7CODE";
    const input = {
      ...baseCreate(),
      inviteCode: rawInviteCanary,
    } as unknown as CreateTripFingerprintInput;

    let thrown: unknown;
    try {
      createTripRequestFingerprint(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(rawInviteCanary);
    expect(JSON.stringify(thrown)).not.toContain(rawInviteCanary);

    const digest = createTripRequestFingerprint(baseCreate());
    expect(Buffer.from(digest).includes(Buffer.from(rawInviteCanary))).toBe(
      false,
    );
    expect(JSON.stringify(digest)).not.toContain(rawInviteCanary);
  });

  it("rejects invalid or noncanonical values before hashing", () => {
    const create = baseCreate();
    const invalidCases: Array<() => Readonly<Uint8Array>> = [
      () =>
        createTripRequestFingerprint({
          ...create,
          canonicalTripName: " Trip " as CanonicalTripName,
        }),
      () =>
        createTripRequestFingerprint({
          ...create,
          inviteCodeHmac: new Uint8Array(31),
        }),
      () =>
        createTripRequestFingerprint({
          ...create,
          ownerKeyEnvelope: new Uint8Array(147),
        }),
      () =>
        createTripRequestFingerprint({
          ...create,
          release: {
            localTime: "9:30 PM",
            mode: "NIGHTLY",
            timeZone: "Asia/Kolkata",
          } as ValidatedTripRelease,
        }),
      () =>
        createTripRequestFingerprint({
          ...create,
          tripId: TRIP_ID.toUpperCase(),
        }),
      () =>
        joinTripRequestFingerprint({
          deviceId: DEVICE_ID,
          inviteCodeHmac: "ABCD2345" as unknown as Uint8Array,
        }),
      () =>
        approveTripRequestFingerprint({
          algorithmVersion: 2 as 1,
          keyEpoch: 1,
          membershipId: MEMBERSHIP_ID,
          tripId: TRIP_ID,
          wrappedKey: new Uint8Array(148),
        }),
      () =>
        startTripRequestFingerprint({ expectedVersion: 0, tripId: TRIP_ID }),
    ];

    for (const invalid of invalidCases) {
      expect(invalid).toThrow("Invalid trip fingerprint input");
    }

    const invalidCode = "abcd2345" as NormalizedInviteCode;
    expect(invalidCode).not.toBe(valueOf(normalizeInviteCode("ABCD2345")));
  });
});
