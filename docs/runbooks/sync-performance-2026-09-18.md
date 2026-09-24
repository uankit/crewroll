# Sync performance and motion verification — September 18, 2026

This change implements the agreed per-device sync/concurrency work (CR-15), the media transaction part of CR-22, trip-wide retry (CR-02), bounded waits (CR-12), and the transition polish discussed during the walkthrough. It preserves the existing Cloudflare Workers/PostgreSQL/R2 architecture. It does not introduce a server per user, Redis, a new deployment, or the separate push/outbox pipeline in CR-11.

## Resulting behavior

Each device retains its own durable delivery records and native journal. Native scheduling allows one original upload and two original downloads at a time, alongside a separate preview lane. A slow original does not monopolize the coordinator, preview reads, cancellation, or an outgoing upload. Native image preparation/cryptography stays off the UI thread. Account/session fences wait for active saves before acknowledging teardown; successful delivery still requires integrity verification and a verified system-photo-library save.

“Sync now” re-evaluates the whole trip journal, including blocked photos outside the displayed page or filter. Failed original work records a durable retry deadline with bounded backoff. Foreground idle polling backs off to 15 seconds, with immediate wakes for user actions and photo events. Background jobs check actual pending/working state and finish when known work drains; unfinished work remains durable and is rescheduled within OS rules. iOS background URLSession owns staged transfers beyond a processing window. This is not a guarantee that either OS runs the app continuously.

The gallery keeps its cached photos while status changes. Compact status describes this phone's uploading/saving/queued work, known network waits, retry countdown, or an actionable blocker. “Up to date on this phone” describes reconciled known work during a live trip, not final completion for all members. Manual sync admission has a 10-second UI deadline; control-plane requests include token retrieval and response-body consumption in a 20-second deadline. An uncertain mutation is not blindly retried.

Screen changes use a short fade with an 8-point movement, rather than a full transparent blank between screens. Bottom sheets animate the backdrop opacity independently of the panel's slide, retain the panel for its exit, and honor reduced motion. Cached galleries remain mounted during refresh.

## Database and storage coordination

R2 HEAD calls and ciphertext retirement run outside PostgreSQL transactions. Short transactions authorize/claim before storage I/O and revalidate authorization, trip state, and claim ownership before finalizing. Read-only pending-delivery queries use shared authorization locks rather than exclusive mutation locks. Short database locks remain necessary for correctness.

The simulator logs also exposed existing lock-order cycles in background authentication and trip commands. Background authentication now resolves the candidate, then locks the user before the device and rechecks the credential after waiting. Trip commands that already hold a trip lock use non-waiting participant locks; contention rolls back and releases the entire transaction before a bounded retry (five attempts with jitter). Only PostgreSQL-confirmed rollback errors are retried, never an uncertain commit or network failure. Authorization and all command invariants are rechecked on every attempt. This also covers a command inspecting another participant while that participant's media work waits for the trip.

R2 original keys are immutable: atomic conditional PUT creates only a missing object. Identical racing/retried writes reconcile to the existing verified checksum. Retirement replaces ciphertext with a zero-byte marker that GET/HEAD do not expose as a photo. This fences a still-running or replayed PUT without holding a PostgreSQL connection during the body stream. A marker retains no photo bytes or decryption material; its object key still exists.

Cleanup uses deadline-ordered, bounded batches with durable claims, a two-minute lease, a token fence, at most four concurrent items, and retry backoff. One failed object does not stop other claimed objects. An expired worker cannot finalize a newer worker's claim. Global database failure can still fail a pass; production alerting/overdue-deletion monitoring remains open.

## Controlled measurements

These are local engineering comparisons, not production/network/battery SLAs.

| Scenario                                                                                                          |               Baseline |                    Updated | What the measurement means                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------: | -------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent PostgreSQL trip-row acquisition while storage HEAD takes an injected 250 ms; median of five runs       |              258.98 ms |                   0.302 ms | Slow remote HEAD no longer holds the conflicting trip-row lock. This is lock wait, not total photo latency.                                                                           |
| Actual Kotlin engine, 100 blocked incoming originals, controlled 40 ms transport delay, one vs two download slots |                 5.36 s |                     2.90 s | 45.9% lower median elapsed time across three paired final-code trials; all six runs verify/save all 100. Crypto/library/transport fixtures do not represent phone/network throughput. |
| Native snapshot p95 during that 100-photo test                                                                    |                6.78 ms |                    7.54 ms | Coordinator reads remain responsive while transfers run; concurrency is not assumed to double throughput.                                                                             |
| iOS debug JS frame interval during guest settings open/close                                                      | No comparable baseline | 16.93 ms p95; 57.60 ms max | 1,193 requestAnimationFrame samples, mostly idle frames. This is a debug JS cadence check, not native presentation FPS or a release-device frame-budget guarantee.                    |
| iOS debug native snapshot round trip, same walkthrough                                                            | No comparable baseline |  8.07 ms p50; 25.57 ms p95 | 30 reads in the simulator; not a physical-device latency target.                                                                                                                      |

