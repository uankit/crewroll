export type DomainErrorKind =
  "DEPENDENCY_NOT_READY" | "INTERNAL_ERROR" | "INVALID_REQUEST" | "NOT_FOUND";

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind) {
    super("CrewRoll domain error");
    this.name = "DomainError";
    this.kind = kind;
  }
}
