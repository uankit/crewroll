import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';

const PROTOCOL_VERSION = 3;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_BINARY_HEADER_BYTES = 16 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_BINARY_FRAME_BYTES = 4 + MAX_BINARY_HEADER_BYTES + MAX_CHUNK_BYTES;
const ROUTE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ROUTE_CONTEXT = 'airmesh-relay-route-v1';
const PEER_AUTHENTICATION_CONTEXT = 'airmesh-relay-peer-auth-v1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const DEFAULTS = Object.freeze({
  path: '/v1/relay',
  // The app admits at most ten trip members. Relay headroom prevents a finite
  // set of stale-capability sockets from consuming every application slot.
  maxPeersPerRoom: 32,
  maxRooms: 1_000,
  maxTotalConnections: 2_000,
  maxPendingHandshakes: 256,
  maxConnectionsPerIp: 64,
  maxUpgradeAttemptsPerSecond: 4,
  maxUpgradeBurst: 64,
  maxTrackedSourceIps: 4_096,
  upgradeRateLimitTtlMs: 2 * 60 * 1_000,
  maxIngressBytesPerSecond: 16 * 1024 * 1024,
  maxIngressBurstBytes: 32 * 1024 * 1024,
  maxIngressMessagesPerSecond: 256,
  maxIngressMessageBurst: 512,
  maxSocketBufferedBytes: 2 * 1024 * 1024,
  maxRoomBufferedBytes: 8 * 1024 * 1024,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
  handshakeTimeoutMs: 8_000,
  authenticationClockSkewMs: 2 * 60 * 1_000,
  heartbeatIntervalMs: 15_000,
  peerTtlMs: 45_000,
});

