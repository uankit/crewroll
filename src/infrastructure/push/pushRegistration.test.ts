import {
  createPushRegistration,
  type NativePushToken,
  type PushRegistrationStatus,
} from "./pushRegistration";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const token = (data: string): NativePushToken => ({ type: "ios", data });

it("does not publish an old account's delayed acquisition after switching devices", async () => {
  let current = true;
  const waiting = deferred<NativePushToken>();
  const publish = jest.fn(async () => {});
  const status = jest.fn();
  const registration = createPushRegistration({
    current: () => current,
    acquire: () => waiting.promise,
    publish,
    status,
    platform: "ios",
  });
  const pending = registration.retry();
  current = false;
  waiting.resolve(token("account-a-token"));
  await pending;
  registration.rotated(token("late-rotation"));
  expect(publish).not.toHaveBeenCalled();
  expect(status.mock.calls.map(([value]) => value)).toEqual(["REGISTERING"]);
});

it("serializes rotations and coalesces intermediate values so the newest token wins", async () => {
  const first = deferred<void>();
  const publish = jest.fn((value: string) =>
    value === "first" ? first.promise : Promise.resolve(),
  );
  const registration = createPushRegistration({
    current: () => true,
    acquire: async () => token("first"),
    publish,
    status: jest.fn(),
    platform: "ios",
  });
  const pending = registration.retry();
  await tick();
  registration.rotated(token("intermediate"));
  registration.rotated(token("latest"));
  expect(publish.mock.calls).toEqual([["first"]]);
  first.resolve();
  await pending;
  expect(publish.mock.calls).toEqual([["first"], ["latest"]]);
});

it("a rotation emitted during APNs acquisition wins without another acquisition loop", async () => {
  const waiting = deferred<NativePushToken>();
  const acquire = jest.fn(() => waiting.promise);
  const publish = jest.fn(async () => {});
  const registration = createPushRegistration({
    current: () => true,
    acquire,
    publish,
    status: jest.fn(),
    platform: "ios",
  });
  const pending = registration.retry();
  await tick();
  registration.rotated(token("newest"));
  waiting.resolve(token("older"));
  await pending;
  await tick();
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls).toEqual([["newest"]]);
});

it("ignores a delayed old-account publish completion and token rotation after disposal", async () => {
  const waiting = deferred<void>();
  const statuses: PushRegistrationStatus[] = [];
  const publish = jest.fn(() => waiting.promise);
  const registration = createPushRegistration({
    current: () => true,
    acquire: async () => token("first"),
    publish,
    status: (value) => statuses.push(value),
    platform: "ios",
  });
  const pending = registration.retry();
  await tick();
  registration.dispose();
  registration.rotated(token("late"));
  waiting.resolve();
  await pending;
  expect(publish).toHaveBeenCalledTimes(1);
  expect(statuses).not.toContain("REGISTERED");
});

it("reports missing provider configuration and retries without blocking device startup", async () => {
  const acquire = jest
    .fn()
    .mockRejectedValueOnce(new Error("DEFAULT_FIREBASE_APP_MISSING"))
    .mockResolvedValueOnce(token("recovered"));
  const statuses: PushRegistrationStatus[] = [];
  const publish = jest.fn(async () => {});
  const registration = createPushRegistration({
    current: () => true,
    acquire,
    publish,
    status: (value) => statuses.push(value),
    platform: "ios",
  });
  await registration.retry();
  expect(statuses.at(-1)).toBe("UNAVAILABLE");
  await registration.retry();
  expect(statuses.at(-1)).toBe("REGISTERED");
  expect(publish).toHaveBeenCalledWith("recovered");
});

it("bounds a stalled APNs registration and discards its late token", async () => {
  const waiting = deferred<NativePushToken>();
  const publish = jest.fn(async () => {});
  const status = jest.fn();
  const registration = createPushRegistration({
    current: () => true,
    acquire: () => waiting.promise,
    publish,
    status,
    platform: "ios",
    deadlineMs: 5,
  });
  await registration.retry();
  expect(status).toHaveBeenLastCalledWith("UNAVAILABLE");
  waiting.resolve(token("late"));
  await tick();
  expect(publish).not.toHaveBeenCalled();
});

it("rejects malformed and wrong-provider tokens before sending them", async () => {
  const publish = jest.fn(async () => {});
  const status = jest.fn();
  const registration = createPushRegistration({
    current: () => true,
    acquire: async () => ({ type: "android", data: "token" }),
    publish,
    status,
    platform: "ios",
  });
  await registration.retry();
  registration.rotated(token("not a token"));
  registration.rotated(token("x".repeat(4097)));
  expect(publish).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith("UNAVAILABLE");
});

it("retries a failed PATCH with the newest token and skips a registered token", async () => {
  const publish = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const acquire = jest
    .fn()
    .mockResolvedValueOnce(token("first"))
    .mockResolvedValue(token("latest"));
  const registration = createPushRegistration({
    current: () => true,
    acquire,
    publish,
    status: jest.fn(),
    platform: "ios",
  });
  await registration.retry();
  registration.rotated(token("latest"));
  await tick();
  await registration.retry();
  expect(publish.mock.calls).toEqual([["first"], ["latest"]]);
});

it("reacquires the provider token on foreground to recover rotation missed while JS was suspended", async () => {
  const acquire = jest
    .fn()
    .mockResolvedValueOnce(token("before-background"))
    .mockResolvedValue(token("rotated-while-suspended"));
  const publish = jest.fn(async () => {});
  const registration = createPushRegistration({
    current: () => true,
    acquire,
    publish,
    status: jest.fn(),
    platform: "ios",
  });
  await registration.retry();
  await registration.retry();
  await registration.retry();
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(publish.mock.calls).toEqual([
    ["before-background"],
    ["rotated-while-suspended"],
  ]);
});
