import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
} from 'node:crypto';
import { afterEach, test } from 'node:test';

import { WebSocket } from 'ws';

import { createRelayServer } from './server.mjs';

const openRelays = new Set();
const openSockets = new Set();
const PROTOCOL_VERSION = 3;
const ROUTE_CONTEXT = 'airmesh-relay-route-v1';
const PEER_AUTHENTICATION_CONTEXT = 'airmesh-relay-peer-auth-v1';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

afterEach(async () => {
  for (const socket of openSockets) socket.terminate();
  openSockets.clear();
  await Promise.all([...openRelays].map((relay) => relay.close()));
  openRelays.clear();
});

test('health endpoint reports only aggregate transient state', async () => {
  const { relay, httpUrl } = await startRelay();
  const response = await fetch(`${httpUrl}/healthz`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.rooms, 0);
  assert.equal(body.peers, 0);
  assert.equal(body.connections, 0);
  assert.equal(body.pendingHandshakes, 0);
  assert.equal(typeof body.uptimeMs, 'number');
  assert.ok(body.uptimeMs >= 0);
  assert.deepEqual(relay.stats(), {
    rooms: 0,
    peers: 0,
    connections: 0,
    pendingHandshakes: 0,
  });
});

test('authenticated peers route control and binary frames without storing payloads', async () => {
  const { relay, wsUrl } = await startRelay();
  const sessionId = 'trip:relay-routing';
  const roomToken = Buffer.alloc(32, 7).toString('base64url');
  const first = await connectPeer(wsUrl, sessionId, 'device:first', roomToken);
  const joined = first.next((message) => message.value?.kind === 'peer');
  const second = await connectPeer(wsUrl, sessionId, 'device:second', roomToken);

  assert.equal((await joined).value.change, 'joined');
  assert.deepEqual(second.welcome.connectedPeerIds, [first.peerId]);
  assert.deepEqual(relay.stats(), {
    rooms: 1,
    peers: 2,
    connections: 2,
    pendingHandshakes: 0,
  });

  const control = {
    v: PROTOCOL_VERSION,
    kind: 'control',
    sessionId,
    senderPeerId: first.peerId,
    targetPeerId: second.peerId,
    messageId: 'message:one',
    type: 'SECURE_CONTROL',
    payload: { ciphertext: 'opaque-to-relay' },
  };
  const routedControl = second.next((message) => message.value?.messageId === 'message:one');
  first.socket.send(JSON.stringify(control));
  assert.deepEqual((await routedControl).value, control);

  const header = {
    v: PROTOCOL_VERSION,
    kind: 'chunk',
    sessionId,
    senderPeerId: first.peerId,
    targetPeerId: second.peerId,
    messageId: 'message:binary-one',
    transferId: 'transfer:one',
    resourceId: 'resource:one',
    chunkIndex: 0,
    offset: 0,
    totalBytes: 4,
    byteLength: 4,
    isLast: true,
  };
  const binary = encodeBinaryFrame(header, Buffer.from([9, 8, 7, 6]));
  const routedBinary = second.next((message) => message.isBinary);
  first.socket.send(binary);
  assert.deepEqual((await routedBinary).data, binary);

  assert.deepEqual(relay.stats(), {
    rooms: 1,
    peers: 2,
    connections: 2,
    pendingHandshakes: 0,
  });
});

test('binary TARGET_OFFLINE errors preserve the opaque application message ID', async () => {
  const { wsUrl } = await startRelay();
  const sessionId = 'trip:binary-target-offline';
  const roomToken = Buffer.alloc(32, 45).toString('base64url');
  const sender = await connectPeer(wsUrl, sessionId, 'device:binary-sender', roomToken);
  const messageId = 'message:binary-target-offline';
  const rejected = sender.next(
    (message) => message.value?.kind === 'relay-error' && message.value.messageId === messageId,
  );
  const payload = Buffer.from([1, 2, 3, 4]);
  sender.socket.send(encodeBinaryFrame({
    v: PROTOCOL_VERSION,
    kind: 'chunk',
    sessionId,
    senderPeerId: sender.peerId,
    targetPeerId: testIdentity('device:offline-target').deviceId,
    messageId,
    transferId: 'transfer:binary-target-offline',
    resourceId: 'resource:binary-target-offline',
    chunkIndex: 0,
    offset: 0,
    totalBytes: payload.byteLength,
    byteLength: payload.byteLength,
    isLast: true,
  }, payload));

  assertRelayError((await rejected).value, {
    code: 'TARGET_OFFLINE',
    recoverable: true,
    messageId,
  });
});

