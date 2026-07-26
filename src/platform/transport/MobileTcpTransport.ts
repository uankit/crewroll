import TcpSockets from 'react-native-tcp-socket';
import type NativeServer from 'react-native-tcp-socket/lib/types/Server';
import type NativeSocket from 'react-native-tcp-socket/lib/types/Socket';

import { MAX_TRIP_MEMBERS } from '../../core/constants';
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
import {
  TransportNotConnectedError,
  decodeBinaryChunkFrame,
  encodeBinaryChunkFrame,
} from './WebSocketRelayTransport';

export type MobileTcpEndpoint =
  | { role: 'coordinator'; host: '0.0.0.0'; port: number }
  | { role: 'member'; host: string; port: number };

export type MobileTcpWireFrameKind = 'text' | 'binary';

export interface MobileTcpWireFrame {
  kind: MobileTcpWireFrameKind;
  payload: Uint8Array;
}

export interface MobileTcpTransportOptions {
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  /** Includes the coordinator. Defaults to the product maximum of 10. */
  maxPeers?: number;
  /** Connections that have not completed hello. Defaults to 3. */
  maxPendingConnections?: number;
  /** JS-side queue per socket. Native/kernel buffers are separate. */
  maxQueuedBytesPerSocket?: number;
  random?: () => number;
  /** Test seam; production uses react-native-tcp-socket directly. */
  socketModule?: MobileTcpSocketModule;
}

export interface MobileTcpSocketModule {
  createConnection(
    options: {
      port: number;
      host?: string;
      reuseAddress?: boolean;
      connectTimeout?: number;
    },
    callback: () => void
  ): NativeSocket;
  createServer(
    options: {
      noDelay?: boolean;
      keepAlive?: boolean;
      keepAliveInitialDelay?: number;
      allowHalfOpen?: boolean;
      pauseOnConnect?: boolean;
    },
    listener: (socket: NativeSocket) => void
  ): NativeServer;
}

interface ManagedSocket {
  readonly socket: NativeSocket;
  readonly decoder: MobileTcpFrameDecoder;
  peerId: string | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  outboundQueue: Uint8Array[];
  outboundQueuedBytes: number;
  backpressured: boolean;
  closed: boolean;
}

type ParsedTextFrame = HelloFrame | WelcomeFrame | PeerFrame | RelayErrorFrame | ControlFrame;

const TEXT_FRAME_KIND = 1;
const BINARY_FRAME_KIND = 2;
const TCP_PREFIX_BYTES = 4;
const TCP_KIND_BYTES = 1;
const MAX_BINARY_BODY_BYTES = TCP_PREFIX_BYTES + MAX_BINARY_HEADER_BYTES + MAX_CHUNK_BYTES;
export const MAX_TCP_FRAME_PAYLOAD_BYTES = TCP_KIND_BYTES + Math.max(
  MAX_CONTROL_FRAME_BYTES,
  MAX_BINARY_BODY_BYTES
);
const DEFAULT_BASE_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_PENDING_CONNECTIONS = 3;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const FORCE_CLOSE_DELAY_MS = 250;

/**
 * Decodes a TCP byte stream without assuming data-event boundaries. Each
 * instance owns its prefix/payload buffers and must belong to exactly one
 * socket.
 */
export class MobileTcpFrameDecoder {
  private readonly prefix = new Uint8Array(TCP_PREFIX_BYTES);
  private prefixOffset = 0;
  private payload: Uint8Array | null = null;
  private payloadOffset = 0;

  constructor(private readonly onFrame: (frame: MobileTcpWireFrame) => void) {}

  push(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('TCP data must be a Uint8Array.');
    }

    let inputOffset = 0;
    while (inputOffset < bytes.byteLength) {
      if (this.payload === null) {
        const prefixBytes = Math.min(
          TCP_PREFIX_BYTES - this.prefixOffset,
          bytes.byteLength - inputOffset
        );
        this.prefix.set(bytes.subarray(inputOffset, inputOffset + prefixBytes), this.prefixOffset);
        this.prefixOffset += prefixBytes;
        inputOffset += prefixBytes;

        if (this.prefixOffset < TCP_PREFIX_BYTES) {
          continue;
        }

        const payloadLength = new DataView(this.prefix.buffer).getUint32(0, false);
        this.prefixOffset = 0;
        if (payloadLength <= TCP_KIND_BYTES || payloadLength > MAX_TCP_FRAME_PAYLOAD_BYTES) {
          throw new TcpProtocolError(
            'INVALID_LENGTH',
            `TCP frame length must be between 2 and ${MAX_TCP_FRAME_PAYLOAD_BYTES} bytes.`
          );
        }
        this.payload = new Uint8Array(payloadLength);
        this.payloadOffset = 0;
      }

      const payloadBytes = Math.min(
        this.payload.byteLength - this.payloadOffset,
        bytes.byteLength - inputOffset
      );
      this.payload.set(bytes.subarray(inputOffset, inputOffset + payloadBytes), this.payloadOffset);
      this.payloadOffset += payloadBytes;
      inputOffset += payloadBytes;

      if (this.payloadOffset === this.payload.byteLength) {
        const completed = this.payload;
        this.payload = null;
        this.payloadOffset = 0;
        const kindByte = completed[0];
        if (kindByte !== TEXT_FRAME_KIND && kindByte !== BINARY_FRAME_KIND) {
          throw new TcpProtocolError('INVALID_KIND', 'TCP frame has an unknown payload kind.');
        }
        this.onFrame({
          kind: kindByte === TEXT_FRAME_KIND ? 'text' : 'binary',
          payload: completed.subarray(TCP_KIND_BYTES),
        });
      }
    }
  }

  reset(): void {
    this.prefixOffset = 0;
    this.payload = null;
    this.payloadOffset = 0;
  }
}

