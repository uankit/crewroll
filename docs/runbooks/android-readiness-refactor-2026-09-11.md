# Android readiness and trip-flow refactor — 11 September 2026

## Acceptance boundary

This is a targeted application refactor after a physical S26 stalled at secure
setup and photo status, followed by an ANR report. The earlier system exit record
reported excessive Binder traffic while cached. We have not captured the latest
physical ANR stack: USB debugging disconnected. Do not infer a proven memory leak
or claim physical-device acceptance from simulator or unit results.

## User flow and ownership

Sign in → provision/reuse this phone's identity → restore or create/join a trip →
owner approval when required → automatic first-use Photos prompt → trip photos.

| Boundary              | Owner                                                 | Required behavior                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth/session          | AppSessionProvider + nativeSessionFence               | One provisioning attempt per session; stale account continuations cannot write native state. Setup stalled for 30 seconds becomes an explicit failure, without inventing success.                               |
| Trip preparation      | preparedTripNative                                    | Serialize import/activation; remember only successful identical commands within the captured session. Trip refreshes do not restart native transfers.                                                           |
| Permission            | ExpoPhotoLibraryPermission + photoReadinessReconciler | Automatic first-use OS prompt on lobby/active-trip entry; coalesce prompt-induced foreground events. Denial/limited access requires deliberate retry. Native failures are not misreported as denied permission. |
| Readiness publication | Scoped trip composition                               | Publish only changed lobby readiness. Active-trip permission checks do not attempt a forbidden membership mutation.                                                                                             |
| Secure persistence    | AccountScopedKeyStore + AndroidScopedDatabaseFile     | Independently test key-state transactions; Android adapter retains Keystore AES-GCM, no-backup storage, atomic replacement and zeroization. Empty expiry cleanup never writes.                                  |
| Native session        | NativeMediaSession                                    | One validated active-session lease; copy buffers to callers, erase on mutation/expiry/teardown. Repeated status/fence reads do not repeatedly decrypt the full key database.                                    |
| Thread ownership      | NativeOperationQueue                                  | Lifecycle cleanup and key commands execute off the UI thread. Safe operation names, completion state and elapsed milliseconds go to native logs, never credentials, keys, photo bytes or URLs.                  |
| Photo transfer        | NativePhotoTransferEngine                             | Keep preview, original and projection work separate. Bound cached/background polling; returning to foreground wakes immediately. No background-delivery SLA is implied.                                         |
| Status UI             | observedRead + singleFlightRead                       | One outstanding native read per query; show a failure after a 10-second stall without queuing more native calls. Ignore disposed listeners and reject cross-trip projections.                                   |

This does not remove encryption, saved-original verification, durable retry
journals, membership authorization, or the all-recipient/expiry deletion rules.
No alternate hosting, queue service, database or fake-success path was added.

## Regression coverage

- Hundreds of native status reads cause one secure-context load.
- Session switch, expired bearer, failed mutation and teardown cannot reuse old secrets.
- Empty cleanup performs zero writes; expiry tombstones only provisional keys.
- A blocked cleanup cannot block the caller/UI thread.
- A thousand background wake attempts cannot repeatedly poll Android services.
- Concurrent trip refreshes activate once per session; failures remain retryable.
- A hung status read reports failure without increasing outstanding native calls.
- Fresh Photos permission prompts automatically; denial and limited access do not
  trigger automatic repeat prompts; prompt-related focus events are coalesced.
- Existing encryption, account fencing, preview-first delivery and verified-save
  regression tests remain required on both native platforms.
- The photo viewer owns a modal-local safe-area provider. A simulator inspection
  exposed the close control overlapping the status-bar area before this change.

Verification executed in this workspace:

| Suite                                  | Result                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Shared UI/application Jest             | 674 passed, 1 pre-existing skipped; 53 suites                                    |
| Android native JVM                     | 38 passed, including cleanup, lease teardown, polling and transfer failure cases |
| iOS native Swift                       | 31 passed                                                                        |
| Contracts/control-plane Vitest         | 755 passed                                                                       |
| Repository tooling                     | 1,381 passed                                                                     |
| Disposable PostgreSQL 17 integration   | 140 passed; loopback test cluster stopped afterward                              |
| Root TypeScript and scoped/full ESLint | Passed                                                                           |
| Android native module compile          | Passed                                                                           |

## Build and device verification

The local Android native module compiled. Full local native builds ran out of Mac
disk space; only generated CrewRoll build outputs were removed. Installable
builds were produced by the existing Expo account, not new infrastructure:

- Initial Android internal APK: `d45bf489-3983-4213-b263-adecd91f6946` (finished).
  Fresh Android 16 emulator installation, email-code signup, create, join, owner
  approval, automatic first-use Photos prompt and pending-join cold recovery passed.
