# CrewRoll speed MVP — September 10, 2026

This supersedes the September 9 transfer baseline. It is a hosted internal MVP;
physical five-phone acceptance is still required. Clerk remains a development
instance, and these are internal installs, not an App Store / Play Store release.

## What changed

- A verified preview is published before uploading the original. It does not
  create a saved receipt or permit early ciphertext deletion.
- iOS and Android each have two bounded native transfer lanes: small previews
  and bulk originals. A stalled original cannot occupy the preview lane.
- Foreground preview discovery/feed reconciliation runs approximately once per
  second when idle. A cursor advances atomically with durable queued previews.
  Reopening the app resumes pending work; this is not a background-delivery SLA.
- Android status/gallery reads no longer queue behind network transfers.
- The trip opens to photos and a compact crew row, with tappable previews,
  separate original-save status, and at most 24 mounted photo tiles per page.
- Only authenticated, integrity-verified local preview file URIs cross into JS.
  Preview pages include their trip identity to reject account/trip transition
  races. Partial decrypted files are never rendered. Expo Image caching is off
  for these protected native render files; sign-out removes the plaintext cache.
- Mobile data remains off by default. The user can explicitly enable it on the
  trip screen, then return to Wi-Fi-only. This preference is session-local.
- The existing Cloudflare Worker runs near the dedicated Seoul Supabase origin
  using `placement.region = aws:ap-northeast-2`. No new hosting, queues, databases,
  Redis, WebSockets, or Trigger.dev jobs were added.

Original byte verification, encrypted staging, idempotent retry, post-save
receipts, and the all-recipient/expiry cleanup boundary remain in place.

## Measured hosted transport result

The same synthetic test used five isolated member/device records, a 96 KiB
opaque preview, and a declared 12 MiB original that was **never uploaded**.
Each member retrieved its authenticated feed and downloaded matching bytes.
No original assets or receipts existed. All temporary R2 objects and database
records from the runs were removed; no real users or photos were involved.

| Trial        | Before database-near placement | After placement |
| ------------ | -----------------------------: | --------------: |
| First / cold |                        7.327 s |         4.616 s |
| Warm 1       |                        5.917 s |         2.737 s |
| Warm 2       |                        6.029 s |         2.367 s |

This measures upload-session creation → preview PUT → publication → all five
feed/download responses, from this Mac's network. It excludes stock-camera
discovery, on-phone preview generation/encryption, idle polling delay and display.
Three trials are not a p95 benchmark or a production load test. The original
blueprint's physical target remains preview p50 ≤3 s / p95 ≤8 s on healthy
foreground devices; **that target has not yet been measured on phones**.

Repeat only with explicit permission to create temporary hosted test records:

```sh
NODE_EXTRA_CA_CERTS=/private/tmp/crewroll-supabase-ca.crt \
CREWROLL_HOSTED_PROOF=SYNTHETIC_FIVE_MEMBER_PREVIEW_ONLY \
node --env-file=services/control-plane/.env --import tsx tools/hosted-preview-proof.mts
```

The probe checks the exact CrewRoll DB hostname, uses fresh synthetic IDs, and
deletes only its own object keys and rows. It never truncates a table. Do not run
the destructive integration-test harness against this hosted database.

## Real native emulator transfer check

The September 10 crash/recovery pass exercised real Clerk sign-in, trip creation,
joining/approval, native encrypted sharing in both directions and five-photo
offline catch-up. Source and saved-original checksums matched. In one additional
14.6 MB synthetic-photo run on the final signed Android APK, the verified preview
was available after 5.294 seconds and the exact original saved after 25.999
seconds. These are filesystem observations from two simulators, not UI-paint
timings or physical-phone percentiles. See [startup/recovery evidence](startup-crash-2026-09-10.md)
for artifact IDs, limitations and release links.

## Automated evidence

Current gates: 31 Swift tests, 29 Android native JVM tests, 140 PostgreSQL
integration tests, 755 contracts/server unit tests, and the full UI suite pass
(663 passed, one existing skipped). Tooling: 1,381 passed. Root and Worker
typechecks pass. Android assembled locally; both release-platform JS bundles
exported successfully. Both EAS internal builds finished; downloaded APK/IPA
signatures, new native preview engines, bundled gallery and live public
configuration were verified. Links and artifact hashes are in the setup runbook;
none of these gates substitutes for physical device acceptance.

Lint and the five-migration static safety check also pass. The topology policy
now explicitly admits the existing media repository, without widening it to
arbitrary DB directories. No database migration was added for the speed update.

Known release advisory: Expo Doctor passes 20 of 21 checks and reports 13 newer
SDK 57 patch versions. These internal builds retain the tested lockfile, rather
than silently suppressing that warning. Reviewed changelogs include an iOS
runtime-reload crash fix in [Expo 57.0.19](https://github.com/expo/expo/blob/sdk-57/packages/expo/CHANGELOG.md)
and image URL-error handling in [Expo Image 57.0.4](https://github.com/expo/expo/blob/sdk-57/packages/expo-image/CHANGELOG.md).
Android's offline startup recovery now explicitly reloads the same bundle and
was tested in the signed release. iOS instead explains manual close/reopen and
does not call the affected native reload path. The gallery renders verified local
preview files, not remote image URLs. Patch alignment and another native build
remain maintenance work before a store release; the
aggregate `npm run check` is not claimed fully green while Doctor warns.

- Android regression: with an original download blocked, the preview renders,
  no original receipt exists, and snapshot/gallery futures each resolve within
  a 250 ms timeout. Sender preview publication precedes original upload.
- iOS regression: a verified preview is available while the original download
  is suspended; sender preview publication precedes original upload.
- Both platforms: durable cache/cursor recovery, unpublished partial-file
  cleanup, expiry, original crypto verification, lost replies, and sign-out
  save barriers are tested. These use native crypto with photo/network fakes.
- PostgreSQL/HTTP test: five authenticated members download the preview before
  original upload; the original commit/save-receipt/cleanup path still passes.
- UI tests cover bounded gallery pages, opening a preview, mobile-data opt-in,
  rejected cross-trip pages and blocked-photo retry.

## First five-phone test

1. Use the new [TestFlight distribution](testflight.md) on iPhone once Apple has
   processed it; no device registration is required. Android uses the speed APK
   linked in `cloudflare-mvp-setup.md`. Use five distinct email-code accounts.
   Avoid the older baseline builds and iOS Ad Hoc links.
2. Create one trip, join using its invite, approve all members, allow full photo
   access, then Start. Every phone should show the same trip and crew.
3. Use good Wi-Fi, or explicitly choose “Allow mobile data” on each phone.
   Leave recipients in CrewRoll. Take one stock-Camera photo on the sender and
   return to CrewRoll. Time from return to preview on each recipient.
4. Confirm the preview opens before the original finishes. Then check each
   phone's system Photos/Gallery: the full original must really be present.
   “Saved on this phone” is not a claim that all five have saved it.
5. Rotate the sender through all five phones; send a burst of 10 photos each.
   Scroll/open previews while originals transfer. Record slowest preview time,
   last-original save time, duplicates, missing files and any UI stalls.
6. Interrupt one phone's network, restore it, and reopen CrewRoll. Verify it
   catches up once without duplicate saves. Repeat after force-close/relaunch.
7. Sign out during a transfer and sign into another account. No old trip preview
   may remain visible and no old-account transfer may acknowledge after sign-out.

Do not disable CAPTCHA or weaken verified-save/encryption checks to get a pass.
Continuous background delivery, real Clerk sign-in, device photo-library
permissions, and real mixed-platform latency still need this physical pass.
