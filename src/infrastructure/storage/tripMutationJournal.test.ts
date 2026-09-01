import {
  TripMutationJournal,
  type MutationDigestPort,
  type MutationSecureStorePort,
} from "./tripMutationJournal";

const scope = {
  clerkSubject: "user_crewroll",
  deviceId: "10000000-0000-4000-8000-000000000001",
};
const first = {
  version: 1 as const,
  kind: "SET_READINESS" as const,
  tripId: "018f22c4-6e80-7000-8000-000000000001",
  commandId: "20000000-0000-4000-8000-000000000001",
  body: { fullPhotoLibraryAccess: true },
};

describe("trip mutation journal", () => {
  const values = new Map<string, string>();
  const secureStore: jest.Mocked<MutationSecureStorePort> = {
    getItemAsync: jest.fn(async (key) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key, value) => void values.set(key, value)),
    deleteItemAsync: jest.fn(async (key) => void values.delete(key)),
  };
  const digest: MutationDigestPort = {
    sha256: async () => "a".repeat(64),
  };

  beforeEach(() => {
    values.clear();
    jest.clearAllMocks();
  });

  it("persists an exact closed record across reconstruction", async () => {
    await new TripMutationJournal({ digest, secureStore }).save(scope, first);
    await expect(
      new TripMutationJournal({ digest, secureStore }).load(scope),
    ).resolves.toEqual(first);
    expect([...values.keys()][0]).toBe(
      `crewroll.trip-mutation.v1.${"a".repeat(64)}`,
    );
  });

  it("serializes writes and refuses to overwrite a live command", async () => {
    const journal = new TripMutationJournal({ digest, secureStore });
    await journal.save(scope, first);
    await expect(
      journal.save(scope, {
        version: 1,
        kind: "START",
        tripId: first.tripId,
        commandId: "20000000-0000-4000-8000-000000000002",
        body: { expectedVersion: 3 },
      }),
    ).rejects.toThrow("pending trip mutation exists");
    await expect(journal.load(scope)).resolves.toEqual(first);
  });

  it("serializes load behind an in-flight save", async () => {
    let release: (() => void) | undefined;
    secureStore.setItemAsync.mockImplementationOnce(
      (key, value) =>
        new Promise<void>((resolve) => {
          release = () => {
            values.set(key, value);
            resolve();
          };
        }),
    );
    const journal = new TripMutationJournal({ digest, secureStore });
    const saving = journal.save(scope, first);
    const loading = journal.load(scope);
    let loaded = false;
    void loading.then(() => {
      loaded = true;
    });
    while (release === undefined) await Promise.resolve();
    expect(loaded).toBe(false);
    release?.();
    await saving;
    await expect(loading).resolves.toEqual(first);
  });

  it("clears only a matching command", async () => {
    const journal = new TripMutationJournal({ digest, secureStore });
    await journal.save(scope, first);
    await journal.clear(scope, "20000000-0000-4000-8000-000000000009");
    await expect(journal.load(scope)).resolves.toEqual(first);
    await journal.clear(scope, first.commandId);
    await expect(journal.load(scope)).resolves.toBeNull();
  });

  it.each([
    "not-json",
    JSON.stringify({ ...first, token: "secret" }),
    JSON.stringify({ ...first, version: 2 }),
    JSON.stringify({ ...first, body: { fullPhotoLibraryAccess: "yes" } }),
  ])(
    "rejects corrupt or open records without leaking them: %s",
    async (raw) => {
      values.set(`crewroll.trip-mutation.v1.${"a".repeat(64)}`, raw);
      await expect(
        new TripMutationJournal({ digest, secureStore }).load(scope),
      ).resolves.toBeNull();
    },
  );

  it("never silently overwrites a malformed persisted record", async () => {
    values.set(
      `crewroll.trip-mutation.v1.${"a".repeat(64)}`,
      "malformed-persisted-record",
    );
    const journal = new TripMutationJournal({ digest, secureStore });
    await expect(journal.save(scope, first)).rejects.toThrow(
      "pending trip mutation exists",
    );
  });
});
