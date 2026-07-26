import type { SQLiteDatabase } from 'expo-sqlite';

import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import {
  ImmutableRecordConflictError,
  SequenceConflictError,
} from '../database/errors';
import type {
  SyncOperationKind,
  SyncOperationRecord,
} from '../types';
import type { SyncOperationRepository } from './contracts';
import {
  decodeJson,
  encodeJson,
  enumValue,
  requiredNumber,
  requiredString,
} from './rowMapping';

const OPERATION_KINDS = [
  'TRIP_CREATED',
  'TRIP_STATUS_CHANGED',
  'MEMBER_JOINED',
  'MEMBER_STATUS_CHANGED',
  'MEDIA_PREVIEW_PUBLISHED',
  'MEDIA_ORIGINAL_PUBLISHED',
  'MEDIA_PUBLISHED',
  'MEDIA_TOMBSTONED',
  'REPLICA_RECORDED',
  'REPLICA_STATUS_CHANGED',
] as const;

interface SyncOperationRow {
  trip_id: unknown;
  operation_id: unknown;
  schema_version: unknown;
  origin_device_id: unknown;
  origin_sequence: unknown;
  actor_member_id: unknown;
  membership_epoch: unknown;
  created_at_ms: unknown;
  kind: unknown;
  payload_json: unknown;
}

interface SequenceRow {
  origin_device_id: unknown;
  origin_sequence: unknown;
}

const OPERATION_COLUMNS = `
  trip_id, operation_id, schema_version, origin_device_id, origin_sequence,
  actor_member_id, membership_epoch, created_at_ms, kind, payload_json
`;

function mapOperation(row: SyncOperationRow): SyncOperationRecord {
  const stored = decodeStoredPayload(row.payload_json);
  return {
    tripId: requiredString('SyncOperation', 'trip_id', row.trip_id),
    operationId: requiredString('SyncOperation', 'operation_id', row.operation_id),
    schemaVersion: requiredNumber('SyncOperation', 'schema_version', row.schema_version),
    originDeviceId: requiredString(
      'SyncOperation',
      'origin_device_id',
      row.origin_device_id,
    ),
    originSequence: requiredNumber(
      'SyncOperation',
      'origin_sequence',
      row.origin_sequence,
    ),
    actorMemberId: requiredString(
      'SyncOperation',
      'actor_member_id',
      row.actor_member_id,
    ),
    membershipEpoch: requiredNumber(
      'SyncOperation',
      'membership_epoch',
      row.membership_epoch,
    ),
    createdAtMs: requiredNumber('SyncOperation', 'created_at_ms', row.created_at_ms),
    originIdentityPublicKey: stored.originIdentityPublicKey,
    originSignature: stored.originSignature,
    kind: enumValue(
      'SyncOperation',
      'kind',
      row.kind,
      OPERATION_KINDS,
    ) as SyncOperationKind,
    payload: stored.payload,
  };
}

