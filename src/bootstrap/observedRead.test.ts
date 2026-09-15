import { createObservedRead } from "./observedRead";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it("a stalled read reports failure without spawning more native work", async () => {
  const pending = deferred<number>();
  const read = jest.fn(() => pending.promise);
  const failed = jest.fn();
  const ready = jest.fn();
  const reader = createObservedRead({
    read,
    failed,
    ready,
    active: () => true,
  });
  const first = reader.refresh();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(failed).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) void reader.refresh();
  expect(read).toHaveBeenCalledTimes(1);
  reader.dispose();
  pending.resolve(5);
  await first;
  expect(ready).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it("background reads are skipped and disposal removes the deadline", async () => {
  const read = jest.fn(async () => 1);
  const failed = jest.fn();
  const reader = createObservedRead({
    read,
    failed,
    ready: jest.fn(),
    active: () => false,
  });
  await reader.refresh();
  reader.dispose();
  await jest.advanceTimersByTimeAsync(20_000);
  expect(read).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});
