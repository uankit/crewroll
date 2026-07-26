# CrewRoll

CrewRoll is a private, local-first trip photo roll for groups of up to ten iPhone and Android users, powered internally by the AirMesh protocol. Friends keep using the system Camera; while a trip is active, CrewRoll discovers new library images and synchronizes encrypted frames through a transient outbound-WSS relay. Phones do not need to share Wi-Fi. There is no account, cloud photo store, offline server queue, or in-app camera.

The flow uses only a QR or complete secure link. The trip creator is the initial admin/admission authority, never a network router. Every phone makes the same outbound relay connection, and ended or left trips remain available as offline Saved rolls.

## P0 product contract

- **Live Share is the core.** Once CrewRoll can see a new image, every connected member receives its catalog entry and thumbnail. iOS may suspend CrewRoll while the standalone Camera is open, so “live” means immediate while runnable and automatic catch-up when the user returns.
- Every connected member automatically receives the thumbnail and exact original. Thumbnail/control traffic is prioritized ahead of background originals, and interrupted transfers resume from durable checkpoints. Transfers are chunked, encrypted, size/hash checked, and never promote an unverified partial file.
- A late joiner reconciles the catalog from the trip’s canonical start, then automatically fetches thumbnails before background originals.
- Photos are filterable by contributor and capture date. There is no AI or natural-language feature.
- The catalog, operation log, outbox, and transfer journal live in SQLite. Secrets live in OS-backed SecureStore; image bytes live in the app’s private filesystem.
- The relay forwards bounded live frames only. It cannot decrypt them and never persists payloads. Delivery therefore requires an online overlap between a requester and at least one phone that holds the requested bytes.
- Exact-byte originals retain embedded metadata, including possible EXIF/GPS. CrewRoll does not publish a separate catalog location in P0, but it cannot strip metadata while also preserving identical bytes.

Mobile photo APIs do not expose one reliable cross-platform “this came from Camera” flag. Live Share therefore covers images whose library creation time is at or after trip start, including newly saved or downloaded images. An in-place edit of an older asset is not claimed. iOS-labelled screenshots are excluded; Android screenshot classification is not claimed. This is disclosed before permission is requested.

## Architecture decision

A full P2P mesh is the wrong default for 5–10 phones: ten members could create 45 links, duplicate reconciliation work, and amplify battery/network failures. Production uses a **stateless transient relay**: each phone holds one outbound WSS connection, while the relay routes already-encrypted frames and retains no application payload. The creator remains an admin for membership decisions but is not the transport host. Each phone remains a local-first replica.

Expo SDK 57 / React Native 0.86 is the pragmatic shell. It provides maintained MediaLibrary, SQLite, FileSystem, SecureStore, routing, development builds, and an escape hatch for native modules. Rust would still require Swift/Kotlin lifecycle and permission shells, so it would add FFI and build cost without changing iOS background limits.

The relay process is deliberately small: room/device authentication, live routing, heartbeat/TTL cleanup, connection and ingress limits, and bounded WebSocket queues. It has no database or file writes. The original native TCP adapter remains behind the same `Transport` boundary as an explicitly configured LAN diagnostic fallback; it is not the production default.

See [docs/architecture.md](docs/architecture.md) for protocol/security invariants,
[docs/relay-operations.md](docs/relay-operations.md) for the WSS/container
contract, and [docs/release-readiness.md](docs/release-readiness.md) for the
automated and external release gates.

## Run locally

Requirements: Node 22.13+, Xcode for iOS, and Android Studio for Android. Copy `.env.example` to `.env.local` and set a reachable relay URL. Expo SDK 57 exposes every `EXPO_PUBLIC_` value in the client bundle, so the URL must not contain a secret.

```bash
npm install
npm run check
```

Run the transient relay locally (plain WS is allowed only with the explicit development flag shown in `.env.example`):

```bash
npm run relay:start
```

Build and install on a simulator/emulator:

```bash
npm run ios
# or
npm run android
```

After a native development build is installed, start Metro with:

```bash
npm start
```

An emulator is useful for UI, database, permission, and library-ingestion smoke tests. Release still requires physical cross-platform evidence over independent networks, Wi-Fi changes, and personal hotspots. LAN co-location is not a production requirement.

## Physical and shareable builds

Fast same-OS local iteration:

```bash
npm run ios:device
# or
npm run android:device
```

Shareable EAS development builds:

```bash
npm run build:dev:ios
npm run build:dev:android
```

Android’s preview profile produces an installable APK. iOS development/internal distribution needs an Apple Developer account and registered-device provisioning.

The checked-in EAS profiles select relay mode. Inject
`EXPO_PUBLIC_AIRMESH_RELAY_URL=wss://.../v1/relay` into the matching EAS
development/preview/production environment before a build or update; the app
fails closed instead of silently returning to phone-hosted LAN mode.
EAS builds run `npm run validate:release-env` before dependency installation and
reject missing, insecure, placeholder, credentialed, local, or room-pinned
relay endpoints.

CrewRoll implements XChaCha20-Poly1305 in application code, so the repository deliberately does not pre-answer Apple’s export-compliance declaration. Complete App Store Connect’s encryption questionnaire before distribution.

Follow [docs/manual-test-plan.md](docs/manual-test-plan.md) for the emulator, same-OS, cross-OS, independent-network, lifecycle, load, and integrity matrix. The automated relay beta gate is 50 simultaneous clients in five ten-member rooms with targeted control traffic and parallel maximum-size chunk bursts.

## Directory structure

```text
src/
  app/          Expo Router screens and navigation
  application/  use cases, orchestration, security, sync, runtime state
  core/         platform-free domain rules, codecs, reconciliation
  data/         SQLite migrations and typed repositories
  features/     feature-facing filters and providers
  platform/     Expo/native media, files, and transport adapters
  ui/           reusable components and design tokens
relay/          stateless transient WebSocket relay and production container
docs/           architecture, operations, release gates, and manual evidence plan
```
