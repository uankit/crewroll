import {
  MAX_BINARY_HEADER_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  TRANSPORT_PROTOCOL_VERSION,
} from './Transport';
import type {
  BinaryChunkHeader,
  ControlFrame,
  HelloFrame,
  InboundBinaryChunk,
  OutboundBinaryChunk,
  OutboundControlMessage,
  PeerFrame,
  RelayErrorFrame,
  Transport,
  TransportConnectRequest,
  TransportEvent,
  TransportStateSnapshot,
  TransportSubscription,
  WelcomeFrame,
} from './Transport';
import type {
  RelayAuthenticator,
  RelayHelloAuthentication,
} from './RelayAuthentication';

export interface WebSocketRelayTransportOptions {
  authentication: RelayAuthenticator;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxRoomFullReconnectAttempts?: number;
  roomFullReconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  maxBufferedAmountBytes?: number;
  webSocketFactory?: (url: string) => WebSocket;
  random?: () => number;
  now?: () => number;
}

type ServerRelayErrorFrame = RelayErrorFrame & {
  readonly recoverable: boolean;
};
interface RelayChallengeFrame {
  readonly v: typeof TRANSPORT_PROTOCOL_VERSION;
  readonly kind: 'relay-challenge';
  readonly challenge: string;
}
type ServerTextFrame =
  | RelayChallengeFrame
  | WelcomeFrame
  | PeerFrame
  | ServerRelayErrorFrame
  | ControlFrame;
type RelayHelloFrame = HelloFrame & { readonly auth: RelayHelloAuthentication };

const DEFAULT_BASE_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 15_000;
const DEFAULT_MAX_ROOM_FULL_RECONNECT_ATTEMPTS = 3;
const DEFAULT_ROOM_FULL_RECONNECT_DELAY_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 2 * 1024 * 1024;
const SOCKET_OPEN = 1;

/** Outbound-only WebSocket relay adapter for internet and local development. */
export class WebSocketRelayTransport implements Transport {
  private snapshot: TransportStateSnapshot = { state: 'idle', reconnectAttempt: 0 };
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxRoomFullReconnectAttempts: number;
  private readonly roomFullReconnectDelayMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxBufferedAmountBytes: number;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly authentication: RelayAuthenticator;

  private socket: WebSocket | null = null;
  private request: TransportConnectRequest | null = null;
  private shouldReconnect = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private roomFullReconnectAttempts = 0;
  private nextReconnectDelayFloorMs = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private receiveChain: Promise<void> = Promise.resolve();
  private challengeSocket: WebSocket | null = null;
  private helloSentSocket: WebSocket | null = null;

  constructor(options: WebSocketRelayTransportOptions) {
    this.baseReconnectDelayMs = requireDelay(
      options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS,
      'baseReconnectDelayMs'
    );
    this.maxReconnectDelayMs = requireDelay(
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      'maxReconnectDelayMs'
    );
    this.maxRoomFullReconnectAttempts = requireRetryCount(
      options.maxRoomFullReconnectAttempts ?? DEFAULT_MAX_ROOM_FULL_RECONNECT_ATTEMPTS,
      'maxRoomFullReconnectAttempts',
    );
    this.roomFullReconnectDelayMs = requireDelay(
      options.roomFullReconnectDelayMs ?? DEFAULT_ROOM_FULL_RECONNECT_DELAY_MS,
      'roomFullReconnectDelayMs',
    );
    this.handshakeTimeoutMs = requireDelay(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs'
    );
    this.maxBufferedAmountBytes = requireBufferedAmountLimit(
      options.maxBufferedAmountBytes ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    );
    if (this.maxReconnectDelayMs < this.baseReconnectDelayMs) {
      throw new RangeError('maxReconnectDelayMs must be at least baseReconnectDelayMs.');
    }
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.authentication = options.authentication;
  }

  get state(): TransportStateSnapshot {
    return this.snapshot;
  }

  connect(request: TransportConnectRequest): void {
    validateWebSocketUrl(request.url);
    requireRouteIdentifier(request.sessionId, 'sessionId');
    requireRouteIdentifier(request.peerId, 'peerId');

    this.stopCurrentSocket();
    this.request = { ...request };
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.roomFullReconnectAttempts = 0;
    this.nextReconnectDelayFloorMs = 0;
    this.generation += 1;
    this.openSocket(this.generation);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.request = null;
    this.generation += 1;
    this.clearTimers();

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      socket.close(1000, 'client disconnect');
    }