Raw results and screenshots are in [outputs/sync-performance-2026-09-18](/Users/uankit/Developer/personal/crewroll/outputs/sync-performance-2026-09-18). The final comparison uses three paired trials (see `native-final-comparison.json` and `final-trials/`). The earlier exploratory run is retained in `native-download-concurrency.json`; it preceded the local-preview recovery fix and ran with other build work active. These controlled comparisons do not establish a production end-to-end p95 transfer SLO.

## Automated evidence

- PostgreSQL 17 media, background authentication, device concurrency and trip-membership concurrency: 69 tests pass across four suites (including 41 media tests). Coverage includes revocation while HEAD is suspended, cleanup outside row locks, independent cleanup failure/retry, expired claim recovery, stale finalization rejection, and deterministic actor/recipient lock-contention races.
- Foreground-trip and background-authentication unit coverage: 107 tests pass, preserving command authorization, idempotency and revocation behavior.
- Local workerd with real R2 bindings: ciphertext round trip, concurrent immutable PUTs, valid-grant replay after retirement, retirement racing an already-streaming PUT, and zero retained ciphertext bytes pass. This is local workerd, not a production deployment test.
- Kotlin native suite: 61 tests pass, including the 100-photo whole-trip retry/concurrency comparison and existing account/save recovery coverage.
- Swift native suite: 54 tests pass, including a stalled incoming original alongside outgoing work, save/receipt recovery, teardown during a save, a preview-only pending original retaining the background lease, and account-independent received-photo discovery exclusions.
- Focused UI/API/navigation suites: 77 tests pass, including gallery/overlay behavior, request deadlines across token retrieval and response consumption, and per-device progress.
- Root and Worker TypeScript checks plus changed-frontend and control-plane lint pass. Full iOS simulator application build and Android native module compilation pass. Android JVM tests do not substitute for a new Android APK/emulator walkthrough.

## Bugs found by the emulator

The first receiving run exposed a real iOS cache-identity bug: the background downloader keyed GET results by host/path/file size. Our gateway puts different objects behind the same path, so equal-size photos could reuse one another's ciphertext. Integrity checks rejected it and prevented a false save receipt, but progress became blocked.

The cache now uses a versioned identity including the ciphertext SHA-256 authenticated by the manifest, size, method, origin and path. Renewed signed URLs still rejoin the same immutable work. Download completion and cache reuse verify the ciphertext hash; a damaged cache entry is discarded before retry. Old ambiguous cache identities are ignored. Regression tests cover two distinct equal-size objects, renewed capabilities and corrupted cached bytes. Both original and preview callers supply the expected hash. A second receiving check exposed missing thumbnails after the temporary server grant expired. Both native engines now rebuild missing previews from the verified local original without another download; each item is isolated so a missing local file cannot stop other previews. Temporary exports use the existing crash-cleaned staging directories and account/session fences.

A third check, signing back into the first guest account after the late member had saved a photo on the same simulator, exposed an iOS discovery loop. Received originals preserve camera EXIF, and the other account's saved local identifier was absent from the returning account's journal. Discovery now excludes the durable `crewroll-<asset UUID>` resource filename before admitting camera work, independently of account/journal state. Android already excludes the `Pictures/CrewRoll/` save directory. The pre-fix run created a fourth test asset from the third photo; that evidence is retained rather than erased or counted as a distinct successful capture. This fix prevents new loops and does not retroactively delete already published duplicates.

## Emulator acceptance

The walkthrough uses separate host/guest iOS 26.5 simulators, real Clerk development sign-up and code verification, and a disposable PostgreSQL database. Application authorization, key envelopes, native encryption/decryption, transfer journals, receipts, and Photos saves use the normal implementation. The isolated API replaces the unavailable Clerk Backend name lookup with a local test directory and uses the local ciphertext adapter; the R2-specific race protocol is validated separately by workerd. No production users or trips were reset.

Simulator photo input uses small synthetic JPEGs with camera-like metadata, imported through `simctl addmedia`. This exercises the normal native discovery and save path; it is not physical stock-camera or background/lock-screen acceptance. Only one simulator runs at a time because of limited disk space, which also deliberately exercises an offline recipient.

