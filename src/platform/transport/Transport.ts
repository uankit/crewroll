import { MAX_RESOURCE_CHUNK_BYTES, PROTOCOL_VERSION } from '../../core/constants';

export const TRANSPORT_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_BINARY_HEADER_BYTES = 16 * 1024;
export const MAX_CHUNK_BYTES = MAX_RESOURCE_CHUNK_BYTES;

export type TransportConnectionState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'stopped';

export interface TransportStateSnapshot {
  state: TransportConnectionState;
  reconnectAttempt: number;
  reason?: string;
}

export interface TransportConnectRequest {
  url: string;
  sessionId: string;
  peerId: string;
}

export interface OutboundControlMessage {
  messageId: string;
  type: string;
  payload: unknown;
  /** Omit or set null to broadcast to the session. */
  targetPeerId?: string | null;
}

export interface InboundControlMessage extends OutboundControlMessage {
  sessionId: string;
  senderPeerId: string;
  targetPeerId: string | null;
}

export interface OutboundBinaryChunk {
  /** Opaque application message identifier used to correlate relay failures. */
  messageId?: string;
  transferId: string;
  resourceId: string;
  chunkIndex: number;
  offset: number;
  totalBytes: number;
  isLast: boolean;
  bytes: Uint8Array;
  /** Omit or set null to broadcast to the session. */
  targetPeerId?: string | null;
}

export interface InboundBinaryChunk extends OutboundBinaryChunk {
  sessionId: string;
  senderPeerId: string;
  targetPeerId: string | null;
}

export type TransportEvent =
  | { kind: 'state'; snapshot: TransportStateSnapshot }
  | { kind: 'peers'; peerIds: string[] }
  | { kind: 'peer-joined'; peerId: string }
  | { kind: 'peer-left'; peerId: string }
  | { kind: 'control'; message: InboundControlMessage }
  | { kind: 'chunk'; chunk: InboundBinaryChunk }
  | {
      kind: 'error';
      source: 'socket' | 'protocol' | 'relay';
      code: string;
      message: string;
      recoverable: boolean;
      messageId?: string;
    };

export interface TransportSubscription {
  remove(): void;
}

/**
 * A live, lossy connection boundary. Durable retries and the outbox belong in
 * the application/data layer; an implementation must not pretend that a
 * successful `send` is a delivery receipt.
 */
export interface Transport {
  readonly state: TransportStateSnapshot;
  connect(request: TransportConnectRequest): void;
  disconnect(): void;
  sendControl(message: OutboundControlMessage): void;
  sendChunk(chunk: OutboundBinaryChunk): void;
  subscribe(listener: (event: TransportEvent) => void): TransportSubscription;
}

export interface HelloFrame {
  v: typeof TRANSPORT_PROTOCOL_VERSION;
  kind: 'hello';
  sessionId: string;
  peerId: string;
}

export interface ControlFrame {
  v: typeof TRANSPORT_PROTOCOL_VERSION;
  kind: 'control';
  sessionId: string;
  senderPeerId: string;
  targetPeerId: string | null;
  messageId: string;
  type: string;
  payload: unknown;
}

export interface BinaryChunkHeader {
  v: typeof TRANSPORT_PROTOCOL_VERSION;
  kind: 'chunk';
  sessionId: string;
  senderPeerId: string;
  targetPeerId: string | null;
  /** Optional for compatibility with protocol-v3 clients built before failure correlation. */
  messageId?: string;
  transferId: string;
  resourceId: string;
  chunkIndex: number;
  offset: number;
  totalBytes: number;
  byteLength: number;
  isLast: boolean;
}

export interface WelcomeFrame {
  v: typeof TRANSPORT_PROTOCOL_VERSION;
  kind: 'welcome';
  sessionId: string;
  peerId: string;
  connectedPeerIds: string[];
}

export interface PeerFrame {
  v: typeof TRANSPORT_PROTOCOL_VERSION;
  kind: 'peer';
  sessionId: string;
  peerId: string;
  change: 'joined' | 'left';
}

export interface RelayErrorFrame {
  v: typeof TRANSPORT_PROTOCOL_VERSION;
  kind: 'relay-error';
  code: string;
  message: string;
  messageId?: string;
}
