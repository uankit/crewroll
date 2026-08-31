const UNIQUE_CONSTRAINTS = new Set([
  "api_idempotency_pk",
  "outbox_events_dedupe_key_unique",
  "trip_invites_invite_code_hmac_key",
  "trip_key_envelopes_pk",
  "trip_members_trip_device_unique",
  "trip_members_trip_epoch_device_unique",
  "trip_members_trip_user_unique",
  "trips_pkey",
  "user_active_trips_pkey",
] as const);

const CHECK_CONSTRAINTS = new Set([
  "trip_invites_hmac_check",
  "trip_invites_uses_check",
  "trip_key_envelopes_version_check",
  "trip_key_envelopes_wrapped_key_check",
  "trip_members_lifecycle_check",
  "trips_duration_check",
  "trips_hard_delete_at_check",
  "trips_member_count_check",
  "trips_name_check",
  "trips_version_check",
] as const);

const FOREIGN_KEY_CONSTRAINTS = new Set([
  "trip_key_envelopes_recipient_member_fk",
  "trip_key_envelopes_sender_member_fk",
  "trip_members_trip_id_fk",
  "trip_members_user_device_fk",
  "trip_members_user_id_fk",
] as const);

export type TripConstraintName =
  | (typeof UNIQUE_CONSTRAINTS extends Set<infer Name> ? Name : never)
  | (typeof CHECK_CONSTRAINTS extends Set<infer Name> ? Name : never)
  | (typeof FOREIGN_KEY_CONSTRAINTS extends Set<infer Name> ? Name : never);

function postgresError(
  error: unknown,
): { readonly code: unknown; readonly constraint: unknown } | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("code" in error) || !("constraint" in error)) return null;
  return error;
}

export function classifyTripConstraint(
  error: unknown,
): TripConstraintName | null {
  const candidate = postgresError(error);
  if (candidate === null || typeof candidate.constraint !== "string") {
    return null;
  }
  if (
    candidate.code === "23505" &&
    UNIQUE_CONSTRAINTS.has(candidate.constraint as never)
  ) {
    return candidate.constraint as TripConstraintName;
  }
  if (
    candidate.code === "23514" &&
    CHECK_CONSTRAINTS.has(candidate.constraint as never)
  ) {
    return candidate.constraint as TripConstraintName;
  }
  if (
    candidate.code === "23503" &&
    FOREIGN_KEY_CONSTRAINTS.has(candidate.constraint as never)
  ) {
    return candidate.constraint as TripConstraintName;
  }
  return null;
}
