# CrewRoll onboarding implementation and emulator evidence

Validated on September 16, 2026. This implements the approved Figma flow and the subsequent empty-gallery feedback. It is Android emulator acceptance for the flow described below; physical Android/iPhone acceptance and a new iOS app build remain separate work.

## Design and behavior

[Figma live gallery](https://www.figma.com/design/aJHBtfIOx8oc7BgbzbKJIa?node-id=31-220) uses the same Manrope, ivory, coral, sage, spacing, and light/dark tokens as the app. The existing screens were refactored rather than retaining a second onboarding implementation.

- Welcome → email account → verification → centered first-trip screen.
- Host: create trip → deliberate photo-access explanation and system permission → waiting gallery → copy invite code → approve guest → start trip.
- Guest: enter code → read-only trip preview with server-provided host/member names → ask to join → automatic approval wait → photo access → waiting gallery → automatic live gallery.
- No separate “ready for your trip” screen. Startup uses the quiet CrewRoll loading mark.
- The empty live gallery has the one-line hint **“Photos appear here automatically.”** immediately below the trip title. It has no placeholder tiles or empty-state card. The hint disappears when photos arrive.
- “Trip info” opens the trip name, sharing end time, active crew/host, and the Wi-Fi/mobile-data preference. Connection policy changes only after a deliberate tap.
- Filters replace the date in the gallery toolbar. Everyone or one member, a local calendar date, and newest/oldest order are supported. Native code filters the complete index before pagination; changing filters resets the cursor. Clear filters restores the full gallery.
- The waiting lobby retains one centered informational card. Invite actions copy a code, without a link/share alternative.
- The photo-access screen now says access can be changed in the phone’s Settings. It does not promise an in-app pause control that this design does not provide.

## Emulator setup and complete flow

Android AVD `CrewRoll_Startup_20260910`, `emulator-5554`, development package `com.uankit53.airmesh.development`. The existing release package and its data were preserved. Host Android user 0 and guest Android user 10 have separate app data, Clerk accounts, and MediaStore libraries. They share one emulator and were used sequentially in the foreground; this is not evidence of two physical devices or simultaneous background delivery.

The two QA accounts use Clerk’s test-email mechanism and verification code. The trip was **Goa weekend**, created and started through the real app against the deployed API. The following sequence passed:

1. Create host email account, reject an incorrect verification code, then verify successfully.
2. Create trip, grant photo access, open invitation, and copy code.
3. Create guest email account in the isolated Android user; look up the code and review the host/crew before requesting membership.
4. Host sees the request, approves it; guest automatically advances, grants permission, and reaches the waiting gallery.
5. Host starts the trip; guest automatically reaches the live gallery.
6. Capture a real new photo with the emulator’s stock Camera app, return to CrewRoll, then foreground the guest. The guest automatically receives and saves the original.
7. On the guest, the host filter shows the photo and “You” shows no match. September 15 shows no match; September 16 shows the photo. Clear filters restores Everyone/All dates.
8. Force-stop and cold-launch the guest. The same trip and one saved photo return, without a duplicate MediaStore save or another observed registration POST.

Screens were inspected at the normal approximately 411 × 914 logical size and at 360 × 640, in light and dark themes. The latest one-line hint fits the compact screen; filters scroll and the primary action remains reachable. Large-text accessibility and physical-device safe areas still need acceptance. The emulator’s development-menu gear was hidden through development preferences only.

## Exact photo-save evidence

The stock AOSP Camera package `com.android.camera2` saved the capture in `Pictures/`. This exposed a real discovery gap: the previous implementation watched only `DCIM/Camera/`.

Discovery now retains the existing DCIM rule and accepts the exact root `Pictures/` only when MediaStore attributes the image to a discovered system Camera package. The manifest declares the two narrow camera-intent queries needed for owner visibility. Downloads, screenshots, unknown owners in `Pictures/`, and received `Pictures/CrewRoll/` originals remain excluded. No in-app camera or broad package-query permission was added.

| Evidence      | Host original                                                      | Guest saved original                                               |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Android user  | 0                                                                  | 10                                                                 |
| MediaStore ID | 24                                                                 | 19                                                                 |
| Filename      | `IMG_20260916_110005.jpg`                                          | `crewroll-8dcc1d81-965a-43dc-85f3-61b0a3ab2c69.jpg`                |
| Folder        | `Pictures/`                                                        | `Pictures/CrewRoll/`                                               |
| Bytes         | 38,257                                                             | 38,257                                                             |
| SHA-256       | `c22ad0b17d4987d5cfb5c0166c266f47939fc907c120cdc866e31a99115b0b1c` | `c22ad0b17d4987d5cfb5c0166c266f47939fc907c120cdc866e31a99115b0b1c` |

The guest library query was empty before receiving the photo. The two `content read` outputs compare equal byte for byte, and the recipient still has exactly one image after cold launch. The image is the emulator’s synthetic camera scene. This verifies the actual local save, not just a thumbnail or HTTP success. Server staging expiry/cleanup was not independently re-observed during this UI pass.

## Startup and network behavior

Native credentials are restored only when account, installation, API base URL, persisted identity, and expiry match. Expiring/missing credentials renew the same device identity. Background bearer values stay native. Cold startup preserves valid credentials while transfer work is paused; sign-out/account transitions still clear session access. Concurrent provisioning is coalesced, and a failed native credential-install retry can reuse the successful registration response without repeating the POST.

Observed JS API trace: [network.jsonl](../../outputs/crewroll-implementation/network.jsonl). It stores request method/path/status only, without auth headers, tokens, or bodies. It contains two successful registration POSTs, one for each new QA account/installation, and no additional registration POST through the observed restarts and APK update. The observer was reattached after an Android-user switch; its earlier detached interval is not complete network coverage. Native photo-transfer traffic is outside this JS trace.

Startup still waits for authenticated account/device binding before account-scoped recovery and trip activation. Native snapshot and recovery reads run concurrently after binding. Gallery snapshot and asset reads also run concurrently and use invalidations with a bounded poll fallback. Single-flight reads coalesce concurrent requests; some transitions still issue sequential trip GETs for recovery/readiness/projection. This pass does not claim every sequential GET was eliminated.

The API’s authenticated `POST /v1/trips/invite-preview` is read-only and no-store. It checks the caller’s device, valid lobby invite, capacity, and active host/crew before returning only trip/public member information. The guest’s subsequent confirmation remains the membership mutation. The deployed Worker version for this pass is `e2e3d43f-7c5e-45eb-a755-16a4b1ee8c8a`; no database migration was required.

## Validation

- Android native JVM suite passed, including gallery-query and camera-source policy cases.
- Swift native suite: 37 tests passed, including restored credential and gallery-query cases. This is not an iOS app build or phone run.
- PostgreSQL invite-preview and media integration checks passed (14 tests).
- The Android APK compiled the latest Kotlin/manifest changes, installed as an update, and ran the complete emulator flow above. The final incremental build reused unchanged JNI outputs from the earlier successful full build.
- Final `npm run check`: app identity, formatting, lint, TypeScript, migration policy, production resolution, 1,381 tool/policy tests, 680 UI tests (one skipped), and 761 Vitest tests all passed. The command exits 1 at Expo Doctor: 20/21 checks pass, with the remaining check reporting 16 SDK 57 package patch mismatches. That failure is not suppressed.

## Remaining work

- Email-only accounts without an existing profile name currently appear as **CrewRoll member**. Add name collection in the account flow and confirm the Clerk profile configuration before accepting the named-crew experience.
- Exercise Google and Apple provider sign-in with configured provider accounts. Email signup and verification were exercised here.
- Align the 16 Expo SDK 57 package patch versions reported by Expo Doctor, rebuild native apps, and rerun native acceptance. These dependency upgrades were kept out of this visual pass.
- Physical Android/iPhone verification: system safe areas, large text, stock-camera ownership/path behavior, background/killed-app delivery, upgrades, and battery/network constraints.
- Verify end-of-trip delivery/expiry on physical devices separately. Existing protocol tests remain in place, but the first user flow above is not a substitute for that acceptance.

## Visual evidence

The screenshots in [outputs/crewroll-implementation](../../outputs/crewroll-implementation) cover welcome/account/verification, host and guest flows, trip info, filters, and receipt of the camera original. Obsolete intermediate empty-gallery screenshots were removed.

- [Centered first-trip screen](../../outputs/crewroll-implementation/04-first-trip-centered.png)
- [Guest lookup before joining](../../outputs/crewroll-implementation/11-trip-lookup.png)
- [Compact empty gallery, light](../../outputs/crewroll-implementation/18-compact-live.png)
- [Compact empty gallery, dark](../../outputs/crewroll-implementation/19-compact-dark.png)
- [Trip info](../../outputs/crewroll-implementation/15-trip-info.png)
- [Guest saved original after cold launch](../../outputs/crewroll-implementation/25-guest-saved-original.png)
- [Host member filter](../../outputs/crewroll-implementation/22-guest-host-filter.png)
- [Date excludes the real photo](../../outputs/crewroll-implementation/23-date-filter-empty.png)
- [Capture date includes the real photo](../../outputs/crewroll-implementation/24-date-filter-match.png)
