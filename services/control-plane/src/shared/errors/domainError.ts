export type DomainErrorKind =
  | "AUTH_INVALID"
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "DEPENDENCY_NOT_READY"
  | "DEVICE_NOT_OWNED"
  | "DEVICE_REVOKED"
  | "IDEMPOTENCY_CONFLICT"
  | "INSTALLATION_OWNED_BY_ANOTHER_USER"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "NOT_FOUND";

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind) {
    super("CrewRoll domain error");
    this.name = "DomainError";
    this.kind = kind;
  }
}
