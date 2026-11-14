import { OperationDeadlineExceeded, withDeadline } from "./withDeadline";

describe("withDeadline", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("bounds a stalled operation and consumes its late rejection", async () => {
    let reject!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const result = withDeadline(() => operation, 100);
    const assertion = expect(result).rejects.toBeInstanceOf(
      OperationDeadlineExceeded,
    );
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("clears the deadline when an operation succeeds or throws synchronously", async () => {
    await expect(withDeadline(async () => "ready", 100)).resolves.toBe("ready");
    const failure = new Error("failed");
    await expect(
      withDeadline(() => {
        throw failure;
      }, 100),
    ).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });
});