export function encodeMobileTcpFrame(
  kind: MobileTcpWireFrameKind,
  payload: Uint8Array
): Uint8Array {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
    throw new RangeError('TCP frame payload must be a non-empty Uint8Array.');
  }
  const framedLength = TCP_KIND_BYTES + payload.byteLength;
  if (framedLength > MAX_TCP_FRAME_PAYLOAD_BYTES) {
    throw new RangeError(`TCP frame exceeds ${MAX_TCP_FRAME_PAYLOAD_BYTES} bytes.`);
  }

  const frame = new Uint8Array(TCP_PREFIX_BYTES + framedLength);
  new DataView(frame.buffer).setUint32(0, framedLength, false);
  frame[TCP_PREFIX_BYTES] = kind === 'text' ? TEXT_FRAME_KIND : BINARY_FRAME_KIND;
  frame.set(payload, TCP_PREFIX_BYTES + TCP_KIND_BYTES);
  return frame;
}

export function parseMobileTcpUrl(value: string): MobileTcpEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('TCP URL must be a valid tcp:// or tcp-listen:// URL.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('TCP URL must not include credentials, query parameters, or a fragment.');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new TypeError('TCP URL must not include a path.');
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('TCP URL must include a port between 1 and 65,535.');
  }

  if (url.protocol === 'tcp-listen:') {
    if (url.hostname !== '0.0.0.0') {
      throw new TypeError('Coordinator URL must listen on 0.0.0.0.');
    }
    return { role: 'coordinator', host: '0.0.0.0', port };
  }
  if (url.protocol === 'tcp:') {
    if (!url.hostname || url.hostname === '0.0.0.0') {
      throw new TypeError('Member TCP URL must contain a reachable coordinator host.');
    }
    return { role: 'member', host: stripIpv6Brackets(url.hostname), port };
  }
  throw new TypeError('TCP URL must use tcp:// or tcp-listen://.');
}

/**
 * Phone-hosted LAN transport using react-native-tcp-socket.
 *
 * The hello frame only supplies routing identity; it is not authentication.
 * Application frames sent through this transport must be encrypted and
 * authenticated by the application protocol.
 */
export class MobileTcpTransport implements Transport {
  private snapshot: TransportStateSnapshot = { state: 'idle', reconnectAttempt: 0 };
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly socketModule: MobileTcpSocketModule;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxPeers: number;
  private readonly maxPendingConnections: number;
  private readonly maxQueuedBytesPerSocket: number;
  private readonly random: () => number;

  private request: TransportConnectRequest | null = null;
  private endpoint: MobileTcpEndpoint | null = null;
  private server: NativeServer | null = null;
  private readonly coordinatorConnections = new Set<ManagedSocket>();
  private readonly coordinatorPeers = new Map<string, ManagedSocket>();
  private memberSocket: ManagedSocket | null = null;
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private memberFailureReason: string | null = null;
  private generation = 0;

  constructor(options: MobileTcpTransportOptions = {}) {
    this.socketModule = options.socketModule ?? (TcpSockets as MobileTcpSocketModule);
    this.baseReconnectDelayMs = requireDelay(
      options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS,
      'baseReconnectDelayMs'
    );
    this.maxReconnectDelayMs = requireDelay(
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      'maxReconnectDelayMs'
    );
    this.handshakeTimeoutMs = requireDelay(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs'
    );
    if (this.maxReconnectDelayMs < this.baseReconnectDelayMs) {
      throw new RangeError('maxReconnectDelayMs must be at least baseReconnectDelayMs.');
    }
    this.maxPeers = requireIntegerInRange(options.maxPeers ?? MAX_TRIP_MEMBERS, 2, 10, 'maxPeers');
    this.maxPendingConnections = requireIntegerInRange(
      options.maxPendingConnections ?? DEFAULT_PENDING_CONNECTIONS,
      1,
      5,
      'maxPendingConnections'
    );
    this.maxQueuedBytesPerSocket = requireIntegerInRange(
      options.maxQueuedBytesPerSocket ?? DEFAULT_MAX_QUEUED_BYTES,
      MAX_TCP_FRAME_PAYLOAD_BYTES,
      8 * 1024 * 1024,
      'maxQueuedBytesPerSocket'
    );
    this.random = options.random ?? Math.random;
  }

  get state(): TransportStateSnapshot {
    return this.snapshot;
  }