test('the process-global application queue cap correlates binary BACKPRESSURE', async () => {
  const { wsUrl } = await startRelay({
    maxSocketBufferedBytes: 4_096,
    maxRoomBufferedBytes: 4_096,
    maxTotalBufferedBytes: 512,
  });
  const sessionId = 'trip:binary-global-pressure';
  const roomToken = Buffer.alloc(32, 46).toString('base64url');
  const sender = await connectPeer(wsUrl, sessionId, 'device:global-sender', roomToken);
  const target = await connectPeer(wsUrl, sessionId, 'device:global-target', roomToken);
  const messageId = 'message:binary-global-pressure';
  const rejected = sender.next(
    (message) => message.value?.kind === 'relay-error' && message.value.messageId === messageId,
  );
  const payload = Buffer.alloc(1_024, 7);
  sender.socket.send(encodeBinaryFrame({
    v: PROTOCOL_VERSION,
    kind: 'chunk',
    sessionId,
    senderPeerId: sender.peerId,
    targetPeerId: target.peerId,
    messageId,
    transferId: 'transfer:binary-global-pressure',
    resourceId: 'resource:binary-global-pressure',
    chunkIndex: 0,
    offset: 0,
    totalBytes: payload.byteLength,
    byteLength: payload.byteLength,
    isLast: true,
  }, payload));

  assertRelayError((await rejected).value, {
    code: 'BACKPRESSURE',
    recoverable: true,
    messageId,
  });
  assert.equal(target.socket.readyState, WebSocket.OPEN);
});

test('rejects application broadcasts before they can amplify opaque payloads', async () => {
  const { wsUrl } = await startRelay();
  const sessionId = 'trip:binary-broadcast-disabled';
  const roomToken = Buffer.alloc(32, 47).toString('base64url');
  const sender = await connectPeer(wsUrl, sessionId, 'device:broadcast-sender', roomToken);
  await connectPeer(wsUrl, sessionId, 'device:broadcast-target', roomToken);
  const messageId = 'message:binary-broadcast-disabled';
  const rejected = sender.next(
    (message) => message.value?.kind === 'relay-error' && message.value.messageId === messageId,
  );
  const closed = new Promise((resolve) => sender.socket.once('close', resolve));
  const payload = Buffer.from([5, 4, 3, 2, 1]);
  sender.socket.send(encodeBinaryFrame({
    v: PROTOCOL_VERSION,
    kind: 'chunk',
    sessionId,
    senderPeerId: sender.peerId,
    targetPeerId: null,
    messageId,
    transferId: 'transfer:binary-broadcast-disabled',
    resourceId: 'resource:binary-broadcast-disabled',
    chunkIndex: 0,
    offset: 0,
    totalBytes: payload.byteLength,
    byteLength: payload.byteLength,
    isLast: true,
  }, payload));

  assertRelayError((await rejected).value, {
    code: 'TARGET_REQUIRED',
    recoverable: false,
    messageId,
  });
  assert.equal(await closed, 4003);
});

test('room capability and challenge-bound device identity are both required', async () => {
  const { wsUrl } = await startRelay();
  const sessionId = 'trip:relay-auth';
  const correctToken = Buffer.alloc(32, 3).toString('base64url');
  await connectPeer(wsUrl, sessionId, 'device:first', correctToken);

  const wrongToken = Buffer.alloc(32, 4).toString('base64url');
  const rejected = await openSocket(relayUrl(wsUrl, sessionId, correctToken));
  const challenge = await nextChallenge(rejected);
  const errorMessage = rejected.next((message) => message.value?.kind === 'relay-error');
  const closed = new Promise((resolve) => rejected.socket.once('close', resolve));
  rejected.socket.send(JSON.stringify(relayHello({
    sessionId,
    identity: testIdentity('device:second'),
    roomToken: wrongToken,
    routeId: relayRouteId(sessionId, correctToken),
    challenge,
  })));

  assertRelayError((await errorMessage).value, {
    code: 'AUTH_ROUTE_MISMATCH',
    recoverable: false,
  });
  assert.equal(await closed, 4003);
});

