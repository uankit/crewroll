import type { SQLiteDatabase } from 'expo-sqlite';

import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import {
  ImmutableRecordConflictError,
  RecordNotFoundError,
} from '../database/errors';
import type { OutboxRecord, OutboxState } from '../types';
import type { OutboxRepository } from './contracts';
import {
  decodeJson,
  encodeJson,
  enumValue,
  nullableNumber,
  nullableString,
  requiredNumber,
  requiredString,
} from './rowMapping';

const OUTBOX_STATES = ['pending', 'in_flight', 'delivered', 'dead_letter'] as const;

interface OutboxRow {
  trip_id: unknown;
  id: unknown;
  recipient_member_id: unknown;
  message_type: unknown;
  payload_json: unknown;
  dedupe_key: unknown;
  state: unknown;
  attempt_count: unknown;
  available_at: unknown;
  lease_owner: unknown;
  lease_expires_at: unknown;
  last_error: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface CountRow {
  count: number;
}

interface NextWakeRow {
  next_wake_at: unknown;
}

const OUTBOX_COLUMNS = `
  trip_id, id, recipient_member_id, message_type, payload_json, dedupe_key,
  state, attempt_count, available_at, lease_owner, lease_expires_at,
  last_error, created_at, updated_at
`;

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    tripId: requiredString('Outbox', 'trip_id', row.trip_id),
    id: requiredString('Outbox', 'id', row.id),
    recipientMemberId: nullableString(
      'Outbox',
      'recipient_member_id',
      row.recipient_member_id,
    ),
    messageType: requiredString('Outbox', 'message_type', row.message_type),
    payload: decodeJson('Outbox', 'payload_json', row.payload_json),
    dedupeKey: nullableString('Outbox', 'dedupe_key', row.dedupe_key),
    state: enumValue('Outbox', 'state', row.state, OUTBOX_STATES) as OutboxState,
    attemptCount: requiredNumber('Outbox', 'attempt_count', row.attempt_count),
    availableAt: requiredNumber('Outbox', 'available_at', row.available_at),
    leaseOwner: nullableString('Outbox', 'lease_owner', row.lease_owner),
    leaseExpiresAt: nullableNumber('Outbox', 'lease_expires_at', row.lease_expires_at),
    lastError: nullableString('Outbox', 'last_error', row.last_error),
    createdAt: requiredNumber('Outbox', 'created_at', row.created_at),
    updatedAt: requiredNumber('Outbox', 'updated_at', row.updated_at),
  };
}

function immutableMessageEqual(left: OutboxRecord, right: OutboxRecord): boolean {
  return (
    left.id === right.id &&
    left.tripId === right.tripId &&
    left.recipientMemberId === right.recipientMemberId &&
    left.messageType === right.messageType &&
    left.dedupeKey === right.dedupeKey &&
    encodeJson(left.payload) === encodeJson(right.payload)
  );
}

function positiveLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('limit must be a positive safe integer.');
  }
  return limit;
}

