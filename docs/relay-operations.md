# Transient relay operations

CrewRoll's production transport is an outbound WebSocket relay. The relay knows
only opaque room routes, device public keys, and a room-scoped bearer capability. It
does not receive the trip secret, decrypt application frames, write payloads to
disk, queue offline deliveries, or use a database/object store.

## Run and verify

Node 22.13 or newer is required.

```bash
npm install
npm run test:relay
npm run relay:start
```

The service listens on `0.0.0.0:8787` by default. Its endpoints are:

- `GET /healthz`: aggregate `rooms`, `peers`, `connections`, and pending
  handshake counts only; no room/device IDs.
- `GET /readyz`: process readiness.
- WebSocket `/v1/relay?room=<opaque-route-id>`: transient frame routing. The
  route is capability-derived but is not itself accepted as authentication.
  The relay first sends a fresh random challenge; HELLO must return a valid
  challenge-bound Ed25519 signature and the room capability.

The integration suite includes five ten-peer rooms (50 simultaneous
clients), point-to-point control fanout, and parallel four-chunk 256 KiB binary
bursts in every room. Every chunk is compared byte-for-byte, then all aggregate
state must return to zero. It also covers challenge replay, identity
substitution, stale-capability slot pressure, NAT sharing, and queue/rate abuse.

## Container

Build from the relay directory context so the mobile dependency graph is not
copied into the image:

```bash
npm run relay:docker:build
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  -p 8787:8787 crewroll-relay:local
```

For deployment, replace the local tag with the immutable registry tag. The
image uses Node 22 Alpine, installs only the pinned
relay dependency tree, runs as the non-root `node` user, needs no writable
application filesystem, and has a built-in health check.

## Configuration

All server values are ordinary runtime environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | HTTP listener |
| `RELAY_PATH` | `/v1/relay` | Upgrade route |
| `RELAY_MAX_PEERS` | `32` | Relay sockets per room; deliberately above the app's ten-member admission cap |
| `RELAY_MAX_ROOMS` | `1000` | In-memory room metadata cap |
| `RELAY_MAX_TOTAL_CONNECTIONS` | `2000` | Hard live-socket cap |
| `RELAY_MAX_PENDING_HANDSHAKES` | `256` | Unauthenticated-socket cap |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `64` | NAT-safe source-IP cap |
| `RELAY_MAX_UPGRADE_ATTEMPTS_PER_SECOND` | `4` | Per-source WebSocket-upgrade token refill rate |
| `RELAY_MAX_UPGRADE_BURST` | `64` | Per-source upgrade burst, including ten-user NAT groups |
| `RELAY_MAX_TRACKED_SOURCE_IPS` | `4096` | In-memory source-rate-bucket cap |
| `RELAY_UPGRADE_RATE_LIMIT_TTL_MS` | `120000` | Idle source-rate-bucket lifetime |
| `RELAY_TRUST_PROXY` | `false` | Trust the first `X-Forwarded-For` address only behind a controlled proxy |
| `RELAY_MAX_SOCKET_BUFFERED_BYTES` | `2097152` | Per-target WebSocket queue cap |
| `RELAY_MAX_ROOM_BUFFERED_BYTES` | `8388608` | Aggregate room queue cap |
| `RELAY_MAX_TOTAL_BUFFERED_BYTES` | `67108864` | Process-wide cap for queued opaque application frames |
| `RELAY_MAX_INGRESS_BYTES_PER_SECOND` | `16777216` | Per-socket token refill rate |
| `RELAY_MAX_INGRESS_BURST_BYTES` | `33554432` | Per-socket byte burst capacity |
| `RELAY_MAX_INGRESS_MESSAGES_PER_SECOND` | `256` | Per-socket message refill rate |
| `RELAY_MAX_INGRESS_MESSAGE_BURST` | `512` | Per-socket message burst capacity |
| `RELAY_ALLOWED_ORIGINS` | unset | Optional comma-separated browser origins; native clients may omit Origin |

Application frames must name one target; relay-level broadcasts are rejected
to prevent room-wide traffic amplification. Queue overflow produces `BACKPRESSURE`; abusive ingress produces
`RATE_LIMITED` and closes that socket. Clients checkpoint and retry after
reconnection. Heartbeats remove dead sockets, and empty rooms are deleted
immediately. Application payloads are forwarded once or
dropped—never retained for an offline peer.

The shared group capability authorizes relay-room access; Ed25519 proves which
device key is using it but cannot prove current trip membership. Consequently,
anyone holding an unrotated leaked or stale group capability can still consume
relay sockets under self-generated identities. The 32-socket relay limit is
intentionally separate from the app's ten-member limit, so ten such sockets do
not block ten legitimate members, while global, source-IP, upgrade-rate,
ingress, and backpressure limits bound the abuse. Revoking the capability
cryptographically requires a group rekey; the relay cannot infer revocation
without storing authoritative membership state.

## Required WSS edge contract

The Node process serves HTTP/WS. Production must terminate TLS at a reverse
proxy or load balancer and expose `wss://.../v1/relay` with:

- WebSocket Upgrade/Connection headers preserved;
- an idle timeout longer than the 15-second heartbeat and 45-second dead-peer
  window (60 seconds minimum; 120 seconds recommended);
- request and application-frame bodies excluded from logs;
- no response buffering or WebSocket compression added by the proxy;
- connection and bandwidth limits at least as strict as the service settings;
- the original source address passed in `X-Forwarded-For`; set
  `RELAY_TRUST_PROXY=true` only when untrusted clients cannot reach the Node
  listener directly. Otherwise the per-IP cap deliberately uses the direct
  socket address. A proxy-facing deployment that neither enables this trusted
  mode nor enforces its own per-client cap can collapse all users into the
  proxy's single 64-connection bucket and is misconfigured.

Rooms live in one process. A multi-replica deployment therefore must
consistently route the opaque, non-secret `room` query value to one replica for
the lifetime of its sockets. A single replica is acceptable for beta. Random
load balancing will split a room and is a deployment blocker. Adding a shared
database or payload queue is not an acceptable workaround; a future scale-out
backplane must remain transient and privacy-reviewed.

For the current 50-user beta, prefer one adequately sized relay instance plus a
standby/restart policy. If both phones say the relay socket is ready but each
reports zero relay-visible peers, first verify that the edge has not randomly
split one room across replicas. At larger scale, either keep consistent
room-to-instance routing or use a transient at-most-once pub/sub backplane with
TLS, bounded memory, and payload logging disabled. Do not use Redis Streams,
Kafka retention, a job queue, or any replayable payload log for photo frames;
those systems change the privacy model by retaining ciphertext server-side.

## Mobile build configuration

Expo SDK 57 statically inlines `EXPO_PUBLIC_` values referenced with dot
notation. Copy `.env.example` to `.env.local` for local builds, or define these
as EAS environment values for every build/update environment:

```text
EXPO_PUBLIC_AIRMESH_TRANSPORT=relay
EXPO_PUBLIC_AIRMESH_RELAY_URL=wss://relay.example.com/v1/relay
```

`EXPO_PUBLIC_AIRMESH_RELAY_URL` is public and must not contain a credential.
The checked-in EAS profiles select relay mode, but the real URL must be injected
through the EAS environment/dashboard before building. Changing it requires a
new bundle/update. `EXPO_PUBLIC_AIRMESH_TRANSPORT=lan` is an explicit diagnostic
fallback only. Local `ws://` additionally requires
`EXPO_PUBLIC_AIRMESH_ALLOW_INSECURE_RELAY=true`; production refuses plain WS.