export function createRelayServer(options = {}) {
  const config = normalizeOptions(options);
  const rooms = new Map();
  const connectionStates = new WeakMap();
  const connectionsByIp = new Map();
  const upgradeBudgetsByIp = new Map();
  let pendingHandshakes = 0;
  let queuedApplicationBytes = 0;
  const startedAtMs = config.now();

  const httpServer = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://relay.invalid');
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      writeJson(response, 200, {
        status: 'ok',
        uptimeMs: Math.max(0, config.now() - startedAtMs),
        ...snapshotStats(rooms, webSocketServer, pendingHandshakes),
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/readyz') {
      writeJson(response, 200, { status: 'ready' });
      return;
    }
    writeJson(response, 404, { error: 'not_found' });
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BINARY_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://relay.invalid');
    } catch {
      rejectUpgrade(socket, 400, 'Invalid request URL');
      return;
    }
    const remoteAddress = resolveRemoteAddress(request, config.trustProxy);
    if (!consumeUpgradeBudget(remoteAddress, upgradeBudgetsByIp, connectionsByIp, config)) {
      rejectUpgrade(socket, 429, 'Relay upgrade rate limit reached');
      return;
    }
    if (requestUrl.pathname !== config.path) {
      rejectUpgrade(socket, 404, 'Relay route not found');
      return;
    }
    const roomRouteId = requestUrl.searchParams.get('room');
    if (!isCanonicalToken(roomRouteId)) {
      rejectUpgrade(socket, 400, 'A valid opaque room route is required');
      return;
    }
    if (!originAllowed(request.headers.origin, config.allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Origin is not allowed');
      return;
    }
    if (webSocketServer.clients.size >= config.maxTotalConnections) {
      rejectUpgrade(socket, 503, 'Relay connection capacity is full');
      return;
    }
    if (pendingHandshakes >= config.maxPendingHandshakes) {
      rejectUpgrade(socket, 503, 'Relay authentication capacity is full');
      return;
    }
    if ((connectionsByIp.get(remoteAddress) ?? 0) >= config.maxConnectionsPerIp) {
      rejectUpgrade(socket, 429, 'Relay connection limit reached');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request, { roomRouteId, remoteAddress });
    });
  });

  webSocketServer.on('connection', (webSocket, _request, metadata) => {
    const state = {
      roomRouteId: metadata.roomRouteId,
      challenge: randomBytes(32).toString('base64url'),
      remoteAddress: metadata.remoteAddress,
      sessionId: null,
      peerId: null,
      authenticated: false,
      superseded: false,
      lastPongAtMs: config.now(),
      ingressBytes: config.maxIngressBurstBytes,
      ingressMessages: config.maxIngressMessageBurst,
      ingressLastRefillAtMs: config.now(),
      queuedApplicationBytes: 0,
      pendingApplicationSendReleases: new Set(),
      handshakeTimer: null,
    };
    pendingHandshakes += 1;
    connectionsByIp.set(
      state.remoteAddress,
      (connectionsByIp.get(state.remoteAddress) ?? 0) + 1,
    );
    connectionStates.set(webSocket, state);
    state.handshakeTimer = setTimeout(() => {
      if (!state.authenticated) {
        sendRelayError(webSocket, config, 'AUTH_TIMEOUT', 'Relay authentication timed out.');
        webSocket.close(1013, 'authentication timeout');
      }
    }, config.handshakeTimeoutMs);
    state.handshakeTimer.unref?.();

    webSocket.on('pong', () => {
      state.lastPongAtMs = config.now();
      const room = state.authenticated ? rooms.get(state.roomRouteId) : null;
      if (room) room.lastActivityAtMs = state.lastPongAtMs;
    });

    webSocket.on('message', (data, isBinary) => {
      try {
        if (!consumeIngressBudget(state, frameByteLength(data), config)) {
          throw relayError(
            'RATE_LIMITED',
            'Relay ingress rate exceeded; reconnect and resume from the last acknowledgement.',
            true,
            1013,
          );
        }
        if (!state.authenticated) {
          authenticateConnection(webSocket, state, data, isBinary);
          return;
        }
        routeApplicationFrame(webSocket, state, data, isBinary);
      } catch (error) {
        const protocolError = toRelayError(error);
        sendRelayError(
          webSocket,
          config,
          protocolError.code,
          protocolError.message,
          protocolError.messageId,
        );
        if (protocolError.fatal) {
          webSocket.close(
            protocolError.closeCode,
            protocolError.message.slice(0, 120),
          );
        }
      }
    });

    webSocket.on('close', () => detachConnection(webSocket, state));
    webSocket.on('error', () => {
      // The close event performs all room cleanup. Never log application data.
    });

    function authenticateConnection(socket, connection, data, isBinary) {
      if (isBinary) {
        throw relayError('INVALID_HELLO', 'The first relay frame must be a JSON hello.', true);
      }
      const encoded = asBuffer(data);
      if (encoded.byteLength > MAX_CONTROL_FRAME_BYTES) {
        throw relayError('INVALID_HELLO', 'The relay hello exceeds the frame limit.', true);
      }
      let hello;
      try {
        hello = JSON.parse(textDecoder.decode(encoded));
      } catch {
        throw relayError('INVALID_HELLO', 'The relay hello is not valid JSON.', true);
      }
      const authentication = verifyRelayHelloAuthentication(hello, {
        nowMs: config.now(),
        clockSkewMs: config.authenticationClockSkewMs,
        expectedRouteId: connection.roomRouteId,
        expectedChallenge: connection.challenge,
      });

      let room = rooms.get(authentication.routeId);
      if (!room) {
        if (rooms.size >= config.maxRooms) {
          throw relayError('RELAY_CAPACITY', 'Relay room capacity is currently full.', true, 1013);
        }
        room = {
          sessionId: hello.sessionId,
          tokenDigest: authentication.roomTokenDigest,
          peers: new Map(),
          queuedApplicationBytes: 0,
          lastActivityAtMs: config.now(),
        };
        rooms.set(authentication.routeId, room);
      } else if (
        room.sessionId !== hello.sessionId ||
        !timingSafeEqual(room.tokenDigest, authentication.roomTokenDigest)
      ) {
        // A route is a 256-bit capability verifier. Reaching this branch would
        // require a cryptographic collision or corrupted process state.
        throw relayError('AUTH_ROUTE_COLLISION', 'Relay route authentication failed.', true);
      }

      const previous = room.peers.get(hello.peerId);
      const wasPresent = previous !== undefined;
      if (!wasPresent && room.peers.size >= config.maxPeersPerRoom) {
        throw relayError('ROOM_FULL', 'This relay room has reached its peer limit.', true, 1013);
      }
      if (previous && previous !== socket) {
        const previousState = connectionStates.get(previous);
        if (previousState) previousState.superseded = true;
        room.peers.delete(hello.peerId);
        previous.close(4009, 'newer connection replaced this peer');
      }

      connection.sessionId = hello.sessionId;
      connection.peerId = hello.peerId;
      connection.authenticated = true;
      pendingHandshakes = Math.max(0, pendingHandshakes - 1);
      connection.lastPongAtMs = config.now();
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
      const connectedPeerIds = [...room.peers.keys()];
      room.peers.set(hello.peerId, socket);
      room.lastActivityAtMs = config.now();

      if (!sendBounded(socket, room, config, JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: 'welcome',
        sessionId: hello.sessionId,
        peerId: hello.peerId,
        connectedPeerIds,
      }), false)) {
        throw relayError('BACKPRESSURE', 'Relay could not queue the welcome frame.', true, 1013);
      }
      if (!wasPresent) {
        broadcastRoom(room, hello.peerId, config, JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: 'peer',
          sessionId: hello.sessionId,
          peerId: hello.peerId,
          change: 'joined',
        }), false);
      }
    }

    function routeApplicationFrame(sender, connection, data, isBinary) {
      const room = rooms.get(connection.roomRouteId);
      if (!room || room.peers.get(connection.peerId) !== sender) {
        throw relayError('ROOM_EXPIRED', 'The relay room is no longer active.', true, 1012);
      }

      const frame = isBinary
        ? parseBinaryRoute(data)
        : parseControlRoute(data);
      if (frame.sessionId !== connection.sessionId || frame.senderPeerId !== connection.peerId) {
        throw relayError('ROUTE_SPOOFED', 'Frame routing identity does not match this socket.', true);
      }
      if (frame.targetPeerId === null) {
        throw relayError(
          'TARGET_REQUIRED',
          'Application frames require an explicit target peer.',
          true,
          4003,
          frame.messageId,
        );
      }
      room.lastActivityAtMs = config.now();
      routeToPeers(
        sender,
        room,
        frame.targetPeerId,
        data,
        isBinary,
        frame.messageId,
      );
    }

    function routeToPeers(sender, room, targetPeerId, data, isBinary, messageId) {
      const target = room.peers.get(targetPeerId);
      if (!target || target.readyState !== WebSocket.OPEN) {
        sendRelayError(
          sender,
          config,
          'TARGET_OFFLINE',
          'The target peer is not connected to this relay room.',
          messageId,
        );
        return;
      }
      const recipients = [target];

      const byteLength = frameByteLength(data);
      const slowRecipients = recipients.filter(
        (recipient) => {
          const recipientState = connectionStates.get(recipient);
          const bufferedBytes = Math.max(
            recipient.bufferedAmount,
            recipientState?.queuedApplicationBytes ?? 0,
          );
          return bufferedBytes + byteLength > config.maxSocketBufferedBytes;
        },
      );
      const roomBufferedBytes = [...room.peers.values()].reduce(
        (total, peer) => total + peer.bufferedAmount,
        0,
      );
      if (
        slowRecipients.length > 0 ||
        Math.max(roomBufferedBytes, room.queuedApplicationBytes) +
          byteLength * recipients.length > config.maxRoomBufferedBytes ||
        queuedApplicationBytes + byteLength * recipients.length > config.maxTotalBufferedBytes
      ) {
        for (const target of slowRecipients) target.close(1013, 'relay backpressure');
        sendRelayError(
          sender,
          config,
          'BACKPRESSURE',
          'Relay queue limit reached; retry after peers reconnect.',
          messageId,
        );
        return;
      }

      for (const target of recipients) {
        if (!queueApplicationFrame(target, room, data, isBinary)) {
          sendRelayError(
            sender,
            config,
            'BACKPRESSURE',
            'Relay could not queue the frame; retry after the peer reconnects.',
            messageId,
          );
        }
      }
    }

    function queueApplicationFrame(target, room, data, isBinary) {
      const targetState = connectionStates.get(target);
      if (!targetState) {
        target.terminate();
        return false;
      }
      const byteLength = frameByteLength(data);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        targetState.pendingApplicationSendReleases.delete(release);
        targetState.queuedApplicationBytes = Math.max(
          0,
          targetState.queuedApplicationBytes - byteLength,
        );
        room.queuedApplicationBytes = Math.max(0, room.queuedApplicationBytes - byteLength);
        queuedApplicationBytes = Math.max(0, queuedApplicationBytes - byteLength);
      };
      targetState.pendingApplicationSendReleases.add(release);
      targetState.queuedApplicationBytes += byteLength;
      room.queuedApplicationBytes += byteLength;
      queuedApplicationBytes += byteLength;
      try {
        target.send(data, { binary: isBinary }, (error) => {
          release();
          if (error) target.terminate();
        });
      } catch {
        release();
        target.terminate();
        return false;
      }
      return true;
    }

    function detachConnection(socket, connection) {
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      for (const release of [...connection.pendingApplicationSendReleases]) release();
      if (!connection.authenticated) pendingHandshakes = Math.max(0, pendingHandshakes - 1);
      const remainingForIp = (connectionsByIp.get(connection.remoteAddress) ?? 1) - 1;
      if (remainingForIp <= 0) connectionsByIp.delete(connection.remoteAddress);
      else connectionsByIp.set(connection.remoteAddress, remainingForIp);
      if (!connection.authenticated || !connection.sessionId || !connection.peerId) return;
      const room = rooms.get(connection.roomRouteId);
      if (!room || room.peers.get(connection.peerId) !== socket) return;
      room.peers.delete(connection.peerId);
      room.lastActivityAtMs = config.now();
      if (!connection.superseded) {
        broadcastRoom(room, connection.peerId, config, JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: 'peer',
          sessionId: connection.sessionId,
          peerId: connection.peerId,
          change: 'left',
        }), false);
      }
      if (room.peers.size === 0) rooms.delete(connection.roomRouteId);
    }

    sendRelayChallenge(webSocket, config, state.challenge);
  });

  const maintenanceTimer = setInterval(() => {
    const now = config.now();
    for (const webSocket of webSocketServer.clients) {
      const state = connectionStates.get(webSocket);
      if (!state) continue;
      if (now - state.lastPongAtMs > config.peerTtlMs) {
        webSocket.terminate();
        continue;
      }
      if (webSocket.readyState === WebSocket.OPEN) webSocket.ping();
    }
    for (const [remoteAddress, budget] of upgradeBudgetsByIp) {
      if (
        !connectionsByIp.has(remoteAddress) &&
        now - budget.lastSeenAtMs > config.upgradeRateLimitTtlMs
      ) {
        upgradeBudgetsByIp.delete(remoteAddress);
      }
    }
  }, config.maintenanceIntervalMs);
  maintenanceTimer.unref?.();

  return {
    httpServer,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (httpServer.listening) return httpServer.address();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
      return httpServer.address();
    },
    stats() {
      return snapshotStats(rooms, webSocketServer, pendingHandshakes);
    },
    async close() {
      clearInterval(maintenanceTimer);
      for (const client of webSocketServer.clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => webSocketServer.close(() => resolve())),
        httpServer.listening
          ? new Promise((resolve, reject) => {
              httpServer.close((error) => error ? reject(error) : resolve());
            })
          : Promise.resolve(),
      ]);
      rooms.clear();
      queuedApplicationBytes = 0;
    },
  };
}