    this.setState({ state: 'stopped', reconnectAttempt: 0 });
  }

  sendControl(message: OutboundControlMessage): void {
    const request = this.requireConnected();
    requireRouteIdentifier(message.messageId, 'messageId');
    requireMessageType(message.type);
    const targetPeerId = normalizeTarget(message.targetPeerId);

    const frame: ControlFrame = {
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'control',
      sessionId: request.sessionId,
      senderPeerId: request.peerId,
      targetPeerId,
      messageId: message.messageId,
      type: message.type,
      payload: message.payload,
    };
    const encoded = JSON.stringify(frame);
    if (utf8Encode(encoded).byteLength > MAX_CONTROL_FRAME_BYTES) {
      throw new RangeError(`Control frame exceeds ${MAX_CONTROL_FRAME_BYTES} bytes.`);
    }
    this.sendBounded(encoded, utf8Encode(encoded).byteLength);
  }

  sendChunk(chunk: OutboundBinaryChunk): void {
    const request = this.requireConnected();
    validateOutboundChunk(chunk);

    const header: BinaryChunkHeader = {
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'chunk',
      sessionId: request.sessionId,
      senderPeerId: request.peerId,
      targetPeerId: normalizeTarget(chunk.targetPeerId),
      ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
      transferId: chunk.transferId,
      resourceId: chunk.resourceId,
      chunkIndex: chunk.chunkIndex,
      offset: chunk.offset,
      totalBytes: chunk.totalBytes,
      byteLength: chunk.bytes.byteLength,
      isLast: chunk.isLast,
    };
    const encoded = encodeBinaryChunkFrame(header, chunk.bytes);
    this.sendBounded(encoded, encoded.byteLength);
  }

  subscribe(listener: (event: TransportEvent) => void): TransportSubscription {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  private openSocket(generation: number): void {
    const request = this.request;
    if (!request || !this.shouldReconnect || generation !== this.generation) {
      return;
    }

    this.setState({
      state: this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting',
      reconnectAttempt: this.reconnectAttempt,
    });

    let routeId: string;
    try {
      routeId = this.authentication.routeId(request.sessionId);
      requireRelayRouteId(routeId);
    } catch (error) {
      this.shouldReconnect = false;
      this.emitError('protocol', 'AUTH_CONFIGURATION_INVALID', errorMessage(error), false);
      this.setState({ state: 'stopped', reconnectAttempt: 0 });
      return;
    }

    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(relaySocketUrl(request.url, routeId));
    } catch (error) {
      this.emitError('socket', 'SOCKET_CREATE_FAILED', errorMessage(error), true);
      this.scheduleReconnect(generation, errorMessage(error));
      return;
    }

    this.socket = socket;
    this.challengeSocket = null;
    this.helloSentSocket = null;
    this.receiveChain = Promise.resolve();
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation) || !this.request) {
        socket.close(1000, 'stale connection');
        return;
      }

      this.setState({ state: 'handshaking', reconnectAttempt: this.reconnectAttempt });
      this.handshakeTimer = setTimeout(() => {
        if (this.isCurrent(socket, generation)) {
          this.emitError(
            'protocol',
            'HANDSHAKE_TIMEOUT',
            'Relay did not acknowledge the session handshake.',
            true
          );
          socket.close(4000, 'handshake timeout');
        }
      }, this.handshakeTimeoutMs);
    };

    socket.onmessage = (event) => {
      this.receiveChain = this.receiveChain
        .then(() => this.handleMessage(socket, generation, event.data))
        .catch((error) => {
          if (this.isCurrent(socket, generation)) {
            this.emitError('protocol', 'INVALID_FRAME', errorMessage(error), true);
          }
        });
    };

    socket.onerror = () => {
      if (this.isCurrent(socket, generation)) {
        this.emitError('socket', 'SOCKET_ERROR', 'WebSocket reported a connection error.', true);
      }
    };

    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) {
        return;
      }
      this.socket = null;
      this.clearHandshakeTimer();

      if (event.code === 4003) {
        this.shouldReconnect = false;
      }

      if (!this.shouldReconnect) {
        this.setState({ state: 'stopped', reconnectAttempt: 0 });
        return;
      }

      const reason = event.reason || `WebSocket closed with code ${event.code}.`;
      this.scheduleReconnect(generation, reason);
    };
  }

  private async handleMessage(
    socket: WebSocket,
    generation: number,
    data: unknown
  ): Promise<void> {
    if (!this.isCurrent(socket, generation)) {
      return;
    }

    if (typeof data === 'string') {
      if (utf8Encode(data).byteLength > MAX_CONTROL_FRAME_BYTES) {
        throw new Error('Text frame exceeds the protocol limit.');
      }
      await this.handleTextFrame(parseTextFrame(data), socket, generation);
      return;
    }

    const bytes = await toUint8Array(data);
    const chunk = decodeBinaryChunkFrame(bytes);
    this.validateInboundRoute(chunk);
    this.emit({ kind: 'chunk', chunk });
  }

  private async handleTextFrame(
    frame: ServerTextFrame,
    socket: WebSocket,
    generation: number,
  ): Promise<void> {
    if (frame.kind === 'relay-challenge') {
      if (this.snapshot.state !== 'handshaking' || this.challengeSocket === socket) {
        throw new Error('Relay challenge is out of sequence.');
      }
      const request = this.request;
      if (!request) throw new Error('Relay challenge arrived without a connection request.');
      this.challengeSocket = socket;

      let hello: RelayHelloFrame;
      try {
        const routeId = this.authentication.routeId(request.sessionId);
        requireRelayRouteId(routeId);
        const issuedAtMs = checkedNow(this.now);
        hello = {
          v: TRANSPORT_PROTOCOL_VERSION,
          kind: 'hello',
          sessionId: request.sessionId,
          peerId: request.peerId,
          auth: await this.authentication({
            sessionId: request.sessionId,
            peerId: request.peerId,
            routeId,
            challenge: frame.challenge,
            issuedAtMs,
          }),
        };
      } catch (error) {
        if (this.isCurrent(socket, generation)) {
          this.shouldReconnect = false;
          this.emitError('protocol', 'AUTH_CONFIGURATION_INVALID', errorMessage(error), false);
          socket.close(4003, 'relay authentication unavailable');
        }
        return;
      }

      if (!this.isCurrent(socket, generation) || this.snapshot.state !== 'handshaking') return;
      const encoded = JSON.stringify(hello);
      if (utf8Encode(encoded).byteLength > MAX_CONTROL_FRAME_BYTES) {
        this.shouldReconnect = false;
        this.emitError('protocol', 'AUTH_CONFIGURATION_INVALID', 'Relay hello exceeds the protocol limit.', false);
        socket.close(4003, 'relay authentication unavailable');
        return;
      }
      this.sendBounded(encoded, utf8Encode(encoded).byteLength);
      this.helloSentSocket = socket;
      return;
    }

    if (frame.kind === 'welcome') {
      const request = this.request;
      if (
        !request ||
        this.helloSentSocket !== socket ||
        frame.sessionId !== request.sessionId ||
        frame.peerId !== request.peerId
      ) {
        throw new Error('Welcome frame does not match the requested session and peer.');
      }
      this.clearHandshakeTimer();
      this.reconnectAttempt = 0;
      this.roomFullReconnectAttempts = 0;
      this.nextReconnectDelayFloorMs = 0;
      this.setState({ state: 'connected', reconnectAttempt: 0 });
      this.emit({ kind: 'peers', peerIds: [...new Set(frame.connectedPeerIds)] });
      return;
    }

    if (frame.kind === 'relay-error') {
      let recoverable = frame.recoverable;
      if (frame.code === 'ROOM_FULL') {
        this.roomFullReconnectAttempts += 1;
        if (this.roomFullReconnectAttempts > this.maxRoomFullReconnectAttempts) {
          recoverable = false;
        } else {
          this.nextReconnectDelayFloorMs = this.roomFullReconnectDelayMs;
        }
      }
      this.emit({
        kind: 'error',
        source: 'relay',
        code: frame.code,
        message: frame.message,
        messageId: frame.messageId,
        recoverable,
      });
      if (!recoverable) {
        this.shouldReconnect = false;
        this.clearReconnectTimer();
        if (this.socket && this.socket.readyState < 2) {
          this.socket.close(4003, 'relay permanently rejected the connection');
        }
      }
      return;
    }

    if (this.snapshot.state !== 'connected') {
      throw new Error('Relay sent application data before completing the handshake.');
    }

    if (frame.kind === 'peer') {
      if (frame.sessionId !== this.request?.sessionId) {
        throw new Error('Peer event belongs to a different session.');
      }
      this.emit({
        kind: frame.change === 'joined' ? 'peer-joined' : 'peer-left',
        peerId: frame.peerId,
      });
      return;
    }

    this.validateInboundRoute(frame);
    this.emit({
      kind: 'control',
      message: {
        sessionId: frame.sessionId,
        senderPeerId: frame.senderPeerId,
        targetPeerId: frame.targetPeerId,
        messageId: frame.messageId,
        type: frame.type,
        payload: frame.payload,
      },
    });
  }

  private validateInboundRoute(frame: {
    sessionId: string;
    senderPeerId: string;
    targetPeerId: string | null;
  }): void {
    const request = this.request;
    if (!request || frame.sessionId !== request.sessionId) {
      throw new Error('Received frame belongs to a different session.');
    }
    if (frame.targetPeerId !== null && frame.targetPeerId !== request.peerId) {
      throw new Error('Received frame targets a different peer.');
    }
    requireRouteIdentifier(frame.senderPeerId, 'senderPeerId');
  }

  private requireConnected(): TransportConnectRequest {
    if (!this.request || !this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new TransportNotConnectedError();
    }
    if (this.snapshot.state !== 'connected') {
      throw new TransportNotConnectedError();
    }
    return this.request;
  }

  private sendBounded(data: string | Uint8Array, byteLength: number): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) throw new TransportNotConnectedError();
    if (socket.bufferedAmount + byteLength > this.maxBufferedAmountBytes) {
      throw new TransportBackpressureError(
        socket.bufferedAmount,
        byteLength,
        this.maxBufferedAmountBytes,
      );
    }
    socket.send(data);
  }

  private scheduleReconnect(generation: number, reason: string): void {
    if (!this.shouldReconnect || generation !== this.generation) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const exponential = Math.min(
      this.maxReconnectDelayMs,
      this.baseReconnectDelayMs * 2 ** Math.min(this.reconnectAttempt - 1, 20)
    );
    const jitteredDelay = Math.round(exponential * (0.8 + this.random() * 0.4));
    const reconnectDelay = Math.max(jitteredDelay, this.nextReconnectDelayFloorMs);
    this.nextReconnectDelayFloorMs = 0;

    this.setState({
      state: 'reconnecting',
      reconnectAttempt: this.reconnectAttempt,
      reason,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(generation);
    }, reconnectDelay);
  }

  private stopCurrentSocket(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      socket.close(1000, 'connection replaced');
    }
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private setState(snapshot: TransportStateSnapshot): void {
    this.snapshot = snapshot;
    this.emit({ kind: 'state', snapshot });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitError(
    source: 'socket' | 'protocol',
    code: string,
    message: string,
    recoverable: boolean
  ): void {
    this.emit({ kind: 'error', source, code, message, recoverable });
  }
}

