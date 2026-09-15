# Startup crash and emulator acceptance — 10 September 2026

## Confirmed defects and fixes

1. The shipped Android 0.2.0 APK exited at the splash screen with
   `TypeError: Cannot read property 'defineProperty' of undefined` on the
   `expo-updates-error-recovery` thread. TypeBox 0.34.52's ESM `Object` export
   shadows the global used by Metro's export shim. `metro.config.js` selects
   TypeBox's published CJS entrypoints on iOS/Android, including subpaths so its
   format registry stays shared. Production/minified bundle execution tests
   cover both platforms. No dependency upgrade or broad exports override.
2. Android's real Keystore rejected caller-supplied AES-GCM IVs while randomized
   encryption was required. Both the outer database container and scoped secret
   records now use a cipher-generated IV. Randomized encryption remains enabled;
   persisted record formats and decryption stay compatible. JVM round-trip,
   nonce uniqueness and tamper tests pass; native release-device verification is
   tracked below.
3. A failed initial native pause happened before the session's visible state was
   bound, hiding the error behind "Connecting this phone." Setup now binds its
   safe loading state first; a failure is visible and retry repeats the required
   native preparation before provisioning.
4. The lobby's Start callback depended on changing permission state. That changed
   the actions object and retriggered permission reconciliation indefinitely.
   Live simulator traces showed about three successful readiness writes/second.
   Start now uses the existing synchronously invalidated readiness ref, keeping
   action identity stable. Regressions cover FULL/SETTINGS_REQUIRED transitions
   and existing account/foreground/Start race protections remain tested.
5. iOS registered a PhotoKit observer while constructing the paused engine,
   prompting for access before the trip flow. Registration now waits for an
   authorized discovery scan; the release simulator starts without that prompt.
6. A successful join returns `PENDING_KEY`, but pending members deliberately
   cannot read the trip. The mobile app immediately tried that forbidden read,
   displayed a failure and could mint conflicting retries. It now preserves the
   original durable join command, shows "Waiting for the owner", and checks that
   same command until approval. Foreground polling backs off on errors; pending
   state survives process restart. No server authorization was weakened.
7. The native Clerk sign-in view could mount before its native environment was
   loaded, showing an empty form with only Continue. It now waits for
   `useAuthViewState().isLoaded` before mounting the form.