export function verifyRelayHelloAuthentication(
  hello,
  {
    nowMs = Date.now(),
    clockSkewMs = DEFAULTS.authenticationClockSkewMs,
    expectedRouteId,
    expectedChallenge,
  } = {},
) {
  if (!isObject(hello) || hello.v !== PROTOCOL_VERSION || hello.kind !== 'hello') {
    throw relayError('INVALID_HELLO', 'Relay hello has an invalid protocol envelope.', true);
  }
  requireIdentifier(hello.sessionId, 'sessionId');
  requireIdentifier(hello.peerId, 'peerId');
  if (!isObject(hello.auth)) {
    throw relayError('AUTH_REQUIRED', 'Relay hello is missing authentication.', true);
  }
  const {
    issuedAtMs,
    roomToken,
    challenge,
    identityPublicKey,
    challengeSignature,
  } = hello.auth;
  if (!Number.isSafeInteger(issuedAtMs) || Math.abs(nowMs - issuedAtMs) > clockSkewMs) {
    throw relayError('AUTH_EXPIRED', 'Relay authentication timestamp is outside the allowed window.', true);
  }
  const roomTokenBytes = decodeCanonicalToken(roomToken, 'room token');
  const routeBytes = decodeCanonicalToken(expectedRouteId, 'room route');
  const expectedRoute = createHmac('sha256', roomTokenBytes)
    .update(`${ROUTE_CONTEXT}\0${hello.sessionId}`, 'utf8')
    .digest();
  if (!timingSafeEqual(expectedRoute, routeBytes)) {
    throw relayError('AUTH_ROUTE_MISMATCH', 'Relay room route authentication failed.', true);
  }
  const expectedChallengeBytes = decodeCanonicalToken(expectedChallenge, 'expected challenge');
  const challengeBytes = decodeCanonicalToken(challenge, 'challenge');
  if (!timingSafeEqual(expectedChallengeBytes, challengeBytes)) {
    throw relayError('AUTH_CHALLENGE_MISMATCH', 'Relay challenge authentication failed.', true);
  }
  const identityPublicKeyBytes = decodeCanonicalToken(identityPublicKey, 'identity public key');
  const signatureBytes = decodeCanonicalBytes(
    challengeSignature,
    64,
    'challenge signature',
  );
  if (deriveDeviceId(identityPublicKeyBytes) !== hello.peerId) {
    throw relayError('AUTH_PEER_ID_MISMATCH', 'Relay peer ID does not match its identity key.', true);
  }
  if (!verifyPeerSignature(
    identityPublicKeyBytes,
    signatureBytes,
    relayPeerAuthenticationBytes({
      challenge,
      routeId: expectedRouteId,
      sessionId: hello.sessionId,
      peerId: hello.peerId,
      identityPublicKey,
      issuedAtMs,
    }),
  )) {
    throw relayError('AUTH_IDENTITY_INVALID', 'Relay peer identity signature is invalid.', true);
  }
  return {
    routeId: expectedRoute.toString('base64url'),
    roomTokenDigest: createHash('sha256').update(roomTokenBytes).digest(),
  };
}

