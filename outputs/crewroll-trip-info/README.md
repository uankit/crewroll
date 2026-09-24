# Trip info and automatic networking — September 16, 2026

## Implemented

- Trip info contains dates, a compact host invite-code row, named crew members,
  personal pause/resume, and host End trip or guest Leave trip, without the pause
  helper line. Existing
  confirmations and conditional join/device approvals remain intact.
- Sync now appears only on the main trip gallery. It shows queued-photo counts,
  prevents duplicate taps, retries blocked work, and keeps the gallery visible
  if a manual attempt fails. It does not resume personal sharing or change
  network policy.
- Both native engines activate with cellular access allowed. Background runtime
  preferences migrate away from the retired Wi-Fi-only choice once, without
  enabling a signed-out session or replacing keys, credentials, or journals.
- Existing Figma host, guest, paused-info and live-gallery designs were updated
  in place. No duplicate app routes or replacement screens were added.

## Verification

- 51 focused UI tests passed; the 12 gallery tests passed again after adding the
  queued-count label. TypeScript, scoped ESLint, and git diff whitespace checks passed.
- Android native transfer-engine tests: 12 passed. Swift native engine tests:
  10 passed. These include the automatic-network transition and sign-out fences.
- iOS bridge/background source syntax parsing passed. A full new iOS app build
  and physical-device acceptance were not performed for this change.
- Android debug build succeeded (584 tasks), then installed over the existing
  emulator app with `adb install -r`. Host account and Testing trip were preserved.
- The running native snapshot confirmed cellularAllowed=true, paused=false,
  no blockers. Scheduled periodic/photo jobs required internet without an
  unmetered-network restriction.
- Disabled emulator Wi-Fi, confirmed its cellular network became the default,
  tapped Sync now, and verified the user-initiated sync job used network 100
  (cellular). No sync error appeared. Wi-Fi was restored afterward.
- Reviewed actual emulator screenshots and the updated Figma renders. The trip
  remains empty; this check does not prove multi-account photo-byte delivery or
  physical background delivery. That planned end-to-end test remains separate.

## Platform references

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), read before editing.
- [Android network permissions](https://developer.android.com/develop/connectivity/network-ops/connecting):
  the existing INTERNET and ACCESS_NETWORK_STATE manifest permissions are granted
  at installation; this change does not need a new runtime network prompt.
- [Apple cellular access](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/allowscellularaccess)
  and [connectivity waiting](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/waitsforconnectivity).
  OS network restrictions and background scheduling still apply.

## Screenshots

- `01-gallery-sync.png`: main gallery with the sync action.
- `02-cellular-sync.png`: gallery after sync on emulated cellular.
- `03-trip-info.png`: simplified host sheet, with no sync/network controls.
- `figma-*.png`: corresponding host and gallery design captures.
