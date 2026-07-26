import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeBinaryChunkFrame,
  encodeBinaryChunkFrame,
  TransportBackpressureError,
  WebSocketRelayTransport,
} from './WebSocketRelayTransport';
import type { RelayAuthenticator } from './RelayAuthentication';
import { TRANSPORT_PROTOCOL_VERSION } from './Transport';

const ROUTE_ID = 'A'.repeat(43);
const CHALLENGE = 'A'.repeat(43);
const IDENTITY_PUBLIC_KEY = 'A'.repeat(43);
const CHALLENGE_SIGNATURE = 'A'.repeat(86);

describe('WebSocketRelayTransport', () => {
  afterEach(() => vi.useRealTimers());

  it('round-trips an optional binary message ID for relay error correlation', () => {
    const bytes = Uint8Array.of(9, 8, 7, 6);
    const encoded = encodeBinaryChunkFrame({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'chunk',
      sessionId: 'trip:one',
      senderPeerId: 'device:one',
      targetPeerId: 'device:two',
      messageId: 'message:binary-one',
      transferId: 'transfer:one',
      resourceId: 'resource:one',
      chunkIndex: 0,
      offset: 0,
      totalBytes: bytes.byteLength,
      byteLength: bytes.byteLength,
      isLast: true,
    }, bytes);

    expect(decodeBinaryChunkFrame(encoded)).toEqual({
      sessionId: 'trip:one',
      senderPeerId: 'device:one',
      targetPeerId: 'device:two',
      messageId: 'message:binary-one',
      transferId: 'transfer:one',
      resourceId: 'resource:one',
      chunkIndex: 0,
      offset: 0,
      totalBytes: bytes.byteLength,
      isLast: true,
      bytes,
    });
  });

  it('adds a non-secret room route and authenticates in the hello frame', async () => {
    const fake = createFakeWebSocket();
    let openedUrl = '';
    const transport = new WebSocketRelayTransport({
      authentication: testAuthenticator(),
      now: () => 1_234,
      webSocketFactory: (url) => {
        openedUrl = url;
        return fake.socket;
      },
    });

    transport.connect({
      url: 'wss://relay.example.test/v1/relay?region=in',
      sessionId: 'trip:one',
      peerId: 'device:one',
    });
    fake.open();
    sendChallenge(fake);
    await flushMessages();

    expect(new URL(openedUrl).searchParams.get('room')).toBe(ROUTE_ID);
    expect(JSON.parse(fake.sent[0] as string)).toEqual({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'hello',
      sessionId: 'trip:one',
      peerId: 'device:one',
      auth: {
        issuedAtMs: 1_234,
        roomToken: 'room-capability',
        challenge: CHALLENGE,
        identityPublicKey: IDENTITY_PUBLIC_KEY,
        challengeSignature: CHALLENGE_SIGNATURE,
      },
    });
    transport.disconnect();
  });

  it('fails synchronously before the WebSocket queue exceeds its byte bound', async () => {
    const fake = createFakeWebSocket();
    const maxBufferedAmountBytes = 300_000;
    const transport = new WebSocketRelayTransport({
      authentication: testAuthenticator(),
      maxBufferedAmountBytes,
      webSocketFactory: () => fake.socket,
    });
    transport.connect({
      url: 'wss://relay.example.test/v1/relay',
      sessionId: 'trip:one',
      peerId: 'device:one',
    });
    fake.open();
    sendChallenge(fake);
    await flushMessages();
    fake.message(JSON.stringify({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'welcome',
      sessionId: 'trip:one',
      peerId: 'device:one',
      connectedPeerIds: [],
    }));
    await Promise.resolve();
    await Promise.resolve();

    fake.setBufferedAmount(maxBufferedAmountBytes - 4);
    expect(() => transport.sendControl({
      messageId: 'message:one',
      type: 'SECURE_CONTROL',
      payload: { ciphertext: 'not-enqueued' },
      targetPeerId: 'device:two',
    })).toThrow(TransportBackpressureError);
    expect(fake.sent).toHaveLength(1);

    try {
      transport.sendControl({
        messageId: 'message:two',
        type: 'SECURE_CONTROL',
        payload: { ciphertext: 'not-enqueued' },
        targetPeerId: 'device:two',
      });
      throw new Error('Expected transport backpressure.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'TransportBackpressureError',
        code: 'TRANSPORT_BACKPRESSURE',
        recoverable: true,
        limitBytes: maxBufferedAmountBytes,
      });
    }
    transport.disconnect();
  });

  it('does not poll forever after a fatal relay authentication rejection', async () => {
    vi.useFakeTimers();
    const fake = createFakeWebSocket();
    let socketCreations = 0;
    const transport = new WebSocketRelayTransport({
      authentication: testAuthenticator(),
      baseReconnectDelayMs: 50,
      maxReconnectDelayMs: 50,
      webSocketFactory: () => {
        socketCreations += 1;
        return fake.socket;
      },
    });
    transport.connect({
      url: 'wss://relay.example.test/v1/relay',
      sessionId: 'trip:one',
      peerId: 'device:one',
    });
    fake.open();
    sendChallenge(fake);
    await flushMessages();
    fake.message(JSON.stringify({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'relay-error',
      code: 'AUTH_INVALID',
      message: 'Authentication rejected.',
      recoverable: false,
    }));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitClose(4003, 'authentication rejected');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(socketCreations).toBe(1);
    expect(transport.state.state).toBe('stopped');
  });

  it('honors an explicit fatal protocol error instead of reconnecting', async () => {
    vi.useFakeTimers();
    const fake = createFakeWebSocket();
    let socketCreations = 0;
    const events: unknown[] = [];
    const transport = new WebSocketRelayTransport({
      authentication: testAuthenticator(),
      baseReconnectDelayMs: 50,
      maxReconnectDelayMs: 50,
      webSocketFactory: () => {
        socketCreations += 1;
        return fake.socket;
      },
    });
    transport.subscribe((event) => events.push(event));
    transport.connect({
      url: 'wss://relay.example.test/v1/relay',
      sessionId: 'trip:one',
      peerId: 'device:one',
    });
    fake.open();
    sendChallenge(fake);
    await flushMessages();
    fake.message(JSON.stringify({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'relay-error',
      code: 'INVALID_CONTROL',
      message: 'Control frame is invalid.',
      recoverable: false,
    }));
    await flushMessages();
    fake.emitClose(4003, 'permanent protocol rejection');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(socketCreations).toBe(1);
    expect(transport.state.state).toBe('stopped');
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'INVALID_CONTROL',
      recoverable: false,
    }));
  });

  it('rejects relay errors that omit the explicit recoverability decision', async () => {
    const fake = createFakeWebSocket();
    const events: unknown[] = [];
    const transport = new WebSocketRelayTransport({
      authentication: testAuthenticator(),
      webSocketFactory: () => fake.socket,
    });
    transport.subscribe((event) => events.push(event));
    transport.connect({
      url: 'wss://relay.example.test/v1/relay',
      sessionId: 'trip:one',
      peerId: 'device:one',
    });
    fake.open();
    sendChallenge(fake);
    await flushMessages();
    fake.message(JSON.stringify({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'relay-error',
      code: 'AUTH_INVALID',
      message: 'Authentication rejected.',
    }));
    await flushMessages();

    expect(events.at(-1)).toEqual({
      kind: 'error',
      source: 'protocol',
      code: 'INVALID_FRAME',
      message: 'Relay error frame is malformed.',
      recoverable: true,
    });
    transport.disconnect();
  });

  it('retries ROOM_FULL slowly and stops after the configured bound', async () => {
    vi.useFakeTimers();
    const sockets: ReturnType<typeof createFakeWebSocket>[] = [];
    const errors: unknown[] = [];
    const transport = new WebSocketRelayTransport({
      authentication: testAuthenticator(),
      baseReconnectDelayMs: 50,
      maxReconnectDelayMs: 50,
      roomFullReconnectDelayMs: 1_000,
      maxRoomFullReconnectAttempts: 2,
      random: () => 0.5,
      webSocketFactory: () => {
        const fake = createFakeWebSocket();
        sockets.push(fake);
        return fake.socket;
      },
    });
    transport.subscribe((event) => {
      if (event.kind === 'error') errors.push(event);
    });
    transport.connect({
      url: 'wss://relay.example.test/v1/relay',
      sessionId: 'trip:one',
      peerId: 'device:one',
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fake = sockets[attempt];
      fake.open();
      sendChallenge(fake);
      await flushMessages();
      fake.message(JSON.stringify({
        v: TRANSPORT_PROTOCOL_VERSION,
        kind: 'relay-error',
        code: 'ROOM_FULL',
        message: 'Room is full.',
        recoverable: true,
      }));
      await flushMessages();
      fake.emitClose(attempt === 2 ? 4003 : 1013, 'room full');
      if (attempt < 2) {
        await vi.advanceTimersByTimeAsync(999);
        expect(sockets).toHaveLength(attempt + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(attempt + 2);
      }
    }
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sockets).toHaveLength(3);
    expect(transport.state.state).toBe('stopped');
    expect(errors.at(-1)).toEqual(expect.objectContaining({
      code: 'ROOM_FULL',
      recoverable: false,
    }));
  });
});