test('a captured hello fails on a fresh socket challenge without evicting its owner', async () => {
  const { relay, wsUrl } = await startRelay();
  const sessionId = 'trip:relay-replay';
  const roomToken = Buffer.alloc(32, 41).toString('base64url');
  const routeId = relayRouteId(sessionId, roomToken);
  const owner = await connectPeer(wsUrl, sessionId, 'device:replay-owner', roomToken);
  const capturedHello = relayHello({
    sessionId,
    identity: owner.identity,
    roomToken,
    routeId,
    challenge: owner.challenge,
  });

  const replay = await openSocket(relayUrl(wsUrl, sessionId, roomToken));
  const freshChallenge = await nextChallenge(replay);
  assert.notEqual(freshChallenge, owner.challenge);
  const rejected = replay.next((message) => message.value?.kind === 'relay-error');
  const closed = new Promise((resolve) => replay.socket.once('close', resolve));
  replay.socket.send(JSON.stringify(capturedHello));

  assertRelayError((await rejected).value, {
    code: 'AUTH_CHALLENGE_MISMATCH',
    recoverable: false,
  });
  assert.equal(await closed, 4003);
  assert.equal(owner.socket.readyState, WebSocket.OPEN);
  assert.equal(relay.stats().peers, 1);
});

test('a different key cannot claim or evict an existing peer ID', async () => {
  const { relay, wsUrl } = await startRelay();
  const sessionId = 'trip:relay-key-substitution';
  const roomToken = Buffer.alloc(32, 42).toString('base64url');
  const routeId = relayRouteId(sessionId, roomToken);
  const owner = await connectPeer(wsUrl, sessionId, 'device:key-owner', roomToken);
  const attacker = await openSocket(relayUrl(wsUrl, sessionId, roomToken));
  const challenge = await nextChallenge(attacker);
  const rejected = attacker.next((message) => message.value?.kind === 'relay-error');
  const closed = new Promise((resolve) => attacker.socket.once('close', resolve));
  attacker.socket.send(JSON.stringify(relayHello({
    sessionId,
    identity: testIdentity('device:different-key'),
    roomToken,
    routeId,
    challenge,
    claimedPeerId: owner.peerId,
  })));

  assertRelayError((await rejected).value, {
    code: 'AUTH_PEER_ID_MISMATCH',
    recoverable: false,
  });
  assert.equal(await closed, 4003);
  assert.equal(owner.socket.readyState, WebSocket.OPEN);
  assert.equal(relay.stats().peers, 1);
});

test('the same identity key can replace its own stale relay socket', async () => {
  const { relay, wsUrl } = await startRelay();
  const sessionId = 'trip:relay-same-key-reconnect';
  const roomToken = Buffer.alloc(32, 43).toString('base64url');
  const first = await connectPeer(wsUrl, sessionId, 'device:reconnecting', roomToken);
  const firstClosed = new Promise((resolve) => first.socket.once('close', resolve));

  const replacement = await connectPeer(wsUrl, sessionId, 'device:reconnecting', roomToken);

  assert.equal(await firstClosed, 4009);
  assert.deepEqual(replacement.welcome.connectedPeerIds, []);
  await waitFor(() => relay.stats().connections === 1);
  assert.equal(relay.stats().peers, 1);
  assert.equal(replacement.peerId, first.peerId);
});

