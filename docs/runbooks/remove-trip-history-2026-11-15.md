# Remove Past trips before the next testing build

This change removes the Past trips feature. UI polish and the next store binaries
are a separate step; the published Android 1.0.6 (19) and Apple 1.0.6 (27) review
remain unchanged by this source change.

## Product behavior

- Home offers the current trip, a pending join or finishing delivery. Departed
  trips have no list, summary sheet, saved-count history or navigation action.
- A departed membership in an older API response or cached query cannot reopen
  a past trip. The ordinary first-trip screen is available after departure.
- The current-trip query stops scheduled polling when it has no current work.
  Visible active/joining/finishing trips still refresh promptly. Foreground
  return, mutations, push invalidation and explicit retry retain their normal
  refresh paths.
- Received originals remain in the trip album in the system photo library.
  Removing the app's history does not remove photos from that library.

## API and database scope

`GET /v1/trips` now follows the authenticated user's `user_active_trips` primary
key, joined to their unfinished, non-rejected membership. It returns zero or one
operational trip. It no longer scans and sorts past memberships or calculates
photo counts for every past trip. Current-trip counts remain truthful.

The response fields remain compatible with installed clients. The new mobile
adapter also filters departed memberships from older deployments. Direct trip
projection access already rejects departed memberships; the lifecycle endpoint
still supplies the terminal outcome needed for local retirement.

There is no separate history table to drop. No database migration is needed.
These shared operational records are deliberately retained:

| Records                                     | Required behavior                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `user_active_trips`                         | Enforce one current trip per account; retain pending joins and final delivery until departure. |
| `trips`, `trip_members`                     | Delivery cutoffs, leave settlement, device recovery and authenticated lifecycle retirement.    |
| `deliveries`, `receipts`                    | Retry interrupted transfers without duplicated or falsely completed saves.                     |
| Assets, uploads and object-deletion records | Retire temporary encrypted bytes and confirm deletion.                                         |
| Idempotency and coordination records        | Settle uncertain commands, preserve replay safety and perform account deletion.                |

Dropping these tables would remove the photo-delivery system. This change does
not claim to erase every historical operational row or alter server retention.

## Local retention

The existing end-time plus seven-day native cleanup still retires transfer
journals, keys, staging and preview data. After a successful expiry purge it now
also discards the full frozen activation metadata. Only its trip identifier,
exact end date and anti-replay tombstone remain. Metadata-backed legacy end dates
are preserved before minimization, so restart, clock rollback and a changed-date
envelope cannot revive an expired key.

Unexpired transfer state and pending album repair retain their existing lifetime.
No new bridge command, storage format or retention window is introduced. Older
already-purged tombstones are not rewritten by a new migration.

## Verification and rollout

Regression coverage includes many departed memberships alongside the current
trip, joining from another phone, final drain after LEAVE and END, stale terminal
pointers, cached/legacy departed rows, account isolation and dated native expiry.
Device recovery remains mounted until its own acknowledgment, even when the Home
list observes device approval first. Departed or missing selections are cleared.

Local validation passed:

| Gate                            | Result                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tooling                         | 1,454 passed.                                                                                                   |
| UI, default and Android presets | 1,144 passed in each; one opposite-platform test skipped in each.                                               |
| Contract and service unit tests | 867 passed.                                                                                                     |
| PostgreSQL integration          | 353 passed across 27 suites, including nine current-trip regressions.                                           |
| Android JVM / Swift             | 178 / 138 passed.                                                                                               |
| Static and production checks    | Types, lint, formatting, unchanged migration policy, Expo Doctor 21/21 and production bundle resolution passed. |

Apply the compatible API source change with the final UI release. Build fresh
Android/iOS binaries after UI polish: this change removes the unused FlashList
dependency and changes native expiry handling. Do not describe existing store
builds as containing these fixes. Installed phone acceptance remains a separate
release gate from source tests.
