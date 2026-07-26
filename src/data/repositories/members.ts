import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import { RecordNotFoundError } from '../database/errors';
import type {
  MemberRecord,
  MemberRole,
  MemberStatus,
  ReplicaRole,
} from '../types';
import type { MemberRepository } from './contracts';
import {
  enumValue,
  nullableNumber,
  requiredNumber,
  requiredString,
} from './rowMapping';

const MEMBER_ROLES = ['ADMIN', 'MEMBER'] as const;
const MEMBER_STATUSES = ['ACTIVE', 'LEAVING', 'LEFT', 'REMOVED'] as const;
const REPLICA_ROLES = ['NONE', 'KEEPER_PRIMARY', 'KEEPER_SECONDARY', 'WITNESS'] as const;

interface MemberRow {
  trip_id: unknown;
  id: unknown;
  schema_version: unknown;
  device_id: unknown;
  display_name: unknown;
  identity_public_key: unknown;
  role: unknown;
  status: unknown;
  replica_role: unknown;
  joined_at_ms: unknown;
  updated_at_ms: unknown;
  left_at_ms: unknown;
  membership_epoch: unknown;
}

const MEMBER_COLUMNS = `
  trip_id, id, schema_version, device_id, display_name, identity_public_key, role, status,
  replica_role, joined_at_ms, updated_at_ms, left_at_ms, membership_epoch
`;

function mapMember(row: MemberRow): MemberRecord {
  return {
    schemaVersion: requiredNumber('Member', 'schema_version', row.schema_version),
    tripId: requiredString('Member', 'trip_id', row.trip_id),
    id: requiredString('Member', 'id', row.id),
    deviceId: requiredString('Member', 'device_id', row.device_id),
    displayName: requiredString('Member', 'display_name', row.display_name),
    identityPublicKey: requiredString(
      'Member',
      'identity_public_key',
      row.identity_public_key,
    ),
    role: enumValue('Member', 'role', row.role, MEMBER_ROLES) as MemberRole,
    status: enumValue('Member', 'status', row.status, MEMBER_STATUSES) as MemberStatus,
    replicaRole: enumValue(
      'Member',
      'replica_role',
      row.replica_role,
      REPLICA_ROLES,
    ) as ReplicaRole,
    joinedAtMs: requiredNumber('Member', 'joined_at_ms', row.joined_at_ms),
    updatedAtMs: requiredNumber('Member', 'updated_at_ms', row.updated_at_ms),
    leftAtMs: nullableNumber('Member', 'left_at_ms', row.left_at_ms),
    membershipEpoch: requiredNumber('Member', 'membership_epoch', row.membership_epoch),
  };
}

export class SqliteMemberRepository implements MemberRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(member: MemberRecord): Promise<void> {
    await (await this.client.connection()).runAsync(
      `INSERT INTO members (
        trip_id, id, schema_version, device_id, display_name, identity_public_key, role, status,
        replica_role, joined_at_ms, updated_at_ms, left_at_ms, membership_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trip_id, id) DO UPDATE SET
        schema_version = excluded.schema_version,
        device_id = excluded.device_id,
        display_name = excluded.display_name,
        identity_public_key = excluded.identity_public_key,
        role = excluded.role,
        status = excluded.status,
        replica_role = excluded.replica_role,
        joined_at_ms = excluded.joined_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        left_at_ms = excluded.left_at_ms,
        membership_epoch = excluded.membership_epoch`,
      [
        member.tripId,
        member.id,
        member.schemaVersion,
        member.deviceId,
        member.displayName,
        member.identityPublicKey,
        member.role,
        member.status,
        member.replicaRole,
        member.joinedAtMs,
        member.updatedAtMs,
        member.leftAtMs,
        member.membershipEpoch,
      ],
    );
  }

  async getById(tripId: string, memberId: string): Promise<MemberRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE trip_id = ? AND id = ?`,
      [tripId, memberId],
    );
    return row ? mapMember(row) : null;
  }

  async getByDeviceId(tripId: string, deviceId: string): Promise<MemberRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<MemberRow>(
      `SELECT ${MEMBER_COLUMNS}
       FROM members
       WHERE trip_id = ? AND device_id = ?
       ORDER BY
         CASE status WHEN 'ACTIVE' THEN 0 WHEN 'LEAVING' THEN 1 ELSE 2 END,
         updated_at_ms DESC,
         id ASC
       LIMIT 1`,
      [tripId, deviceId],
    );
    return row ? mapMember(row) : null;
  }

  async listByTrip(tripId: string): Promise<MemberRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<MemberRow>(
      `SELECT ${MEMBER_COLUMNS}
       FROM members
       WHERE trip_id = ?
       ORDER BY joined_at_ms ASC, id ASC`,
      tripId,
    );
    return rows.map(mapMember);
  }

  async setStatus(
    tripId: string,
    memberId: string,
    status: MemberStatus,
    leftAtMs: number | null,
    membershipEpoch: number,
    updatedAtMs: number,
  ): Promise<void> {
    const result = await (await this.client.connection()).runAsync(
      `UPDATE members
       SET status = ?, left_at_ms = ?, membership_epoch = ?, updated_at_ms = ?
       WHERE trip_id = ? AND id = ?`,
      [status, leftAtMs, membershipEpoch, updatedAtMs, tripId, memberId],
    );
    if (result.changes !== 1) {
      throw new RecordNotFoundError('Member', `${tripId}/${memberId}`);
    }
  }
}
