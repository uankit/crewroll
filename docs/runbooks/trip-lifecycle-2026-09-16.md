# Trip home, personal pause, and departure

Implemented in the mobile UI, API, and both native transfer engines. The API and
additive PostgreSQL migration are deployed. **Emulator acceptance is deferred at
the user’s request after the Mac ran out of disk space.** The user freed space;
the final Android debug build completed successfully and the emulator is stopped.
The new binary has not been installed. Existing installed emulator binaries do
not implement the final-drain acknowledgement.

## Behavior

- Home shows current membership and past trips. Returning Home does not stop
  transfers. The database retains the one-current-trip rule while leaving.
- Personal pause stops sharing new captures. Incoming photos and queued work
  continue. Resume permanently excludes photos from the pause interval. The
  server stores these boundaries across restarts.
- Guests confirm **Finish syncing and leave**. Discovery stops at departure;
  their native engine completes its final discovery/upload pass. The server
  waits for queued originals' verified local-save receipts before releasing
  membership access and the active-trip slot.
- Separately confirmed **Leave now** waives unfinished delivery without inventing
  receipts. Staged originals remain available to other recipients until expiry.
- Only the host can end a trip. Ending freezes new capture and waits for each
  phone's final discovery pass, including offline phones. Each member departs
  after their downloads are verified. An earlier personal departure retains its
  fixed queue if the host ends afterward.
- No remaining participants ends the trip automatically. The host counts as a
  participant; all guests leaving does not end a host's ongoing trip.
- Hard expiry bounds offline waits, releases slots, and marks incomplete trips.
  Original scheduled end/hard-expiry timestamps stay intact.
- Saved originals remain in the phone photo library. Leaving cannot delete other
  people's saved copies. New grants stop after departure; existing short-lived
  signed object grants cannot be recalled before their expiry.
- Past rows currently open metadata and saved counts. An archived in-app photo
  browser is separate work; saved originals remain in the system library.

## Architecture

Native discovery creates durable work. Encrypted previews appear first. Original
ciphertext is staged with a delivery record per recipient. Recipients download,
decrypt, save, verify saved bytes, then acknowledge. Retries reuse durable IDs;
photo bytes and keys stay native. This is store-and-forward with per-recipient
receipts, not a broadcast with assumed delivery.

Account-authenticated users issue version-checked lifecycle commands. Device
background credentials can read capture boundaries and acknowledge final drain;
they cannot issue user pause, resume, leave, or end commands.

## Completed validation

- 598 control-plane unit tests.
- 54 PostgreSQL media/lifecycle/schema tests including migration down/up, plus
  28 trip-concurrency and two-account-room tests.
- Cleanup selects only trips whose scheduled end or hard expiry needs work;
  100 trips still waiting for offline phones cannot starve other trip deadlines.
- 161 mobile/application tests, including actual route navigation, confirmation,
  and stale-projection rejection during departure; four native-session fence tests.
- 54 Kotlin native tests and 41 Swift native tests: pause privacy, departure
  cutoff, drain ordering, save integrity, and noninterrupting Android activation.
- A capture rejected after a pause/departure race stays private without blocking
  the transfer journal or counting as a saved photo. Both native engines cover it.
- Android debug APK built successfully for arm64; it has not been installed/tested.
- 393 migration policy/tool tests. The static grammar was extended only for
  additive nullable timestamps and JSON arrays with a constant empty default.
- 37 mobile API generator tests, including both lifecycle methods on one route.
- App/API/Worker TypeScript and architecture lint passed.
- Hosted migration 006 applied with verified TLS; Worker version
  `66b1bfc0-807c-4559-8453-a02e4442e4bb`; readiness returned ready.

## Remaining acceptance

Install the updated native build preserving emulator data. Verify Home/back,
pause/resume with stock-camera photos, guest departure mid-transfer, host ending
with an offline guest, history/slot release, and creation of the next trip. Record
screenshots and save receipts. Physical Android/iPhone background acceptance is
separate and is not established by automated tests.

## Rollback

The implementation is a separate Git commit from the proposed continuity design.
Revert that implementation commit to restore the previous mobile UI/native code.
Keep additive migration 006 and its data in place on the hosted database; do not
run its destructive down migration against live participation history. Older
server/native builds do not enforce personal pause or departure, so a full service
rollback must first stop affected sharing sessions rather than silently resuming
captures that users paused. Figma canvas changes have a separate node changelog.