function testAuthenticator(): RelayAuthenticator {
  return Object.assign(
    async ({ issuedAtMs, challenge }: Parameters<RelayAuthenticator>[0]) => ({
      issuedAtMs,
      roomToken: 'room-capability',
      challenge,
      identityPublicKey: IDENTITY_PUBLIC_KEY,
      challengeSignature: CHALLENGE_SIGNATURE,
    }),
    { routeId: () => ROUTE_ID },
  );
}

function sendChallenge(fake: ReturnType<typeof createFakeWebSocket>): void {
  fake.message(JSON.stringify({
    v: TRANSPORT_PROTOCOL_VERSION,
    kind: 'relay-challenge',
    challenge: CHALLENGE,
  }));
}

async function flushMessages(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createFakeWebSocket() {
  let readyState = 0;
  let bufferedAmount = 0;
  const sent: unknown[] = [];
  const fake = {
    binaryType: 'blob' as BinaryType,
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
    onopen: null as ((event: Event) => unknown) | null,
    onmessage: null as ((event: MessageEvent) => unknown) | null,
    onerror: null as ((event: Event) => unknown) | null,
    onclose: null as ((event: CloseEvent) => unknown) | null,
    send(data: unknown) {
      sent.push(data);
    },
    close() {
      readyState = 3;
    },
  };
  return {
    socket: fake as unknown as WebSocket,
    sent,
    setBufferedAmount(value: number) {
      bufferedAmount = value;
    },
    open() {
      readyState = 1;
      fake.onopen?.(new Event('open'));
    },
    message(data: string) {
      fake.onmessage?.({ data } as MessageEvent);
    },
    emitClose(code: number, reason: string) {
      fake.onclose?.({ code, reason } as CloseEvent);
    },
  };
}
