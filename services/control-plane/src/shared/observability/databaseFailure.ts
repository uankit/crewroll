const failures = {
  "55P03": "DATABASE_LOCK_WAIT_EXPIRED",
  "57014": "DATABASE_STATEMENT_CANCELLED",
  "25P03": "DATABASE_IDLE_TRANSACTION_EXPIRED",
  "40P01": "DATABASE_DEADLOCK",
  "40001": "DATABASE_SERIALIZATION_FAILURE",
} as const;

/** Return an allowlisted category, never PostgreSQL text, SQL or parameters. */
export function databaseFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") {
    const code = error.code;
    if (Object.hasOwn(failures, code))
      return failures[code as keyof typeof failures];
  }
  if (
    error instanceof Error &&
    [
      "Query read timeout",
      "Connection terminated unexpectedly",
      "Client has encountered a connection error and is not queryable",
    ].includes(error.message)
  )
    return "DATABASE_CONNECTION_FAILED";
  return undefined;
}
