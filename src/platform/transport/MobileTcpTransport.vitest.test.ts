import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TCP_FRAME_PAYLOAD_BYTES,
  MobileTcpFrameDecoder,
  MobileTcpTransport,
  encodeMobileTcpFrame,
  parseMobileTcpUrl,
} from './MobileTcpTransport';
import type { MobileTcpSocketModule } from './MobileTcpTransport';

vi.mock('react-native-tcp-socket', () => ({
  default: {
    createConnection: vi.fn(),
    createServer: vi.fn(),
  },
}));

describe('MobileTcpFrameDecoder', () => {
  it('reassembles a frame split at every byte boundary', () => {
    const payload = new TextEncoder().encode('{"kind":"hello"}');
    const wire = encodeMobileTcpFrame('text', payload);
    const frames: { kind: string; payload: Uint8Array }[] = [];
    const decoder = new MobileTcpFrameDecoder((frame) => frames.push(frame));

    for (let index = 0; index < wire.byteLength; index += 1) {
      decoder.push(wire.subarray(index, index + 1));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe('text');
    expect([...frames[0].payload]).toEqual([...payload]);
  });

  it('emits coalesced text and binary frames independently', () => {
    const first = encodeMobileTcpFrame('text', Uint8Array.of(1, 2, 3));
    const second = encodeMobileTcpFrame('binary', Uint8Array.of(4, 5));
    const coalesced = new Uint8Array(first.byteLength + second.byteLength);
    coalesced.set(first, 0);
    coalesced.set(second, first.byteLength);

    const frames: { kind: string; payload: Uint8Array }[] = [];
    new MobileTcpFrameDecoder((frame) => frames.push(frame)).push(coalesced);

    expect(frames.map((frame) => frame.kind)).toEqual(['text', 'binary']);
    expect(frames.map((frame) => [...frame.payload])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it('rejects an advertised length before allocating an oversized payload', () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, MAX_TCP_FRAME_PAYLOAD_BYTES + 1, false);
    const decoder = new MobileTcpFrameDecoder(() => undefined);

    expect(() => decoder.push(prefix)).toThrow(/frame length/i);
  });
});

describe('parseMobileTcpUrl', () => {
  it('distinguishes coordinator listeners from member connections', () => {
    expect(parseMobileTcpUrl('tcp-listen://0.0.0.0:4040')).toEqual({
      role: 'coordinator',
      host: '0.0.0.0',
      port: 4040,
    });
    expect(parseMobileTcpUrl('tcp://192.168.43.1:4040')).toEqual({
      role: 'member',
      host: '192.168.43.1',
      port: 4040,
    });
  });

  it('rejects non-routable or ambiguous endpoint forms', () => {
    expect(() => parseMobileTcpUrl('tcp://0.0.0.0:4040')).toThrow(/reachable/i);
    expect(() => parseMobileTcpUrl('tcp-listen://127.0.0.1:4040')).toThrow(/0\.0\.0\.0/);
    expect(() => parseMobileTcpUrl('tcp://192.168.1.1:4040/path')).toThrow(/path/i);
    expect(() => parseMobileTcpUrl('ws://192.168.1.1:4040')).toThrow(/tcp/i);
  });
});

describe('MobileTcpTransport physical-device routing', () => {
  it('lets the OS route member sockets instead of globally binding Android to Wi-Fi', () => {
    const socket = new FakeSocket();
    const createConnection = vi.fn((
      _options: Parameters<MobileTcpSocketModule['createConnection']>[0],
      _callback: () => void,
    ) => socket as never);
    const transport = new MobileTcpTransport({
      socketModule: {
        createConnection,
        createServer: vi.fn(),
      } as unknown as MobileTcpSocketModule,
    });

    transport.connect({
      url: 'tcp://192.168.43.1:38457',
      sessionId: 'trip_12345678',
      peerId: 'device_12345678',
    });

    expect(createConnection).toHaveBeenCalledOnce();
    expect(createConnection.mock.calls[0][0]).toEqual({
      host: '192.168.43.1',
      port: 38457,
      reuseAddress: true,
      connectTimeout: 8_000,
    });
    expect(createConnection.mock.calls[0][0]).not.toHaveProperty('interface');
    transport.disconnect();
  });

  it('keeps the native socket error as the reconnect reason after close', () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const transport = new MobileTcpTransport({
        baseReconnectDelayMs: 50,
        maxReconnectDelayMs: 50,
        random: () => 0.5,
        socketModule: {
          createConnection: vi.fn(() => socket as never),
          createServer: vi.fn(),
        } as unknown as MobileTcpSocketModule,
      });
      transport.connect({
        url: 'tcp://192.168.43.1:38457',
        sessionId: 'trip_12345678',
        peerId: 'device_12345678',
      });

      socket.emit('error', new Error('Interface wifi unreachable'));
      socket.emit('close');

      expect(transport.state).toMatchObject({
        state: 'reconnecting',
        reconnectAttempt: 1,
        reason: 'Interface wifi unreachable',
      });
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a coordinator listener after a recoverable native server error', () => {
    vi.useFakeTimers();
    try {
      const first = new FakeServer();
      const second = new FakeServer();
      const createServer = vi.fn()
        .mockReturnValueOnce(first as never)
        .mockReturnValueOnce(second as never);
      const transport = new MobileTcpTransport({
        baseReconnectDelayMs: 50,
        maxReconnectDelayMs: 50,
        random: () => 0.5,
        socketModule: {
          createConnection: vi.fn(),
          createServer,
        } as unknown as MobileTcpSocketModule,
      });
      transport.connect({
        url: 'tcp-listen://0.0.0.0:38457',
        sessionId: 'trip_12345678',
        peerId: 'device_12345678',
      });
      first.emit('listening');
      first.emit('error', new Error('listener interrupted'));

      expect(transport.state).toMatchObject({ state: 'reconnecting', reconnectAttempt: 1 });
      vi.advanceTimersByTime(50);
      expect(createServer).toHaveBeenCalledTimes(2);
      second.emit('listening');
      expect(transport.state).toMatchObject({ state: 'connected', reconnectAttempt: 0 });
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeSocket {
  destroyed = false;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: never[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  write() { return true; }
  end() { this.destroyed = true; return this; }
  destroy() { this.destroyed = true; return this; }
}

class FakeServer {
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: never[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  listen() { return this; }
  close() { return this; }
}