function nonNegativeTimestamp(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(message: OutboxRecord): Promise<void> {
    await this.client.transaction(async (database) => {
      const existing = await this.getByIdOn(database, message.tripId, message.id);
      if (existing) {
        if (!immutableMessageEqual(existing, message)) {
          throw new ImmutableRecordConflictError('Outbox', message.id);
        }
        return;
      }

      if (message.dedupeKey !== null) {
        const deduplicated = await database.getFirstAsync<OutboxRow>(
          `SELECT ${OUTBOX_COLUMNS}
           FROM outbox
           WHERE trip_id = ? AND dedupe_key = ?`,
          [message.tripId, message.dedupeKey],
        );
        if (deduplicated) {
          throw new ImmutableRecordConflictError(
            'OutboxDedupeKey',
            `${message.tripId}/${message.dedupeKey}`,
          );
        }
      }

      await database.runAsync(
        `INSERT INTO outbox (
          trip_id, id, recipient_member_id, message_type, payload_json,
          dedupe_key, state, attempt_count, available_at, lease_owner,
          lease_expires_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.tripId,
          message.id,
          message.recipientMemberId,
          message.messageType,
          encodeJson(message.payload),
          message.dedupeKey,
          message.state,
          message.attemptCount,
          message.availableAt,
          message.leaseOwner,
          message.leaseExpiresAt,
          message.lastError,
          message.createdAt,
          message.updatedAt,
        ],
      );
    });
  }

  async getById(tripId: string, id: string): Promise<OutboxRecord | null> {
    return this.getByIdOn(await this.client.connection(), tripId, id);
  }

  async countUndelivered(tripId: string): Promise<number> {
    const row = await (await this.client.connection()).getFirstAsync<CountRow>(
      `SELECT COUNT(*) AS count
       FROM outbox
       WHERE trip_id = ? AND state IN ('pending', 'in_flight')`,
      tripId,
    );
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error('SQLite returned an invalid outbox count.');
    }
    return row.count;
  }

  async getNextWakeAt(tripId: string): Promise<number | null> {
    const row = await (await this.client.connection()).getFirstAsync<NextWakeRow>(
      `SELECT MIN(next_wake_at) AS next_wake_at
       FROM (
         SELECT MIN(available_at) AS next_wake_at
         FROM outbox
         WHERE trip_id = ? AND state = 'pending'
         UNION ALL
         SELECT MIN(lease_expires_at) AS next_wake_at
         FROM outbox
         WHERE trip_id = ? AND state = 'in_flight'
       )`,
      [tripId, tripId],
    );
    const value = row ? nullableNumber('Outbox', 'next_wake_at', row.next_wake_at) : null;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('SQLite returned an invalid next outbox wake time.');
    }
    return value;
  }

  async claimDue(
    tripId: string,
    nowMs: number,
    limit: number,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<OutboxRecord[]> {
    if (leaseExpiresAtMs <= nowMs) {
      throw new RangeError('leaseExpiresAtMs must be later than nowMs.');
    }

    return this.client.transaction(async (database) => {
      const candidates = await database.getAllAsync<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS}
         FROM outbox
         WHERE trip_id = ?
           AND available_at <= ?
           AND (
             state = 'pending'
             OR (state = 'in_flight' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )
         ORDER BY available_at ASC, created_at ASC, id ASC
         LIMIT ?`,
        [tripId, nowMs, nowMs, positiveLimit(limit)],
      );

      const claimed: OutboxRecord[] = [];
      for (const candidate of candidates) {
        const id = requiredString('Outbox', 'id', candidate.id);
        await database.runAsync(
          `UPDATE outbox
           SET state = 'in_flight',
               attempt_count = attempt_count + 1,
               lease_owner = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE trip_id = ? AND id = ?`,
          [leaseOwner, leaseExpiresAtMs, nowMs, tripId, id],
        );
        const updated = await this.getByIdOn(database, tripId, id);
        if (!updated) {
          throw new RecordNotFoundError('Outbox', `${tripId}/${id}`);
        }
        claimed.push(updated);
      }
      return claimed;
    });
  }

  async markDelivered(tripId: string, id: string, updatedAtMs: number): Promise<void> {
    await this.requireUpdate(
      tripId,
      id,
      `UPDATE outbox
       SET state = 'delivered', lease_owner = NULL, lease_expires_at = NULL,
           last_error = NULL, updated_at = ?
       WHERE trip_id = ? AND id = ?`,
      [updatedAtMs, tripId, id],
    );
  }

  async reschedule(
    tripId: string,
    id: string,
    availableAtMs: number,
    lastError: string,
    updatedAtMs: number,
  ): Promise<void> {
    await this.requireUpdate(
      tripId,
      id,
      `UPDATE outbox
       SET state = 'pending', available_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?
       WHERE trip_id = ? AND id = ?`,
      [availableAtMs, lastError, updatedAtMs, tripId, id],
    );
  }

  async markDeadLetter(
    tripId: string,
    id: string,
    lastError: string,
    updatedAtMs: number,
  ): Promise<void> {
    await this.requireUpdate(
      tripId,
      id,
      `UPDATE outbox
       SET state = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
           last_error = ?, updated_at = ?
       WHERE trip_id = ? AND id = ?`,
      [lastError, updatedAtMs, tripId, id],
    );
  }

  async removeDeliveredBefore(cutoffMs: number): Promise<number> {
    nonNegativeTimestamp('cutoffMs', cutoffMs);
    const result = await (await this.client.connection()).runAsync(
      `DELETE FROM outbox WHERE state = 'delivered' AND updated_at < ?`,
      cutoffMs,
    );
    return result.changes;
  }

  async removeDeadLetterBefore(cutoffMs: number): Promise<number> {
    nonNegativeTimestamp('cutoffMs', cutoffMs);
    const result = await (await this.client.connection()).runAsync(
      `DELETE FROM outbox WHERE state = 'dead_letter' AND updated_at < ?`,
      cutoffMs,
    );
    return result.changes;
  }

  private async getByIdOn(
    database: SQLiteDatabase,
    tripId: string,
    id: string,
  ): Promise<OutboxRecord | null> {
    const row = await database.getFirstAsync<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE trip_id = ? AND id = ?`,
      [tripId, id],
    );
    return row ? mapOutbox(row) : null;
  }

  private async requireUpdate(
    tripId: string,
    id: string,
    sql: string,
    parameters: (string | number | null)[],
  ): Promise<void> {
    const result = await (await this.client.connection()).runAsync(sql, parameters);
    if (result.changes !== 1) {
      throw new RecordNotFoundError('Outbox', `${tripId}/${id}`);
    }
  }
}