- Initial iPhone simulator: `03c97b9c-6262-48e9-977b-480ba4992447` (finished).
  Installed native executable and bundled JavaScript hashes match the downloaded
  artifact. Existing signed-in recovery, cold app restart, trip opening and a
  saved-photo preview were exercised. The trip showed 8 previews and 8/8 saved
  originals. This confirms preserved existing state, not a new transfer.
- iPhone simulator with the modal safe-area correction:
  `77ff7826-5cc7-4ed4-8557-e4674b15e8fa` (finished, downloaded; UI verification pending).
- Android APK with the modal safe-area correction:
  `bcd7ac0a-7887-44f9-b98a-50e6e5140726` (finished, installed and exercised).
  In-place upgrade retained the account, key/trip state and Photos grant. Start,
  active status, three consecutive trip reopens and the preview open/close control
  passed. The new close control has a modal-local safe area.

The first iOS simulator archive SHA-256 is
`3148a02274458e89eafd64496f39f3ebe03d7fb2ef2951122267e561d8005a76`.
Its actual bundled CFBundleVersion is 1; EAS metadata is not used as proof of the
installed bundle version. The first Android artifact also predates the final
modal-layout correction and must not be labeled the final UI build.

Final Android APK SHA-256:
`c65bb99d1dafe44aac95c9f008ab23f6c7b318a2541ea186e8ddb5643a82fde1`.
Its signature verified and matches the initial candidate's certificate. The APK
package is `com.uankit53.airmesh`, version `1.0.1` / code `1`, targeting Android 16.
The signing certificate also matches the retained earlier Android build; this is
an upgrade, not an instruction to uninstall and lose account/key state.

Final iOS simulator archive SHA-256:
`28c0e473c33d51abddd0eed0aa9852ac273ba768f3d8a00adfd42718f484e945`.
A simulator build is not a TestFlight submission; none was submitted this turn.

### New Android encrypted-photo round-trip

The final APK was tested using two newly created accounts on one Android 16
emulator, not two simultaneously connected physical phones. A newly generated
4032×3024 JPEG with in-window camera metadata was inserted into the emulator's
`DCIM/Camera` library after starting the trip. No real user photo was used.

- Source: 14,584,772 bytes, captured at `2026-09-10T20:24:33Z`.
- Upload session created at `20:24:34Z`; full asset committed at `20:24:47Z`.
- Before signing in as the recipient, only this synthetic source was removed from
  the emulator library; its Mac fixture was retained. This prevents a false pass
  caused by reusing the sender's local file or rediscovering it under the joiner.
- Recipient native activation completed at approximately `20:25:54.993Z`.
- At `20:25:59Z`, the UI showed a ready preview while the original was still saving.
- Recipient's verified `SAVED_LOCALLY` receipt was accepted at `20:26:03Z`.
- Recipient MediaStore row 22 contains the new app-owned file under
  `Pictures/CrewRoll/crewroll-b26b9359-48af-47f3-bd7f-ed0bb9bbbbe3.jpg`.
- Pulled saved original: exactly 14,584,772 bytes; `cmp` succeeded and both hashes
  are `388b061a8a386e30555f13ab782471bd034cdaee5c17464741491ee49f47fcfc`.
- Both device delivery rows became `SAVED_LOCALLY`; the asset entered
  `PURGE_PENDING` after the second receipt. The existing cleanup recorded both
  objects deleted and the asset `PURGED` at `2026-09-10T20:39:52Z`, after the
  issued upload capability expired. Test metadata was deleted only afterward.

Selected native operation timings (emulator samples, not physical-device SLAs):
first-account secure setup including registration approximately 2.27 seconds;
existing-identity lookup 14–38 ms in sampled later sessions; initial active status
25 ms, subsequent status reads generally 0–3 ms. The final recipient activation
took 175 ms. A 14.6 MB network transfer remains distinct from local UI readiness.
OS launcher `am start` timings are not reported as application-ready timings.

Across the first 58 completed final-build snapshot reads, native completion was
0–33 ms (p95 25 ms); 55 asset-page reads were 0–3 ms (p95 2 ms). These include
initial secure-context loads, but do not include Clerk/network/UI rendering time.
After cold restart, the existing identity, account and active trip were restored
without entering a new email code. A 53-second background/resume check preserved
the current screen, preview and saved count, without re-import or reactivation.

An explicit offline test disabled both emulator Wi-Fi and mobile data and verified
`Active default network: none`. Local status refresh and the saved-photo preview's
open/close controls still worked. Both networks were restored in the test's
`finally` block and an active default network was verified afterward.

