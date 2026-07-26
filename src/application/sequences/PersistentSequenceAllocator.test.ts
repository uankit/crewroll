import { describe, expect, it } from 'vitest';

import type { DeviceSettingRecord, JsonValue } from '@/data/types';

import { PersistentSequenceAllocator } from './PersistentSequenceAllocator';

describe('PersistentSequenceAllocator', () => {
  it('reuses reservations and advances for a new idempotency key', async () => {
    const values = new Map<string, DeviceSettingRecord>();
    const allocator = new PersistentSequenceAllocator(
      {
        transaction: async (task) =>
          task({
            deviceSettings: {
              get: async <T extends JsonValue>(key: string) =>
                (values.get(key) as DeviceSettingRecord<T> | undefined) ?? null,
              set: async (record) => {
                values.set(record.key, record);
              },
            },
          }),
      },
      'media',
      () => 123,
    );
    const base = { tripId: 'trip-1234', originDeviceId: 'device-1234' };

    expect(await allocator.allocate({ ...base, idempotencyKey: 'asset-a' })).toBe(1);
    expect(await allocator.allocate({ ...base, idempotencyKey: 'asset-a' })).toBe(1);
    expect(await allocator.allocate({ ...base, idempotencyKey: 'asset-b' })).toBe(2);
  });
});