export class TransportNotConnectedError extends Error {
  constructor() {
    super('Transport is not connected; persist the work and retry after a connected state event.');
    this.name = 'TransportNotConnectedError';
  }
}

export class TransportBackpressureError extends Error {
  readonly recoverable = true;
  readonly code = 'TRANSPORT_BACKPRESSURE';

  constructor(
    readonly bufferedBytes: number,
    readonly attemptedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `WebSocket queue is full (${bufferedBytes} buffered bytes; ${attemptedBytes} attempted; ${limitBytes} limit).`,
    );
    this.name = 'TransportBackpressureError';
  }
}

export function encodeBinaryChunkFrame(
  header: BinaryChunkHeader,
  bytes: Uint8Array
): Uint8Array {
  validateBinaryHeader(header);
  if (bytes.byteLength !== header.byteLength) {
    throw new RangeError('Binary header byteLength does not match the chunk payload.');
  }
  const headerBytes = utf8Encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_BINARY_HEADER_BYTES) {
    throw new RangeError(`Binary header exceeds ${MAX_BINARY_HEADER_BYTES} bytes.`);
  }

  const frame = new Uint8Array(4 + headerBytes.byteLength + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  frame.set(bytes, 4 + headerBytes.byteLength);
  return frame;
}

export function decodeBinaryChunkFrame(frame: Uint8Array): InboundBinaryChunk {
  if (frame.byteLength < 4) {
    throw new Error('Binary frame is missing its header length.');
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    Math.min(frame.byteLength, 4)
  ).getUint32(0, false);
  if (headerLength === 0 || headerLength > MAX_BINARY_HEADER_BYTES) {
    throw new Error('Binary frame has an invalid header length.');
  }
  const payloadOffset = 4 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error('Binary frame header is truncated.');
  }

  const parsed: unknown = JSON.parse(utf8Decode(frame.subarray(4, payloadOffset)));
  if (!isBinaryChunkHeader(parsed)) {
    throw new Error('Binary frame has an invalid chunk header.');
  }
  validateBinaryHeader(parsed);

  const bytes = frame.slice(payloadOffset);
  if (bytes.byteLength !== parsed.byteLength) {
    throw new Error('Binary frame payload length does not match its header.');
  }

  return {
    sessionId: parsed.sessionId,
    senderPeerId: parsed.senderPeerId,
    targetPeerId: parsed.targetPeerId,
    messageId: parsed.messageId,
    transferId: parsed.transferId,
    resourceId: parsed.resourceId,
    chunkIndex: parsed.chunkIndex,
    offset: parsed.offset,
    totalBytes: parsed.totalBytes,
    isLast: parsed.isLast,
    bytes,
  };
}

