import { DomainError } from "../../shared/errors/domainError.js";

export const idempotencyLifetimeSeconds = 86_400;

export function addWholeSeconds(now: Date, seconds: number): Date {
  const milliseconds = now.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds % 1_000 !== 0 ||
    !Number.isSafeInteger(seconds)
  ) {
    throw new DomainError("INTERNAL_ERROR");
  }
  return new Date(milliseconds + seconds * 1_000);
}