function sendRelayChallenge(target, config, challenge) {
  if (target.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'relay-challenge',
    challenge,
  });
  if (target.bufferedAmount + Buffer.byteLength(data) > config.maxSocketBufferedBytes) {
    target.close(1013, 'relay backpressure');
    return;
  }
  target.send(data, (error) => {
    if (error) target.terminate();
  });
}

function relayPeerAuthenticationBytes({
  challenge,
  routeId,
  sessionId,
  peerId,
  identityPublicKey,
  issuedAtMs,
}) {
  return Buffer.from(JSON.stringify([
    PEER_AUTHENTICATION_CONTEXT,
    challenge,
    routeId,
    sessionId,
    peerId,
    identityPublicKey,
    issuedAtMs,
  ]), 'utf8');
}

function verifyPeerSignature(identityPublicKey, signature, bytes) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, identityPublicKey]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}

function deriveDeviceId(identityPublicKey) {
  return `device_${createHash('sha256').update(identityPublicKey).digest('base64url')}`;
}

function parseControlRoute(data) {
  const encoded = asBuffer(data);
  if (encoded.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw relayError('FRAME_TOO_LARGE', 'Control frame exceeds the relay limit.', true);
  }
  let value;
  try {
    value = JSON.parse(textDecoder.decode(encoded));
  } catch {
    throw relayError('INVALID_CONTROL', 'Control frame is not valid JSON.', true);
  }
  if (!isObject(value) || value.v !== PROTOCOL_VERSION || value.kind !== 'control') {
    throw relayError('INVALID_CONTROL', 'Control frame has an invalid envelope.', true);
  }
  requireIdentifier(value.sessionId, 'sessionId');
  requireIdentifier(value.senderPeerId, 'senderPeerId');
  requireIdentifier(value.messageId, 'messageId');
  requireTarget(value.targetPeerId);
  if (typeof value.type !== 'string' || value.type.length === 0 || value.type.length > 128) {
    throw relayError('INVALID_CONTROL', 'Control frame type is invalid.', true);
  }
  return value;
}

