import {
  localStartupErrorCode,
  startupCapabilities,
  type StartupCapabilityFacts,
} from "./startupState";

const ready: StartupCapabilityFacts = {
  shellReady: true,
  deviceReady: true,
  accountReady: true,
  recoverySettled: true,
  tripsSettled: true,
  preparingTrip: false,
  transferReady: true,
  activeTrip: true,
  fullPhotoAccess: true,
  teardown: false,
};

describe("startup capabilities", () => {
  it("opens the authenticated shell before device and trip work complete", () => {
    expect(
      startupCapabilities({
        ...ready,
        deviceReady: false,
        recoverySettled: false,
        tripsSettled: false,
        transferReady: false,
      }),
    ).toEqual({
      canUseAuthenticatedShell: true,
      canReadLibrary: false,
      canMutateTrip: false,
      canSharePhotos: false,
    });
  });

  it.each(["accountReady", "recoverySettled", "tripsSettled"] as const)(
    "keeps library reads available while %s is unresolved",
    (fact) => {
      expect(startupCapabilities({ ...ready, [fact]: false })).toEqual({
        canUseAuthenticatedShell: true,
        canReadLibrary: true,
        canMutateTrip: false,
        canSharePhotos: false,
      });
    },
  );

  it("does not permit a mutation to race trip preparation", () => {
    expect(startupCapabilities({ ...ready, preparingTrip: true })).toEqual({
      canUseAuthenticatedShell: true,
      canReadLibrary: true,
      canMutateTrip: false,
      canSharePhotos: false,
    });
  });

  it.each(["transferReady", "activeTrip", "fullPhotoAccess"] as const)(
    "never promises sharing without %s",
    (fact) => {
      expect(startupCapabilities({ ...ready, [fact]: false })).toEqual({
        canUseAuthenticatedShell: true,
        canReadLibrary: true,
        canMutateTrip: true,
        canSharePhotos: false,
      });
    },
  );

  it.each([{ teardown: true }, { shellReady: false }])(
    "closes all capabilities when the account shell is unavailable (%j)",
    (change) => {
      expect(startupCapabilities({ ...ready, ...change })).toEqual({
        canUseAuthenticatedShell: false,
        canReadLibrary: false,
        canMutateTrip: false,
        canSharePhotos: false,
      });
    },
  );
});

describe("startup local-key errors", () => {
  it.each([
    ["KEY_ACCESS_LOCKED", "LOCAL_STORAGE_LOCKED"],
    ["KEY_MATERIAL_LOST", "LOCAL_KEYS_UNAVAILABLE"],
  ])("classifies the finite native Error code %s", (code, expected) => {
    expect(
      localStartupErrorCode(
        Object.assign(new Error("private native message"), { code }),
      ),
    ).toBe(expected);
  });

  it("does not trust plain objects, inherited codes or code getters", () => {
    const getter = jest.fn(() => "KEY_ACCESS_LOCKED");
    const error = new Error();
    Object.defineProperty(error, "code", { get: getter });
    const inherited = Object.create(
      Object.assign(new Error(), { code: "KEY_ACCESS_LOCKED" }),
    );
    expect(
      localStartupErrorCode({ code: "KEY_ACCESS_LOCKED" }),
    ).toBeUndefined();
    expect(localStartupErrorCode(error)).toBeUndefined();
    expect(localStartupErrorCode(inherited)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});
