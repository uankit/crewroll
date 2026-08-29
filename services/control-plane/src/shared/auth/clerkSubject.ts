import { DomainError } from "../errors/domainError.js";

export function requireClerkSubject(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("\u0000") ||
    Array.from(input).length > 255
  ) {
    throw new DomainError("AUTH_INVALID");
  }
  return input;
}