The additional cached/background soak completed: nine samples covering about
eight minutes of emulator uptime, retaining the same process (PID 4900). The host
clock advanced 13 minutes 50 seconds, so this is not labeled an uninterrupted
physical-device wall-clock benchmark. Android reported the process cached from
the second sample onward. Proxy Binder references went from 64 to 54; later
samples were 54–56. This is a bounded observation, not proof against every leak.
Process exit history contained only the intentional emulator restarts and APK
upgrade; no ANR/crash/Binder-kill exit was recorded. Returning to the foreground
restored the active photo screen with its preview and `1 of 1 saved` count. The
app was signed out through its UI after verification, stopping its transfer work.
Evidence: `/private/tmp/crewroll-refactor-background-soak.log` and
`/private/tmp/crewroll-refactor-android-session.log` (capture stopped afterward).
The dedicated `CrewRoll_Startup_20260910` Android test emulator was stopped after
the checks to release local resources; its installed APK/AVD data were not erased.

Android UI interaction was verified through accessibility/UIAutomator. Emulator
screen captures were black while the Mac was locked, so this does not constitute
visual smoothness/frame-rate or complete layout acceptance.

Pending acceptance: final iOS modal/layout verification and fresh iOS permission
flow, then startup/status and real concurrent sharing measurements on the physical
S26 and another phone. Google OAuth has not been reproduced in this emulator;
the email-code path was exercised. No physical-phone data was reset.

Fresh iOS sign-in/permission reset awaits explicit approval after the tool safety
guard blocked signing out the existing simulator QA session. No sign-out/reset
workaround was used. The Android emulator started without a CrewRoll installation
or retained package data; only this run's two QA identities were switched.
The Mac subsequently locked, blocking further iOS UI interaction until it is
unlocked. Android's separate ADB emulator connection remains available.

Database inspection found six pre-existing user records. No pre-existing users or
trips were deleted. Only the following records provably created by this run are
were the exact targets of the completed cleanup:

| Record          | Exact identifier                       |
| --------------- | -------------------------------------- |
| QA owner Clerk  | `user_3J9QKo1YCAyFRIHUnCgDrncBK2S`     |
| QA owner DB     | `04586946-07c0-4460-a2be-ec0999590f9f` |
| QA joiner Clerk | `user_3J9RAyGuPOOAPHsWCCayfY0cv7a`     |
| QA joiner DB    | `b843b700-4f3f-4c46-922d-7d7ad6f22e9d` |
| QA trip         | `01a08cef-5920-7d5e-8129-4e4c751ca177` |
| QA asset        | `b26b9359-48af-47f3-bd7f-ed0bb9bbbbe3` |

Cleanup's read-only scope check subsequently saw eight **other** users and four
other trips; people were also testing while this run was in progress. The cleanup
transaction preserves that current set, rather than assuming the initial count
still applies. It refuses deletion until both asset objects have been purged and
the upload capability has expired (`2026-09-10T20:39:34Z`). No timestamps are
shortened and no purge-success state is invented to bypass this safeguard.

Cleanup completed after both Clerk QA identities were deleted through their
individual dashboard confirmations and verified absent. The serializable database
transaction then removed only the two QA users/devices, one QA trip and its
dependent QA records (including the single purged asset). It verified the other
eight user IDs and four trip IDs were unchanged before committing. No existing
tester account, real phone session or real photo was deleted. These disposable
accounts cannot be restored, but new QA accounts can be created when needed.

Only regenerable local build outputs/older downloaded artifact copies were removed
to recover Mac disk space. They can be rebuilt or downloaded from Expo; project
source and unrelated worktree changes were preserved. No commit, push, production
hosting change, OTA publication or TestFlight submission was performed.

## Physical-device handoff

1. Install the final Android APK **over** the existing CrewRoll installation. Do
   not uninstall or clear data. The native fix requires a new binary, not an OTA.
2. Reconnect the S26 via USB, unlock it and approve that computer's debugging
   prompt. Resolve its serial with `adb devices -l`; never target the emulator by
   accident when collecting phone evidence.
3. Capture the app's `CrewRollSession` operation/completion timings and Android
   runtime errors. The new native log tag deliberately excludes credentials,
   encryption keys, photo bytes and signed URLs. Capture the app's process exit
   history as well if it stalls or exits; a historic exit is not a fresh ANR stack.
4. Measure launch-to-usable-home, repeated active-trip entry, stock-camera return,
   background/resume and photo preview versus verified-original arrival with a
   second real phone. Include the previously problematic Google sign-in path.
5. Complete final iOS UI/modal and first-use permission checks after Mac unlock
   and explicit approval to reset only the existing simulator QA session/Photos
   permission. No physical photo library reset is needed.

## References

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [SDK 57 MediaLibrary permission API](https://docs.expo.dev/versions/v57.0.0/sdk/media-library/)
- [SDK 57 modal safe-area guidance](https://docs.expo.dev/versions/v57.0.0/sdk/safe-area-context/)
- [Android ANR diagnosis](https://developer.android.com/topic/performance/vitals/anr)
- [Android Keystore guidance](https://developer.android.com/privacy-and-security/keystore)
