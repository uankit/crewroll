# CrewRoll UX-002 Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete accessible CrewRoll primitive, feedback, and product-component inventory plus a development-only UI catalog.

**Architecture:** The implementation is split at the public primitive boundary. Slice A makes every primitive independently usable and tested; slice B composes only those public primitives into feedback and CrewRoll product components, then displays the public inventory in an Expo Router development catalog that redirects home outside `__DEV__`.

**Tech Stack:** Expo SDK 57, Expo Router 57, React Native 0.86, React 19.2, TypeScript 6 strict mode, `jest-expo`, React Native Testing Library, plain React Native styles, and the accepted UX-001 semantic theme.

**Spec:** `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md` §§11.4–11.5 and `docs/TECHNICAL_TASKS.md` UX-002

**Current checkpoint:** Only Task 1 (slice A primitives) is authorized for this review. Tasks 2–4 remain deferred until slice A is independently accepted.

## Global Constraints

- Implement exactly the §11.4 primitive, feedback, and product-composite inventory; do not add feature screens or provider behavior.
- Consume the accepted UX-001 semantic colors, typography, spacing, radius, elevation, and motion without raw visual constants.
- Every interactive target has a minimum 48 by 48 point/dp hit area.
- Text scales through 200 percent with `allowFontScaling` enabled and `maxFontSizeMultiplier={2}` by default.
- Components expose meaningful screen-reader roles, labels, values, hints, and disabled, selected, checked, expanded, or busy state where applicable.
- Layout uses logical/start/end semantics and remains usable in RTL.
- Reduced Motion removes Sheet movement, Dialog transitions, and Skeleton pulsing rather than inventing a second animation path.
- Components accept user-facing copy, typed status values, and callbacks; they never accept or render `Error`, `unknown`, HTTP responses, object paths, hashes, or provider payloads.
- The UI catalog route follows Expo Router 57 file-based routing and redirects to `/` whenever `__DEV__` is false.
- Preserve the signed app identity and do not modify package manifests, lockfiles, API, database, crypto, or native code.

---

### Task 1: Complete the public primitive layer (review slice A)

**Files:**
- Modify: `src/design-system/primitives/AppText.tsx`
- Modify: `src/design-system/primitives/Button.tsx`
- Modify: `src/design-system/primitives/Screen.tsx`
- Modify: `src/design-system/primitives/Surface.tsx`
- Create: `src/design-system/primitives/Stack.tsx`
- Create: `src/design-system/primitives/Inline.tsx`
- Create: `src/design-system/primitives/Divider.tsx`
- Create: `src/design-system/primitives/IconButton.tsx`
- Create: `src/design-system/primitives/TextField.tsx`
- Create: `src/design-system/primitives/PressableRow.tsx`
- Create: `src/design-system/primitives/Sheet.tsx`
- Create: `src/design-system/primitives/Dialog.tsx`
- Create: `src/design-system/primitives/Skeleton.tsx`
- Create: `src/design-system/primitives/ProgressBar.tsx`
- Create: `src/design-system/primitives/ProgressRing.tsx`
- Create: `src/design-system/primitives/index.ts`
- Modify: `src/design-system/index.ts`
- Test: `src/design-system/primitives/primitives.test.tsx`
- Test: `src/design-system/primitives/overlays-and-progress.test.tsx`

**Interfaces:**
- Consumes: `CrewRollTheme`, `spacing`, `radius`, `typography`, and `useCrewRollTheme()` from accepted UX-001.
- Produces: `AppText`, `Screen`, `Stack`, `Inline`, `Surface`, `Divider`, `Button`, `IconButton`, `TextField`, `PressableRow`, `Sheet`, `Dialog`, `Skeleton`, `ProgressBar`, and `ProgressRing` from both `primitives/index.ts` and `design-system/index.ts`.
- `Button` supports `label`, `onPress`, `variant`, `disabled`, `loading`, and accessible label/hint props; loading suppresses repeat activation and exposes `busy`.
- `IconButton` requires a human-readable `label` and visual `icon`; it never derives a label from a glyph.
- `TextField` associates visible label, supporting copy, validation copy, disabled/read-only state, and a 48-point input with the native `TextInput` contract.
- `PressableRow` exposes button, radio, checkbox, switch, or link semantics plus selected/checked/disabled state without owning navigation.
- `Sheet` and `Dialog` are controlled React Native `Modal` components with required `title`, `visible`, and `onDismiss`; their close control is always labeled.
- `ProgressBar` and `ProgressRing` clamp values to 0–1 and expose `progressbar` role with a literal 0–100 accessibility value.

