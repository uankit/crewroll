import type { SecureFrameReplayGuard } from '@/core/security';
import type { DeviceId, TripId } from '@/core/ids';
import type { AirMeshDataLayer, JsonValue } from '@/data';

export interface WireCounterRequest {
  readonly tripId: TripId;
  readonly senderDeviceId: DeviceId;
  readonly keyEpoch: number;
}

export interface PersistentWireCounter {
  next(request: WireCounterRequest): Promise<number>;
}

type TransactionalDataLayer = Pick<AirMeshDataLayer, 'transaction'>;

export class DataLayerWireCounter implements PersistentWireCounter {
  private readonly ranges = new Map<string, { next: number; end: number }>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly data: TransactionalDataLayer,
    private readonly reservationSize = 256,
  ) {
    if (
      !Number.isSafeInteger(reservationSize) ||
      reservationSize < 1 ||
      reservationSize > 4_096
    ) {
      throw new RangeError('reservationSize must be an integer from 1 through 4096.');
    }
  }

  next(request: WireCounterRequest): Promise<number> {
    validateEpoch(request.keyEpoch);
    const key = wireCounterSettingKey(request);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const allocation = previous
      .catch(() => undefined)
      .then(() => this.nextLocked(key));
    this.tails.set(key, allocation);
    void allocation.then(
      () => {
        if (this.tails.get(key) === allocation) this.tails.delete(key);
      },
      () => {
        if (this.tails.get(key) === allocation) this.tails.delete(key);
      },
    );
    return allocation;
  }

  private async nextLocked(key: string): Promise<number> {
    const existing = this.ranges.get(key);
    if (existing && existing.next <= existing.end) {
      const value = existing.next;
      existing.next += 1;
      return value;
    }

    const reserved = await this.data.transaction(async (repositories) => {
      const current = await repositories.deviceSettings.get<number>(key);
      const previous = current?.value ?? 0;
      if (
        !Number.isSafeInteger(previous) ||
        previous < 0 ||
        previous > Number.MAX_SAFE_INTEGER - this.reservationSize
      ) {
        throw new Error(`Persisted wire counter '${key}' is invalid or exhausted.`);
      }
      const end = previous + this.reservationSize;
      await repositories.deviceSettings.set({ key, value: end, updatedAt: Date.now() });
      return { next: previous + 1, end };
    });
    this.ranges.set(key, { next: reserved.next + 1, end: reserved.end });
    return reserved.next;
  }
}

interface ReplayWindowRecord {
  readonly highest: number;
  readonly seen: readonly number[];
}

export class DataLayerReplayGuard implements SecureFrameReplayGuard {
  constructor(
    private readonly data: TransactionalDataLayer,
    private readonly windowSize = 128,
  ) {
    if (!Number.isSafeInteger(windowSize) || windowSize < 8 || windowSize > 1_024) {
      throw new RangeError('Replay window size must be an integer from 8 through 1024.');
    }
  }

  accept(input: {
    readonly tripId: TripId;
    readonly senderDeviceId: DeviceId;
    readonly keyEpoch: number;
    readonly senderCounter: number;
  }): Promise<boolean> {
    validateEpoch(input.keyEpoch);
    if (!Number.isSafeInteger(input.senderCounter) || input.senderCounter < 1) {
      return Promise.resolve(false);
    }
    const key = replaySettingKey(input);
    return this.data.transaction(async (repositories) => {
      const stored = await repositories.deviceSettings.get<JsonValue>(key);
      const current = parseReplayWindow(stored?.value);
      const floor = Math.max(1, current.highest - this.windowSize + 1);
      if (input.senderCounter < floor || current.seen.includes(input.senderCounter)) {
        return false;
      }
      const highest = Math.max(current.highest, input.senderCounter);
      const nextFloor = Math.max(1, highest - this.windowSize + 1);
      const seen = [...current.seen, input.senderCounter]
        .filter((counter) => counter >= nextFloor)
        .sort((left, right) => left - right);
      await repositories.deviceSettings.set({
        key,
        value: { highest, seen },
        updatedAt: Date.now(),
      });
      return true;
    });
  }
}

export function wireCounterSettingKey(request: WireCounterRequest): string {
  return `sync.wire.v1:${request.tripId}:${request.senderDeviceId}:${request.keyEpoch}`;
}

export function replaySettingKey(input: {
  readonly tripId: TripId;
  readonly senderDeviceId: DeviceId;
  readonly keyEpoch: number;
}): string {
  return `sync.replay.v1:${input.tripId}:${input.senderDeviceId}:${input.keyEpoch}`;
}

function parseReplayWindow(value: JsonValue | undefined): ReplayWindowRecord {
  if (value === undefined) return { highest: 0, seen: [] };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Persisted replay window is not an object.');
  }
  const highest = value.highest;
  const seen = value.seen;
  if (
    typeof highest !== 'number' ||
    !Number.isSafeInteger(highest) ||
    highest < 0 ||
    !Array.isArray(seen) ||
    seen.some(
      (counter) =>
        typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 1,
    )
  ) {
    throw new Error('Persisted replay window is malformed.');
  }
  return { highest, seen: seen as number[] };
}

function validateEpoch(keyEpoch: number): void {
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) {
    throw new RangeError('keyEpoch must be a non-negative safe integer.');
  }
}