function parseBinaryRoute(data) {
  const encoded = asBuffer(data);
  if (encoded.byteLength < 5 || encoded.byteLength > MAX_BINARY_FRAME_BYTES) {
    throw relayError('INVALID_CHUNK', 'Binary chunk has an invalid size.', true);
  }
  const headerLength = encoded.readUInt32BE(0);
  if (headerLength < 1 || headerLength > MAX_BINARY_HEADER_BYTES || 4 + headerLength > encoded.length) {
    throw relayError('INVALID_CHUNK', 'Binary chunk header length is invalid.', true);
  }
  let header;
  try {
    header = JSON.parse(textDecoder.decode(encoded.subarray(4, 4 + headerLength)));
  } catch {
    throw relayError('INVALID_CHUNK', 'Binary chunk header is not valid JSON.', true);
  }
  if (!isObject(header) || header.v !== PROTOCOL_VERSION || header.kind !== 'chunk') {
    throw relayError('INVALID_CHUNK', 'Binary chunk has an invalid envelope.', true);
  }
  requireIdentifier(header.sessionId, 'sessionId');
  requireIdentifier(header.senderPeerId, 'senderPeerId');
  if (header.messageId !== undefined) requireIdentifier(header.messageId, 'messageId');
  requireIdentifier(header.transferId, 'transferId');
  requireIdentifier(header.resourceId, 'resourceId');
  requireTarget(header.targetPeerId);
  for (const field of ['chunkIndex', 'offset', 'totalBytes', 'byteLength']) {
    if (!Number.isSafeInteger(header[field]) || header[field] < 0) {
      throw relayError('INVALID_CHUNK', `Binary chunk ${field} is invalid.`, true);
    }
  }
  const payloadLength = encoded.byteLength - 4 - headerLength;
  if (
    header.byteLength < 1 ||
    header.byteLength > MAX_CHUNK_BYTES ||
    header.byteLength !== payloadLength ||
    typeof header.isLast !== 'boolean' ||
    header.offset + header.byteLength > header.totalBytes ||
    header.isLast !== (header.offset + header.byteLength === header.totalBytes)
  ) {
    throw relayError('INVALID_CHUNK', 'Binary chunk payload metadata is inconsistent.', true);
  }
  return header;
}

function broadcastRoom(room, excludedPeerId, config, data, isBinary) {
  for (const [peerId, target] of room.peers) {
    if (peerId !== excludedPeerId) sendBounded(target, room, config, data, isBinary);
  }
}

