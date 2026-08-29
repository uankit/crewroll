import { DomainError } from "../errors/domainError.js";

export type AuthorizationHeader = string | readonly string[] | undefined;

export function requireBearerToken(header: AuthorizationHeader): string {
  if (header === undefined || (Array.isArray(header) && header.length === 0)) {
    throw new DomainError("AUTH_REQUIRED");
  }
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new DomainError("AUTH_INVALID");
  }

  const token = header.slice("Bearer ".length);
  if (
    token.length === 0 ||
    token.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    throw new DomainError("AUTH_INVALID");
  }
  return token;
}