function parseTextFrame(text: string): ServerTextFrame {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.v !== TRANSPORT_PROTOCOL_VERSION || typeof value.kind !== 'string') {
    throw new Error('Text frame has an invalid protocol envelope.');
  }

  if (value.kind === 'welcome') {
    requireRouteIdentifier(value.sessionId, 'sessionId');
    requireRouteIdentifier(value.peerId, 'peerId');
    if (!Array.isArray(value.connectedPeerIds)) {
      throw new Error('Welcome frame is missing connectedPeerIds.');
    }
    value.connectedPeerIds.forEach((peerId) => requireRouteIdentifier(peerId, 'connectedPeerId'));
    return value as unknown as WelcomeFrame;
  }

  if (value.kind === 'relay-challenge') {
    requireCanonicalBase64Url(value.challenge, 32, 'challenge');
    return value as unknown as RelayChallengeFrame;
  }

  if (value.kind === 'peer') {
    requireRouteIdentifier(value.sessionId, 'sessionId');
    requireRouteIdentifier(value.peerId, 'peerId');
    if (value.change !== 'joined' && value.change !== 'left') {
      throw new Error('Peer frame has an invalid change value.');
    }
    return value as unknown as PeerFrame;
  }

  if (value.kind === 'relay-error') {
    if (
      typeof value.code !== 'string' ||
      typeof value.message !== 'string' ||
      typeof value.recoverable !== 'boolean'
    ) {
      throw new Error('Relay error frame is malformed.');
    }
    return value as unknown as ServerRelayErrorFrame;
  }

  if (value.kind === 'control') {
    validateControlFrame(value);
    return value;
  }

  throw new Error(`Unsupported text frame kind: ${value.kind}.`);
}

