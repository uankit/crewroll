import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { validateReleaseEnvironment } from './validate-release-env.mjs';

const VALID_ENVIRONMENT = {
  EXPO_PUBLIC_AIRMESH_TRANSPORT: 'relay',
  EXPO_PUBLIC_AIRMESH_RELAY_URL: 'wss://relay.crewroll.app/v1/relay?region=in',
};

describe('validateReleaseEnvironment', () => {
  test('accepts public WSS domain and IP endpoints without contacting them', () => {
    assert.deepEqual(validateReleaseEnvironment(VALID_ENVIRONMENT), {
      mode: 'relay',
      relayUrl: 'wss://relay.crewroll.app/v1/relay?region=in',
    });
    assert.doesNotThrow(() =>
      validateReleaseEnvironment({
        ...VALID_ENVIRONMENT,
        EXPO_PUBLIC_AIRMESH_RELAY_URL: 'wss://8.8.8.8:443/v1/relay',
      }),
    );
    assert.doesNotThrow(() =>
      validateReleaseEnvironment({
        ...VALID_ENVIRONMENT,
        EXPO_PUBLIC_AIRMESH_RELAY_URL: 'wss://[2606:4700:4700::1111]/v1/relay',
      }),
    );
  });

  test('requires explicit relay mode and a URL', () => {
    assert.throws(() => validateReleaseEnvironment({}), /transport.*relay/i);
    assert.throws(
      () => validateReleaseEnvironment({ ...VALID_ENVIRONMENT, EXPO_PUBLIC_AIRMESH_TRANSPORT: 'lan' }),
      /transport.*relay/i,
    );
    assert.throws(
      () => validateReleaseEnvironment({ EXPO_PUBLIC_AIRMESH_TRANSPORT: 'relay' }),
      /relay_url.*must be set/i,
    );
  });

  test('rejects insecure, malformed, credentialed, fragmented, or room-pinned URLs', () => {
    const rejected = [
      'ws://relay.crewroll.app/v1/relay',
      'https://relay.crewroll.app/v1/relay',
      'not a URL',
      'wss://user:secret@relay.crewroll.app/v1/relay',
      'wss://relay.crewroll.app/v1/relay#fragment',
      'wss://relay.crewroll.app:0/v1/relay',
      'wss://relay.crewroll.app/v1/relay?room=trip-1',
      'wss://relay.crewroll.app/v1/relay?ROOM=trip-1',
    ];
    for (const relayUrl of rejected) {
      assert.throws(() =>
        validateReleaseEnvironment({
          ...VALID_ENVIRONMENT,
          EXPO_PUBLIC_AIRMESH_RELAY_URL: relayUrl,
        }),
      );
    }
  });

  test('rejects placeholder, single-label, private, local, and reserved hosts', () => {
    const rejectedHosts = [
      'relay.invalid',
      'relay.example',
      'relay.example.com',
      'relay.test',
      'localhost',
      'relay.localhost',
      'relay.local',
      'relay.internal',
      'relay.onion',
      'relay',
      '127.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.1.10',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[2001:db8::1]',
      '[::ffff:192.168.1.10]',
    ];
    for (const host of rejectedHosts) {
      assert.throws(() =>
        validateReleaseEnvironment({
          ...VALID_ENVIRONMENT,
          EXPO_PUBLIC_AIRMESH_RELAY_URL: `wss://${host}/v1/relay`,
        }),
      );
    }
  });
});

describe('release environment CLI', () => {
  const script = fileURLToPath(new URL('./validate-release-env.mjs', import.meta.url));

  test('exits successfully for a valid release environment', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: cleanEnvironment(VALID_ENVIRONMENT),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /environment is valid/i);
  });

  test('fails before install when the relay endpoint is missing', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: cleanEnvironment({ EXPO_PUBLIC_AIRMESH_TRANSPORT: 'relay' }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /validation failed.*relay_url/i);
  });
});

function cleanEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  delete environment.EXPO_PUBLIC_AIRMESH_ALLOW_INSECURE_RELAY;
  if (!Object.hasOwn(overrides, 'EXPO_PUBLIC_AIRMESH_TRANSPORT')) {
    delete environment.EXPO_PUBLIC_AIRMESH_TRANSPORT;
  }
  if (!Object.hasOwn(overrides, 'EXPO_PUBLIC_AIRMESH_RELAY_URL')) {
    delete environment.EXPO_PUBLIC_AIRMESH_RELAY_URL;
  }
  return environment;
}
