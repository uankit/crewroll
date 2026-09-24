# CrewRoll testing update — 25 September 2026

This continues [the 24 September release](release-1.0.4-2026-09-24.md). Public availability and the latest TestFlight availability must not be inferred from an upload or successful build.

## Changes

Source commit: `a800a77a448f506a8fbc4425a2b2b058d509696f`, pushed and verified on `origin/main`.

- A guest waiting for approval now enters the trip when approved. Entering checks and publishes existing photo permission, without requesting it again.
- An interrupted readiness mutation replays its saved command before making a new one. A newer server projection is preserved. Temporary failures retry while the trip is visible, pause in the background, and resume on return; only an explicit tap opens a permission prompt.
- Lobby join requests appear alongside the crew with approve/decline controls and a row-specific failure message. The notification sheet retains join requests after the trip starts.
- Android uses the native stack transition. Back from an invite preview returns to code entry, and Back from the photo explanation returns to the lobby.
- Android module startup and background-job session restoration now run on a serial worker queue instead of the UI thread. Android fonts are included in the native binary, and font loading cannot keep the native splash visible indefinitely.

The Samsung S26 is not attached. These changes address identified startup blockers, but do not establish that the reported one–two minute delay is resolved on that physical phone.

## Verification

- 35 focused suites / 563 tests passed: trip commands, bootstrap/session behavior, permissions, invitation and lobby screens, and actual Expo Router navigation.
- TypeScript, scoped ESLint, identity verification and `git diff --check` passed.
- The existing pure JVM native suite passed from cache. It excludes the changed Android platform classes; the successful Android build 8 compiles those classes. iOS build 20 also compiled successfully.
- Android build 8 was installed over the existing signed app without uninstalling. Its account session and granted photo permissions were preserved. The iPhone simulator uses the production API with the current development binary and JavaScript; this is not a physical TestFlight acceptance test.
- Both host directions passed: the host approves inline in the crew list, the waiting guest automatically enters the lobby, both members become Ready using existing permission, and starting the trip updates both phones without reopening. The lobby heading fits one line at normal text size.
- Back from Android's invitation preview preserves the entered code. The trip sheet and gallery return to the expected preceding screen.
- Three force-stopped Android launches reached a populated Home screen within 5.828, 4.936 and 4.728 seconds, including ADB/UIAutomator observation overhead. Android Activity launch times were 337, 278 and 274 ms; these are not full app readiness times. The Android crash buffer contained no entries.
- A new photo taken with Android's stock Camera app during the Android-hosted trip was discovered, shared and saved to the iPhone Photos library. The 36,713-byte source and saved original have identical SHA-256 `dddbccceec97b5ad4599c1145feaa250245cb4a1d4640a4ecd693dbbc847bf3967`. The UI on both phones reports Saved. An older imported fixture remained excluded by its capture date.
- A separate late-join trip passed the timing boundary: a request sent after the trip started appeared in the Android bell sheet; approval automatically opened the active trip on iPhone. The photo taken before approval was absent from that iPhone trip. A new photo taken after approval was saved there, with source and saved-original SHA-256 `7c934dfad4a14195dd3a593af8cf26d1ff3a13125fc4783d7b2ebae77efdc390` (38,839 bytes). Android displayed two saved photos, iPhone one, as intended.
- Ending trips preserves their saved-photo counts in history. Reopening Android preserves its session and trip history. These checks do not establish OEM-specific background scheduling or physical gesture smoothness.
- Actual Android screenshots were captured from build 8 at a native 1080 × 1920 viewport, without compositing or altering the UI. The ATD emulator's drawing setting had to be enabled before screenshots could render.
- Both OTA bundles use the production API and production Clerk key. Neither contains the beta API or either private reviewer credential.
- Both live Expo channel manifests returned HTTP 200 and the update IDs below.

## Distribution

