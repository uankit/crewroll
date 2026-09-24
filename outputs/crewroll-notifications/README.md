# Trip notifications — September 16, 2026

- Main trip header: notification bell with live pending count, plus a settings icon for trip details and sharing controls.
- Join and phone-confirmation requests use the existing trip polling data in a separate notification sheet. There is no additional polling timer.
- Join rows contain a fixed circular avatar, name, and accessible 48-point decline/approve controls. No “Wants to join your trip” helper line.
- Decline uses the existing authenticated, idempotent server DELETE endpoint. Pending actions block repeat taps; failed requests remain available to retry.
- Trip info retains dates, invite code, crew, personal pause, and End/Leave. Join and phone decisions no longer appear there.
- Existing Figma gallery `31:220`, host lobby `11:69`, and request sheet `123:243` were updated in place. The request sheet was moved into the current-build section. Product text uses Manrope; the gallery status bar uses its existing system font.

## Verification

- 60 UI test suites: 740 passed, 1 skipped. Includes approval, decline, duplicate taps, failed-request retry, guest access, and device-transfer sign-out.
- Mobile API generator: 37 tests passed, including deterministic generation of the new mobile rejection operation.
- TypeScript, scoped ESLint, formatting, and diff whitespace checks passed.
- Android emulator: Testing shows a bell with one pending request. Harsh appears in the compact notification sheet without helper text. Settings contains no join request. Harsh was neither approved nor declined during this visual check; the request remains pending for the user's test.
- `gallery.png`, `notifications.png`, and `settings.png` capture the running emulator. Photo delivery and physical-device acceptance are separate from this UI check.

[Figma notification sheet](https://www.figma.com/design/aJHBtfIOx8oc7BgbzbKJIa?node-id=123-243)
