import { describe, expect, it, vi } from 'vitest';

import type { AirMeshRepositories } from './repositories';
import {
  applyLocalDataRetention,
  DELIVERED_OUTBOX_RETENTION_MS,
  TERMINAL_SYNC_HISTORY_RETENTION_MS,
} from './index';

vi.mock('expo-sqlite', () => ({}));

describe('local data retention', () => {
  it('prunes short-lived delivery noise sooner than diagnostic failure history', async () => {
    const now = 60 * 24 * 60 * 60 * 1_000;
    const removeDeliveredBefore = vi.fn(async () => 4);
    const removeDeadLetterBefore = vi.fn(async () => 2);
    const removeTerminalBefore = vi.fn(async () => 8);
    const repositories = {
      outbox: { removeDeliveredBefore, removeDeadLetterBefore },
      transfers: { removeTerminalBefore },
    } as unknown as Pick<AirMeshRepositories, 'outbox' | 'transfers'>;

    await applyLocalDataRetention(repositories, now);

    expect(removeDeliveredBefore).toHaveBeenCalledWith(
      now - DELIVERED_OUTBOX_RETENTION_MS,
    );
    expect(removeDeadLetterBefore).toHaveBeenCalledWith(
      now - TERMINAL_SYNC_HISTORY_RETENTION_MS,
    );
    expect(removeTerminalBefore).toHaveBeenCalledWith(
      now - TERMINAL_SYNC_HISTORY_RETENTION_MS,
    );
  });

  it('rejects invalid clocks before deleting anything', async () => {
    const removeDeliveredBefore = vi.fn();
    const repositories = {
      outbox: { removeDeliveredBefore },
      transfers: {},
    } as unknown as Pick<AirMeshRepositories, 'outbox' | 'transfers'>;

    await expect(applyLocalDataRetention(repositories, -1)).rejects.toThrow(
      'nowMs must be a safe timestamp',
    );
    expect(removeDeliveredBefore).not.toHaveBeenCalled();
  });
});
