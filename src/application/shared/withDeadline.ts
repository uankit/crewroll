export class OperationDeadlineExceeded extends Error {
  constructor() {
    super("OPERATION_DEADLINE_EXCEEDED");
    this.name = "OperationDeadlineExceeded";
  }
}

/** Bounds the caller's wait. Callers must fence or cancel any late side effects. */
export async function withDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OperationDeadlineExceeded()),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