function validateControlFrame(
  value: Record<string, unknown>
): asserts value is Record<string, unknown> & ControlFrame {
  requireRouteIdentifier(value.sessionId, 'sessionId');
  requireRouteIdentifier(value.senderPeerId, 'senderPeerId');
  requireRouteIdentifier(value.messageId, 'messageId');
  requireMessageType(value.type);
  normalizeTarget(value.targetPeerId as string | null | undefined);
}

function validateOutboundChunk(chunk: OutboundBinaryChunk): void {
  if (chunk.messageId !== undefined) requireRouteIdentifier(chunk.messageId, 'messageId');
  requireRouteIdentifier(chunk.transferId, 'transferId');
  requireRouteIdentifier(chunk.resourceId, 'resourceId');
  requireNonNegativeInteger(chunk.chunkIndex, 'chunkIndex');
  requireNonNegativeInteger(chunk.offset, 'offset');
  requireNonNegativeInteger(chunk.totalBytes, 'totalBytes');
  if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0) {
    throw new RangeError('Chunk bytes must be a non-empty Uint8Array.');
  }
  if (chunk.bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new RangeError(`Chunk exceeds ${MAX_CHUNK_BYTES} bytes.`);
  }
  const chunkEnd = chunk.offset + chunk.bytes.byteLength;
  if (!Number.isSafeInteger(chunkEnd) || chunkEnd > chunk.totalBytes) {
    throw new RangeError('Chunk extends beyond totalBytes.');
  }
  if (chunk.isLast !== (chunkEnd === chunk.totalBytes)) {
    throw new RangeError('isLast must be true exactly when the chunk ends at totalBytes.');
  }
  normalizeTarget(chunk.targetPeerId);
}

