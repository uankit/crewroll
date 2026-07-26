import { describe, expect, it } from 'vitest';

import { resolveRuntimeTransportConfig } from './transportConfig';

describe('resolveRuntimeTransportConfig', () => {
  it('defaults to a secure relay and fails closed when its URL is missing', () => {
    expect(() => resolveRuntimeTransportConfig({})).toThrow(/requires.*relay_url/i);
  });

  it('normalizes a WSS relay and removes a stale room routing key', () => {
    expect(
      resolveRuntimeTransportConfig({
        relayUrl: 'wss://relay.example.test/v1/relay?region=in&room=old',
      }),
    ).toEqual({
      mode: 'relay',
      relayUrl: 'wss://relay.example.test/v1/relay?region=in',
    });
  });

  it('requires an explicit opt-in for insecure local relay development', () => {
    expect(() =>
      resolveRuntimeTransportConfig({ relayUrl: 'ws://192.168.1.10:8787/v1/relay' }),
    ).toThrow(/plain ws/i);
    expect(
      resolveRuntimeTransportConfig({
        relayUrl: 'ws://192.168.1.10:8787/v1/relay',
        allowInsecureRelay: 'true',
      }),
    ).toEqual({ mode: 'relay', relayUrl: 'ws://192.168.1.10:8787/v1/relay' });
  });

  it('uses LAN only when selected explicitly', () => {
    expect(resolveRuntimeTransportConfig({ mode: 'lan' })).toEqual({ mode: 'lan' });
  });
});
