# Mid-trip joining, recovery, and background sync

Implemented September 16, 2026 in the mobile screens, API, PostgreSQL migrations,
and Android/iOS native transfer engines. Emulator testing remains deferred at the
user's request. Automated checks and native builds do not establish physical-phone
background reliability or production security acceptance.

## Implemented product behavior

| Event                                               | Behavior                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A guest arrives mid-trip                            | The host's code stays available in Trip info. The guest sees the trip, host and members, requests access, waits for host approval, then completes photo access.                                                                                                                |
| Host approves                                       | The approval timestamp is the guest's eligibility cutoff. Only captures at or after it are shared in either direction, even if an earlier photo uploads later.                                                                                                                 |
| Same account signs back in on the same installation | Reuse protected device credentials, trip keys and durable transfer IDs. Resume eligible unfinished work without consuming another participant slot.                                                                                                                            |
| Approved member reinstalls or replaces their phone  | Request device approval. The host or their previously connected phone approves; an active trusted member can approve a host's replacement. Keep the membership and incoming-photo cutoff, revoke the old installation, and reissue deliveries for retained eligible originals. |
| A pending guest reinstalls before approval          | Move the unapproved membership to their authenticated new installation. No trip key or photo access is granted; normal host approval is still required.                                                                                                                        |
| Recovery request is rejected or superseded          | Explain that approval was not completed and allow an explicit new request. A fresh request ID prevents an old approval from approving the new request.                                                                                                                         |
| Trip ends during recovery                           | Stop offering phone approval. Saved originals remain in the system photo library.                                                                                                                                                                                              |
| User taps Sync now and switches apps                | Continue eligible work through OS-managed jobs/transfers when permitted. Preserve durable work on interruption. Wi-Fi is the default; mobile data requires opt-in.                                                                                                             |
| User returns Home                                   | Show current membership and past trip metadata. Navigation does not stop syncing. Only one current membership is permitted, including while finishing a departure.                                                                                                             |

Personal pause, finish-sync departure, explicit immediate departure, host ending,
and automatic ending after everyone leaves remain as documented in
[trip lifecycle](trip-lifecycle-2026-09-16.md).

The gallery uses the CrewRoll theme and a real photo grid with person/date filters.
Its empty state is a centered headline and short explanation; there are no fake
photo placeholders. Invite cards use Copy code. The permission, pending approval,
recovery and error screens are connected to real state rather than mock navigation.

## Server and storage

- Invite lookup, request, approval and readiness now work in LOBBY and ACTIVE.
  ENDING, expired and terminal trips reject new participation. Starting a trip no
  longer revokes its invite.
- Owner invite persistence is separate from ordinary trip projections. The code
  is encrypted with authenticated encryption and trip-bound associated data; only
  the authenticated current host can retrieve it. The key is domain-separated
  from the existing invite HMAC secret. No new deployment secret is required.
- `GET/POST /v1/trips/{tripId}/continuity` provides owner invite persistence,
  account/device recovery requests, approval and rejection. Mutations use the
  trip version, authenticated account/device checks, and transaction locks.
- At most one pending replacement exists per membership. Resolved command replays
  do not perform a second replacement. Pending approval never grants media access.
- Migration 007 adds capture timestamps to upload sessions and assets for policy
  enforcement. Encrypted manifests remain encrypted; capture time is now explicit
  server-side eligibility metadata. Legacy rows are not assigned invented times.
- Capture eligibility is checked during native discovery, server upload admission,
  preview fan-out, direct preview grants and original fan-out. A replacement phone
  discovers only captures after its device approval, while eligible retained
  incoming photos retain the original membership cutoff.
- Migration 008 stores encrypted owner invites and device requests. Historical
  media/envelope references point to immutable device identities rather than the
  membership's replaceable current phone. API checks still require the authorized
  current member/device.
- Replacement revokes the old device credential and its unfinished delivery
  grants. Old SAVED receipts stay historical; they do not count as saves on the
  new phone. Each eligible retained original gets a new device-specific receipt.
- If an object upload succeeds but its response is lost, retry verifies the remote
  object's length/checksum and returns its ETag. Both native engines reuse that
  object instead of getting stuck on a repeated create-only upload.

## Native background work

