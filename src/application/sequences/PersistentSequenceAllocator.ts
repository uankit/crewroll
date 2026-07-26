import { sha256Hex } from '@/application/media/contentIdentity';
import type {
  MonotonicSequenceAllocator,
  MonotonicSequenceRequest,
} from '@/application/media/MediaIngestionService';
import type { DeviceSettingsRepository } from '@/data';

const encoder = new TextEncoder();

interface SequenceRepositories {
  deviceSettings: Pick<DeviceSettingsRepository, 'get' | 'set'>;
}

export interface SequencePersistence {
  transaction<T>(task: (repositories: SequenceRepositories) => Promise<T>): Promise<T>;
}

/**
 * Transactionally reserves gap-free stream sequences and remembers an
 * idempotency key. A retry after a file/DB interruption receives the original
 * number instead of creating a reconciliation gap.
 */
export class PersistentSequenceAllocator implements MonotonicSequenceAllocator {
  constructor(
    private readonly persistence: SequencePersistence,
    private readonly stream: 'media' | 'operation' | 'wire',
    private readonly now: () => number = Date.now,
  ) {}

  allocate(request: MonotonicSequenceRequest): Promise<number> {
    validateRequest(request);
    const counterKey = `trip.${request.tripId}.sequence.${this.stream}.${request.originDeviceId}`;
    const reservationKey = `${counterKey}.reservation.${sha256Hex(
      encoder.encode(request.idempotencyKey),
    )}`;

    return this.persistence.transaction(async ({ deviceSettings }) => {
      const reservation = await deviceSettings.get<number>(reservationKey);
      if (reservation) {
        return positiveSafeInteger(reservation.value, 'stored reservation');
      }

      const counter = await deviceSettings.get<number>(counterKey);
      const previous = counter ? nonNegativeSafeInteger(counter.value, 'stored counter') : 0;
      if (previous === Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`The ${this.stream} sequence is exhausted.`);
      }
      const sequence = previous + 1;
      const updatedAt = this.now();
      await deviceSettings.set({ key: counterKey, value: sequence, updatedAt });
      await deviceSettings.set({ key: reservationKey, value: sequence, updatedAt });
      return sequence;
    });
  }
}

function validateRequest(request: MonotonicSequenceRequest): void {
  if (!request.tripId.trim() || !request.originDeviceId.trim()) {
    throw new Error('tripId and originDeviceId are required.');
  }
  if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 512) {
    throw new Error('idempotencyKey must contain 1–512 characters.');
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}