test('a wrong capability cannot squat the legitimate route after empty-room deletion', async () => {
  const { relay, wsUrl } = await startRelay();
  const sessionId = 'trip:relay-no-tofu';
  const wrongToken = Buffer.alloc(32, 31).toString('base64url');
  const correctToken = Buffer.alloc(32, 32).toString('base64url');
  const squatter = await connectPeer(wsUrl, sessionId, 'device:squatter', wrongToken);
  const legitimate = await connectPeer(wsUrl, sessionId, 'device:legitimate', correctToken);

  assert.deepEqual(squatter.welcome.connectedPeerIds, []);
  assert.deepEqual(legitimate.welcome.connectedPeerIds, []);
  assert.equal(relay.stats().rooms, 2);

  squatter.socket.close(1000, 'wrong capability leaves');
  await waitFor(() => relay.stats().rooms === 1);
  const second = await connectPeer(wsUrl, sessionId, 'device:second', correctToken);
  assert.deepEqual(second.welcome.connectedPeerIds, [legitimate.peerId]);
});

test('bounded queues reject a frame and disconnect a slow target', async () => {
  const { wsUrl } = await startRelay({
    maxSocketBufferedBytes: 512,
    maxRoomBufferedBytes: 512,
  });
  const sessionId = 'trip:relay-pressure';
  const roomToken = Buffer.alloc(32, 5).toString('base64url');
  const sender = await connectPeer(wsUrl, sessionId, 'device:sender', roomToken);
  const slow = await connectPeer(wsUrl, sessionId, 'device:slow', roomToken);

  const backpressure = sender.next(
    (message) => message.value?.kind === 'relay-error' && message.value.code === 'BACKPRESSURE',
  );
  sender.socket.send(JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'control',
    sessionId,
    senderPeerId: sender.peerId,
    targetPeerId: slow.peerId,
    messageId: 'message:large',
    type: 'SECURE_CONTROL',
    payload: 'x'.repeat(1_024),
  }));

  assertRelayError((await backpressure).value, {
    code: 'BACKPRESSURE',
    recoverable: true,
    messageId: 'message:large',
  });
});

test('caps pending handshakes before unauthenticated sockets can exhaust memory', async () => {
  const { wsUrl } = await startRelay({
    maxTotalConnections: 4,
    maxPendingHandshakes: 1,
    maxConnectionsPerIp: 4,
  });
  const token = Buffer.alloc(32, 14).toString('base64url');
  await openSocket(relayUrl(wsUrl, 'trip:pending-one', token));

  assert.equal(
    await rejectedUpgradeStatus(relayUrl(wsUrl, 'trip:pending-two', token)),
    503,
  );
});

test('caps total and per-IP connections', async () => {
  const totalRelay = await startRelay({
    maxTotalConnections: 2,
    maxPendingHandshakes: 2,
    maxConnectionsPerIp: 64,
  });
  const token = Buffer.alloc(32, 6).toString('base64url');
  await connectPeer(totalRelay.wsUrl, 'trip:total', 'device:one', token);
  await connectPeer(totalRelay.wsUrl, 'trip:total', 'device:two', token);
  assert.equal(
    await rejectedUpgradeStatus(relayUrl(totalRelay.wsUrl, 'trip:total', token)),
    503,
  );

  const ipRelay = await startRelay({
    maxTotalConnections: 3,
    maxPendingHandshakes: 3,
    maxConnectionsPerIp: 2,
  });
  await connectPeer(ipRelay.wsUrl, 'trip:ip', 'device:one', token);
  await connectPeer(ipRelay.wsUrl, 'trip:ip', 'device:two', token);
  assert.equal(
    await rejectedUpgradeStatus(relayUrl(ipRelay.wsUrl, 'trip:ip', token)),
    429,
  );
});

test('upgrade limiter permits ten phones behind one NAT before rejecting burst abuse', async () => {
  const frozenNow = Date.now();
  const { wsUrl } = await startRelay({
    maxTotalConnections: 20,
    maxPendingHandshakes: 20,
    maxConnectionsPerIp: 20,
    maxUpgradeAttemptsPerSecond: 1,
    maxUpgradeBurst: 10,
    now: () => frozenNow,
  });
  const token = Buffer.alloc(32, 29).toString('base64url');

  for (let index = 0; index < 10; index += 1) {
    await connectPeer(wsUrl, `trip:nat-${index}`, `device:nat-${index}`, token);
  }

  assert.equal(
    await rejectedUpgradeStatus(relayUrl(wsUrl, 'trip:nat-overflow', token)),
    429,
  );
});