- [x] **Step 1: Write failing primitive behavior tests**

  Import the full primitive public surface and render it under `CrewRollThemeProvider`. Assert the following observable behavior:

  ```tsx
  expect(screen.getByText("Body").props.maxFontSizeMultiplier).toBe(2);
  expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toEqual(
    expect.objectContaining({ busy: true, disabled: true }),
  );
  expect(flatten(screen.getByRole("button", { name: "More" }).props.style)).toEqual(
    expect.objectContaining({ minHeight: spacing.xxxl, minWidth: spacing.xxxl }),
  );
  expect(screen.getByDisplayValue("Trip name").props.accessibilityState.disabled).toBe(true);
  expect(screen.getByRole("radio", { name: "Nightly" }).props.accessibilityState.checked).toBe(true);
  ```

- [x] **Step 2: Verify primitive tests fail for the missing public surface**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/primitives/primitives.test.tsx`

  Expected: FAIL because the new primitive modules and exports do not exist.

- [x] **Step 3: Implement text, layout, surface, and control primitives**

  Keep component files focused, compose `AppText` inside controls, use `StyleSheet.flatten`-friendly style arrays, logical layout properties, semantic theme values, and explicit accessibility state. `AppText` defaults to scaling through 200 percent but honors an explicit consumer override.

- [x] **Step 4: Verify control and layout behavior passes in light, dark, and RTL cases**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/primitives/primitives.test.tsx`

  Expected: PASS with no act warnings or console output.

- [x] **Step 5: Write failing overlay and progress tests**

  Assert that visible Sheet/Dialog content is modal, close actions are labeled, normal motion selects platform animation, reduced motion selects `none`, Skeleton is inaccessible and static under Reduce Motion, and progress clamps both visuals and accessibility values:

  ```tsx
  expect(screen.getByRole("progressbar", { name: "Delivery" }).props.accessibilityValue).toEqual({
    min: 0,
    max: 100,
    now: 100,
    text: "100%",
  });
  expect(screen.getByTestId("sheet-modal").props.animationType).toBe("none");
  ```

- [x] **Step 6: Verify overlay/progress tests fail for missing modules**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/primitives/overlays-and-progress.test.tsx`

  Expected: FAIL because Sheet, Dialog, Skeleton, ProgressBar, and ProgressRing do not exist.

- [x] **Step 7: Implement overlays, loading, and progress primitives**

  Use controlled `Modal` instances, the theme's zeroed motion values as the Reduce Motion signal, one semantic-background scrim layer with opacity, a native `Animated` pulse only when motion is enabled, and determinate progress visuals that are always paired with accessible text/value.

- [x] **Step 8: Verify all slice-A behavior and semantic-policy tests**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/primitives/primitives.test.tsx src/design-system/primitives/overlays-and-progress.test.tsx src/design-system/semantic-consumption.test.ts`

  Expected: PASS with all primitive and raw-token mutations green.

- [x] **Step 9: Stop uncommitted for independent slice-A review**

  Run: `git status --short && git diff --check`

  Expected: only the plan, primitive files/tests, and design-system export surface are modified or new; no app route, manifest, native, API, database, or crypto changes are present.

#### Review fix round 1

- [x] Expose `PressableRow` supporting copy as the default accessibility hint while preserving an explicit override.
- [x] Wire Sheet and Dialog accessibility-escape dismissal to the controlled `onDismiss` action.
- [x] Give every Button variant a distinct semantic pressed surface, including Critical.
- [x] Forward a typed native `TextInput` ref through React `forwardRef`.
- [x] Keep Sheet and Dialog headers/actions outside bounded, scrollable long-form content at 200 percent text scaling.
- [x] Capture focused behavior/type REDs before production edits and restore the primitive plus semantic-policy suites to green.
- [x] Stop uncommitted for fresh independent re-review after full verification.

---

### Task 2: Build typed feedback components (review slice B, after slice-A acceptance)

**Files:**
- Modify: `src/design-system/feedback/StatusBadge.tsx`
- Create: `src/design-system/feedback/LiveStatus.tsx`
- Create: `src/design-system/feedback/InlineBanner.tsx`
- Create: `src/design-system/feedback/BlockingCallout.tsx`
- Create: `src/design-system/feedback/Toast.tsx`
- Create: `src/design-system/feedback/EmptyState.tsx`
- Create: `src/design-system/feedback/PermissionCard.tsx`
- Create: `src/design-system/feedback/types.ts`
- Create: `src/design-system/feedback/index.ts`
- Modify: `src/design-system/index.ts`
- Test: `src/design-system/feedback/feedback.test.tsx`