  connect(request: TransportConnectRequest): void {
    const endpoint = parseMobileTcpUrl(request.url);
    requireCoreIdentifier(request.sessionId, 'sessionId');
    requireCoreIdentifier(request.peerId, 'peerId');

    this.shouldReconnect = false;
    this.teardown();
    this.generation += 1;
    this.request = { ...request };
    this.endpoint = endpoint;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.memberFailureReason = null;

    if (endpoint.role === 'coordinator') {
      this.startCoordinator(endpoint, this.generation);
    } else {
      this.startMember(endpoint, this.generation);
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.generation += 1;
    this.teardown();
    this.request = null;
    this.endpoint = null;
    this.setState({ state: 'stopped', reconnectAttempt: 0 });
  }

  sendControl(message: OutboundControlMessage): void {
    const request = this.requireConnected();
    requireCoreIdentifier(message.messageId, 'messageId');
    requireMessageType(message.type);
    const targetPeerId = normalizeTarget(message.targetPeerId);
    if (targetPeerId === request.peerId) {
      throw new RangeError('A peer cannot send a transport frame to itself.');
    }

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
    const wire = encodeTextWireFrame(frame);
    this.sendApplicationWireFrame(targetPeerId, wire, message.messageId);
  }

  sendChunk(chunk: OutboundBinaryChunk): void {
    const request = this.requireConnected();
    validateOutboundChunk(chunk);
    const targetPeerId = normalizeTarget(chunk.targetPeerId);
    if (targetPeerId === request.peerId) {
      throw new RangeError('A peer cannot send a transport frame to itself.');
    }

    const header: BinaryChunkHeader = {
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'chunk',
      sessionId: request.sessionId,
      senderPeerId: request.peerId,
      targetPeerId,
      ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
      transferId: chunk.transferId,
      resourceId: chunk.resourceId,
      chunkIndex: chunk.chunkIndex,
      offset: chunk.offset,
      totalBytes: chunk.totalBytes,
      byteLength: chunk.bytes.byteLength,
      isLast: chunk.isLast,
    };
    const wire = encodeMobileTcpFrame('binary', encodeBinaryChunkFrame(header, chunk.bytes));
    this.sendApplicationWireFrame(targetPeerId, wire, chunk.messageId);
  }

  subscribe(listener: (event: TransportEvent) => void): TransportSubscription {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  private startCoordinator(endpoint: Extract<MobileTcpEndpoint, { role: 'coordinator' }>, generation: number): void {
    if (!this.request || !this.shouldReconnect || generation !== this.generation) {
      return;
    }
    this.setState({
      state: this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting',
      reconnectAttempt: this.reconnectAttempt,
    });

    let server: NativeServer;
    try {
      server = this.socketModule.createServer(
        {
          noDelay: true,
          keepAlive: true,
          keepAliveInitialDelay: 5_000,
          allowHalfOpen: false,
          pauseOnConnect: false,
        },
        (socket) => this.acceptCoordinatorSocket(socket, generation)
      );
      this.server = server;

      server.on('listening', () => {
        if (this.server !== server || generation !== this.generation) {
          return;
        }
        this.reconnectAttempt = 0;
        this.setState({ state: 'connected', reconnectAttempt: 0 });
        this.emit({ kind: 'peers', peerIds: [] });
      });
      server.on('error', (error) => {
        if (this.server !== server || generation !== this.generation) {
          return;
        }
        const reason = errorMessage(error);
        this.emitError('socket', 'TCP_SERVER_ERROR', reason, true);
        this.closeCoordinatorServer(server);
        this.scheduleCoordinatorReconnect(generation, reason);
      });
      server.on('close', () => {
        if (this.server === server) {
          this.server = null;
          for (const connection of [...this.coordinatorConnections]) {
            this.cleanupCoordinatorSocket(connection, true, false);
          }
          this.scheduleCoordinatorReconnect(generation, 'TCP listener closed.');
        }
      });
      server.listen({ host: endpoint.host, port: endpoint.port, reuseAddress: true });
    } catch (error) {
      this.server = null;
      const reason = errorMessage(error);
      this.emitError('socket', 'TCP_SERVER_START_FAILED', reason, true);
      this.scheduleCoordinatorReconnect(generation, reason);
    }
  }

  private scheduleCoordinatorReconnect(generation: number, reason: string): void {
    if (!this.shouldReconnect || generation !== this.generation) {
      return;
    }
    this.scheduleReconnect(generation, reason, () => {
      const endpoint = this.endpoint;
      if (endpoint?.role === 'coordinator') {
        this.startCoordinator(endpoint, generation);
      }
    });
  }

  private acceptCoordinatorSocket(socket: NativeSocket, generation: number): void {
    if (generation !== this.generation || !this.server || !this.request) {
      socket.destroy();
      return;
    }
    const pendingCount = [...this.coordinatorConnections].filter(
      (connection) => connection.peerId === null && !connection.closed
    ).length;
    if (pendingCount >= this.maxPendingConnections) {
      endUnmanagedSocketWithError(socket, 'SERVER_BUSY', 'Too many pending handshakes.');
      return;
    }

    let managed!: ManagedSocket;
    managed = this.createManagedSocket(
      socket,
      (frame) => this.handleCoordinatorWireFrame(managed, frame),
      (error) => {
        const protocolError = asProtocolError(error);
        this.emitError('protocol', protocolError.code, protocolError.message, false);
        this.rejectCoordinatorSocket(managed, protocolError.code, protocolError.message);
      }
    );
    this.coordinatorConnections.add(managed);
    managed.handshakeTimer = setTimeout(() => {
      this.rejectCoordinatorSocket(
        managed,
        'HELLO_TIMEOUT',
        'A hello frame is required before application data.'
      );
    }, this.handshakeTimeoutMs);

    socket.on('error', (error) => {
      if (!managed.closed) {
        this.emitError('socket', 'TCP_PEER_ERROR', error.message, true);
        this.cleanupCoordinatorSocket(managed, true);
      }
    });
    socket.on('close', () => this.cleanupCoordinatorSocket(managed, false));
  }

  private handleCoordinatorWireFrame(state: ManagedSocket, wireFrame: MobileTcpWireFrame): void {
    if (state.closed) {
      return;
    }
    try {
      if (state.peerId === null) {
        if (wireFrame.kind !== 'text') {
          throw new TcpProtocolError('HELLO_REQUIRED', 'A hello frame must be sent first.');
        }
        const frame = parseTextFrame(wireFrame.payload);
        if (frame.kind !== 'hello') {
          throw new TcpProtocolError('HELLO_REQUIRED', 'A hello frame must be sent first.');
        }
        this.admitCoordinatorPeer(state, frame);
        return;
      }

      if (wireFrame.kind === 'text') {
        const frame = parseTextFrame(wireFrame.payload);
        if (frame.kind !== 'control') {
          throw new TcpProtocolError(
            'UNSUPPORTED_FRAME',
            'Only control text frames are accepted after hello.'
          );
        }
        this.handleCoordinatorControl(state, frame, wireFrame.payload);
      } else {
        this.handleCoordinatorChunk(state, wireFrame.payload);
      }
    } catch (error) {
      const protocolError = asProtocolError(error);
      this.emitError('protocol', protocolError.code, protocolError.message, false);
      this.rejectCoordinatorSocket(state, protocolError.code, protocolError.message);
    }
  }

  private admitCoordinatorPeer(state: ManagedSocket, hello: HelloFrame): void {
    const request = this.request;
    if (!request) {
      throw new TcpProtocolError('SESSION_GONE', 'Coordinator session is not active.');
    }
    requireCoreIdentifier(hello.sessionId, 'sessionId');
    requireCoreIdentifier(hello.peerId, 'peerId');
    if (hello.sessionId !== request.sessionId) {
      throw new TcpProtocolError('SESSION_MISMATCH', 'Hello belongs to a different trip.');
    }
    if (hello.peerId === request.peerId) {
      throw new TcpProtocolError('SELF_PEER', 'Coordinator and member cannot share a device ID.');
    }

    const previous = this.coordinatorPeers.get(hello.peerId);
    if (!previous && this.coordinatorPeers.size + 1 >= this.maxPeers) {
      throw new TcpProtocolError('SESSION_FULL', `This trip already has ${this.maxPeers} peers.`);
    }

    const wasReplacement = previous !== undefined && previous !== state;
    if (wasReplacement) {
      const replacementError = encodeTextWireFrame({
        v: TRANSPORT_PROTOCOL_VERSION,
        kind: 'relay-error',
        code: 'PEER_REPLACED',
        message: 'Another socket registered this device ID.',
      } satisfies RelayErrorFrame);
      this.cleanupCoordinatorSocket(previous, false, false);
      try {
        previous.socket.end(replacementError);
      } catch {
        previous.socket.destroy();
      }
      previous.closeTimer = setTimeout(
        () => previous.socket.destroy(),
        FORCE_CLOSE_DELAY_MS
      );
    }

    clearManagedHandshakeTimer(state);
    state.peerId = hello.peerId;
    const connectedPeerIds = [
      request.peerId,
      ...[...this.coordinatorPeers.keys()].filter((peerId) => peerId !== hello.peerId),
    ];
    const welcomed = this.writeManaged(
      state,
      encodeTextWireFrame({
        v: TRANSPORT_PROTOCOL_VERSION,
        kind: 'welcome',
        sessionId: request.sessionId,
        peerId: hello.peerId,
        connectedPeerIds,
      } satisfies WelcomeFrame)
    );
    if (!welcomed) {
      throw new TcpProtocolError('WELCOME_FAILED', 'Could not send the welcome frame.');
    }
    this.coordinatorPeers.set(hello.peerId, state);

    if (!wasReplacement) {
      const peerFrame: PeerFrame = {
        v: TRANSPORT_PROTOCOL_VERSION,
        kind: 'peer',
        sessionId: request.sessionId,
        peerId: hello.peerId,
        change: 'joined',
      };
      this.broadcastCoordinatorSystemFrame(peerFrame, state);
      this.emit({ kind: 'peer-joined', peerId: hello.peerId });
    }
  }

  private handleCoordinatorControl(
    sender: ManagedSocket,
    frame: ControlFrame,
    rawPayload: Uint8Array
  ): void {
    this.verifyCoordinatorInboundRoute(sender, frame);
    const wire = encodeMobileTcpFrame('text', rawPayload);
    if (!this.routeCoordinatorInbound(sender, frame.targetPeerId, wire, frame.messageId)) {
      return;
    }
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

  private handleCoordinatorChunk(sender: ManagedSocket, rawPayload: Uint8Array): void {
    const chunk = decodeBinaryChunkFrame(rawPayload);
    validateInboundChunkIdentity(chunk);
    this.verifyCoordinatorInboundRoute(sender, chunk);
    const wire = encodeMobileTcpFrame('binary', rawPayload);
    if (!this.routeCoordinatorInbound(sender, chunk.targetPeerId, wire, chunk.messageId)) {
      return;
    }
    this.emit({ kind: 'chunk', chunk });
  }

  private verifyCoordinatorInboundRoute(
    sender: ManagedSocket,
    frame: { sessionId: string; senderPeerId: string; targetPeerId: string | null }
  ): void {
    const request = this.request;
    if (
      !request ||
      frame.sessionId !== request.sessionId ||
      frame.senderPeerId !== sender.peerId
    ) {
      throw new TcpProtocolError(
        'ROUTE_SPOOFING',
        'Frame identity does not match the admitted socket.'
      );
    }
    if (frame.targetPeerId === sender.peerId) {
      throw new TcpProtocolError('SELF_TARGET', 'A peer cannot route a frame to itself.');
    }
    normalizeTarget(frame.targetPeerId);
  }

  private routeCoordinatorInbound(
    sender: ManagedSocket,
    targetPeerId: string | null,
    wire: Uint8Array,
    messageId?: string
  ): boolean {
    const ownPeerId = this.request?.peerId;
    if (!ownPeerId) {
      return false;
    }
    if (targetPeerId === ownPeerId) {
      return true;
    }

    if (targetPeerId !== null) {
      const target = this.coordinatorPeers.get(targetPeerId);
      if (!target) {
        this.sendRelayError(sender, 'TARGET_OFFLINE', `Target peer ${targetPeerId} is offline.`, messageId);
        return false;
      }
      if (!this.writeManaged(target, wire)) {
        this.handleCoordinatorBackpressure(target, sender, messageId);
        return false;
      }
      return true;
    }

    let hadBackpressure = false;
    for (const peer of this.coordinatorPeers.values()) {
      if (peer !== sender && !this.writeManaged(peer, wire)) {
        hadBackpressure = true;
        this.handleCoordinatorBackpressure(peer, null);
      }
    }
    if (hadBackpressure) {
      this.sendRelayError(
        sender,
        'PEER_BACKPRESSURE',
        'One or more peers could not accept the broadcast.',
        messageId
      );
    }
    return true;
  }

  private startMember(endpoint: Extract<MobileTcpEndpoint, { role: 'member' }>, generation: number): void {
    if (!this.request || !this.shouldReconnect || generation !== this.generation) {
      return;
    }
    this.memberFailureReason = null;
    this.setState({
      state: this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting',
      reconnectAttempt: this.reconnectAttempt,
    });

    let managed: ManagedSocket | null = null;
    let connectedBeforeManaged = false;
    try {
      const socket = this.socketModule.createConnection(
        {
          host: endpoint.host,
          port: endpoint.port,
          reuseAddress: true,
          connectTimeout: this.handshakeTimeoutMs,
        },
        () => {
          if (managed) {
            this.handleMemberConnected(managed, generation);
          } else {
            connectedBeforeManaged = true;
          }
        }
      );
      managed = this.createManagedSocket(
        socket,
        (frame) => this.handleMemberWireFrame(managed!, frame, generation),
        (error) => {
          if (managed && this.memberSocket === managed) {
            const protocolError = asProtocolError(error);
            this.memberFailureReason = protocolError.message;
            this.emitError('protocol', protocolError.code, protocolError.message, true);
            managed.socket.destroy();
          }
        }
      );
      this.memberSocket = managed;

      socket.on('error', (error) => {
        if (this.memberSocket === managed && generation === this.generation) {
          const reason = errorMessage(error);
          this.memberFailureReason = reason;
          this.emitError('socket', 'TCP_CONNECTION_ERROR', reason, true);
          socket.destroy();
        }
      });
      socket.on('close', () => this.handleMemberClosed(managed!, generation));
      if (connectedBeforeManaged) {
        this.handleMemberConnected(managed, generation);
      }
    } catch (error) {
      this.memberSocket = null;
      const reason = errorMessage(error);
      this.memberFailureReason = reason;
      this.emitError('socket', 'TCP_CONNECT_FAILED', reason, true);
      this.scheduleMemberReconnect(generation, reason);
    }
  }

  private handleMemberConnected(state: ManagedSocket, generation: number): void {
    const request = this.request;
    if (!request || this.memberSocket !== state || generation !== this.generation) {
      state.socket.destroy();
      return;
    }

    this.setState({ state: 'handshaking', reconnectAttempt: this.reconnectAttempt });
    const hello: HelloFrame = {
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'hello',
      sessionId: request.sessionId,
      peerId: request.peerId,
    };
    if (!this.writeManaged(state, encodeTextWireFrame(hello))) {
      state.socket.destroy();
      return;
    }
    state.handshakeTimer = setTimeout(() => {
      if (this.memberSocket === state) {
        this.memberFailureReason = 'Coordinator did not acknowledge the TCP hello.';
        this.emitError(
          'protocol',
          'HANDSHAKE_TIMEOUT',
          'Coordinator did not acknowledge the TCP hello.',
          true
        );
        state.socket.destroy();
      }
    }, this.handshakeTimeoutMs);
  }

  private handleMemberWireFrame(
    state: ManagedSocket,
    wireFrame: MobileTcpWireFrame,
    generation: number
  ): void {
    if (this.memberSocket !== state || generation !== this.generation || state.closed) {
      return;
    }
    try {
      if (wireFrame.kind === 'binary') {
        if (this.snapshot.state !== 'connected') {
          throw new TcpProtocolError(
            'HANDSHAKE_REQUIRED',
            'Binary data arrived before the welcome frame.'
          );
        }
        const chunk = decodeBinaryChunkFrame(wireFrame.payload);
        validateInboundChunkIdentity(chunk);
        this.verifyMemberInboundRoute(chunk);
        this.emit({ kind: 'chunk', chunk });
        return;
      }

      const frame = parseTextFrame(wireFrame.payload);
      if (frame.kind === 'relay-error') {
        this.emit({
          kind: 'error',
          source: 'relay',
          code: frame.code,
          message: frame.message,
          recoverable: true,
          messageId: frame.messageId,
        });
        return;
      }
      if (frame.kind === 'welcome') {
        this.handleMemberWelcome(state, frame);
        return;
      }
      if (this.snapshot.state !== 'connected') {
        throw new TcpProtocolError(
          'HANDSHAKE_REQUIRED',
          'Application data arrived before the welcome frame.'
        );
      }
      if (frame.kind === 'peer') {
        if (frame.sessionId !== this.request?.sessionId) {
          throw new TcpProtocolError('SESSION_MISMATCH', 'Peer event belongs to another trip.');
        }
        this.emit({
          kind: frame.change === 'joined' ? 'peer-joined' : 'peer-left',
          peerId: frame.peerId,
        });
        return;
      }
      if (frame.kind !== 'control') {
        throw new TcpProtocolError('UNSUPPORTED_FRAME', 'Unexpected TCP text frame.');
      }
      this.verifyMemberInboundRoute(frame);
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
    } catch (error) {
      const protocolError = asProtocolError(error);
      this.memberFailureReason = protocolError.message;
      this.emitError('protocol', protocolError.code, protocolError.message, true);
      state.socket.destroy();
    }
  }

  private handleMemberWelcome(state: ManagedSocket, frame: WelcomeFrame): void {
    const request = this.request;
    if (
      !request ||
      frame.sessionId !== request.sessionId ||
      frame.peerId !== request.peerId ||
      this.snapshot.state !== 'handshaking'
    ) {
      throw new TcpProtocolError(
        'INVALID_WELCOME',
        'Welcome does not match the requested trip and device.'
      );
    }
    if (frame.connectedPeerIds.length > this.maxPeers - 1) {
      throw new TcpProtocolError('INVALID_WELCOME', 'Welcome exceeds the trip peer limit.');
    }
    for (const peerId of frame.connectedPeerIds) {
      requireCoreIdentifier(peerId, 'connectedPeerId');
      if (peerId === request.peerId) {
        throw new TcpProtocolError('INVALID_WELCOME', 'Welcome peer list contains this device.');
      }
    }

    clearManagedHandshakeTimer(state);
    this.memberFailureReason = null;
    this.reconnectAttempt = 0;
    this.setState({ state: 'connected', reconnectAttempt: 0 });
    this.emit({ kind: 'peers', peerIds: [...new Set(frame.connectedPeerIds)] });
  }

  private verifyMemberInboundRoute(frame: {
    sessionId: string;
    senderPeerId: string;
    targetPeerId: string | null;
  }): void {
    const request = this.request;
    if (!request || frame.sessionId !== request.sessionId) {
      throw new TcpProtocolError('SESSION_MISMATCH', 'Frame belongs to another trip.');
    }
    if (frame.targetPeerId !== null && frame.targetPeerId !== request.peerId) {
      throw new TcpProtocolError('WRONG_TARGET', 'Frame targets another device.');
    }
    requireCoreIdentifier(frame.senderPeerId, 'senderPeerId');
    normalizeTarget(frame.targetPeerId);
  }

  private handleMemberClosed(state: ManagedSocket, generation: number): void {
    if (this.memberSocket !== state) {
      return;
    }
    this.cleanupManagedSocket(state, false);
    this.memberSocket = null;
    if (this.shouldReconnect && generation === this.generation) {
      const reason = this.memberFailureReason ?? 'TCP connection closed unexpectedly.';
      this.scheduleMemberReconnect(generation, reason);
    }
  }

  private scheduleMemberReconnect(generation: number, reason: string): void {
    if (!this.shouldReconnect || generation !== this.generation) {
      return;
    }
    this.scheduleReconnect(generation, reason, () => {
      const endpoint = this.endpoint;
      if (endpoint?.role === 'member') {
        this.startMember(endpoint, generation);
      }
    });
  }

  private scheduleReconnect(
    generation: number,
    reason: string,
    reconnect: () => void,
  ): void {
    if (!this.shouldReconnect || generation !== this.generation) return;
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const exponential = Math.min(
      this.maxReconnectDelayMs,
      this.baseReconnectDelayMs * 2 ** Math.min(this.reconnectAttempt - 1, 20)
    );
    const delay = Math.round(exponential * (0.8 + clampRandom(this.random()) * 0.4));
    this.setState({ state: 'reconnecting', reconnectAttempt: this.reconnectAttempt, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      reconnect();
    }, delay);
  }

  private sendApplicationWireFrame(
    targetPeerId: string | null,
    wire: Uint8Array,
    messageId?: string
  ): void {
    if (this.endpoint?.role === 'coordinator') {
      this.routeCoordinatorOutbound(targetPeerId, wire, messageId);
      return;
    }
    const socket = this.memberSocket;
    if (!socket || !this.writeManaged(socket, wire)) {
      if (socket) {
        this.memberFailureReason = 'The TCP send queue could not accept the frame.';
        socket.socket.destroy();
      }
      throw new TcpBackpressureError();
    }
  }

  private routeCoordinatorOutbound(
    targetPeerId: string | null,
    wire: Uint8Array,
    messageId?: string
  ): void {
    if (targetPeerId !== null) {
      const target = this.coordinatorPeers.get(targetPeerId);
      if (!target) {
        this.emit({
          kind: 'error',
          source: 'relay',
          code: 'TARGET_OFFLINE',
          message: `Target peer ${targetPeerId} is offline.`,
          messageId,
          recoverable: true,
        });
        return;
      }
      if (!this.writeManaged(target, wire)) {
        this.handleCoordinatorBackpressure(target, null, messageId);
      }
      return;
    }

    for (const peer of [...this.coordinatorPeers.values()]) {
      if (!this.writeManaged(peer, wire)) {
        this.handleCoordinatorBackpressure(peer, null, messageId);
      }
    }
  }

  private handleCoordinatorBackpressure(
    slowPeer: ManagedSocket,
    sender: ManagedSocket | null,
    messageId?: string
  ): void {
    const slowPeerId = slowPeer.peerId ?? 'pending peer';
    this.emitError(
      'socket',
      'TCP_BACKPRESSURE',
      `Closing ${slowPeerId}: its bounded send queue is full.`,
      true
    );
    this.cleanupCoordinatorSocket(slowPeer, true);
    if (sender) {
      this.sendRelayError(
        sender,
        'TARGET_BACKPRESSURE',
        `Target peer ${slowPeerId} could not accept the frame.`,
        messageId
      );
    }
  }

  private broadcastCoordinatorSystemFrame(frame: PeerFrame, excluded: ManagedSocket): void {
    const wire = encodeTextWireFrame(frame);
    for (const peer of [...this.coordinatorPeers.values()]) {
      if (peer !== excluded && !this.writeManaged(peer, wire)) {
        this.handleCoordinatorBackpressure(peer, null);
      }
    }
  }

  private sendRelayError(
    target: ManagedSocket,
    code: string,
    message: string,
    messageId?: string
  ): void {
    this.writeManaged(
      target,
      encodeTextWireFrame({
        v: TRANSPORT_PROTOCOL_VERSION,
        kind: 'relay-error',
        code,
        message,
        ...(messageId ? { messageId } : {}),
      } satisfies RelayErrorFrame)
    );
  }

  private rejectCoordinatorSocket(
    state: ManagedSocket,
    code: string,
    message: string
  ): void {
    if (state.closed) {
      return;
    }
    const wire = encodeTextWireFrame({
      v: TRANSPORT_PROTOCOL_VERSION,
      kind: 'relay-error',
      code,
      message,
    } satisfies RelayErrorFrame);
    try {
      state.socket.end(wire);
    } catch {
      state.socket.destroy();
    }
    this.cleanupCoordinatorSocket(state, false);
    state.closeTimer = setTimeout(() => state.socket.destroy(), FORCE_CLOSE_DELAY_MS);
  }

  private createManagedSocket(
    socket: NativeSocket,
    onFrame: (frame: MobileTcpWireFrame) => void,
    onDecoderError: (error: unknown) => void
  ): ManagedSocket {
    const managed: ManagedSocket = {
      socket,
      decoder: new MobileTcpFrameDecoder(onFrame),
      peerId: null,
      handshakeTimer: null,
      closeTimer: null,
      outboundQueue: [],
      outboundQueuedBytes: 0,
      backpressured: false,
      closed: false,
    };
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5_000);
    socket.on('data', (data) => {
      if (managed.closed) {
        return;
      }
      try {
        managed.decoder.push(toUint8Array(data));
      } catch (error) {
        onDecoderError(error);
      }
    });
    socket.on('drain', () => this.flushManagedSocket(managed));
    return managed;
  }

  private writeManaged(state: ManagedSocket, frame: Uint8Array): boolean {
    if (state.closed || state.socket.destroyed) {
      return false;
    }
    if (state.backpressured || state.outboundQueue.length > 0) {
      if (state.outboundQueuedBytes + frame.byteLength > this.maxQueuedBytesPerSocket) {
        return false;
      }
      state.outboundQueue.push(frame);
      state.outboundQueuedBytes += frame.byteLength;
      return true;
    }

    try {
      const flushed = state.socket.write(frame);
      if (!flushed) {
        state.backpressured = true;
      }
    } catch {
      return false;
    }
    return true;
  }

  private flushManagedSocket(state: ManagedSocket): void {
    if (state.closed) {
      return;
    }
    state.backpressured = false;
    while (state.outboundQueue.length > 0) {
      const frame = state.outboundQueue.shift()!;
      state.outboundQueuedBytes -= frame.byteLength;
      try {
        if (!state.socket.write(frame)) {
          state.backpressured = true;
          return;
        }
      } catch {
        state.socket.destroy();
        return;
      }
    }
  }

  private cleanupCoordinatorSocket(
    state: ManagedSocket,
    destroy: boolean,
    announce = true
  ): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    clearManagedTimers(state);
    state.decoder.reset();
    state.outboundQueue = [];
    state.outboundQueuedBytes = 0;
    this.coordinatorConnections.delete(state);

    const peerId = state.peerId;
    if (peerId && this.coordinatorPeers.get(peerId) === state) {
      this.coordinatorPeers.delete(peerId);
      if (announce && this.request) {
        const peerFrame: PeerFrame = {
          v: TRANSPORT_PROTOCOL_VERSION,
          kind: 'peer',
          sessionId: this.request.sessionId,
          peerId,
          change: 'left',
        };
        this.broadcastCoordinatorSystemFrame(peerFrame, state);
        this.emit({ kind: 'peer-left', peerId });
      }
    }
    if (destroy && !state.socket.destroyed) {
      state.socket.destroy();
    }
  }

  private cleanupManagedSocket(state: ManagedSocket, destroy: boolean): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    clearManagedTimers(state);
    state.decoder.reset();
    state.outboundQueue = [];
    state.outboundQueuedBytes = 0;
    if (destroy && !state.socket.destroyed) {
      state.socket.destroy();
    }
  }