test('reports a full room as explicitly recoverable before closing with retry-later', async () => {
  const { wsUrl } = await startRelay({ maxPeersPerRoom: 1 });
  const sessionId = 'trip:room-full';
  const token = Buffer.alloc(32, 30).toString('base64url');
  await connectPeer(wsUrl, sessionId, 'device:first', token);

  const rejected = await openSocket(relayUrl(wsUrl, sessionId, token));
  const challenge = await nextChallenge(rejected);
  const errorMessage = rejected.next((message) => message.value?.kind === 'relay-error');
  const closed = new Promise((resolve) => rejected.socket.once('close', resolve));
  rejected.socket.send(JSON.stringify(relayHello({
    sessionId,
    identity: testIdentity('device:second'),
    roomToken: token,
    routeId: relayRouteId(sessionId, token),
    challenge,
  })));

  assertRelayError((await errorMessage).value, {
    code: 'ROOM_FULL',
    recoverable: true,
  });
  assert.equal(await closed, 1013);
});

test('ten stale identities cannot consume the ten legitimate application slots', async () => {
  const { relay, wsUrl } = await startRelay();
  const sessionId = 'trip:stale-slot-abuse';
  const token = Buffer.alloc(32, 44).toString('base64url');
  const stale = [];
  for (let index = 0; index < 10; index += 1) {
    stale.push(await connectPeer(wsUrl, sessionId, `device:stale-${index}`, token));
  }
  assert.equal(relay.stats().peers, 10);
  const legitimate = [];
  for (let index = 0; index < 10; index += 1) {
    legitimate.push(
      await connectPeer(wsUrl, sessionId, `device:legitimate-${index}`, token),
    );
  }

  assert.equal(relay.stats().peers, 20);
  assert.equal(legitimate.at(-1).welcome.connectedPeerIds.length, 19);
  assert.ok(stale.every((peer) => peer.socket.readyState === WebSocket.OPEN));
  assert.ok(legitimate.every((peer) => peer.socket.readyState === WebSocket.OPEN));
});

test('closes a socket that sustains ingress beyond its token bucket', async () => {
  const { wsUrl } = await startRelay({
    maxIngressBytesPerSecond: 1,
    maxIngressBurstBytes: 300_000,
    maxIngressMessagesPerSecond: 100,
    maxIngressMessageBurst: 100,
  });
  const sessionId = 'trip:rate-limit';
  const roomToken = Buffer.alloc(32, 9).toString('base64url');
  const abusive = await connectPeer(wsUrl, sessionId, 'device:abusive', roomToken);
  const target = await connectPeer(wsUrl, sessionId, 'device:rate-target', roomToken);
  const rejected = abusive.next(
    (message) => message.value?.kind === 'relay-error' && message.value.code === 'RATE_LIMITED',
  );
  for (let index = 0; index < 8; index += 1) {
    abusive.socket.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'control',
      sessionId,
      senderPeerId: abusive.peerId,
      targetPeerId: target.peerId,
      messageId: `message:flood-${index}`,
      type: 'SECURE_CONTROL',
      payload: 'x'.repeat(55_000),
    }));
  }

  assertRelayError((await rejected).value, {
    code: 'RATE_LIMITED',
    recoverable: true,
  });
});

test('empty authenticated rooms are deleted immediately', async () => {
  const { relay, wsUrl } = await startRelay({
    heartbeatIntervalMs: 10,
    peerTtlMs: 30,
    maintenanceIntervalMs: 5,
  });
  const sessionId = 'trip:relay-ttl';
  const roomToken = Buffer.alloc(32, 8).toString('base64url');
  const peer = await connectPeer(wsUrl, sessionId, 'device:temporary', roomToken);

  peer.socket.close(1000, 'test complete');
  await waitFor(() => relay.stats().peers === 0);
  await waitFor(() => relay.stats().rooms === 0, 500);
  assert.deepEqual(relay.stats(), {
    rooms: 0,
    peers: 0,
    connections: 0,
    pendingHandshakes: 0,
  });
});

