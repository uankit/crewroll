# CrewRoll protocol-v3 manual release plan

Automated checks cover domain parsing, signed invites and operations, encrypted/signed frames, reconciliation, preview-first ingestion, durable transfer recovery, corruption failover, UI presentation state, transport limits, and the transient relay. Physical evidence is still required for OS photo permissions, Camera suspension, network transitions, rendering, and install/distribution behavior.

Record the app version/build number, git revision, protocol version, device/OS, relay image digest/configuration, network type, timestamps, file sizes, and failures. Use the same fresh native release candidate throughout a matrix. Protocol v3 and the iOS backup-exclusion module require a new native binary; an OTA update on an older binary is not a valid candidate.

The creator is never a transport host. Every device must use its own outbound WSS connection, and no test depends on shared Wi-Fi. First-time admission is different from data transfer: it still requires the creator/admin coordinator to overlap online.

## 1. Automated release-candidate preflight

Run these against the exact revision used for the mobile and relay artifacts:

```bash
npm ci
npm run check
npm run test:relay
EXPO_PUBLIC_AIRMESH_TRANSPORT=relay \
EXPO_PUBLIC_AIRMESH_RELAY_URL=wss://relay.example.com/v1/relay \
npm run verify:bundle
npx expo install --check
npx expo-doctor@latest
```

Also build the relay container with `npm run relay:docker:build` when Docker is available. Dependency checks must not be “fixed” with a forced Expo downgrade. Capture any accepted advisory and why it is not in shipped application/relay runtime code.

Before installation, verify the resolved Expo config contains protocol version 3, `android.allowBackup=false`, the expected application IDs, and a real `wss://` relay URL. Confirm Android and iOS are fresh signed native builds, not Expo Go or an OTA-only update.

## 2. One-device install and UI smoke test

1. Install the signed candidate on a clean device. Launching must not report a private-storage backup-policy failure.
2. Complete onboarding, create a trip, and verify the active roll, filters, invite QR, copied secure link, and permission copy.
3. Grant full photo access, add an image through the system Camera, and return to CrewRoll if the OS suspended it. It must appear once and survive a full app restart.
4. Add two images with the same visible timestamp. Both must appear once and retain stable attribution.
5. Repeat after denying photo access. Received content and navigation must remain usable. On supported OS versions, repeat with limited/selected access and “Choose more photos”; expanding access must not duplicate existing media.
6. Open a photo detail view. Controls must remain above system navigation/home indicators in portrait at the smallest supported height and with large text enabled.
7. Open a roll with at least five images and swipe horizontally through adjacent photos without returning to the grid. Confirm the position indicator, contributor/date/size, preview, transfer state, and action belong to the visible page.
8. End the trip. It must appear under Saved rolls with filters and locally retained previews/originals.

## 3. Same-OS physical pair

Run once with two iPhones and once with two Android phones.

1. Install the same protocol-v3 candidate on A and B.
2. Test these routes separately: both on the same Wi-Fi; unrelated Wi-Fi/cellular; A providing a hotspot to B; and B providing a hotspot to A. All cases must use WSS and behave the same. A phone IP/port must never appear in the invite or production diagnostics.
3. Create on A. Join B through the QR/system Camera or the complete secure link. A must be online for this first admission. Verify B becomes ACTIVE, both show 2/10 members, and reconnect does not create duplicate membership.
4. Take a photo on A while both apps are runnable. B must receive the catalog entry and thumbnail automatically, with no download tap. The preview should be usable while A may still show “Preparing exact original.”
5. The exact original must then arrive automatically. A byte-count 100% state must change to “Verifying”/“Finishing,” then to “Original ready”; it must never remain indefinitely at 100% or leave a preview presented as the original.
6. Open Connection diagnostics and copy the redacted report. Confirm it includes transfer benchmark sample timestamps plus p50/p95 results for the 5-second remote-preview and 30-second 5 MiB-original budgets, and contains no raw trip/member/device/media/resource/transfer IDs, file paths, invite data, keys, or image payloads.
6. Save the original on B and compare its SHA-256 and byte length with A’s app-owned source. Saving must not republish the image, including when saving from a Saved roll while another trip is active.
7. Repeat steps 4–6 with B as publisher. Trip creation must not affect transfer direction or speed.
8. Open either photo and swipe through the full-screen sequence. Retry/save buttons must remain visible and must update to the newly visible photo.

For a stable network with at least 20 Mbps each way and less than 100 ms relay RTT, collect 30 samples in each direction. The beta acceptance budgets are:

- remote thumbnail usable within 5 seconds at p95 after CrewRoll observes the library asset;
- a 5 MiB exact original verified and ready within 30 seconds at p95;
- no transfer spends more than 20 seconds without progress or a truthful paused/failed/retry state;
- a member can leave immediately even when one or more originals have not reached the replica target;
- no preview or original requires a manual request during the healthy connected path.