Verified on the rebuilt iOS application:

- New host registration/profile/device creation, create trip, persistent invite code, new guest registration, native in-app photo permission prompt, invite lookup/request, host notification approval, reuse of granted access, both members ready, and host start.
- Two host originals commit while the guest is offline. Returning guest saves both; native counts report 2 originals and 2 previews, no blockers. Both saved files match the source SHA-256 and length (76,856 bytes each). There is one local file per original.
- Sign out and register a different account on the same simulator. The new account has no prior-trip gallery. After mid-trip approval it has zero eligible deliveries for the earlier photos.
- Add one new original after approval. The late member saves exactly that one; the native gallery reports 1 original and 1 preview, zero blockers, and the local file hash matches. The other recipient's offline queue does not delay it.
- Home/trip navigation, notification and settings sheet open/close preserve the underlying screen; gallery opens reuse photo access. The frame probe is reported above with its debug/simulator limits.

The final updated-binary account cycle restored the late member, saved its remaining eligible delivery, then restored the original guest and ran whole-trip sync. The guest reports four originals/four previews with zero blockers; the server asset count remains four, including the documented duplicate created before the discovery fix. No further uploads or device registrations appeared. The updated host subsequently saved its remaining delivery. Final server counts are host 4, original guest 4, late member 2, all `SAVED_LOCALLY`, with three devices total and no pending eligible deliveries. The late member's two exclude the first two pre-approval originals and include the post-approval original plus the pre-fix duplicate. See `ios-final-delivery-reconciliation.json` and `ios-returning-guest-after-discovery-fix.json`.

The host gallery is left open for inspection. `ios-navigation.mp4` records the guest's trip sheet opening/closing, Home navigation and cached gallery re-entry; it is a debug capture with a brief development refresh overlay, not a release motion benchmark.

One launch immediately after a simulator boot reached the existing session-restoration fallback and recovered after reopening the app, with no account reset. Subsequent account restorations and the host launch succeeded. That isolated cold-start observation was not conclusively diagnosed; offline/auth cold-start recovery remains separate acceptance work. The local Metro server also needed restarting after the lint pre-step briefly removed generated contract files; this was a development build/cache interruption.

## Rollout requirements and remaining acceptance

1. Apply migration `009_media_cleanup_claims` with the migration owner and grant the runtime role SELECT/INSERT/UPDATE/DELETE on `media_cleanup_claims`. Verify with the restricted role before release. No production migration was applied during this task.
2. Ship native binaries with the compatible JavaScript bundle. The snapshot `sync` field is optional for an old native engine with new JS; older strict JS schemas must not be paired with a newer native snapshot by accident. An OTA alone cannot add native concurrency/background behavior.
3. Drain old Worker versions that physically delete object keys before enabling the retirement-marker protocol. Do not run mixed old deletion code against keys protected by new markers. R2 lifecycle deletion must not remove these markers while stale writers/capabilities can exist. The conservative implementation retains markers indefinitely; lifecycle/compaction needs a separately proven fencing horizon and operational cost review.
4. Repeat on physical iPhone and Android devices with real cameras, large originals, cellular/Wi-Fi changes, suspension/reboot, disk pressure, permissions, battery saver and force-stop. Measure stage p50/p95, bytes retransmitted, battery impact, and peak memory. Simulator/unit results do not establish those properties.
5. Remaining backlog includes production stage/queue-age dashboards and alerts, push/outbox dispatch, Android authenticated resumable bytes, archived galleries/offline cold-start policy, and the ended-trip delivery-slot policy. Do not label expired/missing photos as fully synced.

## Reproducing checks

Use an isolated PostgreSQL database with the existing integration-test opt-in guard. Never run destructive integration fixtures against a user's testing or production database.

```sh
# Swift native state/transfer tests
swift test --package-path modules/crewroll-transfer/ios/IdentityKeys \
  --scratch-path .expo/crewroll-native-keys-tests

# Native Kotlin benchmark writes JSON to the supplied directory
CREWROLL_SYNC_BENCHMARK_DIR="$PWD/.expo/sync-benchmark" \
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
packages/contracts/crypto/conformance/kotlin/gradlew \
  -p modules/crewroll-transfer/android/native-key-tests test --console=plain

# Gallery/motion regression coverage
npx jest src/bootstrap/ActiveTripTransfers.test.tsx \
  src/design-system/primitives/overlays-and-progress.test.tsx --runInBand
```
