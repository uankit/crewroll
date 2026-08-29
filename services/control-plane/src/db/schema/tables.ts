import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null,
  Date | string | null
>;

export type DevicePlatform = "ios" | "android";
export type TripState =
  | "LOBBY"
  | "ACTIVE"
  | "ENDING"
  | "COMPLETE"
  | "INCOMPLETE_EXPIRED"
  | "CANCELLED";
export type ReleaseMode = "IMMEDIATE" | "NIGHTLY";
export type TripMemberRole = "OWNER" | "MEMBER";
export type TripMemberState = "PENDING_KEY" | "ACTIVE" | "REJECTED";

export interface UserTable {
  id: string;
  clerk_subject: string;
  display_name: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface DeviceTable {
  id: string;
  user_id: string;
  installation_id: string;
  platform: DevicePlatform;
  authentication_key_algorithm: "P-256";
  authentication_public_key: Uint8Array;
  authentication_key_version: 1;
  e2ee_key_algorithm: "X25519";
  e2ee_public_key: Uint8Array;
  e2ee_key_version: 1;
  background_credential_hash: Uint8Array;
  background_credential_expires_at: Timestamp;
  encrypted_push_token: Uint8Array | null;
  push_token_hash: Uint8Array | null;
  app_version: string;
  last_seen_at: Timestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  revoked_at: NullableTimestamp;
}

export interface TripTable {
  id: string;
  owner_user_id: string;
  name: string;
  state: TripState;
  release_mode: ReleaseMode;
  release_timezone: string | null;
  release_local_time: string | null;
  ends_at: Timestamp;
  hard_delete_at: Timestamp;
  member_count: Generated<number>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  started_at: NullableTimestamp;
  ending_started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
}

export interface UserActiveTripTable {
  user_id: string;
  trip_id: string;
  acquired_at: GeneratedTimestamp;
}

export interface TripInviteTable {
  id: string;
  trip_id: string;
  invite_code_hmac: Uint8Array;
  expires_at: Timestamp;
  max_uses: number;
  uses_count: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  revoked_at: NullableTimestamp;
}

export interface TripMemberTable {
  id: string;
  trip_id: string;
  user_id: string;
  participating_device_id: string;
  role: TripMemberRole;
  state: TripMemberState;
  key_epoch: number | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  approved_at: NullableTimestamp;
  rejected_at: NullableTimestamp;
}

export interface TripKeyEnvelopeTable {
  trip_id: string;
  key_epoch: 1;
  recipient_device_id: string;
  sender_device_id: string;
  algorithm_version: 1;
  wrapped_key: Uint8Array;
  created_at: GeneratedTimestamp;
}

export interface Database {
  users: UserTable;
  devices: DeviceTable;
  trips: TripTable;
  user_active_trips: UserActiveTripTable;
  trip_invites: TripInviteTable;
  trip_members: TripMemberTable;
  trip_key_envelopes: TripKeyEnvelopeTable;
}
