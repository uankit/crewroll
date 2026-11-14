import type { Clock } from "../../shared/time/clock.js";
import type {
  ClaimedPushWake,
  PushProvider,
  PushTokenReader,
  PushWakeRepository,
} from "./ports/pushDispatch.js";

const MAX_ATTEMPTS = 8;

/** Bounded work; leases recover process death and provider responses are not receipts. */
export function createPushWakeDispatcher(input: {
  readonly repository: PushWakeRepository;
  readonly provider: PushProvider;
  readonly tokenReader: PushTokenReader;
  readonly clock: Clock;
  readonly jitter?: () => number;
}) {
  const { repository, provider, tokenReader, clock } = input;
  const jitter =
    input.jitter ??
    (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000);
  return {
    async run(limit = 16) {
      const boundedLimit = Math.max(1, Math.min(16, Math.floor(limit)));
      const counts = {
        accepted: 0,
        retried: 0,
        retired: 0,
        failed: 0,
        configurationErrors: 0,
      };
      async function retry(job: ClaimedPushWake, code: string, seconds = 0) {
        const now = clock.now();
        if (job.expiresAt <= now) {
          await repository.complete(job, "EXPIRED");
          counts.retired += 1;
        } else if (job.attempt >= MAX_ATTEMPTS) {
          await repository.complete(job, "DEAD_LETTERED", code);
          counts.failed += 1;
        } else {
          const delay =
            Math.max(seconds, Math.min(900, 60 * 2 ** (job.attempt - 1))) +
            Math.floor(Math.max(0, Math.min(1, jitter())) * 15);
          await repository.retry(
            job,
            new Date(now.getTime() + delay * 1_000),
            code,
          );
          counts.retried += 1;
        }
      }
      async function processOne() {
        const job = await repository.claim();
        if (!job) return;
        try {
          if (job.expiresAt <= clock.now()) {
            await repository.complete(job, "EXPIRED");
            counts.retired += 1;
            return;
          }
          const target = await repository.target(job);
          if (!target) {
            await repository.complete(job, "INELIGIBLE");
            counts.retired += 1;
            return;
          }
          const token = await tokenReader.read(
            target.encryptedToken,
            job.hint.deviceId,
            target.platform,
          );
          // Decryption may cross a revocation, suspension, membership change or
          // token rotation. Recheck before any provider request, without holding
          // user/device locks during network I/O.
          const current = await repository.target(job);
          if (!current) {
            await repository.complete(job, "INELIGIBLE");
            counts.retired += 1;
            return;
          }
          if (
            !Buffer.from(current.tokenHash).equals(
              Buffer.from(target.tokenHash),
            ) ||
            current.platform !== target.platform
          ) {
            await retry(job, "TARGET_CHANGED");
            return;
          }
          const result = await provider.send({
            platform: target.platform,
            token,
            hint: job.hint,
            expiresAt: job.expiresAt,
          });
          if (result.kind === "accepted") {
            await repository.complete(job, "SENT");
            counts.accepted += 1;
          } else if (result.kind === "invalid-token") {
            await repository.invalidateToken(
              job,
              target.tokenHash,
              target.revision,
              result.invalidatedAt,
            );
            await repository.complete(job, "INVALID_TOKEN");
            counts.retired += 1;
          } else if (result.kind === "permanent") {
            await repository.complete(job, "DEAD_LETTERED", result.code);
            counts.failed += 1;
          } else {
            if (result.code === "PROVIDER_CONFIGURATION")
              counts.configurationErrors += 1;
            await retry(job, result.code, result.retryAfterSeconds);
          }
        } catch {
          // Exceptions can embed credentials or URLs. Persist only an owned code.
          await retry(job, "DISPATCH_FAILED");
        }
      }
      await repository.materialize(boundedLimit);
      for (let offset = 0; offset < boundedLimit; offset += 4) {
        await Promise.all(
          Array.from(
            { length: Math.min(4, boundedLimit - offset) },
            processOne,
          ),
        );
      }
      await repository.compact(200);
      return counts;
    },
  };
}
