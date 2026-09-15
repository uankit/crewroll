import { createSingleFlightRead } from "./singleFlightRead";

it("coalesces overlapping reads and releases the slot on success or rejection", async () => {
  const reader = createSingleFlightRead<number>();
  const operation = jest.fn(async () => 42);
  const results = await Promise.all(
    Array.from({ length: 100 }, () => reader.read("snapshot", operation)),
  );
  expect(results.every((value) => value === 42)).toBe(true);
  expect(operation).toHaveBeenCalledTimes(1);
  await reader.read("snapshot", operation);
  expect(operation).toHaveBeenCalledTimes(2);
  operation.mockRejectedValueOnce(new Error("unavailable"));
  await expect(reader.read("snapshot", operation)).rejects.toThrow(
    "unavailable",
  );
  await expect(reader.read("snapshot", operation)).resolves.toBe(42);
});

it("a session mutation never shares an old in-flight result with a new reader", async () => {
  const reader = createSingleFlightRead<number>();
  let resolve!: (value: number) => void;
  const old = reader.read(
    "snapshot",
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  reader.invalidate();
  const current = reader.read("snapshot", async () => 2);
  resolve(1);
  expect(await old).toBe(1);
  expect(await current).toBe(2);
});
