import { describe, expect, it } from 'vitest';

import { runCoreTests } from './core.test';

describe('core protocol smoke suite', () => {
  it('preserves strict parsing, protocol, reconciliation, and replica invariants', () => {
    expect(() => runCoreTests()).not.toThrow();
  });
});
