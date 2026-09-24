export type DomainErrorKind =
  | "ACTIVE_TRIP_EXISTS"
  | "AUTH_INVALID"
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "DEPENDENCY_NOT_READY"
  | "DEVICE_NOT_OWNED"
  | "DEVICE_NOT_PARTICIPANT"
  | "DEVICE_REVOKED"
  | "IDEMPOTENCY_CONFLICT"
  | "INSTALLATION_OWNED_BY_ANOTHER_USER"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "INVITE_CODE_CONFLICT"
  | "INVITE_INVALID"
  | "KEY_ENVELOPE_INVALID"
  | "KEY_ENVELOPE_MISSING"
  | "MEMBERSHIP_FROZEN"
  | "PENDING_JOIN_REQUESTS"
  | "PHOTO_LIBRARY_ACCESS_REQUIRED"
  | "RATE_LIMITED"
  | "TRIP_STORAGE_LIMIT"
  | "TRIP_DURATION_INVALID"
  | "TRIP_FULL"
  | "TRIP_ID_CONFLICT"
  | "TRIP_OWNER_REQUIRED"
  | "TRIP_STATE_CONFLICT"
  | "VERSION_CONFLICT"
  | "NOT_FOUND";

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind) {
    super("CrewRoll domain error");
    this.name = "DomainError";
    this.kind = kind;
  }
}