  private closeCoordinatorServer(server: NativeServer): void {
    if (this.server === server) {
      this.server = null;
    }
    for (const connection of [...this.coordinatorConnections]) {
      this.cleanupCoordinatorSocket(connection, true, false);
    }
    try {
      server.close();
    } catch {
      // The native server can already be closed after an error.
    }
  }

  private teardown(): void {
    this.clearReconnectTimer();
    if (this.memberSocket) {
      const socket = this.memberSocket;
      this.memberSocket = null;
      this.cleanupManagedSocket(socket, true);
    }
    if (this.server) {
      this.closeCoordinatorServer(this.server);
    } else {
      for (const connection of [...this.coordinatorConnections]) {
        this.cleanupCoordinatorSocket(connection, true, false);
      }
    }
  }

  private requireConnected(): TransportConnectRequest {
    if (!this.request || this.snapshot.state !== 'connected') {
      throw new TransportNotConnectedError();
    }
    if (this.endpoint?.role === 'member' && !this.memberSocket) {
      throw new TransportNotConnectedError();
    }
    if (this.endpoint?.role === 'coordinator' && !this.server) {
      throw new TransportNotConnectedError();
    }
    return this.request;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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

export class TcpBackpressureError extends Error {
  constructor() {
    super('The bounded TCP send queue is full; retry this durable operation after reconnect.');
    this.name = 'TcpBackpressureError';
  }
}

class TcpProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TcpProtocolError';
  }
}