test('routes 50 simultaneous clients across five ten-member rooms and cleans up', async () => {
  const { relay, wsUrl } = await startRelay({
    heartbeatIntervalMs: 1_000,
    peerTtlMs: 3_000,
    maintenanceIntervalMs: 5,
  });
  const roomClients = await Promise.all(
    Array.from({ length: 5 }, async (_, roomIndex) => {
      const sessionId = `trip:load-${roomIndex}`;
      const roomToken = Buffer.alloc(32, 20 + roomIndex).toString('base64url');
      return Promise.all(
        Array.from({ length: 10 }, (_, peerIndex) =>
          connectPeer(
            wsUrl,
            sessionId,
            `device:${roomIndex}-${peerIndex}`,
            roomToken,
          )),
      );
    }),
  );

  assert.deepEqual(relay.stats(), {
    rooms: 5,
    peers: 50,
    connections: 50,
    pendingHandshakes: 0,
  });

  await Promise.all(roomClients.map(async (clients, roomIndex) => {
    const sessionId = `trip:load-${roomIndex}`;
    const messageId = `message:broadcast-${roomIndex}`;
    const deliveries = clients.slice(1).map((client) =>
      client.next((message) => message.value?.messageId === messageId),
    );
    for (const target of clients.slice(1)) {
      clients[0].socket.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: 'control',
        sessionId,
        senderPeerId: clients[0].peerId,
        targetPeerId: target.peerId,
        messageId,
        type: 'SECURE_CONTROL',
        payload: { roomIndex },
      }));
    }
    assert.equal((await Promise.all(deliveries)).length, 9);

    const transferId = `transfer:load-${roomIndex}`;
    const chunkBytes = 256 * 1024;
    const chunkCount = 4;
    const totalBytes = chunkBytes * chunkCount;
    const binaryDeliveries = Array.from({ length: chunkCount }, () =>
      clients[9].next((message) => message.isBinary),
    );
    const expectedPayloads = [];
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const payload = Buffer.alloc(chunkBytes, roomIndex * 10 + chunkIndex);
      expectedPayloads.push(payload);
      clients[1].socket.send(encodeBinaryFrame({
        v: PROTOCOL_VERSION,
        kind: 'chunk',
        sessionId,
        senderPeerId: clients[1].peerId,
        targetPeerId: clients[9].peerId,
        transferId,
        resourceId: `resource:load-${roomIndex}`,
        chunkIndex,
        offset: chunkIndex * chunkBytes,
        totalBytes,
        byteLength: payload.length,
        isLast: chunkIndex === chunkCount - 1,
      }, payload));
    }
    const routedChunks = (await Promise.all(binaryDeliveries))
      .map((delivery) => decodeBinaryFrame(delivery.data))
      .sort((left, right) => left.header.chunkIndex - right.header.chunkIndex);
    assert.equal(
      routedChunks.reduce((total, chunk) => total + chunk.payload.byteLength, 0),
      totalBytes,
    );
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      assert.equal(routedChunks[chunkIndex].header.transferId, transferId);
      assert.deepEqual(routedChunks[chunkIndex].payload, expectedPayloads[chunkIndex]);
    }
  }));

  assert.deepEqual(relay.stats(), {
    rooms: 5,
    peers: 50,
    connections: 50,
    pendingHandshakes: 0,
  });

  for (const clients of roomClients) {
    for (const client of clients) client.socket.close(1000, 'load test complete');
  }
  await waitFor(() => relay.stats().connections === 0, 1_000);
  await waitFor(() => relay.stats().rooms === 0, 1_000);
  assert.deepEqual(relay.stats(), {
    rooms: 0,
    peers: 0,
    connections: 0,
    pendingHandshakes: 0,
  });
});

async function startRelay(options = {}) {
  const relay = createRelayServer(options);
  openRelays.add(relay);
  const address = await relay.listen();
  assert.equal(typeof address, 'object');
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return {
    relay,
    httpUrl: `http://${host}:${address.port}`,
    wsUrl: `ws://${host}:${address.port}/v1/relay`,
  };
}