function validateBinaryHeader(header: BinaryChunkHeader): void {
  requireRouteIdentifier(header.sessionId, 'sessionId');
  requireRouteIdentifier(header.senderPeerId, 'senderPeerId');
  if (header.messageId !== undefined) requireRouteIdentifier(header.messageId, 'messageId');
  requireRouteIdentifier(header.transferId, 'transferId');
  requireRouteIdentifier(header.resourceId, 'resourceId');
  normalizeTarget(header.targetPeerId);
  requireNonNegativeInteger(header.chunkIndex, 'chunkIndex');
  requireNonNegativeInteger(header.offset, 'offset');
  requireNonNegativeInteger(header.totalBytes, 'totalBytes');
  requireNonNegativeInteger(header.byteLength, 'byteLength');
  if (header.byteLength === 0 || header.byteLength > MAX_CHUNK_BYTES) {
    throw new RangeError(`byteLength must be between 1 and ${MAX_CHUNK_BYTES}.`);
  }
  const chunkEnd = header.offset + header.byteLength;
  if (!Number.isSafeInteger(chunkEnd) || chunkEnd > header.totalBytes) {
    throw new RangeError('Binary chunk extends beyond totalBytes.');
  }
  if (header.isLast !== (chunkEnd === header.totalBytes)) {
    throw new RangeError('Binary chunk isLast flag is inconsistent with totalBytes.');
  }
}

function isBinaryChunkHeader(value: unknown): value is BinaryChunkHeader {
  return (
    isRecord(value) &&
    value.v === TRANSPORT_PROTOCOL_VERSION &&
    value.kind === 'chunk' &&
    typeof value.sessionId === 'string' &&
    typeof value.senderPeerId === 'string' &&
    (value.targetPeerId === null || typeof value.targetPeerId === 'string') &&
    (value.messageId === undefined || typeof value.messageId === 'string') &&
    typeof value.transferId === 'string' &&
    typeof value.resourceId === 'string' &&
    typeof value.chunkIndex === 'number' &&
    typeof value.offset === 'number' &&
    typeof value.totalBytes === 'number' &&
    typeof value.byteLength === 'number' &&
    typeof value.isLast === 'boolean'
  );
}

async function toUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  if (
    isRecord(data) &&
    typeof data.arrayBuffer === 'function'
  ) {
    const buffer = await (data.arrayBuffer as () => Promise<ArrayBuffer>)();
    return new Uint8Array(buffer);
  }
  throw new Error('Unsupported WebSocket binary payload type.');
}

function normalizeTarget(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  requireRouteIdentifier(value, 'targetPeerId');
  return value;
}

function requireRouteIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new RangeError(
      `${field} must use 1 to 128 ASCII letters, digits, dots, underscores, colons, or dashes.`
    );
  }
}

function requireMessageType(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new RangeError('type must contain between 1 and 128 characters.');
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function requireDelay(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 50 || value > 300_000) {
    throw new RangeError(`${field} must be an integer between 50 and 300,000 milliseconds.`);
  }
  return value;
}

function requireBufferedAmountLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < MAX_CHUNK_BYTES + MAX_BINARY_HEADER_BYTES + 4) {
    throw new RangeError('maxBufferedAmountBytes must hold at least one maximum-size chunk.');
  }
  return value;
}

function validateWebSocketUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('url must be a valid ws:// or wss:// URL.');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError('url must use ws:// or wss://.');
  }
}

function relaySocketUrl(url: string, routeId: string): string {
  const parsed = new URL(url);
  // The route is a one-way verifier derived from the room capability. It lets
  // a stateless relay and load balancer route consistently without exposing
  // the trip identifier or accepting a first-claim token after restart.
  parsed.searchParams.set('room', routeId);
  return parsed.toString();
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Clock returned an invalid time for relay authentication.');
  }
  return value;
}

function requireRelayRouteId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)
  ) {
    throw new RangeError('Relay route must be a canonical 32-byte base64url verifier.');
  }
}

function requireCanonicalBase64Url(value: unknown, byteLength: number, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((byteLength * 8) / 6) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new RangeError(`${field} must be canonical base64url for ${byteLength} bytes.`);
  }
  // All challenge values are currently 32 bytes, whose final base64url sextet
  // has only four meaningful bits. This rejects alternate encodings.
  if (byteLength === 32 && !/[AEIMQUYcgkosw048]$/.test(value)) {
    throw new RangeError(`${field} must be canonical base64url for ${byteLength} bytes.`);
  }
}

function requireRetryCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
    throw new RangeError(`${field} must be an integer between 0 and 20.`);
  }
  return value;
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function utf8Decode(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
