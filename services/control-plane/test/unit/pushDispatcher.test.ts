import { describe, expect, it, vi } from "vitest";
import { createPushWakeDispatcher } from "../../src/modules/push/dispatchPushWakeups.js";
import type {
  ClaimedPushWake,
  PushTarget,
  PushWakeRepository,
  PushSendResult,
} from "../../src/modules/push/ports/pushDispatch.js";

function setup() {
  const now = new Date("2026-11-12T03:00:00Z");
  const job: ClaimedPushWake = {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    attempt: 1,
    userId: crypto.randomUUID(),
    expiresAt: new Date(now.getTime() + 3_600_000),
    hint: {
      type: "crewroll.sync.v1",
      tripId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
    },
  };
  const target: PushTarget = {
    platform: "android",
    encryptedToken: Buffer.from("opaque ciphertext"),
    tokenHash: Buffer.alloc(32, 7),
    revision: { registeredAt: now, committed: "0" },
  };
  const repository = {
    materialize: vi.fn<PushWakeRepository["materialize"]>().mockResolvedValue(),
    claim: vi
      .fn<PushWakeRepository["claim"]>()
      .mockResolvedValueOnce(job)
      .mockResolvedValue(null),
    target: vi.fn<PushWakeRepository["target"]>().mockResolvedValue(target),
    complete: vi.fn<PushWakeRepository["complete"]>().mockResolvedValue(),
    retry: vi.fn<PushWakeRepository["retry"]>().mockResolvedValue(),
    invalidateToken: vi
      .fn<PushWakeRepository["invalidateToken"]>()
      .mockResolvedValue(),
    compact: vi.fn<PushWakeRepository["compact"]>().mockResolvedValue(),
  } satisfies PushWakeRepository;
  const send = vi
    .fn<() => Promise<PushSendResult>>()
    .mockResolvedValue({ kind: "accepted" });
  const read = vi.fn().mockResolvedValue("secret-native-token");
  const dispatcher = createPushWakeDispatcher({
    repository,
    provider: { send },
    tokenReader: { read },
    clock: { now: () => now },
    jitter: () => 0,
  });
  return { now, job, target, repository, send, read, dispatcher };
}

describe("durable push dispatch policy", () => {
  it("sends the stable closed hint and treats provider acceptance separately from photo receipts", async () => {
    const { dispatcher, send, repository, job } = setup();
    await expect(dispatcher.run(1)).resolves.toEqual({
      accepted: 1,
      retried: 0,
      retired: 0,
      failed: 0,
      configurationErrors: 0,
    });
    expect(send).toHaveBeenCalledWith({
      platform: "android",
      token: "secret-native-token",
      hint: job.hint,
      expiresAt: job.expiresAt,
    });
    expect(repository.complete).toHaveBeenCalledWith(job, "SENT");
    expect(repository.invalidateToken).not.toHaveBeenCalled();
  });

  it("does not contact a provider if the account/device/membership became ineligible during decryption", async () => {
    const { dispatcher, send, repository, job } = setup();
    repository.target
      .mockResolvedValueOnce({
        platform: "android",
        encryptedToken: Buffer.from("frame"),
        tokenHash: Buffer.alloc(32, 7),
        revision: { registeredAt: job.expiresAt, committed: "0" },
      })
      .mockResolvedValueOnce(null);
    await dispatcher.run(1);
    expect(send).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith(job, "INELIGIBLE");
  });

  it("retries a token rotation before send without disclosing the old token", async () => {
    const { dispatcher, send, repository, target, job } = setup();
    repository.target
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({ ...target, tokenHash: Buffer.alloc(32, 8) });
    await dispatcher.run(1);
    expect(send).not.toHaveBeenCalled();
    expect(repository.retry).toHaveBeenCalledWith(
      job,
      expect.any(Date),
      "TARGET_CHANGED",
    );
  });

  it("invalidates only the exact token fingerprint that the provider rejected", async () => {
    const { dispatcher, send, repository, target, job } = setup();
    send.mockResolvedValue({ kind: "invalid-token" });
    await dispatcher.run(1);
    expect(repository.invalidateToken).toHaveBeenCalledWith(
      job,
      target.tokenHash,
      target.revision,
      undefined,
    );
    expect(repository.complete).toHaveBeenCalledWith(job, "INVALID_TOKEN");
  });

  it("honors provider backoff and preserves stable event identity across retry", async () => {
    const { dispatcher, send, repository, job, now } = setup();
    send.mockResolvedValue({
      kind: "retry",
      code: "PROVIDER_UNAVAILABLE",
      retryAfterSeconds: 900,
    });
    await dispatcher.run(1);
    expect(repository.retry).toHaveBeenCalledWith(
      job,
      new Date(now.getTime() + 900_000),
      "PROVIDER_UNAVAILABLE",
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("dead-letters exhausted attempts and never persists provider exception text", async () => {
    const { dispatcher, send, repository, job } = setup();
    repository.claim
      .mockReset()
      .mockResolvedValueOnce({ ...job, attempt: 8 })
      .mockResolvedValue(null);
    send.mockRejectedValue(new Error("secret-token https://private.example"));
    await dispatcher.run(1);
    expect(repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 8 }),
      "DEAD_LETTERED",
      "DISPATCH_FAILED",
    );
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it("retires expired work before decrypting or sending", async () => {
    const { dispatcher, send, read, repository, job, now } = setup();
    repository.claim
      .mockReset()
      .mockResolvedValueOnce({ ...job, expiresAt: now })
      .mockResolvedValue(null);
    await dispatcher.run(1);
    expect(send).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: now }),
      "EXPIRED",
    );
  });

  it("bounds a caller-supplied batch and compaction sizes", async () => {
    const { dispatcher, repository } = setup();
    await dispatcher.run(10_000);
    expect(repository.claim).toHaveBeenCalledTimes(16);
    expect(repository.materialize).toHaveBeenCalledWith(16);
    expect(repository.compact).toHaveBeenCalledWith(200);
  });
});
