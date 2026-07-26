# CrewRoll v3 beta release readiness

This document separates repository readiness from deployment and physical-device evidence. “Production-ready for 50 users” means five independent rooms of at most ten admitted members, not a single 50-member room.

## Repository contract

The v3 candidate is expected to provide all of the following together:

- outbound WSS on every phone; no creator-hosted socket server or LAN auto-fallback;
- challenge-bound Ed25519 relay authentication;
- Ed25519-signed invites, immutable operations, and application frames;
- XChaCha20-Poly1305 application-frame encryption that the relay cannot decrypt;
- durable preview-first `MEDIA_PREVIEW_PUBLISHED`, followed by `MEDIA_ORIGINAL_PUBLISHED` and verified replica receipts;
- two-recipient original seeding, then deterministic verified-holder fanout;
- resumable bounded transfers, exact final verification, corrupt-holder `LOST` publication, targeted rejection, and alternate-holder failover;
- creator-independent synchronization for already admitted members, with creator/admin-only first admission;
- one best-effort hidden saved-roll responder when no active trip owns the sync session;
- Android backup disabled and iOS private-media/SQLite backup exclusion enforced at startup;
- horizontal active/Saved-roll photo paging and truthful preparing/transferring/verifying/ready UI.

Removing any item changes the release contract and requires a new review, not a documentation exception.

## Automated gates

Run from a clean checkout with the pinned Node/npm toolchain. Preserve the output with the build record.

| Gate | Command | Pass condition |
| --- | --- | --- |
| Application checks | `npm run check` | Typecheck, lint, and all application tests pass |
| Release environment | `npm run test:release-env`, then `npm run validate:release-env` with the selected EAS environment | Static acceptance/rejection tests pass; the real relay is public WSS with no credentials, fragment, room pin, placeholder, or local address |
| Relay security/load | `npm run test:relay` | Authentication, abuse bounds, five-room/50-client fanout, byte checks, and cleanup pass |
| Production bundle | `npm run verify:bundle` with real relay-mode environment | iOS and Android bundles export without placeholder/insecure transport |
| Expo compatibility | `npx expo install --check` and `npx expo-doctor@latest` | No incompatible SDK dependency or native configuration error |
| Dependency risk | `npm audit --omit=dev --audit-level=high` | No high/critical shipped dependency advisory; no forced Expo downgrade |
| Relay image | `npm run relay:docker:build` | Image builds from the relay context and passes health checks read-only |
| iOS native compile | release/archive build | Backup module compiles and startup read-back succeeds |
| Android native compile | release/AAB and preview/APK builds | Manifest resolves `allowBackup=false` and application launches |

Automated success does not replace the physical matrix in `docs/manual-test-plan.md`.

The current root audit reports 11 moderate `uuid` findings through Expo's
transitive `xcode`/config build tooling; the shipped relay audit reports zero
findings and the high/critical application gate passes. `npm audit fix --force`
is not accepted because its proposed resolution downgrades the Expo stack to an
incompatible release. Re-evaluate this exception when Expo updates that
toolchain dependency, and do not let the exception expand to a high/critical or
mobile/relay runtime advisory.

## Deployment gates

The repository does not contain a hosted relay, TLS certificate, mobile signing identity, or store approval. Before inviting users:

1. Deploy the exact tested relay image behind `wss://` TLS termination.
2. Preserve WebSocket upgrades and heartbeat timing, disable payload/body logging and compression, and apply the documented connection/ingress/backpressure limits.
3. Use one relay process for beta or consistently route the public opaque `room` query to one process. Random load balancing splits rooms.
4. Inject the real relay URL into every selected EAS environment before bundling. The URL is public configuration and must contain no secret. The dependency-free `eas-build-pre-install` hook rejects missing, insecure, placeholder/local, credentialed, fragmented, or room-pinned endpoints before an EAS build installs dependencies.
5. Produce fresh signed iOS and Android native binaries. Do not deliver the protocol/native backup changes as an OTA-only update to an older runtime.
6. Complete Apple encryption/export-compliance answers and internal-distribution/store provisioning.
7. Configure Expo Updates manifest code signing with an operationally protected signing key before relying on OTA updates, or keep OTA publishing disabled. The repository intentionally does not contain that private credential.
8. Execute and archive the same-OS, cross-platform, independent-network, hotspot, creator-offline, saved-roll repair, corruption, and UI evidence.

## Beta acceptance budgets

Under the controlled-network conditions in the manual plan:

- remote thumbnails: p95 at or below 5 seconds after the app observes the asset;
- 5 MiB exact originals: p95 verified/ready at or below 30 seconds;
- healthy connected path: zero manual original requests;
- integrity: zero unverified promoted files and zero terminal 9%/100% UI stalls;
- membership: at most ten admitted devices per room;
- load: 50 simultaneous clients across five ten-member rooms.

Latency while iOS has suspended CrewRoll behind the standalone Camera is excluded; foreground catch-up latency begins when the app becomes runnable.

## Privacy and availability statement

The relay may observe connection timing, source addresses at the edge, opaque room routes, public device keys, and frame sizes. It does not receive the group secret, application plaintext, filenames, photo bytes in plaintext, or a durable offline payload. It has no payload storage path.

Consequences that must be disclosed:

- an original cannot reach a phone until it overlaps online with at least one verified holder;
- losing all verified phone copies loses the original; the relay cannot recover it;
- a leaked unrotated room capability can consume bounded relay resources even though it cannot forge admitted-member history;
- first-time admission waits for the creator/admin coordinator;
- only one eligible Saved roll is repaired at a time, while CrewRoll is runnable.

## Rollout and rollback

1. Start with one two-device internal room and verify the real production WSS edge.
2. Expand to one mixed-platform ten-member room and verify seed/fanout plus creator-offline recovery.
3. Expand to five rooms, keeping the total at or below 50 users while observing only aggregate relay health and client-side error reports.
4. Stop enrollment if preview/original budgets regress, relay backpressure becomes routine, hash rejection repeats, or admission failures exceed isolated user/configuration errors.

Protocol v3 is intentionally strict. Do not mix incompatible protocol builds in a room. Rollback means distributing a coherent signed mobile build and matching relay version to the affected cohort; it does not mean pointing a v3 database/identity at an older incompatible OTA bundle. Preserve private on-device data during rollback and never introduce a payload-storing server as an emergency queue.

## Accepted v3 boundaries

The following are explicitly out of scope for this beta: admin handover/election, membership rekey/capability revocation, concurrent responders for multiple Saved rolls, an Android foreground service, arbitrary iOS background execution, multi-source chunk swarming, videos/RAW/Live Photos, server payload storage, accounts, and social/AI features.
