# Crew lobby and trip-list review — September 16, 2026

Implemented in the existing routes and design components:

- Host lobby: joined crew directly on the app canvas; neutral gathering status;
  Invite crew is primary, Start trip is secondary. Existing approval, permission,
  and start eligibility checks remain in force.
- Guest lobby: actual trip name and joined crew; automatic host-start waiting state.
- Home: compact current/past rows. Only the live trip has a green accent and Live
  label. Paused, pending, and finishing states use their existing status text.
- Invite loading and retry live inside the invite sheet; copy uses the displayed
  code, including a code restored by the continuity API.

## Evidence

- `02-crew-lobby.png`: actual Android host lobby, captured before the test trip started.
- `04-home-list.png`: actual Android compact Home list after reloading the current code.
- `05-invite-code.png`: invite code visible in the running trip's information sheet.
- `figma-home.png`, `figma-host.png`, `figma-guest.png`, `figma-invite.png`: Figma
  review captures. Minor navigation color adjustments followed the host/invite capture.
- Existing Figma screen IDs were retained: Home `115:186`, host `11:69`, guest
  `8:165`, invite `37:168`. Current/past list components were updated in place.
- TypeScript and lint passed. Four focused Jest suites passed: 116 tests covering
  route state, lobby interactions, session lifecycle, and shared product components.
- The real emulator received successful authenticated lifecycle and continuity
  responses after the runtime database grant repair. Copy code showed Copied.

The hosted failure was missing runtime-role permissions on migration 008's two
new tables. The exact narrow grant and deployment verification requirements are
documented in `docs/runbooks/cloudflare-mvp-setup.md`.

## Test-state limitation

A reused emulator helper accidentally tapped Start trip during this review.
The helper was stopped and its input action removed; this was disclosed to the
user. The user's empty Testing trip is now live, with one member and no photos
or uploads at verification. It was not rolled back or deleted, to preserve sync
history and native keys. The choice to keep it live or replace it with a fresh
waiting trip remains with the user. Emulator is left on Home.

This is UI, route, and API recovery evidence. It does not establish physical-phone
acceptance or complete the planned multi-account photo/late-join transfer test.
