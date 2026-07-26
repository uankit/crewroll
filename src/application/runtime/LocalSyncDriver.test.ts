import { describe, expect, it } from 'vitest';

import { syncStateAfterTransportError } from './syncState';

describe('syncStateAfterTransportError', () => {
  it('does not mark a listening coordinator as reconnecting for one peer error', () => {
    expect(syncStateAfterTransportError('connected', true)).toBe('connected');
  });

  it('leaves reconnect transitions to transport state events', () => {
    expect(syncStateAfterTransportError('connecting', true)).toBe('connecting');
    expect(syncStateAfterTransportError('reconnecting', true)).toBe('reconnecting');
  });

  it('surfaces non-recoverable transport failures', () => {
    expect(syncStateAfterTransportError('connected', false)).toBe('error');
  });
});