function sendBounded(target, room, config, data, isBinary) {
  if (target.readyState !== WebSocket.OPEN) return false;
  const byteLength = frameByteLength(data);
  const roomBufferedBytes = [...room.peers.values()].reduce(
    (total, peer) => total + peer.bufferedAmount,
    0,
  );
  if (
    target.bufferedAmount + byteLength > config.maxSocketBufferedBytes ||
    roomBufferedBytes + byteLength > config.maxRoomBufferedBytes
  ) {
    target.close(1013, 'relay backpressure');
    return false;
  }
  target.send(data, { binary: isBinary }, (error) => {
    if (error) target.terminate();
  });
  return true;
}

function sendRelayError(target, config, code, message, messageId) {
  if (target.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'relay-error',
    code,
    message,
    recoverable: isRecoverableRelayErrorCode(code),
    ...(messageId ? { messageId } : {}),
  });
  if (target.bufferedAmount + Buffer.byteLength(data) > config.maxSocketBufferedBytes) {
    target.close(1013, 'relay backpressure');
    return;
  }
  target.send(data);
}

function normalizeOptions(options) {
  const normalized = {
    ...DEFAULTS,
    ...options,
    now: options.now ?? Date.now,
    allowedOrigins: options.allowedOrigins ?? null,
    trustProxy: options.trustProxy ?? false,
  };
  for (const field of [
    'maxPeersPerRoom',
    'maxRooms',
    'maxTotalConnections',
    'maxPendingHandshakes',
    'maxConnectionsPerIp',
    'maxUpgradeAttemptsPerSecond',
    'maxUpgradeBurst',
    'maxTrackedSourceIps',
    'upgradeRateLimitTtlMs',
    'maxIngressBytesPerSecond',
    'maxIngressBurstBytes',
    'maxIngressMessagesPerSecond',
    'maxIngressMessageBurst',
    'maxSocketBufferedBytes',
    'maxRoomBufferedBytes',
    'maxTotalBufferedBytes',
    'handshakeTimeoutMs',
    'authenticationClockSkewMs',
    'heartbeatIntervalMs',
    'peerTtlMs',
  ]) {
    if (!Number.isSafeInteger(normalized[field]) || normalized[field] < 1) {
      throw new RangeError(`${field} must be a positive safe integer.`);
    }
  }
  if (normalized.maxRoomBufferedBytes < normalized.maxSocketBufferedBytes) {
    throw new RangeError('maxRoomBufferedBytes must be at least maxSocketBufferedBytes.');
  }
  if (normalized.maxPendingHandshakes > normalized.maxTotalConnections) {
    throw new RangeError('maxPendingHandshakes cannot exceed maxTotalConnections.');
  }
  if (normalized.maxIngressBurstBytes < MAX_BINARY_FRAME_BYTES) {
    throw new RangeError('maxIngressBurstBytes must permit at least one maximum-size chunk.');
  }
  if (normalized.peerTtlMs <= normalized.heartbeatIntervalMs) {
    throw new RangeError('peerTtlMs must be greater than heartbeatIntervalMs.');
  }
  if (typeof normalized.path !== 'string' || !normalized.path.startsWith('/')) {
    throw new TypeError('path must be an absolute HTTP path.');
  }
  if (
    normalized.allowedOrigins !== null &&
    (!Array.isArray(normalized.allowedOrigins) ||
      normalized.allowedOrigins.some((origin) => typeof origin !== 'string'))
  ) {
    throw new TypeError('allowedOrigins must be an array of origin strings.');
  }
  if (typeof normalized.trustProxy !== 'boolean') {
    throw new TypeError('trustProxy must be a boolean.');
  }
  normalized.maintenanceIntervalMs = options.maintenanceIntervalMs ?? Math.max(
    25,
    normalized.heartbeatIntervalMs / 2,
  );
  if (!Number.isSafeInteger(normalized.maintenanceIntervalMs) || normalized.maintenanceIntervalMs < 1) {
    throw new RangeError('maintenanceIntervalMs must be a positive safe integer.');
  }
  return normalized;
}

function snapshotStats(rooms, webSocketServer, pendingHandshakes) {
  let peers = 0;
  for (const room of rooms.values()) peers += room.peers.size;
  return {
    rooms: rooms.size,
    peers,
    connections: webSocketServer.clients.size,
    pendingHandshakes,
  };
}