function encodeTextWireFrame(value: ParsedTextFrame): Uint8Array {
  const encoded = utf8Encode(JSON.stringify(value));
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new RangeError(`TCP text frame exceeds ${MAX_CONTROL_FRAME_BYTES} bytes.`);
  }
  return encodeMobileTcpFrame('text', encoded);
}

function parseTextFrame(payload: Uint8Array): ParsedTextFrame {
  if (payload.byteLength === 0 || payload.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new TcpProtocolError('INVALID_TEXT_SIZE', 'TCP text frame has an invalid size.');
  }
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(payload));
  } catch {
    throw new TcpProtocolError('INVALID_JSON', 'TCP text frame is not valid UTF-8 JSON.');
  }
  if (!isRecord(value) || value.v !== TRANSPORT_PROTOCOL_VERSION || typeof value.kind !== 'string') {
    throw new TcpProtocolError('INVALID_ENVELOPE', 'TCP text frame has an invalid envelope.');
  }

  switch (value.kind) {
    case 'hello':
      requireCoreIdentifier(value.sessionId, 'sessionId');
      requireCoreIdentifier(value.peerId, 'peerId');
      return value as unknown as HelloFrame;
    case 'welcome':
      requireCoreIdentifier(value.sessionId, 'sessionId');
      requireCoreIdentifier(value.peerId, 'peerId');
      if (!Array.isArray(value.connectedPeerIds) || value.connectedPeerIds.length > 10) {
        throw new TcpProtocolError('INVALID_WELCOME', 'Welcome has an invalid peer list.');
      }
      for (const peerId of value.connectedPeerIds) {
        requireCoreIdentifier(peerId, 'connectedPeerId');
      }
      return value as unknown as WelcomeFrame;
    case 'peer':
      requireCoreIdentifier(value.sessionId, 'sessionId');
      requireCoreIdentifier(value.peerId, 'peerId');
      if (value.change !== 'joined' && value.change !== 'left') {
        throw new TcpProtocolError('INVALID_PEER_EVENT', 'Peer event has an invalid change.');
      }
      return value as unknown as PeerFrame;
    case 'relay-error':
      if (
        typeof value.code !== 'string' ||
        value.code.length === 0 ||
        value.code.length > 128 ||
        typeof value.message !== 'string' ||
        value.message.length > 512 ||
        (value.messageId !== undefined && typeof value.messageId !== 'string')
      ) {
        throw new TcpProtocolError('INVALID_RELAY_ERROR', 'Relay error frame is malformed.');
      }
      return value as unknown as RelayErrorFrame;
    case 'control':
      requireCoreIdentifier(value.sessionId, 'sessionId');
      requireCoreIdentifier(value.senderPeerId, 'senderPeerId');
      requireCoreIdentifier(value.messageId, 'messageId');
      requireMessageType(value.type);
      normalizeTarget(value.targetPeerId as string | null | undefined);
      return value as unknown as ControlFrame;
    default:
      throw new TcpProtocolError('UNSUPPORTED_FRAME', `Unsupported text frame kind: ${value.kind}.`);
  }
}

