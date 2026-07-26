import { describe, expect, it } from 'vitest';

import {
  buildRedactedLanDiagnosticReport,
  redactDiagnosticText,
  redactIdentifier,
} from './lanDiagnosticReport';

const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('connection diagnostic report redaction', () => {
  it('reports connection and queue state without raw endpoints, peer IDs, or trip IDs', () => {
    const report = buildRedactedLanDiagnosticReport({
      generatedAtMs: Date.UTC(2026, 6, 23, 12),
      appVersion: '0.1.0',
      expoSdkVersion: '57.0.0',
      platform: 'android',
      platformVersion: '36',
      tripId: 'trip_1234567890abcdef',
      readyPeerCount: 0,
      network: { type: 'WIFI', isConnected: true, isInternetReachable: false },
      diagnostics: {
        role: 'member',
        advertisedEndpoint: 'tcp://192.168.43.1:38457',
        transportState: 'reconnecting',
        transportPeerDeviceIds: ['device_1234567890abcdef'],
        reconnectAttempt: 4,
        pendingOutbox: 3,
        pendingTransfers: 2,
        lastError: {
          source: 'socket',
          code: 'TCP_CONNECTION_ERROR',
          message: `connect to 192.168.43.1 failed; secret=${secret}`,
          atMs: Date.UTC(2026, 6, 23, 11, 59),
        },
      },
    });

    expect(report).toContain('transportState=reconnecting');
    expect(report).toContain('pendingTransfers=2');
    expect(report).toContain('readyTripMembers=0');
    expect(report).toContain('transport=lan-fallback');
    expect(report).toContain('tcp://<local-address>:38457');
    expect(report).not.toContain('192.168.43.1');
    expect(report).not.toContain('trip_1234567890abcdef');
    expect(report).not.toContain('device_1234567890abcdef');
    expect(report).not.toContain(secret);
  });

  it('identifies relay transport without exposing its hostname or admin as a network host', () => {
    const report = buildRedactedLanDiagnosticReport({
      generatedAtMs: Date.UTC(2026, 6, 23, 12),
      appVersion: '0.1.0',
      expoSdkVersion: '57.0.0',
      platform: 'ios',
      platformVersion: '19',
      tripId: 'trip_1234567890abcdef',
      readyPeerCount: 1,
      network: { type: 'WIFI', isConnected: true, isInternetReachable: true },
      diagnostics: {
        role: 'coordinator',
        advertisedEndpoint: 'wss://relay.example.test/v1/relay',
        transportState: 'connected',
        transportPeerDeviceIds: [],
        reconnectAttempt: 0,
        pendingOutbox: 0,
        pendingTransfers: 0,
        lastError: null,
      },
    });

    expect(report).toContain('admissionRole=trip-admin');
    expect(report).toContain('transport=relay');
    expect(report).toContain('readyTripMembers=1');
    expect(report).toContain('wss://<relay-address>');
    expect(report).not.toContain('relay.example.test');
    expect(report).not.toContain('role=coordinator');
  });

  it('removes invite URLs and secret-like values from native error messages', () => {
    const text = redactDiagnosticText(
      `bad airmesh://join?secret=${secret}&endpoint=tcp://10.0.0.1:4 token=${secret}`,
    );
    expect(text).not.toContain('airmesh://join');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('10.0.0.1');
  });

  it('does not echo arbitrary identifier prefixes or common opaque key formats', () => {
    const identifier = 'CustomerSecretMaterialWithoutSeparators1234';
    const uuid = '018fc372-8b5a-7cc2-98af-1234567890ab';
    const hexKey = '0123456789abcdef'.repeat(4);
    const base64Key = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE';

    expect(redactIdentifier(identifier)).toBe('<redacted-id>');
    const text = redactDiagnosticText(`ids ${uuid} ${hexKey} ${base64Key}`);
    expect(text).not.toContain(uuid);
    expect(text).not.toContain(hexKey);
    expect(text).not.toContain(base64Key);
  });

  it('keeps report generation safe when native clocks return invalid values', () => {
    const report = buildRedactedLanDiagnosticReport({
      generatedAtMs: Number.NaN,
      appVersion: '0.1.0',
      expoSdkVersion: '57.0.0',
      platform: 'android',
      platformVersion: '36',
      tripId: 'trip_1234567890abcdef',
      readyPeerCount: 0,
      network: { type: null, isConnected: null, isInternetReachable: null },
      diagnostics: {
        role: null,
        advertisedEndpoint: null,
        transportState: 'idle',
        transportPeerDeviceIds: [],
        reconnectAttempt: 0,
        pendingOutbox: 0,
        pendingTransfers: 0,
        lastError: {
          source: 'sync',
          code: 'CLOCK',
          message: 'invalid clock',
          atMs: Number.POSITIVE_INFINITY,
        },
      },
    });

    expect(report).toContain('generatedAt=invalid');
    expect(report).toContain('at invalid');
  });
});
