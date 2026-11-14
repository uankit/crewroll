import { withDeadline } from "../../application/shared/withDeadline";

export type PushRegistrationStatus =
  "IDLE" | "REGISTERING" | "REGISTERED" | "UNAVAILABLE";
export type NativePushToken = Readonly<{ type: string; data: unknown }>;

/** One writer per mounted device scope. Rotation never races an older PATCH.
 * Tokens and provider error details must never enter logs or persisted JS state. */
export function createPushRegistration(
  input: Readonly<{
    current(): boolean;
    acquire(): Promise<NativePushToken>;
    publish(token: string): Promise<void>;
    status(value: PushRegistrationStatus): void;
    platform: string;
    deadlineMs?: number;
  }>,
) {
  let disposed = false;
  let running = false;
  let desired: string | null = null;
  let registered: string | null = null;
  let acquisition = 0;
  const current = () => !disposed && input.current();
  const status = (value: PushRegistrationStatus) => {
    if (current()) input.status(value);
  };
  const valid = (
    token: NativePushToken,
  ): token is { type: string; data: string } =>
    token.type === input.platform &&
    typeof token.data === "string" &&
    token.data.length >= 1 &&
    token.data.length <= 4096 &&
    !/\s/.test(token.data);

  async function flush() {
    if (running || !current() || desired === null) return;
    if (desired === registered) {
      status("REGISTERED");
      return;
    }
    running = true;
    try {
      while (current() && desired !== null && desired !== registered) {
        const token = desired;
        status("REGISTERING");
        // The API transport already has an aborting deadline. Keep a single
        // PATCH writer until it settles so a late older token cannot replace a
        // newer rotation. Its account fence prevents replay as another user.
        await input.publish(token);
        if (!current()) return;
        registered = token;
      }
      status("REGISTERED");
    } catch {
      status("UNAVAILABLE");
    } finally {
      running = false;
    }
  }
  function rotated(token: NativePushToken) {
    if (!current()) return;
    if (!valid(token)) {
      status("UNAVAILABLE");
      return;
    }
    acquisition += 1;
    desired = token.data;
    void flush();
  }
  async function retry() {
    if (!current() || running) return;
    const attempt = ++acquisition;
    status("REGISTERING");
    try {
      const token = await withDeadline(
        input.acquire,
        input.deadlineMs ?? 10_000,
      );
      // APNs registration can emit rotation before getDevicePushTokenAsync
      // resolves. The listener's newest token wins over that older result.
      if (attempt !== acquisition || !current()) return;
      if (!valid(token)) {
        status("UNAVAILABLE");
        return;
      }
      desired = token.data;
      await flush();
    } catch {
      if (attempt === acquisition) status("UNAVAILABLE");
    }
  }
  return Object.freeze({
    retry,
    rotated,
    dispose() {
      disposed = true;
      acquisition += 1;
      desired = null;
      registered = null;
    },
  });
}
