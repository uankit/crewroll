import {
  TripRecoveryStore,
  type RecoveryDigestPort,
  type SecureStorePort,
  type TripRecoveryRecord,
  type TripRecoveryScope,
} from "./tripRecoveryStore";

jest.mock(
  "expo-crypto",
  () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digestStringAsync: jest.fn(),
  }),
  { virtual: true },
);
jest.mock(
  "expo-secure-store",
  () => ({
    deleteItemAsync: jest.fn(),
    getItemAsync: jest.fn(),
    setItemAsync: jest.fn(),
  }),
  { virtual: true },
);

const scope: TripRecoveryScope = {
  clerkSubject: "user_2wC5zabc",
  deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
};

const unknownCreate: TripRecoveryRecord = {
  state: "UNKNOWN_CREATE",
  tripId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
  commandId: "5a95305d-c558-4c79-b78c-a075be7bff84",
  ownerInviteCode: "ABCD2345",
};

const unknownJoin: TripRecoveryRecord = {
  state: "UNKNOWN_JOIN",
  inviteCode: "ABCD2345",
  deviceId: scope.deviceId,
  commandId: "5a95305d-c558-4c79-b78c-a075be7bff84",
};

const confirmed: TripRecoveryRecord = {
  state: "CONFIRMED",
  tripId: unknownCreate.tripId,
  membershipId: "5a95305d-c558-4c79-b78c-a075be7bff86",
};

function createStore() {
  const values = new Map<string, string>();
  const secureStore: jest.Mocked<SecureStorePort> = {
    deleteItemAsync: jest.fn(async (key: string) => {
      values.delete(key);
    }),
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const digests = new Map<string, string>();
  const digest: jest.Mocked<RecoveryDigestPort> = {
    sha256: jest.fn(async (input: string) => {
      const existing = digests.get(input);
      if (existing) return existing;
      const next = (digests.size + 1).toString(16).repeat(64);
      digests.set(input, next);
      return next;
    }),
  };

  return {
    digest,
    secureStore,
    store: new TripRecoveryStore({ digest, secureStore }),
    values,
  };
}

describe("TripRecoveryStore", () => {
  it.each([
    ["UUIDv4", "5a95305d-c558-4c79-b78c-a075be7bff84"],
    ["non-lowercase UUIDv7", unknownCreate.tripId.toUpperCase()],
    ["non-v7 UUID", "018f0d98-76fa-6d1a-b4b4-1f742c2e3130"],
  ])("rejects a %s tripId in UNKNOWN_CREATE", async (_name, tripId) => {
    const { store } = createStore();

    await expect(
      store.save(scope, { ...unknownCreate, tripId }),
    ).rejects.toThrow("invalid trip recovery record");
  });

  it.each([
    ["UUIDv4", "5a95305d-c558-4c79-b78c-a075be7bff84"],
    ["non-lowercase UUIDv7", confirmed.tripId.toUpperCase()],
    ["non-v7 UUID", "018f0d98-76fa-8d1a-b4b4-1f742c2e3130"],
  ])("rejects a %s tripId in CONFIRMED", async (_name, tripId) => {
    const { store } = createStore();

    await expect(store.save(scope, { ...confirmed, tripId })).rejects.toThrow(
      "invalid trip recovery record",
    );
  });

  it("retains UUIDv4 command and membership identifier rules", async () => {
    const { store } = createStore();

    await expect(store.save(scope, unknownCreate)).resolves.toBeUndefined();
    await expect(store.save(scope, confirmed)).resolves.toBeUndefined();
  });

  it("distinguishes unknown create from a confirmed trip across restart", async () => {
    const { digest, secureStore, values, store } = createStore();

    await store.save(scope, unknownCreate);

    const [storageKey, serialized] =
      secureStore.setItemAsync.mock.calls[0] ?? [];
    expect(storageKey).toMatch(/^crewroll\.trip-recovery\.v1\.[0-9a-f]{64}$/);
    expect(storageKey).not.toContain(scope.clerkSubject);
    expect(storageKey).not.toContain(scope.deviceId);
    expect(serialized).not.toMatch(/wrapped|envelope|bearer|token|raw key/i);

    const restartedStore = new TripRecoveryStore({
      digest,
      secureStore: {
        deleteItemAsync: async (key) => {
          values.delete(key);
        },
        getItemAsync: async (key) => values.get(key) ?? null,
        setItemAsync: async (key, value) => {
          values.set(key, value);
        },
      },
    });
    await expect(restartedStore.load(scope)).resolves.toEqual(unknownCreate);

    await restartedStore.save(scope, {
      state: "CONFIRMED",
      tripId: unknownCreate.tripId,
      membershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3140",
      ownerInviteCode: unknownCreate.ownerInviteCode,
    });
    await expect(restartedStore.load(scope)).resolves.toEqual({
      state: "CONFIRMED",
      tripId: unknownCreate.tripId,
      membershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3140",
      ownerInviteCode: unknownCreate.ownerInviteCode,
    });
  });

  it("persists the exact pending join replay command across restart", async () => {
    const { digest, values, store } = createStore();

    await store.save(scope, unknownJoin);
    const restartedStore = new TripRecoveryStore({
      digest,
      secureStore: {
        deleteItemAsync: async (key) => {
          values.delete(key);
        },
        getItemAsync: async (key) => values.get(key) ?? null,
        setItemAsync: async (key, value) => {
          values.set(key, value);
        },
      },
    });

    await expect(restartedStore.load(scope)).resolves.toEqual(unknownJoin);
  });

  it("fails closed on corruption and cannot enumerate or clear another scope", async () => {
    const { secureStore, store, values } = createStore();
    const otherScope = {
      clerkSubject: "user_other",
      deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
    } as const;

    await store.save(scope, unknownCreate);
    await store.save(otherScope, unknownJoin);
    await store.clear(scope);

    await expect(store.load(scope)).resolves.toBeNull();
    await expect(store.load(otherScope)).resolves.toEqual(unknownJoin);
    expect(secureStore.getItemAsync.mock.calls).toHaveLength(2);

    const otherKey = secureStore.setItemAsync.mock.calls[1]?.[0];
    expect(otherKey).toBeDefined();
    values.set(
      otherKey as string,
      '{"state":"UNKNOWN_CREATE","token":"forbidden"}',
    );
    await expect(store.load(otherScope)).resolves.toBeNull();
  });

  it("serializes concurrent updates for one hashed scope", async () => {
    const writes: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    let firstWriteStarted: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const store = new TripRecoveryStore({
      digest: { sha256: async () => "a".repeat(64) },
      secureStore: {
        deleteItemAsync: async () => undefined,
        getItemAsync: async () => null,
        setItemAsync: async (_key, value) => {
          writes.push(value);
          if (writes.length === 1) {
            firstWriteStarted?.();
            await firstWrite;
          }
        },
      },
    });

    const first = store.save(scope, unknownCreate);
    const second = store.save(scope, {
      state: "CONFIRMED",
      tripId: unknownCreate.tripId,
      membershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3140",
    });
    await started;
    expect(writes).toHaveLength(1);
    releaseFirstWrite?.();
    await Promise.all([first, second]);

    expect(writes.map((value) => JSON.parse(value).state)).toEqual([
      "UNKNOWN_CREATE",
      "CONFIRMED",
    ]);
  });
});