function writeJson(response, statusCode, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

function rejectUpgrade(socket, statusCode, message) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function originAllowed(origin, allowedOrigins) {
  if (allowedOrigins === null) return true;
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}

function consumeIngressBudget(state, byteLength, config) {
  const now = config.now();
  const elapsedMs = Math.max(0, now - state.ingressLastRefillAtMs);
  state.ingressLastRefillAtMs = now;
  state.ingressBytes = Math.min(
    config.maxIngressBurstBytes,
    state.ingressBytes + (elapsedMs / 1_000) * config.maxIngressBytesPerSecond,
  );
  state.ingressMessages = Math.min(
    config.maxIngressMessageBurst,
    state.ingressMessages + (elapsedMs / 1_000) * config.maxIngressMessagesPerSecond,
  );
  if (state.ingressBytes < byteLength || state.ingressMessages < 1) return false;
  state.ingressBytes -= byteLength;
  state.ingressMessages -= 1;
  return true;
}

function consumeUpgradeBudget(
  remoteAddress,
  upgradeBudgetsByIp,
  connectionsByIp,
  config,
) {
  const now = config.now();
  let budget = upgradeBudgetsByIp.get(remoteAddress);
  if (!budget) {
    if (upgradeBudgetsByIp.size >= config.maxTrackedSourceIps) {
      for (const [address, candidate] of upgradeBudgetsByIp) {
        if (
          !connectionsByIp.has(address) &&
          now - candidate.lastSeenAtMs > config.upgradeRateLimitTtlMs
        ) {
          upgradeBudgetsByIp.delete(address);
        }
      }
    }
    if (upgradeBudgetsByIp.size >= config.maxTrackedSourceIps) return false;
    budget = {
      tokens: config.maxUpgradeBurst,
      lastRefillAtMs: now,
      lastSeenAtMs: now,
    };
    upgradeBudgetsByIp.set(remoteAddress, budget);
  }
  const elapsedMs = Math.max(0, now - budget.lastRefillAtMs);
  budget.lastRefillAtMs = now;
  budget.lastSeenAtMs = now;
  budget.tokens = Math.min(
    config.maxUpgradeBurst,
    budget.tokens + (elapsedMs / 1_000) * config.maxUpgradeAttemptsPerSecond,
  );
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
}

function resolveRemoteAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const firstAddress = value?.split(',')[0]?.trim();
    if (firstAddress) return normalizeRemoteAddress(firstAddress);
  }
  return normalizeRemoteAddress(request.socket.remoteAddress);
}

function normalizeRemoteAddress(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function decodeCanonicalToken(value, label) {
  if (!isCanonicalToken(value)) {
    throw relayError('AUTH_INVALID', `Relay ${label} is malformed.`, true);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw relayError('AUTH_INVALID', `Relay ${label} is not canonical.`, true);
  }
  return decoded;
}

function decodeCanonicalBytes(value, byteLength, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw relayError('AUTH_INVALID', `Relay ${label} is malformed.`, true);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== byteLength || decoded.toString('base64url') !== value) {
    throw relayError('AUTH_INVALID', `Relay ${label} is not canonical.`, true);
  }
  return decoded;
}

function isCanonicalToken(value) {
  return typeof value === 'string' && BASE64URL_32.test(value);
}

function requireIdentifier(value, field) {
  if (!isIdentifier(value)) {
    throw relayError('INVALID_ROUTE', `${field} is not a valid route identifier.`, true);
  }
}

function requireTarget(value) {
  if (value !== null && !isIdentifier(value)) {
    throw relayError('INVALID_ROUTE', 'targetPeerId is not a valid route identifier.', true);
  }
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && ROUTE_IDENTIFIER.test(value);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw relayError('INVALID_FRAME', 'Relay received an unsupported frame payload.', true);
}

function frameByteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value) : asBuffer(value).byteLength;
}

function relayError(code, message, fatal, closeCode = 4003, messageId) {
  const error = new Error(message);
  error.code = code;
  error.fatal = fatal;
  error.closeCode = closeCode;
  error.messageId = messageId;
  return error;
}

function toRelayError(error) {
  if (
    error instanceof Error &&
    typeof error.code === 'string' &&
    typeof error.fatal === 'boolean'
  ) {
    return error;
  }
  return relayError('INTERNAL_ERROR', 'Relay rejected the frame.', true, 1011);
}

function isRecoverableRelayErrorCode(code) {
  return (
    code === 'AUTH_TIMEOUT' ||
    code === 'RELAY_CAPACITY' ||
    code === 'ROOM_FULL' ||
    code === 'ROOM_EXPIRED' ||
    code === 'TARGET_OFFLINE' ||
    code === 'BACKPRESSURE' ||
    code === 'RATE_LIMITED' ||
    code === 'INTERNAL_ERROR'
  );
}