async function connectPeer(wsUrl, sessionId, peerId, roomToken) {
  const client = await openSocket(relayUrl(wsUrl, sessionId, roomToken));
  const challenge = await nextChallenge(client);
  const identity = testIdentity(peerId);
  const routeId = relayRouteId(sessionId, roomToken);
  const welcome = client.next((message) => message.value?.kind === 'welcome');
  client.socket.send(JSON.stringify(relayHello({
    sessionId,
    identity,
    roomToken,
    routeId,
    challenge,
  })));
  return {
    ...client,
    identity,
    peerId: identity.deviceId,
    challenge,
    welcome: (await welcome).value,
  };
}

async function nextChallenge(client) {
  const message = await client.next(
    (candidate) => candidate.value?.kind === 'relay-challenge',
  );
  assert.equal(message.value.v, PROTOCOL_VERSION);
  assert.match(message.value.challenge, /^[A-Za-z0-9_-]{43}$/);
  return message.value.challenge;
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  openSockets.add(socket);
  const queued = [];
  const waiters = [];
  socket.on('message', (data, isBinary) => {
    const message = {
      data: Buffer.from(data),
      isBinary,
      value: isBinary ? null : JSON.parse(data.toString('utf8')),
    };
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    next(predicate, timeoutMs = 1_000) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error('Timed out waiting for a relay message.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function rejectedUpgradeStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('Expected the relay to reject the WebSocket upgrade.'));
    });
    socket.once('error', (error) => {
      // ws emits an error after some HTTP upgrade rejections. The
      // unexpected-response event above is the authoritative status.
      if (error.message.includes('Unexpected server response')) return;
      reject(error);
    });
  });
}

function relayHello({
  sessionId,
  identity,
  roomToken,
  routeId,
  challenge,
  issuedAtMs = Date.now(),
  claimedPeerId = identity.deviceId,
}) {
  const challengeSignature = signBytes(
    null,
    relayPeerAuthenticationBytes({
      challenge,
      routeId,
      sessionId,
      peerId: claimedPeerId,
      identityPublicKey: identity.publicKey,
      issuedAtMs,
    }),
    identity.privateKey,
  ).toString('base64url');
  return {
    v: PROTOCOL_VERSION,
    kind: 'hello',
    sessionId,
    peerId: claimedPeerId,
    auth: {
      issuedAtMs,
      roomToken,
      challenge,
      identityPublicKey: identity.publicKey,
      challengeSignature,
    },
  };
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

function testIdentity(label) {
  const seed = createHash('sha256').update(`airmesh-relay-test\0${label}`, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKeyBytes = publicKeyDer.subarray(publicKeyDer.byteLength - 32);
  const publicKey = publicKeyBytes.toString('base64url');
  return {
    privateKey,
    publicKey,
    deviceId: `device_${createHash('sha256').update(publicKeyBytes).digest('base64url')}`,
  };
}

function relayUrl(wsUrl, sessionId, roomToken) {
  const url = new URL(wsUrl);
  url.searchParams.set('room', relayRouteId(sessionId, roomToken));
  return url.toString();
}

function relayRouteId(sessionId, roomToken) {
  return createHmac('sha256', Buffer.from(roomToken, 'base64url'))
    .update(`${ROUTE_CONTEXT}\0${sessionId}`, 'utf8')
    .digest('base64url');
}

function assertRelayError(value, expected) {
  assert.equal(value.v, PROTOCOL_VERSION);
  assert.equal(value.kind, 'relay-error');
  assert.equal(value.code, expected.code);
  assert.equal(value.recoverable, expected.recoverable);
  assert.equal(typeof value.message, 'string');
  if ('messageId' in expected) assert.equal(value.messageId, expected.messageId);
}

function encodeBinaryFrame(header, payload) {
  const headerBytes = Buffer.from(JSON.stringify(header));
  const frame = Buffer.allocUnsafe(4 + headerBytes.length + payload.length);
  frame.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(frame, 4);
  payload.copy(frame, 4 + headerBytes.length);
  return frame;
}

function decodeBinaryFrame(frame) {
  const headerLength = frame.readUInt32BE(0);
  return {
    header: JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8')),
    payload: frame.subarray(4 + headerLength),
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