function validateOutboundChunk(chunk: OutboundBinaryChunk): void {
  if (chunk.messageId !== undefined) requireCoreIdentifier(chunk.messageId, 'messageId');
  requireCoreIdentifier(chunk.transferId, 'transferId');
  requireCoreIdentifier(chunk.resourceId, 'resourceId');
  requireNonNegativeSafeInteger(chunk.chunkIndex, 'chunkIndex');
  requireNonNegativeSafeInteger(chunk.offset, 'offset');
  requireNonNegativeSafeInteger(chunk.totalBytes, 'totalBytes');
  if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0) {
    throw new RangeError('Chunk bytes must be a non-empty Uint8Array.');
  }
  if (chunk.bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new RangeError(`Chunk exceeds ${MAX_CHUNK_BYTES} bytes.`);
  }
  const end = chunk.offset + chunk.bytes.byteLength;
  if (!Number.isSafeInteger(end) || end > chunk.totalBytes) {
    throw new RangeError('Chunk extends beyond totalBytes.');
  }
  if (chunk.isLast !== (end === chunk.totalBytes)) {
    throw new RangeError('isLast must be true exactly when the chunk ends at totalBytes.');
  }
  normalizeTarget(chunk.targetPeerId);
}

function endUnmanagedSocketWithError(socket: NativeSocket, code: string, message: string): void {
  socket.on('error', () => undefined);
  try {
    socket.end(
      encodeTextWireFrame({
        v: TRANSPORT_PROTOCOL_VERSION,
        kind: 'relay-error',
        code,
        message,
      } satisfies RelayErrorFrame)
    );
  } catch {
    socket.destroy();
  }
}

