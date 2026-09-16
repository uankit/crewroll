# Trip lifecycle acceptance and rollback

Implementation checkpoint: `ed6b56f` on `codex/crewroll-greenfield`.
The subsequent [continuity implementation checkpoint](sync-continuity-acceptance-2026-09-16.md)
adds mid-trip joining, replacement-phone recovery and native background work.
The evidence below remains specific to the earlier lifecycle checkpoint.
The API and additive migration are deployed; the Android debug build passes.
**Emulator acceptance is deferred at the user's request.** No row below is marked
accepted by an emulator or physical device. Figma checks establish prototype
navigation and layout only.

Use the Figma node map in
`outputs/crewroll-trip-lifecycle/figma-design-state.json` for the matching screens.
The lifecycle and continuity sections have separate Figma checkpoints.

## Run one path at a time

| Path                     | Action                                                                                              | Acceptance evidence                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home and back            | Open the current trip, return Home using the header and Android back, then reopen.                  | One current trip; past trips listed; no second-trip creation while membership is current. Returning Home does not pause native sync.                                                                 |
| Personal pause           | Guest pauses, takes a stock-camera photo, receives a host photo, resumes, then takes another photo. | The paused-period photo stays private even after resume. Incoming and previously queued photos finish. The post-resume photo reaches the other phone with a verified save receipt.                   |
| Cancel departure         | Choose Leave trip, then Stay in trip.                                                               | Membership, capture eligibility, and the current-trip slot remain unchanged.                                                                                                                         |
| Finish syncing and leave | Begin sending/receiving an original, confirm departure, and wait.                                   | New discovery stops at the cutoff. Queued originals finish and are verified locally before membership is released. Home eventually shows the past trip; saved originals remain in the phone library. |
| Leave immediately        | From departure progress choose Leave now instead, inspect the warning, then confirm.                | Unfinished delivery is waived, never marked as a successful save. Other recipients can still finish their existing deliveries.                                                                       |
| Host ends                | Keep a guest offline with an eligible photo; host ends the trip. Reconnect the guest.               | Only the host can end for everyone. The trip remains Finishing until the final discovery and receipt work completes or expires. Photos taken after the cutoff are not shared.                        |
| Earlier departure        | A guest begins departure, then the host ends.                                                       | The earlier guest keeps its original fixed queue and is not enrolled in the later whole-trip final-photo wait.                                                                                       |
| Everyone has left        | Finish all member departures.                                                                       | The trip becomes terminal automatically and each user's current-trip slot is released. The host counts as a participant. A forced or expired incomplete departure is not shown as fully synced.      |
| Start the next trip      | After verified departure, create a new trip.                                                        | New trip gets its own keys/journal and photo-readiness state. A delayed old-trip response cannot reactivate the old trip.                                                                            |
| History                  | Open a past-trip row.                                                                               | Metadata and saved count are shown. This version does not promise an archived in-app gallery or restoration from expired ciphertext.                                                                 |

For each accepted path, keep a screenshot, the relevant membership/transfer state,
and per-device save receipts or file hashes. API success and an image preview alone
do not establish original-photo delivery.

## Resume device testing later

- Install `android/app/build/outputs/apk/debug/app-debug.apk` over the existing
  development app, preserving its data; do not uninstall or reset the AVD.
- The emulator is currently stopped. Existing installed binaries predate the final
  drain protocol. Restart Metro and the emulator when device testing resumes.
- Run Home/back and personal pause first, then guest departure, then host ending.
  Keep a separate test trip for destructive departure cases.
- Real Android and iPhone acceptance is required for suspension, force-stop,
  stock-camera use while in another app, permission changes, and low storage.
  The proposed OS background-transfer work is not part of this checkpoint.

## Revert the implementation without losing the design

The lifecycle implementation and design/continuity artifacts are separate commits.
Revert `ed6b56f` on a clean working tree to restore the earlier app implementation;
retain the design commit for comparison. The Figma node changelog records its own
canvas undo scope. No duplicate app screens or backup implementation was added.

Keep hosted migration 006 and its data. A server/native rollback must first stop
affected sharing sessions: an older engine does not know personal pause or final
drain rules. Do not silently restore an older sharing policy over a user's paused
or departing session. See `trip-lifecycle-2026-09-16.md` for deployment evidence and
`sync-continuity-design-2026-09-16.md` for the implemented follow-up and its limits.