These budgets start when CrewRoll is runnable and observes the asset, not while iOS has suspended it behind the standalone Camera. Record device-side timestamps instead of estimating by eye.

## 4. Cross-platform pair

Repeat section 3 with iPhone creator/admin → Android member, then Android creator/admin → iPhone member.

Additionally verify:

- HEIC/JPEG source combinations produce renderable JPEG thumbnails on both platforms;
- a 20+ MiB original transfers, verifies, and saves without memory termination or hash change;
- iPhone Camera suspension catches up immediately on return instead of claiming background delivery;
- Android selected-photo permission and iOS limited-photo permission expose only selected assets and can be expanded;
- Android restore/backup is disabled in the packaged manifest, and iOS launches successfully after the native module verifies backup exclusion for both private media and SQLite directories.

## 5. Creator independence and admission boundary

Use A as creator/admin and B/C as already admitted members.

1. Let A publish a photo while B is online and C is offline. Wait until B has a verified original.
2. Take A completely offline. Bring C online with B. C must reconcile the missing signed catalog history, thumbnail, and exact original from B. It must not display “Can’t reach the host,” because no phone is a host.
3. While A remains offline, try to add new device D with the signed invite. D must remain DRAFT/not admitted; B and C must not invent authority to admit it.
4. Bring A online before the invite expires. D must become ACTIVE through the coordinator-signed `MEMBER_JOINED`, then complete catalog and resource catch-up.
5. Repeat with A changing network or restarting during established B↔C distribution. Existing members must continue whenever a required holder overlaps online.

This section passes only when creator independence for existing members and creator/admin dependence for first admission are both observed. Do not describe v3 as decentralized admission.

## 6. Ten-member seeding and fanout

1. Grow one trip to ten members. The eleventh admission must be rejected without evicting or changing any existing member.
2. Publish a fresh original from A while the other nine are connected and eligible to store originals.
3. In an instrumented build or transfer trace, verify only the deterministic two seed recipients initially request from A.
4. After their signed verified receipts propagate, verify the remaining seven receivers select verified holders through deterministic rendezvous selection rather than all requesting from A. Repeating with reversed peer discovery order must produce the same selections.
5. Disconnect one selected holder during transfer. The receiver must preserve its durable contiguous checkpoint and select another admitted verified holder after retry/cooldown.
6. Join an already admitted but stale device late. It must receive signed catalog metadata and thumbnails before background originals.
7. Use duplicate display names. Attribution and filters must continue to use member IDs.

One ten-member room is the maximum product room. The 50-user beta load is validated as five independent ten-member rooms in section 11, never as a 50-member trip.

## 7. Lifecycle, interruption, and saved-roll repair

1. During an original transfer, disable connectivity, background/foreground, lock/unlock, and relaunch each app. No partial file may become available. After overlap returns, transfer must resume from a durable checkpoint or restart truthfully and finish with the expected hash.
2. Move a connected phone between Wi-Fi, cellular, and hotspot. Reconnection must use jittered backoff; a fatal authentication/protocol rejection must stop instead of polling once per second.
3. Stop B, publish multiple photos from A, then restart B. B must reconcile every catalog entry once, display thumbnails first, and automatically fill originals while a holder overlaps.
4. With B offline, end the trip on A. Keep CrewRoll runnable on A, then open B. A’s hidden saved-roll responder must let existing member B receive the end operation and any pending catalog/resources without reopening capture.
5. Verify the responder does not scan new Camera images, expose an invite, or admit a first-time phone.
6. Restart A with no active trip. Only the most recently updated eligible ended/archived admin/keeper roll is selected for hidden repair. Creating or joining an active trip must replace that responder.
7. Suspend or force-quit A and confirm repair stops. Resume A and confirm durable work continues. Do not claim the hidden responder is an OS background service or that it serves multiple Saved rolls concurrently.
8. Leave locally as a non-admin member and confirm the roll remains readable. Do not expect a locally LEFT member to serve it as a responder.

## 8. Integrity failure and alternate-holder recovery

Use a controlled test build that can alter the app-owned file after a verified receipt exists.

1. Arrange three holders for one original, then corrupt or remove holder B’s verified local file without updating SQLite.
2. Make receiver D choose B. B must detect the mismatch before claiming upload success, remove local availability with compare-and-swap protection, persist a `LOST` receipt, and publish a signed `REPLICA_STATUS_CHANGED` operation.
3. B must send a targeted `SENDER_REJECTED`; D must terminally fail that attempt, cool down B, clear its resource retry gate, and immediately select A or C.
4. D must only become ready after exact byte-length/SHA-256 verification from the alternate holder. No duplicate receipt, false 100%, or corrupt promoted file is allowed.
5. Repeat the rejection after D’s first attempt is already marked failed. The duplicate terminal message must still trigger alternate-holder reconciliation rather than strand the resource.