function clearManagedHandshakeTimer(state: ManagedSocket): void {
  if (state.handshakeTimer !== null) {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
  }
}

function clearManagedTimers(state: ManagedSocket): void {
  clearManagedHandshakeTimer(state);
  if (state.closeTimer !== null) {
    clearTimeout(state.closeTimer);
    state.closeTimer = null;
  }
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    return utf8Encode(value);
  }
  throw new TcpProtocolError('INVALID_SOCKET_DATA', 'Native TCP socket returned unsupported data.');
}

function normalizeTarget(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  requireCoreIdentifier(value, 'targetPeerId');
  return value;
}

function validateInboundChunkIdentity(chunk: {
  transferId: string;
  resourceId: string;
}): void {
  requireCoreIdentifier(chunk.transferId, 'transferId');
  requireCoreIdentifier(chunk.resourceId, 'resourceId');
}

function requireCoreIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)
  ) {
    throw new TcpProtocolError(
      'INVALID_IDENTIFIER',
      `${field} must be an 8 to 128 character core identifier.`
    );
  }
}

function requireMessageType(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TcpProtocolError('INVALID_MESSAGE_TYPE', 'type must contain 1 to 128 characters.');
  }
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function requireDelay(value: number, field: string): number {
  return requireIntegerInRange(value, 50, 300_000, field);
}

function requireIntegerInRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function clampRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
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

function asProtocolError(error: unknown): TcpProtocolError {
  return error instanceof TcpProtocolError
    ? error
    : new TcpProtocolError('INVALID_FRAME', errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