function operationsEqual(left: SyncOperationRecord, right: SyncOperationRecord): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.operationId === right.operationId &&
    left.tripId === right.tripId &&
    left.originDeviceId === right.originDeviceId &&
    left.originSequence === right.originSequence &&
    left.actorMemberId === right.actorMemberId &&
    left.membershipEpoch === right.membershipEpoch &&
    left.createdAtMs === right.createdAtMs &&
    (left.originIdentityPublicKey ?? null) === (right.originIdentityPublicKey ?? null) &&
    (left.originSignature ?? null) === (right.originSignature ?? null) &&
    left.kind === right.kind &&
    encodeJson(left.payload) === encodeJson(right.payload)
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export class SqliteSyncOperationRepository implements SyncOperationRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  append(operation: SyncOperationRecord): Promise<boolean> {
    return this.client.transaction((database) => this.appendOn(database, operation));
  }

  appendMany(operations: readonly SyncOperationRecord[]): Promise<number> {
    return this.client.transaction(async (database) => {
      let inserted = 0;
      for (const operation of operations) {
        if (await this.appendOn(database, operation)) {
          inserted += 1;
        }
      }
      return inserted;
    });
  }

  async getById(tripId: string, operationId: string): Promise<SyncOperationRecord | null> {
    return this.getByIdOn(await this.client.connection(), tripId, operationId);
  }

  async listRange(
    tripId: string,
    originDeviceId: string,
    afterSequence: number,
    throughSequence: number | null,
    limit: number,
  ): Promise<SyncOperationRecord[]> {
    nonNegativeInteger(afterSequence, 'afterSequence');
    positiveInteger(limit, 'limit');
    if (throughSequence !== null) {
      positiveInteger(throughSequence, 'throughSequence');
      if (throughSequence <= afterSequence) {
        return [];
      }
    }

    const database = await this.client.connection();
    const rows = throughSequence === null
      ? await database.getAllAsync<SyncOperationRow>(
          `SELECT ${OPERATION_COLUMNS}
           FROM sync_operations
           WHERE trip_id = ? AND origin_device_id = ? AND origin_sequence > ?
           ORDER BY origin_sequence ASC, operation_id ASC
           LIMIT ?`,
          [tripId, originDeviceId, afterSequence, limit],
        )
      : await database.getAllAsync<SyncOperationRow>(
          `SELECT ${OPERATION_COLUMNS}
           FROM sync_operations
           WHERE trip_id = ? AND origin_device_id = ?
             AND origin_sequence > ? AND origin_sequence <= ?
           ORDER BY origin_sequence ASC, operation_id ASC
           LIMIT ?`,
          [tripId, originDeviceId, afterSequence, throughSequence, limit],
        );
    return rows.map(mapOperation);
  }

  async getContiguousHighWaterMarks(tripId: string): Promise<Record<string, number>> {
    const rows = await (await this.client.connection()).getAllAsync<SequenceRow>(
      `SELECT origin_device_id, origin_sequence
       FROM sync_operations
       WHERE trip_id = ?
       ORDER BY origin_device_id ASC, origin_sequence ASC`,
      tripId,
    );

    const highWaterMarks: Record<string, number> = {};
    let currentDevice: string | null = null;
    let highWater = 0;
    let encounteredGap = false;

    for (const row of rows) {
      const deviceId = requiredString(
        'SyncOperation',
        'origin_device_id',
        row.origin_device_id,
      );
      const sequence = requiredNumber(
        'SyncOperation',
        'origin_sequence',
        row.origin_sequence,
      );

      if (deviceId !== currentDevice) {
        if (currentDevice !== null) {
          highWaterMarks[currentDevice] = highWater;
        }
        currentDevice = deviceId;
        highWater = 0;
        encounteredGap = false;
      }

      if (!encounteredGap && sequence === highWater + 1) {
        highWater = sequence;
      } else if (sequence > highWater + 1) {
        encounteredGap = true;
      }
    }

    if (currentDevice !== null) {
      highWaterMarks[currentDevice] = highWater;
    }
    return highWaterMarks;
  }

  private async appendOn(
    database: SQLiteDatabase,
    operation: SyncOperationRecord,
  ): Promise<boolean> {
    const byId = await this.getByIdOn(database, operation.tripId, operation.operationId);
    if (byId) {
      if (!operationsEqual(byId, operation)) {
        throw new ImmutableRecordConflictError('SyncOperation', operation.operationId);
      }
      return false;
    }

    const sequenceRow = await database.getFirstAsync<SyncOperationRow>(
      `SELECT ${OPERATION_COLUMNS}
       FROM sync_operations
       WHERE trip_id = ? AND origin_device_id = ? AND origin_sequence = ?`,
      [operation.tripId, operation.originDeviceId, operation.originSequence],
    );
    if (sequenceRow) {
      const existing = mapOperation(sequenceRow);
      if (!operationsEqual(existing, operation)) {
        throw new SequenceConflictError(
          operation.tripId,
          operation.originDeviceId,
          operation.originSequence,
        );
      }
      return false;
    }

    await database.runAsync(
      `INSERT INTO sync_operations (
        trip_id, operation_id, schema_version, origin_device_id, origin_sequence,
        actor_member_id, membership_epoch, created_at_ms, kind, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.tripId,
        operation.operationId,
        operation.schemaVersion,
        operation.originDeviceId,
        operation.originSequence,
        operation.actorMemberId,
        operation.membershipEpoch,
        operation.createdAtMs,
        operation.kind,
        encodeStoredPayload(operation),
      ],
    );
    return true;
  }

  private async getByIdOn(
    database: SQLiteDatabase,
    tripId: string,
    operationId: string,
  ): Promise<SyncOperationRecord | null> {
    const row = await database.getFirstAsync<SyncOperationRow>(
      `SELECT ${OPERATION_COLUMNS}
       FROM sync_operations
       WHERE trip_id = ? AND operation_id = ?`,
      [tripId, operationId],
    );
    return row ? mapOperation(row) : null;
  }
}

const STORED_OPERATION_ENVELOPE = 'airmesh-signed-operation-v1';

function encodeStoredPayload(operation: SyncOperationRecord): string {
  const publicKey = operation.originIdentityPublicKey ?? null;
  const signature = operation.originSignature ?? null;
  if ((publicKey === null) !== (signature === null)) {
    throw new Error('Sync operation identity key and signature must be stored together.');
  }
  if (publicKey === null) return encodeJson(operation.payload);
  return encodeJson({
    _format: STORED_OPERATION_ENVELOPE,
    payload: operation.payload,
    originIdentityPublicKey: publicKey,
    originSignature: signature,
  });
}

function decodeStoredPayload(value: unknown): {
  payload: SyncOperationRecord['payload'];
  originIdentityPublicKey: string | null;
  originSignature: string | null;
} {
  const decoded = decodeJson('SyncOperation', 'payload_json', value);
  if (
    decoded !== null &&
    !Array.isArray(decoded) &&
    typeof decoded === 'object' &&
    decoded._format === STORED_OPERATION_ENVELOPE &&
    typeof decoded.originIdentityPublicKey === 'string' &&
    typeof decoded.originSignature === 'string' &&
    Object.prototype.hasOwnProperty.call(decoded, 'payload')
  ) {
    return {
      payload: decoded.payload as SyncOperationRecord['payload'],
      originIdentityPublicKey: decoded.originIdentityPublicKey,
      originSignature: decoded.originSignature,
    };
  }
  return { payload: decoded, originIdentityPublicKey: null, originSignature: null };
}
