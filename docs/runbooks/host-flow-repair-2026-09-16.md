# Host onboarding recovery and date controls

## Failure and correction

The reported host failure was reproduced on Android user 11. The emulator clock was approximately 22 minutes behind the host/API clock (08:31:15 versus 08:53:44 UTC). Clerk reused a cached session token that the API rejected with `AUTH_INVALID`. The app then signed out; the uncommitted create journal later reconciled to a terminal no-create result, which was incorrectly presented as a device connection failure.

The mobile API now bypasses Clerk's cache after a well-formed authentication 401 and retries once with the same request body, device binding and idempotency key. Concurrent requests rejected with the same token share one pending refresh. Different session tokens do not share a refresh. A second rejected token still follows normal sign-out handling; server JWT verification and clock tolerance are unchanged. Token-provider transport exceptions no longer masquerade as an absent session.

When reconciliation confirms that no trip was created, the session returns to the first-trip screen with a retry message. It does not present device reconnection or sign the user out. Unknown outcomes still use the existing reconciliation protocol; the fix does not create another trip automatically.

The local host/guest emulator shortcuts now synchronize emulator time from the host when switching profiles. This repairs simulator drift after a paused session without resetting app data or replacing device keys.

## UI

- Welcome image and copy are centered between the wordmark and bottom actions.
- The verification input remains a real accessible native input for keyboard entry and autofill. Its native rendering sits below the opaque visual digit row, preventing Android composing text from appearing over the six digits. Verified by typing and editing with the numeric keyboard open.
- The misleading date-range field is replaced by independently editable **End date** and **End time** controls. The introduction explains that sharing starts when the host is ready. End time remains required, with the existing 14-day limit; scheduled starts and an optional end are not implemented.
- The existing Figma welcome and create-trip frames were updated in place. No duplicate screens were added. All 31 prototype navigation destinations still resolve; the two updated frames have no overflowing text.

## Profiles and device information

Name collection, canonical profile synchronization, and valid saved-device reuse remain in place. Device platform and app version are already stored with registration. Read-only inspection also confirmed that Expo SDK 57 can obtain model, OS name/version, and physical-device status without another user form or permission prompt: this emulator reports Android ATD built for arm64, Android 16, and `isDevice: false`.

This repair does not add model/OS telemetry storage or new required signup fields. Suggested social-profile follow-up: optional profile photo first, then optional hometown and a few travel interests. These are recommendations, not implemented fields. Do not use user-assigned device names, contacts, precise location, or hardware identifiers as a substitute for a social profile.

## Automated checks

167 tests passed across the session provider, API boundary, Clerk token source, account authentication, profile completion, device provisioning, trip screens, and route state. Coverage includes bounded token refresh, concurrent refresh, request/idempotency preservation, revoked fresh tokens, transient transport failures, terminal no-create recovery, and independent date/time selection. Scoped ESLint and app TypeScript checks passed.

## Emulator acceptance

The test uses API 36 AVD `CrewRoll_Startup_20260910` with separate Android users 11 (host) and 12 (guest), preserving the previous accounts and media libraries. Compact testing uses 360 × 640 logical dimensions. Changing emulator dimensions can restart the Activity and return an unsubmitted form to home; the form was reopened after resizing before testing it.

The host successfully recovered the prior failed command, created **Coastal test trip**, reached photo access, accepted Android's full-library permission, and opened the invite sheet. The sheet preserved the selected end instant: September 18, 2026, 6:00 PM in the emulator's local time zone. The API returned HTTP 201 for creation.

The guest completed the name step as **Maya**, looked up the invite, and saw the canonical host name **Ankit**. After the host approved Maya, the guest automatically reached photo access. The host could start only after both members had full access. Both profiles then reached the live gallery.

A new photo taken in the stock AOSP camera was detected on the host and delivered to the guest's system photo library. Both originals contain **37,820 bytes** and share SHA-256 `609d033eee7fe5f1e5e761e897320a1e7b991b89f1762296dac1125067b4f002`. Host MediaStore ID is 18; guest ID is 19. These fresh demo profiles had no MediaStore photos before this capture. See [photo-proof.json](../../outputs/crewroll-host-flow-repair/photo-proof.json).

After force-stopping and cold-launching the guest app, the same signed-in account, live trip and saved photo returned. Guest MediaStore still contains only ID 19; no duplicate photo was created. The test uses sequential foreground sessions on one emulator, not two physical phones.

Visual artifacts are in [outputs/crewroll-host-flow-repair](../../outputs/crewroll-host-flow-repair/). The grey gear is an Expo development overlay. Teal multi-touch markers in user-supplied screenshots are emulator overlays, not app content.

The debugger traces capture only final JS API outcomes after attachment; they do not establish complete startup or native-transfer network coverage. Physical Android/iPhone background delivery, force-quit delivery, and real Google/Apple sign-in remain separate acceptance work.
