import { describe, expect, it } from 'vitest';

import { parseDeviceId, parseTripId } from '../../core/ids';
import { assertParsed } from '../../core/validation';
import type { AirMeshDataLayer, DeviceSettingRecord, JsonValue } from '@/data';

import { DataLayerReplayGuard, DataLayerWireCounter } from './counters';

const tripId = assertParsed(parseTripId('trip:counter-test'));
const senderDeviceId = assertParsed(parseDeviceId('device:counter-test'));

function memorySettingsData(): Pick<AirMeshDataLayer, 'transaction'> {
  const values = new Map<string, DeviceSettingRecord>();
  let lock = Promise.resolve();
  return {
    transaction: async (task) => {
      let release!: () => void;
      const previous = lock;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await task({
          deviceSettings: {
            get: async <T extends JsonValue>(key: string) =>
              (values.get(key) as DeviceSettingRecord<T> | undefined) ?? null,
            set: async <T extends JsonValue>(record: DeviceSettingRecord<T>) => {
              values.set(record.key, record);
            },
            remove: async (key: string) => values.delete(key),
            list: async () => [...values.values()],
          },
        } as Parameters<typeof task>[0]);
      } finally {
        release();
      }
    },
  };
}

describe('persistent secure-frame counters', () => {
  it('allocates atomically and survives service recreation', async () => {
    const data = memorySettingsData();
    const first = new DataLayerWireCounter(data);
    const request = { tripId, senderDeviceId, keyEpoch: 4 } as const;

    expect(await Promise.all([first.next(request), first.next(request), first.next(request)])).toEqual([
      1, 2, 3,
    ]);
    const afterRestart = new DataLayerWireCounter(data);
    expect(await afterRestart.next(request)).toBe(257);
    expect(await afterRestart.next(request)).toBe(258);
  });

  it('persists one reservation instead of writing SQLite for every frame', async () => {
    const data = memorySettingsData();
    const counter = new DataLayerWireCounter(data, 4);
    const request = { tripId, senderDeviceId, keyEpoch: 7 } as const;

    expect(await Promise.all(Array.from({ length: 6 }, () => counter.next(request)))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(await new DataLayerWireCounter(data, 4).next(request)).toBe(9);
  });

  it('durably rejects duplicate and stale frames while allowing bounded reordering', async () => {
    const data = memorySettingsData();
    const guard = new DataLayerReplayGuard(data, 8);
    const input = { tripId, senderDeviceId, keyEpoch: 2 } as const;

    expect(await guard.accept({ ...input, senderCounter: 10 })).toBe(true);
    expect(await guard.accept({ ...input, senderCounter: 8 })).toBe(true);
    expect(await guard.accept({ ...input, senderCounter: 8 })).toBe(false);
    expect(await guard.accept({ ...input, senderCounter: 2 })).toBe(false);
    expect(
      await new DataLayerReplayGuard(data, 8).accept({ ...input, senderCounter: 10 }),
    ).toBe(false);
  });
});