async function runFromCommandLine() {
  const relay = createRelayServer({
    path: process.env.RELAY_PATH ?? DEFAULTS.path,
    maxPeersPerRoom: integerEnvironment(
      process.env.RELAY_MAX_PEERS,
      'RELAY_MAX_PEERS',
      DEFAULTS.maxPeersPerRoom,
    ),
    maxRooms: integerEnvironment(
      process.env.RELAY_MAX_ROOMS,
      'RELAY_MAX_ROOMS',
      DEFAULTS.maxRooms,
    ),
    maxTotalConnections: integerEnvironment(
      process.env.RELAY_MAX_TOTAL_CONNECTIONS,
      'RELAY_MAX_TOTAL_CONNECTIONS',
      DEFAULTS.maxTotalConnections,
    ),
    maxPendingHandshakes: integerEnvironment(
      process.env.RELAY_MAX_PENDING_HANDSHAKES,
      'RELAY_MAX_PENDING_HANDSHAKES',
      DEFAULTS.maxPendingHandshakes,
    ),
    maxConnectionsPerIp: integerEnvironment(
      process.env.RELAY_MAX_CONNECTIONS_PER_IP,
      'RELAY_MAX_CONNECTIONS_PER_IP',
      DEFAULTS.maxConnectionsPerIp,
    ),
    maxUpgradeAttemptsPerSecond: integerEnvironment(
      process.env.RELAY_MAX_UPGRADE_ATTEMPTS_PER_SECOND,
      'RELAY_MAX_UPGRADE_ATTEMPTS_PER_SECOND',
      DEFAULTS.maxUpgradeAttemptsPerSecond,
    ),
    maxUpgradeBurst: integerEnvironment(
      process.env.RELAY_MAX_UPGRADE_BURST,
      'RELAY_MAX_UPGRADE_BURST',
      DEFAULTS.maxUpgradeBurst,
    ),
    maxTrackedSourceIps: integerEnvironment(
      process.env.RELAY_MAX_TRACKED_SOURCE_IPS,
      'RELAY_MAX_TRACKED_SOURCE_IPS',
      DEFAULTS.maxTrackedSourceIps,
    ),
    upgradeRateLimitTtlMs: integerEnvironment(
      process.env.RELAY_UPGRADE_RATE_LIMIT_TTL_MS,
      'RELAY_UPGRADE_RATE_LIMIT_TTL_MS',
      DEFAULTS.upgradeRateLimitTtlMs,
    ),
    maxIngressBytesPerSecond: integerEnvironment(
      process.env.RELAY_MAX_INGRESS_BYTES_PER_SECOND,
      'RELAY_MAX_INGRESS_BYTES_PER_SECOND',
      DEFAULTS.maxIngressBytesPerSecond,
    ),
    maxIngressBurstBytes: integerEnvironment(
      process.env.RELAY_MAX_INGRESS_BURST_BYTES,
      'RELAY_MAX_INGRESS_BURST_BYTES',
      DEFAULTS.maxIngressBurstBytes,
    ),
    maxIngressMessagesPerSecond: integerEnvironment(
      process.env.RELAY_MAX_INGRESS_MESSAGES_PER_SECOND,
      'RELAY_MAX_INGRESS_MESSAGES_PER_SECOND',
      DEFAULTS.maxIngressMessagesPerSecond,
    ),
    maxIngressMessageBurst: integerEnvironment(
      process.env.RELAY_MAX_INGRESS_MESSAGE_BURST,
      'RELAY_MAX_INGRESS_MESSAGE_BURST',
      DEFAULTS.maxIngressMessageBurst,
    ),
    maxSocketBufferedBytes: integerEnvironment(
      process.env.RELAY_MAX_SOCKET_BUFFERED_BYTES,
      'RELAY_MAX_SOCKET_BUFFERED_BYTES',
      DEFAULTS.maxSocketBufferedBytes,
    ),
    maxRoomBufferedBytes: integerEnvironment(
      process.env.RELAY_MAX_ROOM_BUFFERED_BYTES,
      'RELAY_MAX_ROOM_BUFFERED_BYTES',
      DEFAULTS.maxRoomBufferedBytes,
    ),
    maxTotalBufferedBytes: integerEnvironment(
      process.env.RELAY_MAX_TOTAL_BUFFERED_BYTES,
      'RELAY_MAX_TOTAL_BUFFERED_BYTES',
      DEFAULTS.maxTotalBufferedBytes,
    ),
    allowedOrigins: process.env.RELAY_ALLOWED_ORIGINS
      ? process.env.RELAY_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
      : null,
    trustProxy: booleanEnvironment(process.env.RELAY_TRUST_PROXY, 'RELAY_TRUST_PROXY', false),
  });
  const address = await relay.listen({
    port: integerEnvironment(process.env.PORT, 'PORT', 8787),
    host: process.env.HOST ?? '0.0.0.0',
  });
  process.stdout.write(`CrewRoll transient relay listening on ${JSON.stringify(address)}\n`);

  const stop = async () => {
    await relay.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

function integerEnvironment(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function booleanEnvironment(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be either true or false.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromCommandLine();
}