Android uses one process-wide engine/journal writer shared by Expo and JobScheduler.
MediaStore content changes trigger capture work; persisted 15-minute periodic jobs
provide a process/reboot fallback. Sync now uses a user-initiated transfer job with
an ongoing notification on Android 14+, and a bounded ordinary job on older
versions. Network policy and low-storage scheduling constraints apply. Overlapping
jobs share the worker instead of cancelling each other's transfer. Credentials,
trip keys and image bytes never cross into a JavaScript background task.

On iOS, file-backed encrypted uploads/downloads use background URLSession. Launch
callbacks reconnect existing sessions and recover completed ciphertext. BGProcessing
runs bounded native discovery/reconciliation work; foreground-started work gets a
short background checkpoint window. Expiration does not erase the journal or turn
an HTTP download into a saved-photo receipt. Temporary transfer files contain
ciphertext, are excluded from device backup and are cleaned up after retention.

Discovery, ciphertext transfer and verified saving are separate stages. Only a
verified original saved into the system photo library is acknowledged as SAVED.
Recognizable existing system-library originals are hash/length checked before a
replacement download is acknowledged, reducing duplicates after reinstall.

The OS controls scheduling. This release does not promise instant stock-camera
sharing after force-stop/force-quit, nor continuous execution while suspended.
There is no new push-triggered wake protocol. Android periodic fallback and iOS
background processing timing must be measured on physical phones.

## Recovery limits and security boundary

CrewRoll remains ciphertext-only temporary staging, not permanent photo backup.
Recovery can redeliver retained COMMITTED originals that this membership is
eligible to receive. Cleanup and replacement serialize on the trip. Already
purged/expired ciphertext cannot be restored by signing in. Originals saved in the
system library remain there, but a lost encrypted manifest can prevent rebuilding
an old in-app gallery index. A host with no surviving trusted phone/member cannot
recover a lost trip key through email authentication alone.

The existing format uses a shared epoch-1 trip key. API and native capture cutoffs
restrict ordinary access, and revoked phones cannot obtain new grants. However,
this is **not cryptographic forward secrecy**: a member who retains that key and
independently obtains ciphertext can still decrypt it. Membership-driven key
rotation, multi-epoch native journals/envelopes and recovery-key backup are not
implemented in this checkpoint. Do not market those guarantees or mark the
production security gate complete. Existing short-lived signed URLs also remain
valid until their expiry after departure/replacement.

Past Home rows currently show trip metadata and saved counts. Saved photos remain
in the system library; a complete archived in-app gallery and permanent restore
service are separate features, not hidden promises of this implementation.

## Validation and deployment evidence

See [continuity implementation acceptance](sync-continuity-acceptance-2026-09-16.md)
for exact checks, build outputs and deployment identifiers. The emulator remains
stopped and the new APK has not been installed. No physical Android/iPhone
background acceptance is claimed.

The existing Figma checkpoint remains available for comparison and rollback:
[trip lifecycle and continuity](https://www.figma.com/design/aJHBtfIOx8oc7BgbzbKJIa?node-id=123-243).
The seven continuity references cover host invite/requests, live-trip preview,
waiting approval, the first shared roll, returning sign-in, replacement-phone
confirmation, and pending device approval. Returning same-phone sign-in resumes
Home directly rather than adding a redundant confirmation screen.

## Rollback

Use the separate Git implementation checkpoint to revert app/API code. Preserve
native journals, device keys and installed app data. Do not downgrade the live
schema or delete participation history as a UI rollback. Migration 008's down
transaction intentionally fails safely if device replacement has created history
incompatible with the previous foreign keys. Older apps also lack sender-device
recovery envelopes and capture cutoffs: a service rollback must stop affected
sessions rather than silently enable an older, weaker sharing policy.

## Remaining physical acceptance

Late joining: three devices, captures on both sides of approval, late uploads,
pauses, host offline, duplicate approval, invite expiry and membership removal.
Recovery: sign-out/in, process death at every transfer stage, reinstall, a new
phone, an unavailable host, already-saved originals and expired ciphertext.
Background: stock camera while another app is open, lock screen, battery saver,
OS suspension, force-stop/force-quit, reboot, Wi-Fi/cellular changes, denied photo
permission, low storage and scheduled trip end. Measure capture-to-preview and
capture-to-verified-save latency separately.

## Primary references checked September 16, 2026

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [Android transfer jobs](https://developer.android.com/develop/background-work/background-tasks/uidt)
- [Android JobScheduler](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Apple background downloads](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)
- [Apple Background Tasks](https://developer.apple.com/documentation/backgroundtasks)
