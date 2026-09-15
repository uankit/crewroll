import { createPreparedTripNative } from "./preparedTripNative";
import type { ActiveTripNativePort } from "./ports";

const command: Parameters<ActiveTripNativePort["activateTrip"]>[0] = {
  protocolVersion: 1,
  tripId: "0191a203-227b-7011-9213-141516171819",
  membershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
  startsAt: "2026-09-11T00:00:00Z",
  endsAt: "2026-09-12T00:00:00Z",
  releaseAt: null,
  keyEpoch: 1,
};
const harness = () => ({
  importTripKey: jest.fn().mockResolvedValue(undefined),
  activateTrip: jest.fn().mockResolvedValue(undefined),
});

it("100 concurrent and subsequent refreshes activate once per session", async () => {
  const native = harness();
  const prepared = createPreparedTripNative(native);
  await Promise.all(
    Array.from({ length: 100 }, () => prepared.activateTrip(command)),
  );
  expect(native.activateTrip).toHaveBeenCalledTimes(1);
  await prepared.activateTrip({ ...command });
  expect(native.activateTrip).toHaveBeenCalledTimes(1);
  await createPreparedTripNative(native).activateTrip(command);
  expect(native.activateTrip).toHaveBeenCalledTimes(2);
});

it("failure is not remembered as success and does not block a deliberate retry", async () => {
  const native = harness();
  native.activateTrip.mockRejectedValueOnce(new Error("native failed"));
  const prepared = createPreparedTripNative(native);
  await expect(prepared.activateTrip(command)).rejects.toThrow("native failed");
  await prepared.activateTrip(command);
  expect(native.activateTrip).toHaveBeenCalledTimes(2);
});

it("changed activation metadata is dispatched, never masked by an earlier success", async () => {
  const native = harness();
  const prepared = createPreparedTripNative(native);
  await prepared.activateTrip(command);
  await prepared.activateTrip({ ...command, endsAt: "2026-09-13T00:00:00Z" });
  await prepared.activateTrip(command);
  expect(native.activateTrip).toHaveBeenCalledTimes(3);
});
