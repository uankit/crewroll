# Mid-trip joining, recovery, and background sync

Status: implementation plan for the next flow, after lifecycle emulator acceptance.
These capabilities are not yet implemented or accepted as production-ready.

## Product rules

| Event                                                    | Recommended behavior                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New guest arrives during an active trip                  | Host can always find and copy the invite in Trip info; guest previews the trip, requests access, grants photo access, and waits for host approval.                              |
| Host approves                                            | Server records an immutable approval cutoff. Only photos captured from that cutoff onward are eligible in either direction. Never share the newcomer's earlier camera roll.     |
| Guest resumes their existing membership after signing in | Keep the original cutoff and delivery identities; resume missing work without duplicating saved originals or consuming another member slot.                                     |
| App is reinstalled or phone replaced                     | Authenticate the account, detect missing device keys, and enter explicit device recovery. Do not silently assign the old device's credentials or claim all photos are restored. |
| User taps Sync now then switches apps                    | Continue eligible queued work using OS-supported background transfers, show honest progress, checkpoint interruptions, and resume when allowed.                                 |
| Trip ends                                                | Stop discovery at the end cutoff, finish the fixed eligible queue, retain already saved local photos.                                                                           |

The habit should come from seeing friends' views and revisiting the trip gallery.
Blocking delivery to force app opens would weaken CrewRoll's promise.

## Current implementation gaps verified in code

- `requestJoin` and invite lookup are lobby-only; approval policy also freezes the
  roster after start. The active gallery hides the invite action.
- Current epoch-1 trip key is shared among approved members. API access gates can
  prevent historical downloads, but sharing one key is not cryptographic forward
  secrecy. Production late admission/removal requires an explicit key-epoch model.
- Account trip history is now server-backed. Membership still nominates one
  participating device. Reinstall is not a valid continuation of the old identity.
- Native journals recover interrupted transfers. Android uses ContentObserver
  and process-local workers; there is no WorkManager/JobScheduler task. iOS uses
  ephemeral URLSession, not background URLSession. Suspension/process death must
  be covered separately from foreground operation.

## Server and crypto work

1. Permit invite lookup/request/approval in ACTIVE, reject ENDING/terminal trips,
   keep one-current-trip and capacity rules, and provide a host invite rotation
   path. Preserve the existing code on ordinary navigation/relaunch; do not store
   raw reusable invite codes in the ordinary server trip response.
2. Store membership intervals and a server-authoritative `sync_from` cutoff.
   Apply it to source discovery, upload validation, preview feed, direct preview
   grants, original fan-out, and recovery. Checking only the gallery UI is unsafe.
   Delayed uploads use capture time, not arrival time. Test clock skew explicitly.
3. Define epoch transitions at admission/departure, with per-device key envelopes
   and the correct epoch persisted in native upload journals. Removed members
   never get future epoch envelopes. Authorized old queued work drains under its
   original epoch. Retry and rollback tests must cover partial key distribution.
4. Give users a stable membership independent of installations. Device replacement
   is an authenticated, idempotent command: approve the new key, retire old grants
   and bearer access, fence old workers, and recreate eligible missing deliveries
   without re-counting a participant or expanding their historical access.
5. Store device-specific save receipts separately from account photo availability.
   A previous device's SAVED receipt cannot prove a replacement phone has a copy.

## Recovery is a separate promise

Signing out should stop account activity and clear credentials/rendered private
content, while preserving protected account-scoped journals and keys according to
retention policy. Signing back into the same account resumes the same work.

Reinstall may remove private keys and journals, especially on Android. First
reconcile recognizable originals still in the system photo library; validate
content before acknowledging or recreating delivery. Rebuild the app index from
an encrypted manifest with stable asset identifiers, not filenames alone.

For missing keys, the initial safe recovery path is approval by an existing trusted
device/host. A host with no surviving trusted device needs a separately designed
recovery key or encrypted account backup. Email authentication alone cannot decrypt
end-to-end encrypted photos. Recovery also needs retained ciphertext or a consenting
member's re-upload. Once every copy and retained ciphertext is gone, restoration is
impossible.

The current ciphertext-only, hard-expiry staging promise stays unchanged. Permanent
cross-device photo backup would be an explicit additional storage/retention product,
with recovery-key UX, deletion behavior and costs decided before implementation.

## Background implementation

- Android: persist jobs with WorkManager for deferred recovery; use an appropriate
  user-initiated data-transfer job for explicit Sync now on supported versions,
  with progress notification, cancellation, network policy, and a bounded fallback.
  A dataSync foreground service is not an unlimited trip-long daemon.
- iOS: stage encrypted files for background URLSession uploads/downloads, reconnect
  delegates after relaunch, and schedule discovery/reconciliation with Background
  Tasks. BGContinuedProcessingTask can continue an explicit user-started batch on
  supported newer OS versions; handle expiration and cancellation.
- Separate discovering a new stock-camera photo, transferring ciphertext, and
  decrypting/verifying/saving it. A completed HTTP download alone is not a saved
  original; completion waits for the local verified receipt.
- UI states: Up to date, Syncing N photos, Waiting for Wi-Fi, Sharing paused,
  Photo access needed, and Open CrewRoll to finish. Never silently discard work
  when the OS stops a task, permissions change, or the device runs out of storage.

## Acceptance gates

Late guest: three devices, photos on both sides of approval cutoff, late uploads,
pauses, host offline, duplicate approval, invite expiry, and membership removal.
Recovery: sign-out/in, process death during each transfer stage, uninstall/reinstall,
new device, unavailable host, lost recovery key, already-saved originals, expired
ciphertext, and malicious/stale device commands.
Background: real Android and iPhone; stock camera while using another app, lock
screen, battery saver, app suspension, force-stop/force-quit, reboot, Wi-Fi/cellular
changes, revoked photo permission, low storage, and scheduled trip end. Measure
capture-to-preview and capture-to-verified-save latency separately. Emulator results
cannot establish OEM/iOS background reliability.

## Primary references checked September 16, 2026

- [Android transfer jobs](https://developer.android.com/develop/background-work/background-tasks/uidt)
- [Android foreground-service time limits](https://developer.android.com/develop/background-work/services/fgs/timeout)
- [Apple continued processing](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados)
- [Apple background downloads](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)
- [Google Photos iPhone backup guidance](https://support.google.com/photos/answer/6193313?co=GENIE.Platform%3DiOS&hl=en-GB): even a mature backup app documents foreground guidance for best results; do not claim stronger unconditional behavior without device evidence.
