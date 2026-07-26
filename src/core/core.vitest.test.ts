import { describe, it } from 'vitest';

import { runCoreTests } from './core.test';

describe('core production contracts', () => {
  it('passes the dependency-free domain, invite, protocol, security, and reconciliation suite', () => {
    runCoreTests();
  });
});
