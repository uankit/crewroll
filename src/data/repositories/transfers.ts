import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import {
  ImmutableRecordConflictError,
  RecordNotFoundError,
} from '../database/errors';
import type {
  TransferDirection,
  TransferRecord,
  TransferState,
} from '../types';
import type { TransferRepository } from './contracts';
import {
  enumValue,
  nullableNumber,
  nullableString,
  requiredNumber,
  requiredString,
} from './rowMapping';

const TRANSFER_DIRECTIONS = ['upload', 'download'] as const;
const TRANSFER_STATES = [
  'queued',
  'transferring',
  'verifying',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

const TERMINAL_TRANSFER_STATES: ReadonlySet<TransferState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

interface TransferRow {
  trip_id: unknown;
  id: unknown;
  resource_id: unknown;
  peer_member_id: unknown;
  direction: unknown;
  state: unknown;
  bytes_transferred: unknown;
  total_bytes: unknown;
  chunk_size: unknown;
  next_chunk_index: unknown;
  attempt_count: unknown;
  last_error: unknown;
  started_at: unknown;
  completed_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const TRANSFER_COLUMNS = `
  trip_id, id, resource_id, peer_member_id, direction, state,
  bytes_transferred, total_bytes, chunk_size, next_chunk_index, attempt_count,
  last_error, started_at, completed_at, created_at, updated_at
`;

function mapTransfer(row: TransferRow): TransferRecord {
  return {
    tripId: requiredString('Transfer', 'trip_id', row.trip_id),
    id: requiredString('Transfer', 'id', row.id),
    resourceId: requiredString('Transfer', 'resource_id', row.resource_id),
    peerMemberId: requiredString('Transfer', 'peer_member_id', row.peer_member_id),
    direction: enumValue(
      'Transfer',
      'direction',
      row.direction,
      TRANSFER_DIRECTIONS,
    ) as TransferDirection,
    state: enumValue('Transfer', 'state', row.state, TRANSFER_STATES) as TransferState,
    bytesTransferred: requiredNumber(
      'Transfer',
      'bytes_transferred',
      row.bytes_transferred,
    ),
    totalBytes: requiredNumber('Transfer', 'total_bytes', row.total_bytes),
    chunkSize: requiredNumber('Transfer', 'chunk_size', row.chunk_size),
    nextChunkIndex: requiredNumber(
      'Transfer',
      'next_chunk_index',
      row.next_chunk_index,
    ),
    attemptCount: requiredNumber('Transfer', 'attempt_count', row.attempt_count),
    lastError: nullableString('Transfer', 'last_error', row.last_error),
    startedAt: nullableNumber('Transfer', 'started_at', row.started_at),
    completedAt: nullableNumber('Transfer', 'completed_at', row.completed_at),
    createdAt: requiredNumber('Transfer', 'created_at', row.created_at),
    updatedAt: requiredNumber('Transfer', 'updated_at', row.updated_at),
  };
}

function immutableTransferContextEqual(left: TransferRecord, right: TransferRecord): boolean {
  return (
    left.tripId === right.tripId &&
    left.id === right.id &&
    left.resourceId === right.resourceId &&
    left.peerMemberId === right.peerMemberId &&
    left.direction === right.direction &&
    left.totalBytes === right.totalBytes &&
    left.chunkSize === right.chunkSize &&
    left.createdAt === right.createdAt
  );
}

function isTransferTransitionAllowed(from: TransferState, to: TransferState): boolean {
  if (TERMINAL_TRANSFER_STATES.has(from)) return from === to;
  if (from === to || to === 'paused' || TERMINAL_TRANSFER_STATES.has(to)) return true;
  if (to === 'queued') return from === 'transferring' || from === 'paused';
  if (to === 'transferring') return from === 'queued' || from === 'paused';
  if (to === 'verifying') {
    return from === 'queued' || from === 'transferring' || from === 'paused';
  }
  return false;
}

function assertNonNegativeSafeInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertValidTransfer(transfer: TransferRecord): void {
  assertNonNegativeSafeInteger('bytesTransferred', transfer.bytesTransferred);
  assertNonNegativeSafeInteger('totalBytes', transfer.totalBytes);
  assertNonNegativeSafeInteger('nextChunkIndex', transfer.nextChunkIndex);
  assertNonNegativeSafeInteger('attemptCount', transfer.attemptCount);
  assertNonNegativeSafeInteger('createdAt', transfer.createdAt);
  assertNonNegativeSafeInteger('updatedAt', transfer.updatedAt);
  if (!Number.isSafeInteger(transfer.chunkSize) || transfer.chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive safe integer.');
  }
  if (transfer.bytesTransferred > transfer.totalBytes) {
    throw new RangeError('bytesTransferred cannot exceed totalBytes.');
  }
  if (transfer.state === 'completed' && transfer.bytesTransferred !== transfer.totalBytes) {
    throw new RangeError('A completed transfer must have all bytes persisted.');
  }
  if (transfer.state === 'verifying' && transfer.bytesTransferred !== transfer.totalBytes) {
    throw new RangeError('A verifying transfer must have all bytes persisted.');
  }
}

export class SqliteTransferRepository implements TransferRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(transfer: TransferRecord): Promise<void> {
    assertValidTransfer(transfer);
    const result = await (await this.client.connection()).runAsync(
      `INSERT INTO transfers (
        trip_id, id, resource_id, peer_member_id, direction, state,
        bytes_transferred, total_bytes, chunk_size, next_chunk_index,
        attempt_count, last_error, started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trip_id, id) DO UPDATE SET
        state = excluded.state,
        bytes_transferred = excluded.bytes_transferred,
        next_chunk_index = excluded.next_chunk_index,
        attempt_count = excluded.attempt_count,
        last_error = excluded.last_error,
        started_at = COALESCE(transfers.started_at, excluded.started_at),
        completed_at = CASE
          WHEN excluded.state = 'completed'
            THEN MAX(
              transfers.updated_at,
              excluded.updated_at,
              COALESCE(excluded.completed_at, 0)
            )
          ELSE transfers.completed_at
        END,
        updated_at = MAX(transfers.updated_at, excluded.updated_at)
      WHERE transfers.state IN ('queued', 'transferring', 'verifying', 'paused')
        AND transfers.resource_id = excluded.resource_id
        AND transfers.peer_member_id = excluded.peer_member_id
        AND transfers.direction = excluded.direction
        AND transfers.total_bytes = excluded.total_bytes
        AND transfers.chunk_size = excluded.chunk_size
        AND transfers.created_at = excluded.created_at
        AND transfers.bytes_transferred <= excluded.bytes_transferred
        AND transfers.next_chunk_index <= excluded.next_chunk_index
        AND transfers.attempt_count <= excluded.attempt_count
        AND (transfers.started_at IS NULL OR transfers.started_at = excluded.started_at)
        AND (excluded.state <> 'verifying'
             OR excluded.bytes_transferred = excluded.total_bytes)
        AND (
          transfers.state = excluded.state
          OR excluded.state IN ('completed', 'failed', 'cancelled', 'paused')
          OR (excluded.state = 'queued'
              AND transfers.state IN ('transferring', 'paused'))
          OR (excluded.state = 'transferring'
              AND transfers.state IN ('queued', 'paused'))
          OR (excluded.state = 'verifying'
              AND transfers.state IN ('queued', 'transferring', 'paused'))
        )`,
      [
        transfer.tripId,
        transfer.id,
        transfer.resourceId,
        transfer.peerMemberId,
        transfer.direction,
        transfer.state,
        transfer.bytesTransferred,
        transfer.totalBytes,
        transfer.chunkSize,
        transfer.nextChunkIndex,
        transfer.attemptCount,
        transfer.lastError,
        transfer.startedAt,
        transfer.completedAt,
        transfer.createdAt,
        transfer.updatedAt,
      ],
    );
    if (result.changes === 1) return;

    const existing = await this.getById(transfer.tripId, transfer.id);
    if (!existing) {
      throw new RecordNotFoundError('Transfer', `${transfer.tripId}/${transfer.id}`);
    }
    if (!immutableTransferContextEqual(existing, transfer)) {
      throw new ImmutableRecordConflictError('Transfer', transfer.id);
    }
    if (!isRecoverableState(existing.state)) {
      if (
        transfer.state === existing.state &&
        transfer.bytesTransferred === existing.bytesTransferred &&
        transfer.nextChunkIndex === existing.nextChunkIndex
      ) {
        return;
      }
      throw new RangeError(`Transfer '${transfer.id}' is already terminal.`);
    }
    if (
      transfer.bytesTransferred < existing.bytesTransferred ||
      transfer.nextChunkIndex < existing.nextChunkIndex
    ) {
      throw new RangeError('Transfer checkpoints must be monotonic.');
    }
    if (transfer.attemptCount < existing.attemptCount) {
      throw new RangeError('Transfer attemptCount must be monotonic.');
    }
    if (!isTransferTransitionAllowed(existing.state, transfer.state)) {
      throw new RangeError(
        `Illegal transfer transition from '${existing.state}' to '${transfer.state}'.`,
      );
    }
    if (existing.startedAt !== null && existing.startedAt !== transfer.startedAt) {
      throw new ImmutableRecordConflictError('Transfer start', transfer.id);
    }
    throw new RangeError(`Transfer '${transfer.id}' failed its compare-and-set update.`);
  }

  async getById(tripId: string, id: string): Promise<TransferRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE trip_id = ? AND id = ?`,
      [tripId, id],
    );
    return row ? mapTransfer(row) : null;
  }

  async listActive(tripId: string): Promise<TransferRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers
       WHERE trip_id = ? AND state IN ('queued', 'transferring', 'verifying', 'paused')
       ORDER BY updated_at ASC, id ASC`,
      tripId,
    );
    return rows.map(mapTransfer);
  }

  async listRecent(tripId: string, limit = 250): Promise<TransferRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('limit must be an integer from 1 to 1,000.');
    }
    const rows = await (await this.client.connection()).getAllAsync<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers
       WHERE trip_id = ?
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      [tripId, limit],
    );
    return rows.map(mapTransfer);
  }

  async removeTerminalBefore(cutoffMs: number): Promise<number> {
    assertNonNegativeSafeInteger('cutoffMs', cutoffMs);
    const result = await (await this.client.connection()).runAsync(
      `DELETE FROM transfers
       WHERE state IN ('completed', 'failed', 'cancelled')
         AND updated_at < ?`,
      cutoffMs,
    );
    return result.changes;
  }

  async updateProgress(
    tripId: string,
    id: string,
    bytesTransferred: number,
    nextChunkIndex: number,
    state: TransferState,
    updatedAtMs: number,
  ): Promise<void> {
    assertNonNegativeSafeInteger('bytesTransferred', bytesTransferred);
    assertNonNegativeSafeInteger('nextChunkIndex', nextChunkIndex);
    assertNonNegativeSafeInteger('updatedAtMs', updatedAtMs);
    if (state === 'paused' || state === 'failed' || state === 'cancelled') {
      throw new RangeError(`updateProgress cannot transition a transfer to '${state}'.`);
    }
    const result = await (await this.client.connection()).runAsync(
      `UPDATE transfers
       SET bytes_transferred = ?, next_chunk_index = ?, state = ?,
           last_error = NULL, updated_at = MAX(updated_at, ?),
           started_at = CASE
             WHEN started_at IS NULL AND ? = 'transferring' THEN ?
             ELSE started_at
           END,
           completed_at = CASE
             WHEN ? = 'completed' THEN MAX(updated_at, ?)
             ELSE completed_at
           END
       WHERE trip_id = ? AND id = ?
         AND bytes_transferred <= ?
         AND next_chunk_index <= ?
         AND total_bytes >= ?
         AND (? <> 'verifying' OR total_bytes = ?)
         AND (? <> 'completed' OR total_bytes = ?)
         AND state IN ('queued', 'transferring', 'verifying', 'paused')
         AND (
           (? = 'queued' AND state IN ('queued', 'transferring', 'paused'))
           OR (? = 'transferring' AND state IN ('queued', 'transferring', 'paused'))
           OR (? = 'verifying'
               AND state IN ('queued', 'transferring', 'verifying', 'paused'))
           OR (? = 'completed')
         )`,
      [
        bytesTransferred,
        nextChunkIndex,
        state,
        updatedAtMs,
        state,
        updatedAtMs,
        state,
        updatedAtMs,
        tripId,
        id,
        bytesTransferred,
        nextChunkIndex,
        bytesTransferred,
        state,
        bytesTransferred,
        state,
        bytesTransferred,
        state,
        state,
        state,
        state,
      ],
    );

    if (result.changes === 1) {
      return;
    }
    const existing = await this.getById(tripId, id);
    if (!existing) {
      throw new RecordNotFoundError('Transfer', `${tripId}/${id}`);
    }
    if (!isRecoverableState(existing.state)) {
      throw new RangeError(`Transfer '${id}' is already terminal.`);
    }
    if (nextChunkIndex < existing.nextChunkIndex) {
      throw new RangeError('Transfer checkpoints must be monotonic.');
    }
    if (!isTransferTransitionAllowed(existing.state, state)) {
      throw new RangeError(
        `Illegal transfer transition from '${existing.state}' to '${state}'.`,
      );
    }
    throw new RangeError(
      `Transfer progress must be monotonic and no greater than ${existing.totalBytes}.`,
    );
  }

  async markPaused(
    tripId: string,
    id: string,
    reason: string,
    updatedAtMs: number,
  ): Promise<void> {
    assertNonNegativeSafeInteger('updatedAtMs', updatedAtMs);
    const result = await (await this.client.connection()).runAsync(
      `UPDATE transfers
       SET state = 'paused',
           attempt_count = attempt_count + CASE WHEN state = 'paused' THEN 0 ELSE 1 END,
           last_error = ?, updated_at = MAX(updated_at, ?)
       WHERE trip_id = ? AND id = ?
         AND state IN ('queued', 'transferring', 'verifying', 'paused')`,
      [reason, updatedAtMs, tripId, id],
    );
    if (result.changes === 1) return;
    const existing = await this.getById(tripId, id);
    if (!existing) {
      throw new RecordNotFoundError('Transfer', `${tripId}/${id}`);
    }
    if (isRecoverableState(existing.state)) {
      throw new RangeError(`Transfer '${id}' failed its compare-and-set pause.`);
    }
    // Pausing a terminal transfer is an idempotent no-op. This matters when a
    // disconnect races the receiver's durable completion transaction.
  }

  async markCancelled(
    tripId: string,
    id: string,
    reason: string,
    updatedAtMs: number,
  ): Promise<boolean> {
    assertNonNegativeSafeInteger('updatedAtMs', updatedAtMs);
    const result = await (await this.client.connection()).runAsync(
      `UPDATE transfers
       SET state = 'cancelled', last_error = ?, updated_at = MAX(updated_at, ?)
       WHERE trip_id = ? AND id = ?
         AND state IN ('queued', 'transferring', 'verifying', 'paused')`,
      [reason, updatedAtMs, tripId, id],
    );
    if (result.changes === 1) return true;
    const existing = await this.getById(tripId, id);
    if (!existing) {
      throw new RecordNotFoundError('Transfer', `${tripId}/${id}`);
    }
    if (isRecoverableState(existing.state)) {
      throw new RangeError(`Transfer '${id}' failed its compare-and-set cancellation.`);
    }
    // Completion/failure racing sibling cleanup is already terminal and must
    // not be overwritten by a late cancellation.
    return false;
  }

  async markFailed(
    tripId: string,
    id: string,
    error: string,
    updatedAtMs: number,
  ): Promise<void> {
    assertNonNegativeSafeInteger('updatedAtMs', updatedAtMs);
    const result = await (await this.client.connection()).runAsync(
      `UPDATE transfers
       SET state = 'failed', attempt_count = attempt_count + 1,
           last_error = ?, updated_at = MAX(updated_at, ?)
       WHERE trip_id = ? AND id = ?
         AND state IN ('queued', 'transferring', 'verifying', 'paused')`,
      [error, updatedAtMs, tripId, id],
    );
    if (result.changes === 1) return;
    const existing = await this.getById(tripId, id);
    if (!existing) {
      throw new RecordNotFoundError('Transfer', `${tripId}/${id}`);
    }
    if (isRecoverableState(existing.state)) {
      throw new RangeError(`Transfer '${id}' failed its compare-and-set failure.`);
    }
    // Terminal attempts remain terminal when a delayed verification failure or
    // disconnect races durable completion.
  }
}

function isRecoverableState(state: TransferState): boolean {
  return state === 'queued' || state === 'transferring' || state === 'verifying' || state === 'paused';
}
