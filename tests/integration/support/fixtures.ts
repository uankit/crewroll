import type { Insertable, Kysely, Selectable } from "kysely";

import type {
  Database,
  DeviceTable,
  TripInviteTable,
  TripKeyEnvelopeTable,
  TripMemberTable,
  TripTable,
  UserActiveTripTable,
  UserTable,
} from "../../../services/control-plane/src/db/schema/tables.js";

type Overrides<T> = Partial<Insertable<T>>;

const FIXED_NOW = new Date("2026-08-29T08:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const P256_PUBLIC_KEY = Uint8Array.from(
  Buffer.from(
    "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
    "base64",
  ),
);

function fixedBytes(fill: number, length = 32): Uint8Array {
  return Uint8Array.from({ length }, () => fill);
}

export interface IdentityTripFixtures {
  user(overrides?: Overrides<UserTable>): Promise<Selectable<UserTable>>;
  device(
    userId: string,
    overrides?: Overrides<DeviceTable>,
  ): Promise<Selectable<DeviceTable>>;
  trip(
    ownerUserId: string,
    overrides?: Overrides<TripTable>,
  ): Promise<Selectable<TripTable>>;
  activeTrip(
    userId: string,
    tripId: string,
    overrides?: Overrides<UserActiveTripTable>,
  ): Promise<Selectable<UserActiveTripTable>>;
  invite(
    tripId: string,
    overrides?: Overrides<TripInviteTable>,
  ): Promise<Selectable<TripInviteTable>>;
  member(
    tripId: string,
    userId: string,
    participatingDeviceId: string,
    overrides?: Overrides<TripMemberTable>,
  ): Promise<Selectable<TripMemberTable>>;
  envelope(
    tripId: string,
    recipientDeviceId: string,
    senderDeviceId: string,
    overrides?: Overrides<TripKeyEnvelopeTable>,
  ): Promise<Selectable<TripKeyEnvelopeTable>>;
}

export function createIdentityTripFixtures(
  db: Kysely<Database>,
): IdentityTripFixtures {
  let sequence = 0;

  function uuid(): string {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  }

  return {
    async user(overrides = {}) {
      const id = uuid();
      return db
        .insertInto("users")
        .values({
          clerk_subject: `user_${id}`,
          created_at: FIXED_NOW,
          deleted_at: null,
          display_name: `Member ${sequence}`,
          id,
          updated_at: FIXED_NOW,
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async device(userId, overrides = {}) {
      const id = uuid();
      return db
        .insertInto("devices")
        .values({
          app_version: "0.2.0",
          authentication_key_algorithm: "P-256",
          authentication_key_version: 1,
          authentication_public_key: P256_PUBLIC_KEY.slice(),
          background_credential_expires_at: new Date(
            FIXED_NOW.getTime() + 30 * ONE_DAY_MS,
          ),
          background_credential_hash: fixedBytes(sequence),
          created_at: FIXED_NOW,
          e2ee_key_algorithm: "X25519",
          e2ee_key_version: 1,
          e2ee_public_key: fixedBytes(sequence),
          encrypted_push_token: null,
          id,
          installation_id: `installation_${id}`,
          last_seen_at: FIXED_NOW,
          platform: "ios",
          push_token_hash: null,
          revoked_at: null,
          updated_at: FIXED_NOW,
          user_id: userId,
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async trip(ownerUserId, overrides = {}) {
      const id = uuid();
      const endsAt = new Date(FIXED_NOW.getTime() + 7 * ONE_DAY_MS);
      return db
        .insertInto("trips")
        .values({
          cancelled_at: null,
          completed_at: null,
          created_at: FIXED_NOW,
          ending_started_at: null,
          ends_at: endsAt,
          hard_delete_at: new Date(endsAt.getTime() + 7 * ONE_DAY_MS),
          id,
          member_count: 1,
          name: `Trip ${sequence}`,
          owner_user_id: ownerUserId,
          release_local_time: null,
          release_mode: "IMMEDIATE",
          release_timezone: null,
          started_at: null,
          state: "LOBBY",
          updated_at: FIXED_NOW,
          version: 1,
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async activeTrip(userId, tripId, overrides = {}) {
      return db
        .insertInto("user_active_trips")
        .values({
          acquired_at: FIXED_NOW,
          trip_id: tripId,
          user_id: userId,
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async invite(tripId, overrides = {}) {
      const id = uuid();
      return db
        .insertInto("trip_invites")
        .values({
          created_at: FIXED_NOW,
          expires_at: new Date(FIXED_NOW.getTime() + ONE_DAY_MS),
          id,
          invite_code_hmac: fixedBytes(sequence),
          max_uses: 9,
          revoked_at: null,
          trip_id: tripId,
          updated_at: FIXED_NOW,
          uses_count: 0,
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async member(tripId, userId, participatingDeviceId, overrides = {}) {
      const id = uuid();
      return db
        .insertInto("trip_members")
        .values({
          approved_at: FIXED_NOW,
          created_at: FIXED_NOW,
          id,
          key_epoch: 1,
          participating_device_id: participatingDeviceId,
          rejected_at: null,
          role: "MEMBER",
          state: "ACTIVE",
          trip_id: tripId,
          updated_at: FIXED_NOW,
          user_id: userId,
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async envelope(tripId, recipientDeviceId, senderDeviceId, overrides = {}) {
      return db
        .insertInto("trip_key_envelopes")
        .values({
          algorithm_version: 1,
          created_at: FIXED_NOW,
          key_epoch: 1,
          recipient_device_id: recipientDeviceId,
          sender_device_id: senderDeviceId,
          trip_id: tripId,
          wrapped_key: fixedBytes(sequence, 148),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  };
}
