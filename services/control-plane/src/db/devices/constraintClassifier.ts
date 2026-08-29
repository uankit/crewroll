const RETRYABLE_DEVICE_CONSTRAINTS = new Set([
  "api_idempotency_pk",
  "devices_installation_id_unique",
  "users_clerk_subject_key",
]);

interface PostgreSqlConstraintError {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

export type DeviceConstraintClassification =
  "not-device-race" | "retryable-unique-race";

export function classifyDeviceConstraint(
  error: unknown,
): DeviceConstraintClassification {
  if (typeof error !== "object" || error === null) return "not-device-race";
  const candidate = error as PostgreSqlConstraintError;
  return candidate.code === "23505" &&
    typeof candidate.constraint === "string" &&
    RETRYABLE_DEVICE_CONSTRAINTS.has(candidate.constraint)
    ? "retryable-unique-race"
    : "not-device-race";
}
