# Trip lifecycle and continuity design review

Reviewed September 16, 2026. Current-code reference: `ed6b56f`.
Design work and evidence are separate from the implementation checkpoint so they can be reviewed or reverted independently.

## Open the designs

- [Current lifecycle section](https://www.figma.com/design/aJHBtfIOx8oc7BgbzbKJIa?node-id=113-182)
- [Proposed continuity section](https://www.figma.com/design/aJHBtfIOx8oc7BgbzbKJIa?node-id=113-183)
- [Guest lifecycle prototype](https://www.figma.com/proto/aJHBtfIOx8oc7BgbzbKJIa?node-id=115-186&starting-point-node-id=115%3A186)
- [Host ending prototype](https://www.figma.com/proto/aJHBtfIOx8oc7BgbzbKJIa?node-id=115-194&starting-point-node-id=115%3A194)
- [Proposed mid-trip join prototype](https://www.figma.com/proto/aJHBtfIOx8oc7BgbzbKJIa?node-id=123-245&starting-point-node-id=123%3A245)
- [Proposed host approval prototype](https://www.figma.com/proto/aJHBtfIOx8oc7BgbzbKJIa?node-id=123-243&starting-point-node-id=123%3A243)
- [Proposed sign-in resume prototype](https://www.figma.com/proto/aJHBtfIOx8oc7BgbzbKJIa?node-id=123-251&starting-point-node-id=123%3A251)
- [Proposed device recovery prototype](https://www.figma.com/proto/aJHBtfIOx8oc7BgbzbKJIa?node-id=123-253&starting-point-node-id=123%3A253)

All screens remain in the existing Onboarding page (`2:62`). The canonical live gallery (`31:220`) and guest Trip info (`86:167`) retain their node IDs; they were moved into the lifecycle section and updated in place. Welcome, authentication, verification, photo access and other approved onboarding screens were preserved. No duplicate canonical gallery or backup screen was created.

## Current flow

| View/state | Node | Export |
| --- | --- | --- |
| Home: current and past trips | `115:186` | [Home](figma-01-home.png) |
| Live gallery, with Home navigation | `31:220` | [Gallery](figma-02-gallery.png) |
| Guest Trip info | `86:167` | [Trip info](figma-03-trip-info-guest.png) |
| Personal sharing paused | `115:188` | [Paused](figma-04-paused.png) |
| Finish syncing and leave confirmation | `115:190` | [Leave confirmation](figma-05-leave-confirmation.png) |
| Guest finishing sync | `115:192` | [Leaving](figma-06-leaving.png) |
| Host Trip info | `115:194` | [Host controls](figma-07-trip-info-host.png) |
| Host End confirmation | `115:196` | [End confirmation](figma-08-end-confirmation.png) |
| Trip finishing, waiting for final crew photos | `115:198` | [Trip finishing](figma-09-trip-finishing.png) |
| Home: past trips only | `115:200` | [Past trips](figma-10-past-trips.png) |
| Past-trip metadata and saved-photo count | `115:202` | [Saved summary](figma-11-past-summary.png) |
| Leave now warning; cancel means Keep syncing | `115:204` | [Leave now](figma-12-leave-now.png) |
| Home: finishing trip still occupies current slot | `124:240` | [Home while finishing](figma-13-home-finishing.png) |

Clickable review paths:

1. Guest: Home → Goa weekend → Trip info → Pause my sharing → Resume my sharing → Leave trip → Stay in trip, or Finish syncing and leave → finishing progress.
2. While finishing: Close → Home with **Finishing sync** still current. Open that card to return to progress. Leave now instead → warning → Keep syncing returns to progress.
3. Host: start at Host Trip info → End trip for everyone → End trip → finishing progress. Close retains the current slot on Home.
4. Simulated completion → past-only Home → Goa weekend → saved-photo summary. Start a trip and Enter invite code reuse the existing approved screens.

Completion is simulated after **8 seconds** in the prototype. The app waits for verified sync and the server lifecycle; the timer is not an implementation rule or latency promise. Approval-waiting proposals do not automatically approve a person or device. The connected paths focus on the selected Goa trip; other history examples and connection-setting controls are static reference content.

Personal pause stops new capture sharing and keeps existing transfers moving. Photos captured while paused remain private. Leaving defaults to finishing queued uploads and local saves before departure. Saved originals remain in the system photo library. History currently shows metadata and saved counts, not an archived in-app gallery. Scheduled end wording is retained while a trip is finishing, without incorrectly saying sharing continues until that time.

## Proposed continuity, not implemented

| Proposed state | Node | Export |
| --- | --- | --- |
| Host invite code and join request | `123:243` | [Host invite](figma-p1-host-invite.png) |
| Guest previews an active trip and requests access | `123:245` | [Join mid-trip](figma-p2-join-midtrip.png) |
| Waiting for host approval | `123:247` | [Waiting](figma-p3-waiting-approval.png) |
| Empty gallery beginning at approval cutoff | `123:249` | [From approval onward](figma-p4-approved-gallery.png) |
| Sign in and resume the same membership | `123:251` | [Resume](figma-p5-signin-resume.png) |
| Request approval for a replacement phone | `123:253` | [Confirm phone](figma-p6-device-recovery.png) |
| Wait for device approval | `123:255` | [Device approval pending](figma-p7-device-pending.png) |

The host's copyable code uses a valid sample alphabet (`G0A7CREW`). The copy interaction opens existing prototype feedback; it does not access the clipboard. The guest path assumes photo access is already granted; the approved photo-access screen is reused when needed. Host approval and guest waiting are separate actor perspectives in the prototype. Approve Kabir opens the proposed gallery with a visible approval cutoff.

Same-account sign-in and a known device are distinct from reinstall or missing keys. Device recovery requires host/trusted-device approval and does not promise that every old photo can be restored. No recovery approval is simulated automatically. These states do not establish production readiness for admission, key rotation, replacement devices or background sync. See the [continuity architecture plan](../../docs/runbooks/sync-continuity-design-2026-09-16.md).

## Validation and evidence

- **13 current views/states, 7 proposed views/states.** Twenty PNG exports were visually reviewed.
- **32 node-navigation edges:** 27 in current lifecycle and 5 in continuity, plus dismiss actions. Every target resolved in Figma. This is structural prototype validation, not a live multi-user sync test.
- Six named prototype entry points were added; the five original onboarding entry points and names were preserved.
- Reused Manrope styles, semantic theme variables, existing buttons, brand mark, member rows and gallery images. Added two reusable components on `07 · Trip patterns` (`113:184`): Current summary (`114:38`) and Past row (`114:47`). Added only the 18-point `radius/trip` metric (`VariableID:113:185`) to match code.
- No unexpected text fonts or horizontal text overflow in the final 393-point views. Eleven lifecycle views were additionally checked at 360-point width with no horizontal text overflow. Long phone content uses vertical overflow where appropriate. Compact-height sheet behavior still needs the deferred emulator/device pass.
- Corrected the past-only Home title alignment, opaque invite-sheet fill, scheduled-end copy, Leave-now cancel label and Home/Finishing navigation during review.
- Emulator acceptance remains deferred at the user's request. Follow the [lifecycle device acceptance guide](../../docs/runbooks/trip-lifecycle-acceptance-2026-09-16.md).

The complete node ledger, initial properties and final edge audit are in [figma-design-state.json](figma-design-state.json).

## Targeted Figma undo

A named version save is unsupported by this Figma MCP runtime. No named Figma version was created. The following is recorded, targeted undo guidance, not a tested one-click restoration script.

**Restore the reused canonical nodes before deleting the new section.** Deleting the lifecycle section first would also delete the gallery and guest Trip info it contains.

1. Move `31:220` and `86:167` back to page `2:62`, using their recorded original page order, then restore gallery position `(2485, 1220)` and Trip info position `(3912, 1220)`. Their original dimensions are 393×852 and 393×533 respectively; Trip info height is derived by auto layout after restoring its children.
2. Remove only the added nodes inside those existing trees: gallery Home button `115:310`, guest sheet header `115:313`, and guest sharing controls `115:317`. Removing these parents also removes their new children.
3. Restore `102:174` and `31:283` to visible. Restore `86:170`, `88:167`, and `88:168` to visible. No original editable text node was deleted.
4. Restore `86:167` name to `Gallery / Trip info sheet` and item spacing to 24, bound to `VariableID:2:42`. Restore `87:168` characters to `Sharing until 17 Sep · 6:00 PM`. Existing gallery Trip info and Filters reactions were retained throughout.
5. After confirming both canonical nodes are safely back on the page, remove new sections `113:182` and `113:183`, then new patterns page `113:184`, and finally the unused new variable `VariableID:113:185`.
6. Remove only the six added lifecycle/continuity prototype entry points, preserving the five entries in `originalFlowStartingPoints`. Recheck original frame positions, children, labels and navigation against the ledger.

The code checkpoint `ed6b56f` is independent of this design change. Undoing the Figma additions does not revert app/server/native behavior, and reverting code does not alter the Figma file.