8. The native splash was held until network authentication loaded. An offline
   cold start could therefore cover the recovery UI and produce Android's
   "Application does not have a focused window" ANR. Splash dismissal now depends
   only on local font readiness. After 15 seconds, startup explains recovery.
   Android's Retry connection reloads the same bundle without deleting data.
   iOS uses manual close/reopen instructions: the installed Expo 57.0.18 native
   runtime predates the [57.0.19 iOS reload crash fix](https://github.com/expo/expo/blob/sdk-57/packages/expo/CHANGELOG.md).
   The app does not call that affected iOS reload path.

## Release builds, emulators and automated evidence

- Original shipped APK crash reproduced on Android 16; corrected production JS
  reached real Clerk sign-in, including cold starts and background/resume.
- Real Clerk development test-code sign-in and native device registration reached
  the Android and iOS home screens. Test addresses use Clerk's reserved
  `+clerk_test` suffix;
  no email verification messages were sent to a real person.
- iOS created a trip, exposed an invite, and recovered that trip after process
  termination/reinstallation without deleting the account or app data.
- Denied permission now settles to "Open photo settings"; after full access the
  lobby enables Start. The app opened Settings, but the simulator initially
  showed the Settings root; exact physical-device Settings routing remains a
  check for phone acceptance.
- A fresh two-account trip exercised create → join → pending owner approval →
  process restart while pending → approval → both phones ready → Start. The
  pending member reached the lobby automatically after approval. Failed pending
  records made by the older code were not migrated or deleted; this proof used
  a fresh QA trip.
- With approved simulator Photos access, actual native encrypted originals were
  shared in both directions. Source and system-library SHA-256 hashes matched.
  A five-photo burst sent while Android was offline recovered after reconnect
  and reopen; all five matched and no duplicate system-library saves appeared.
  Both UIs showed seven previews and seven originals saved after that batch.
- The final signed Android APK was installed and its on-device APK SHA-256
  matched the downloaded artifact. The 1 GiB emulator could not stage an ordinary
  in-place upgrade, so only its old app binary was removed with `pm uninstall -k`
  before reinstalling. The account, key material, active trip and test photos
  survived; this is not a physical-phone upgrade acceptance claim.
- A separate, empty, ephemeral Android user profile showed the complete email
  sign-in form without an early Photos prompt. It was removed afterward; the
  original two-account sharing test data remained in user 0.
- Actual Android offline cold start revealed the readable recovery screen.
  Restoring Wi-Fi and tapping Retry connection returned to the signed-in home
  with the active trip, without re-authentication or data clearing. The old
  native-splash ANR trace was retained as negative-control evidence.
- Full UI suite: 663 passed, one pre-existing skipped. Tool suite: 1,381 passed.
  Contracts/server unit tests: 755 passed. Native JVM tests: 29 passed. Swift
  tests: 31 passed. Direct PostgreSQL integration tests: 140 passed against only
  the opted-in local `crewroll_test_pg17` database, which was stopped afterward.
  Final typecheck and full lint passed; the final iOS-only recovery guard also
  passed its scoped lint and UI/typecheck rerun. Do not run tooling boundary
  tests concurrently with typecheck:
  boundary fixtures temporarily enter the source tree and then disappear.

## Native transfer timing (one sample, not a benchmark)

On the final Android APK, an additional 4032×3024 synthetic JPEG was injected into
the iOS simulator Photos library at `2026-09-10T13:39:51.881Z`:

- Original size: 14,584,451 bytes. Import completed after 509 ms.
- Verified local preview appeared in Android's protected preview store at
  **5.294 seconds** from injection.
- Original appeared in Android's system photo library at **25.999 seconds**.
- Source/receiver SHA-256 both:
  `fc2a94bad1113f4126b7a73e99e522d62bdd70b3964e40827d59c60dface73f8`.
- The final Android gallery then showed eight previews and eight originals saved;
  opening a preview rendered the test image and Back returned to the gallery.

The observer used the host clock and 500 ms filesystem polling. This proves
preview-before-original with real native transfer engines and hosted services;
it does not measure UI paint, stock-Camera capture, physical-phone p50/p95 or
five-phone load. An earlier Android clock skew was corrected before this run.
No foreground/background delivery SLA is inferred.

Local evidence includes `/private/tmp/crewroll-online-photo-observation.jsonl`,
`/private/tmp/crewroll-offline-start-anr.txt`,
`/private/tmp/crewroll-offline-visible-final.png` and the
`/private/tmp/crewroll-startup-*-final*.log` test logs. They contain only test data.

## Distribution

- Final Android replacement: [EAS build a289f1b9](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/a289f1b9-b89c-46c5-b11a-664388caf1f0),
  [APK](https://expo.dev/artifacts/eas/GhsX0bXTg_MTK8JOi2qIY993oyQmLg5YmthexIvFMHU.apk),
  package `com.uankit53.airmesh`, version `1.0.1`, versionCode `1`.
  APK SHA-256: `f111ab25997ad3f43023d734f7a7f9054c76f3a3142fade62f8c6f902d45b8fb`.
  Signature verification passed; signing-certificate SHA-256:
  `0498e3cab59bbde5b1f485fbca6419bd320ea440c26d591e588565578490f1f4`.
  Earlier native transfer proof used EAS release APK
  `b921f894-3770-4fbb-8923-9f0bc28c8fcc`; final timing used `a289f1b9`.
- iOS release simulator with deferred PhotoKit registration: EAS build
  `afa23d96-5162-49d9-834f-e54a5c790c3c` (finished, installed). This is a simulator
  artifact, not an installable iPhone/TestFlight build.
- Android preview update group `eb3965c8-f76a-45ed-ae65-146e73c2cae5`,
  update `01a08b83-479e-7edc-994e-eafa5b287418`, runtime `1.0.1`.
- Final iOS preview group `bc7ea9f6-51b5-446f-8dbc-62c797eba5a7`; identical
  bundle republished to TestFlight group `db4c527b-bf74-43b3-9bd3-3eadd0285a88`,
  update `01a08b90-e905-7b8d-9272-2228fc488bf1`, runtime `1.0.1`.
  The last recovery changes arrived by OTA after those native artifacts compiled;
  the replacement iPhone store build 13 also embeds them directly.
- Replacement iPhone store build **1.0.1 (13)**,
  [EAS build 212f9481](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/212f9481-db20-474b-a97d-d9b67082f0cd),
  finished. At the account holder's explicit request, its actual IPA restores
  Boolean `ITSAppUsesNonExemptEncryption = false`; the photo encryption is
  unchanged and this is not a verified exemption classification. Deep/strict
  code-signature verification passed for team `639SF375P5`. The embedded
  configuration targets `testflight`, runtime `1.0.1`, and the final iOS recovery
  copy was verified in the embedded JavaScript bundle.
  IPA SHA-256: `32d2f9f9bd85b783fd14e4af8b7a91b6a9e46cbb3fd21687022ee3f3c2edb3af`.
  Apple's `altool` accepted the IPA with **no errors** on September 10 at
  **23:41:45 India**, delivery UUID `15848197-368a-4689-b4fc-facb3fbb839b`.
  At **23:53 India**, Apple's API confirmed upload `COMPLETE`, processing
  `VALID`, and internal **`IN_BETA_TESTING`**. The existing **Team (Expo)**
  group's builds endpoint includes build 13 and its one existing internal tester
  retains access. External status is `READY_FOR_BETA_SUBMISSION`; no beta or
  public App Store review was submitted for this replacement. See
  [the current TestFlight record](testflight.md) for evidence and install steps.
- iPhone store build **1.0.1 (12)**,
  [EAS build 25ccded6](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/25ccded6-e0b4-48b8-b1e0-6d0b3c603219),
  finished. Its actual IPA declares `ITSAppUsesNonExemptEncryption = true`.
  Deep/strict code-signature verification passed for Apple team `639SF375P5`;
  its Expo configuration targets channel `testflight`, runtime `1.0.1`.
  IPA SHA-256: `7f8f22783d010712dcf5210857d507bfcf39b179ef2a794e44f475b8bb8c9d4d`.
  EAS submission jobs `d411b2ce-2e0c-48a5-b108-a0886e32b7bb` and
  `07f640a2-3216-430c-b61a-828be529b1fa` both returned ERRORED with no error
  detail or log files. A subsequent direct Apple `altool` upload at 21:56 India
  returned **90592, Invalid Export Compliance Code**. The IPA declares non-exempt
  encryption but contains no Apple-issued compliance code; Apple's API confirmed
  zero encryption declarations for CrewRoll at 22:05 India. Build 12 was **not
  accepted** and is not available to testers. See [the TestFlight record](testflight.md)
  for evidence and the required account-holder compliance decision.
- No TestFlight build was withdrawn, expired, or removed; no tester membership
  was changed. No update was sent to the native-incompatible 1.0.0 runtime.

## Remaining acceptance

The Mac locked during the earlier emulator pass. The final iOS manual-reopen copy
has unit coverage but has not been visually checked in the simulator after that
lock. Later direct Apple API/uploader access established build 12's TestFlight
compliance rejection without needing browser sign-in; the requested replacement
build 13 has since uploaded successfully and reached internal TestFlight testing.
Internal availability is not physical-phone acceptance or confirmation of the
export classification.

Physical five-phone stock-camera discovery, mixed-phone latency, long/poor-network
trips, physical Settings routing, and sign-out during real transfers still need
the acceptance pass in `speed-mvp.md`. Expo Doctor's SDK patch-alignment advisory
and Clerk development-instance limits remain; this is a testable internal MVP,
not a claim of production readiness or a completed store release.