| Destination | Identifier | State |
| --- | --- | --- |
| Android OTA, production, runtime 1.0.4 | `01a0d544-5cec-718c-ace2-d79d3d61f325`; group `356a182c-e10b-4f63-94bf-290f82179d5b` | Published and served |
| iOS OTA, testflight, runtime 1.0.4 | `01a0d545-1a71-7480-9613-04fdd869760d`; group `6ef8f960-4f5d-4431-9fed-65b6b172d80f` | Published and served |
| Android 1.0.4 (8) | EAS `fbed5c4c-9bb4-4682-8eaa-f0cdddf79728`; Play internal release 3 | Available to internal testers; verified in Play Console, 25 September at 03:23 IST |
| iOS 1.0.4 (20) | EAS `c9a6acf5-364c-4c5d-a895-8d17345fd923`; Apple build `c32d49ce-79e0-4d03-94b2-b26f9a139041` | Uploaded and processed VALID; internal and external status MISSING_EXPORT_COMPLIANCE |

Android bundle: `/Users/uankit/Developer/CrewRoll-1.0.4-8.aab`, 90,343,760 bytes, SHA-256 `dc0248258953d34c325746fdd1dfc134f5c3e48789f33a77959554092c0da9b3`. Bundletool validation, ZIP integrity and signature verification passed. Its manifest retains `com.uankit53.airmesh`, version code 8 and target SDK 36. Play reports unchanged supported-device counts and no blocking release errors; its only warning is the absence of an optional deobfuscation file.

The owner uploaded the AAB manually. Build 8 was selected from the Play artifact library, added to internal release 3, reviewed and published. The existing tester list has two addresses and remains selected. Testers use the same [internal-test link](https://play.google.com/apps/internaltest/4700971440071305397).

iOS submission `df03d401-ec8f-44e1-95ad-c5b464cdce59` finished successfully. Apple's API confirmed the processed/export-blocked state at `2026-09-24T21:57:55.799Z`. Build 20's What to Test notes are saved and verified. It has not been added to a tester group or submitted for latest beta review while export compliance is unresolved. The public TestFlight link must not be described as serving build 20.

The Android native startup changes require the new binary. Existing build 6 can receive the JavaScript fixes through OTA. The initial Android attempt reserved code 7 but failed locally because disk space ran out. Disposable dependency caches, old exports and a duplicate old AAB were removed; source, credentials and simulator data were preserved. The initial iOS build 19 failed with Expo's `CREDENTIALS_TEMPORARY_NETWORK_ERROR`; the retry is build 20.

## Store setup

- The owner explicitly approved saving the two dedicated reviewer credentials in both stores. Google now has separate host and guest instructions; the public App Store 1.0.4 review form also has verified private credentials. The older build 16 beta-review instructions remain unchanged while it is awaiting review.
- The owner selected adults 18+ for the initial release. Google Target Audience is saved.
- Google Data Safety is saved, including all ten previously audited collected data types, encryption in transit, and the account-deletion URL. Google's optional separate data-deletion facility is not claimed.
- The app name is saved as **CrewRoll: Shared Trip Photos**. Play explicitly states that the package-derived temporary name remains until initial setup and review complete. Renaming the immutable Android package is not required.
- The Chrome upload API still returns `Not allowed`. The owner chose manual uploads. Public upload assets are staged in `/Users/uankit/Developer/CrewRoll-store-assets`: `01-play-icon.png`, `02-feature-graphic.png`, `03-create-trip.png` and `04-invite-your-crew.png`. The last two are actual 1080 × 1920 Android screenshots. Credentials are kept in a separate protected directory.
- Google confirms 10 of 11 setup tasks complete. The missing task is the store listing, which needs its images uploaded and saved before review can be submitted. All prepared listing text is saved as a draft.
- Apple export compliance remains unresolved under support case **102974597698**. Replies go to the email used for the support request. No new exemption or export classification has been asserted.
- Google requires a closed test with at least 12 opted-in testers for 14 continuous days before applying for public production access. The internal-test link is not that closed test.

## Remaining work

Finish the manual Play listing image upload, then complete the listing and submit initial review. Configure the closed test once Google unlocks that step; the current internal test does not start the 12-tester/14-day requirement. Complete iOS export compliance and latest beta-review submission when Apple's response provides the required basis. Public App Store screenshots, territory availability and applicable owner declarations remain distinct from beta testing. Retest the reported repeated-launch delay and gesture feel on the physical Samsung S26.
