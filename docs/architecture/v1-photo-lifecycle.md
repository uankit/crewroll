# First-beta photo ownership, recovery and albums

Status: trip-album implementation and independent source review complete;
combined native compilation and installed-device acceptance are separate gates.
This builds on startup candidate 890c897. The owner chose received originals in an Android trip album, with
camera originals left in Camera and no extra copies or move prompts. No change
to server retention, history expiry or cloud deployment is included.

## Product contract

CrewRoll supports one ongoing trip participation per account, including setup
and finishing sync. Each distinct eligible capture is delivered automatically
to the other participating devices. Separate captures stay separate even if
their bytes match. A retry must reuse an already verified save of that capture.

Users do not need a second download step. Received originals are verified and
saved into the system photo library. They remain there after leaving a trip,
expiry of CrewRoll recovery material, or deletion of CrewRoll's local cache.
CrewRoll must never remove a saved original or a user's album as part of its
retention cleanup. The person's Photos/iCloud/Google Photos settings govern
their own library and backup.

This is not a zero-storage transport. The source encrypts photo data before
upload; a temporary encrypted relay lets other phones receive it while they
are offline or suspended. CrewRoll does not maintain a readable cloud photo
archive. Temporary staging and smaller previews also consume phone storage
while delivery is in progress.

## Keep the lifetimes separate

| Data                                | Role and lifetime                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Current trip                        | Capture eligibility, membership, host approval and end/leave decisions                                            |
| Transfer recovery                   | Keys, unfinished transfers, verified save references and receipt recovery until the existing deadline             |
| Temporary server bytes              | Eligible for retirement after confirmed delivery; hard expiry remains independent of whether every phone finished |
| Recent trip status                  | Small name/date/count/completion summary; no image bytes or private key is required to display it                 |
| System-library originals and albums | User-owned; survive CrewRoll cleanup                                                                              |

The existing recovery deadline is scheduled trip end plus seven days. An early
End tap does not currently shorten it. End stops new captures and enters
finishing sync; an offline member may still have eligible earlier captures to
upload. Deleting keys or the journal at End would lose that recovery path and
could lose knowledge of an already saved original whose receipt was interrupted.

Current trip history has no expiry. A small seven-day Recent trips panel is a
reasonable product follow-up, but hiding a card is not deletion of the database
graph or permission to destroy unfinished transfers. Its expiry clock and
backend metadata policy must be decided explicitly. This implementation does
not silently introduce either policy.

The hundreds of keys used by the startup regression are isolated synthetic
fixtures. They do not imply that a real single-trip phone should accumulate
hundreds of retained secret keys.

## Trip albums

- Android: newly received originals use a per-trip MediaStore directory. A full
  trip UUID is a hidden parent path component; the visible bucket basename is a
  sanitized trip name and date. The first chosen destination is durable and
  remains stable across retries and name changes. Camera originals stay in
  Camera. Only app-owned received originals in a known CrewRoll location may be
  moved during organization repair; a user-moved file is respected.
- iOS: a trip's durable PhotoKit album identifier groups existing assets.
  Received originals and eligible own-camera assets can be added by reference,
  without creating another photo asset. A Photos album is not an exclusive
  directory: the same asset can also appear in Library or Recents.
- No album operation may create another original, collapse distinct captures,
  claim an unverified save, or prompt to move the user's camera originals.
- Existing full-library sharing permission is still required for this
  implementation. Account and trip browsing stay available when permission is
  insufficient. Album work must not add another startup gate or permission prompt.

## Module boundaries

The native photo-library port owns exact original save and readback verification.
The transfer engine owns upload/download work, durable save identifiers and
server receipts. A separate album organizer owns trip-to-album identity,
membership and organization retry. Small presentation records contain no image
bytes or private keys.

The optional importAndActivateTripWithAlbum command adds bounded trip
presentation to the existing validated composite. Registration occurs only
after authenticated key import and before activation. Trip names are kept out
of the cryptographic envelope, AAD and frozen activation metadata. Existing
binaries use the prior path only when the new native capability is absent.
Present protocol or activation failures never trigger a legacy fallback.

Valid names are well-formed, trimmed Unicode with one to eighty code points,
matching the server contract. Platform display/path sanitization is a separate
step. Native folder names must have a bounded UTF-8 length and cannot interpret
a trip name as a path. Cosmetic names never authorize a trip or select a key.

Original delivery and album organization have separate completion states. A
saved original can be receipted while its album membership needs repair. Album
failure is visible as PENDING or FAILED organization status and can be retried
without saving another original. The dedicated local retry preserves original
transport backoff and never invokes upload, download or saved-receipt replay.
It carries the caller's account/selection fence through queued work and local
continuations. Its UI is unavailable while sharing is paused.

Android repair inspects destination metadata first; it reads authenticated
original bytes again only when a legacy original actually needs moving. iOS
membership uses batches of at most sixteen asset references and one durable
completion checkpoint per batch. Known missing assets remain failed without
starving later valid assets.

## Upgrade and recovery invariants

1. Resolve the journaled saved identifier first and verify the exact expected
   bytes/hash. Look for the capture's stable filename in legacy/new destinations
   before inserting a new original.
2. Preserve the existing save-identifier checkpoint before publication and
   verify the saved original before its server receipt.
3. Coalesce album creation and retry membership against stable collection IDs.
   Matching titles do not prove that two trips share an album.
4. Late work must obey account/selection/policy fences. Teardown drains accepted
   library mutations before acknowledging sign-out or erasure.
5. Retention removes app-private organization state without deleting user
   originals, public folders or Photos albums.
6. A PhotoKit album request cannot be cancelled after creation has entered its
   change block. An exceptional checkpoint-write failure combined with process
   death can leave an empty orphan album. It must not produce duplicate photo
   assets, false receipts or title-based merging across trips.
7. Corrupt cosmetic metadata is recovered only after fresh authenticated
   registration. A lost iOS collection mapping may leave an old album orphaned;
   a replacement can reference the same originals, without duplicating assets.

Required acceptance includes concurrent original saves, interrupted save and
album commits, lost receipts, legacy saves, moved files, same-name trips,
permission changes, account replacement and exact HEIC/JPEG readback. Automated
native ports do not establish behavior in Samsung Gallery, Google Photos or
Apple Photos; installed-device acceptance remains required.

## Primary platform references

- [Expo SDK 57 media library](https://docs.expo.dev/versions/v57.0.0/sdk/media-library/)
- [Android shared media](https://developer.android.com/training/data-storage/shared/media)
- [Apple PhotoKit album operations](https://developer.apple.com/documentation/photokit/browsing-and-modifying-photo-albums)
- [Apple PhotoKit privacy](https://developer.apple.com/documentation/photokit/delivering-an-enhanced-privacy-experience-in-your-photos-app)