**Interfaces:**
- Consumes: slice-A public primitives only.
- Produces: every §11.4 feedback component and `FeedbackTone = "neutral" | "info" | "success" | "warning" | "critical"`.
- Status components require icon text plus a label; `LiveStatus` and `Toast` use polite live regions while `BlockingCallout` uses alert semantics.
- `PermissionCard` consumes a closed readiness state and exposes only the direct action appropriate to that state.

- [ ] **Step 1: Write and run failing feedback behavior tests**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/feedback/feedback.test.tsx`

  Expected: FAIL because the feedback inventory is absent.

- [ ] **Step 2: Implement the complete feedback inventory from public primitives**

  Map each closed tone to semantic text/surface colors, require text beside every status icon, expose state through labels/live regions, and never accept an exception/provider payload prop.

- [ ] **Step 3: Verify feedback in both schemes, RTL, Dynamic Type, and disabled actions**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/feedback/feedback.test.tsx src/design-system/semantic-consumption.test.ts`

  Expected: PASS.

---

### Task 3: Build CrewRoll product composites (review slice B)

**Files:**
- Create: `src/design-system/product/CrewRollWordmark.tsx`
- Create: `src/design-system/product/MemberAvatar.tsx`
- Create: `src/design-system/product/MemberStack.tsx`
- Create: `src/design-system/product/MemberReadinessRow.tsx`
- Create: `src/design-system/product/TripSummaryCard.tsx`
- Create: `src/design-system/product/InviteCard.tsx`
- Create: `src/design-system/product/PhotoTile.tsx`
- Create: `src/design-system/product/PhotoGrid.tsx`
- Create: `src/design-system/product/TransferHealthCard.tsx`
- Create: `src/design-system/product/MemberCoverageCard.tsx`
- Create: `src/design-system/product/ReconciliationRow.tsx`
- Create: `src/design-system/product/ReleaseModeField.tsx`
- Create: `src/design-system/product/index.ts`
- Modify: `src/design-system/index.ts`
- Test: `src/design-system/product/product.test.tsx`

**Interfaces:**
- Consumes: public primitives and feedback components only.
- Produces: the exact §11.4 product-composite inventory.
- `InviteCard` always renders the readable short code and invite URL, even when a visual QR child is supplied.
- `PhotoTile` requires accessible photo/member/status copy; `PhotoGrid` delegates rendering to PhotoTile and preserves list semantics.
- `ReleaseModeField` exposes Immediate and Nightly as a labeled radio group with checked and disabled state.

- [ ] **Step 1: Write and run failing product-component behavior tests**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/product/product.test.tsx`

  Expected: FAIL because the product inventory is absent.

- [ ] **Step 2: Implement member, trip, invitation, photo, coverage, health, reconciliation, and release-mode composites**

  Keep all domain transitions outside the design system. Components receive display-ready closed state and callbacks, compose public primitives, and never call network/native/navigation APIs.

- [ ] **Step 3: Verify product behavior and forbidden-language controls**

  Run: `npm run test:ui -- --runTestsByPath src/design-system/product/product.test.tsx src/design-system/semantic-consumption.test.ts`

  Expected: PASS with readable invite alternatives, textual status, accessible selection, and 48-point actions.

---

### Task 4: Add the development-only Expo Router catalog (review slice B)

**Files:**
- Create: `app/dev/ui-catalog.tsx`
- Test: `app/dev/ui-catalog.test.tsx`

**Interfaces:**
- Consumes: the public `@/design-system` export only.
- Produces: `/dev/ui-catalog` under Expo Router 57; production evaluation returns `<Redirect href="/" />` before catalog UI is rendered.

- [ ] **Step 1: Write and run a failing route-gate/catalog test**

  Render the route in development and assert representative sections for Primitives, Feedback, and Product; evaluate with `__DEV__ = false` and assert the Expo Router Redirect target is `/`.

  Run: `npm run test:ui -- --runTestsByPath app/dev/ui-catalog.test.tsx`

  Expected: FAIL because the route does not exist.

- [ ] **Step 2: Implement the catalog route using only public components**

  Render light and dark examples in a scrolling Screen, keep callbacks local and inert, use display fixtures with no provider/internal payloads, and configure the page with Expo Router's supported Stack screen API.

- [ ] **Step 3: Run UX-002 and repository verification**

  Run: `npm run test:ui && npm run typecheck && npm run lint && npm run format:check && npm run verify:identity && npm run test:unit && git diff --check`

  Expected: all deterministic gates pass, identity remains exact, and scope is limited to this plan, design-system components/tests/exports, and the single development route/test.
