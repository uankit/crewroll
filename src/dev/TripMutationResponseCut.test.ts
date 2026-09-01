import type { AcceptedTripMutationKind } from "../application/trips/ports";
import {
  DevelopmentTripMutationResponseCut,
  type ResponseCutArmStore,
} from "./TripMutationResponseCut";

describe("development accepted-response cut", () => {
  const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
  let persisted: string | null;
  let store: jest.Mocked<ResponseCutArmStore>;

  beforeEach(() => {
    persisted = null;
    store = {
      read: jest.fn(async () => persisted),
      write: jest.fn(async (value) => void (persisted = value)),
      clear: jest.fn(async () => void (persisted = null)),
    };
  });

  it.each(["JOIN", "SET_READINESS", "START"] as AcceptedTripMutationKind[])(
    "cuts one accepted %s response and consumes its persistent arm",
    async (kind) => {
      const cut = new DevelopmentTripMutationResponseCut(store);
      await cut.arm(kind);
      await expect(
        cut.afterAccepted({ kind, commandId }),
      ).rejects.toMatchObject({ kind: "TRANSPORT_UNAVAILABLE" });
      await expect(
        cut.afterAccepted({ kind, commandId }),
      ).resolves.toBeUndefined();
      expect(persisted).toBeNull();
    },
  );

  it("cuts both built-in CREATE attempts with the same command, but not after restart", async () => {
    const firstProcess = new DevelopmentTripMutationResponseCut(store);
    await firstProcess.arm("CREATE");
    await expect(
      firstProcess.afterAccepted({ kind: "CREATE", commandId }),
    ).rejects.toMatchObject({ kind: "TRANSPORT_UNAVAILABLE" });
    expect(persisted).toBeNull();
    await expect(
      firstProcess.afterAccepted({ kind: "CREATE", commandId }),
    ).rejects.toMatchObject({ kind: "TRANSPORT_UNAVAILABLE" });
    await expect(
      firstProcess.afterAccepted({ kind: "CREATE", commandId }),
    ).resolves.toBeUndefined();

    const nextProcess = new DevelopmentTripMutationResponseCut(store);
    await expect(
      nextProcess.afterAccepted({ kind: "CREATE", commandId }),
    ).resolves.toBeUndefined();
  });

  it("leaves a nonmatching arm intact", async () => {
    const cut = new DevelopmentTripMutationResponseCut(store);
    await cut.arm("START");
    await cut.afterAccepted({ kind: "JOIN", commandId });
    expect(persisted).toContain("START");
  });
});