## 9. Security and malformed input

- Expired, edited, duplicate-field, wrong-version, wrong-trip, wrong-epoch, wrong-signer, and wrong-secret invites fail without partial admission.
- A relay HELLO captured from one socket fails on a new socket challenge. Substituting the claimed device identity also fails and must not evict the legitimate authenticated socket.
- Replayed encrypted frames, stale counters, invalid Ed25519 frame/operation signatures, wrong sender routes, foreign operation origins, and forged targeted acknowledgements are rejected.
- The group secret and private identity material are absent from SQLite and logs and remain in SecureStore.
- Relay logs and health output contain no room/device identifiers, invite capability, frame bodies, filenames, or payload bytes. The relay has no writable payload path or persistence service.
- Ten stale/self-generated identities holding a leaked room capability must not prevent ten legitimate app members from connecting; global/per-IP/rate/backpressure limits must still bound abuse.
- A leaked current room capability is not equivalent to an admitted application identity, but it remains valid relay authorization until rekey. Record this as an accepted v3 limitation, not as solved revocation.

## 10. Media and gallery edge cases

- An iOS-labelled screenshot is excluded. Android screenshot exclusion is not claimed.
- An iCloud-only image is deferred without a cellular/cloud fetch and does not block newer local images.
- A newly saved/downloaded image created after trip start is included; an in-place edit of an older asset is not claimed.
- Unicode contributor names work; blank/control-character names fail validation.
- Low disk, revoked permission, and unsupported/corrupt assets show recoverable status while later valid photos continue.
- Exact originals retain EXIF/GPS; thumbnails and catalog rows do not add a separate location field.
- Active and Saved rolls page beyond the first database page. Swipe across a page boundary and confirm lazy loading preserves order, filters, and current position.
- Rotate is unsupported by the portrait product contract, but display cutouts, gesture navigation, three-button Android navigation, and large accessibility text must not hide the action area.

## 11. Relay load, backpressure, and operations

1. Run `npm run test:relay`. It must connect 50 clients across five full application rooms, deliver targeted control traffic within each room, route four parallel maximum-size 256 KiB relay chunks per room byte-for-byte, and return aggregate counts to zero.
2. Run the relay image read-only with the command in `docs/relay-operations.md`; `/healthz` and `/readyz` must pass.
3. Verify a slow receiver reaches bounded `BACKPRESSURE`; senders checkpoint/retry and relay memory does not grow without bound.
4. Verify abusive ingress closes with `RATE_LIMITED` while the normal beta burst succeeds.
5. Leave an unauthenticated socket idle; it must close at handshake TTL. Exceed pending, total, and per-IP caps in a test environment without disrupting authenticated rooms.
6. Present a wrong/expired proof. The app must expose one fatal error and stop reconnecting.
7. With multiple relay replicas, verify consistent routing by the public `room` query for every socket lifetime. Random room splitting is a deployment blocker.
8. Verify the relay never stores an offline frame. When all holders are offline, the client must say it is waiting; bringing a holder online must resume from durable phone state.

## 12. Explicit LAN fallback (diagnostic only)

Set `EXPO_PUBLIC_AIRMESH_TRANSPORT=lan` only in a dedicated development build and run the old same-Wi-Fi/hotspot reachability matrix. This tests the fallback adapter. A LAN pass cannot substitute for the WSS production matrix, and production must fail closed rather than silently choosing LAN when relay configuration is absent.

## Release blockers

- Missing, placeholder, or non-`wss://` `EXPO_PUBLIC_AIRMESH_RELAY_URL` in the chosen EAS environment.
- TLS/WebSocket edge configuration that drops upgrades/heartbeats, logs application frames, or randomly splits a room across relay processes.
- Failure of the exact relay image’s 50-client/five-room load gate, challenge-authentication suite, or read-only container gate.
- Any physical path that requires the creator after admission for catalog/byte distribution, or any first admission that succeeds without creator/admin authority.
- Preview p95 above the stated controlled-network budget, manual download required on the healthy path, an indefinite 9%/100% state, unverified availability, or buttons hidden by system UI.
- Failure to swipe active or Saved-roll photos horizontally, including across a paginated boundary.
- Any backup-enabled Android artifact, iOS startup that cannot verify both exclusions, or OTA-only delivery of the native backup-policy change.
- A custom `airmesh://` link that target OS versions cannot open from the chosen QR flow unless a verified HTTPS universal/app link replaces it.
- Unsigned mobile artifacts, unresolved export-compliance answers, or missing store/internal-distribution credentials.

The following are accepted v3 boundaries and must remain explicit in release notes: exact delivery needs online holder overlap; first-time admission needs the creator/admin coordinator; one saved-roll responder runs only while the app is runnable; Android has no foreground service; iOS Camera-background execution is not guaranteed; capability rekey/revocation and admin handover are deferred.
