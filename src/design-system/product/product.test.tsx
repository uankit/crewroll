import { fireEvent, render } from "@testing-library/react-native";
import type { ComponentProps, PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";

import {
  CrewRollWordmark,
  InviteCard,
  MemberAvatar,
  MemberCoverageCard,
  MemberReadinessRow,
  MemberStack,
  PhotoGrid,
  PhotoTile,
  ReconciliationRow,
  ReleaseModeField,
  TransferHealthCard,
  TripSummaryCard,
} from "./index";
import { CrewRollThemeProvider, darkColors, spacing } from "../index";

type ThemeHarnessProps = PropsWithChildren<{
  readonly scheme?: "light" | "dark";
}>;

function ThemeHarness({ children, scheme = "light" }: ThemeHarnessProps) {
  return (
    <CrewRollThemeProvider scheme={scheme}>{children}</CrewRollThemeProvider>
  );
}

type ForbiddenPropName = "error" | "payload" | "providerPayload" | "response";
type ForbiddenProductProp = Extract<
  | keyof ComponentProps<typeof CrewRollWordmark>
  | keyof ComponentProps<typeof MemberAvatar>
  | keyof ComponentProps<typeof MemberStack>
  | keyof ComponentProps<typeof MemberReadinessRow>
  | keyof ComponentProps<typeof TripSummaryCard>
  | keyof ComponentProps<typeof InviteCard>
  | keyof ComponentProps<typeof PhotoTile>
  | keyof ComponentProps<typeof PhotoGrid>
  | keyof ComponentProps<typeof TransferHealthCard>
  | keyof ComponentProps<typeof MemberCoverageCard>
  | keyof ComponentProps<typeof ReconciliationRow>
  | keyof ComponentProps<typeof ReleaseModeField>,
  ForbiddenPropName
>;

const productPropsArePrivacySafe: [ForbiddenProductProp] extends [never]
  ? true
  : never = true;
void productPropsArePrivacySafe;

const readyStatus = {
  icon: "✓",
  label: "Ready",
  tone: "success",
} as const;
const waitingStatus = {
  icon: "…",
  label: "Waiting",
  tone: "warning",
} as const;

describe("CrewRoll product composites", () => {
  test("renders the wordmark and member identity inventory with scalable copy and list semantics", async () => {
    const screen = await render(
      <ThemeHarness scheme="dark">
        <CrewRollWordmark tagline="Photos find everyone" />
        <MemberAvatar displayName="Ada Lovelace" testID="ada-avatar" />
        <MemberStack
          label="Trip members"
          maxVisible={2}
          members={[
            { displayName: "Ada Lovelace", key: "ada" },
            { displayName: "Grace Hopper", key: "grace" },
            { displayName: "Katherine Johnson", key: "katherine" },
          ]}
          testID="member-stack"
        />
      </ThemeHarness>,
    );

    const wordmark = screen.getByText("crewroll");
    expect(wordmark.props.allowFontScaling).toBe(true);
    expect(wordmark.props.maxFontSizeMultiplier).toBe(2);
    expect(screen.getByText("Photos find everyone")).toBeTruthy();
    expect(
      screen.getAllByText("AL", { includeHiddenElements: true }),
    ).toHaveLength(2);
    expect(
      screen.getByText("+1", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.getByTestId("member-stack").props).toEqual(
      expect.objectContaining({
        accessibilityLabel: "Trip members",
        accessibilityRole: "list",
      }),
    );
    expect(screen.getByTestId("member-stack").props.accessible).not.toBe(true);
    expect(
      screen
        .getAllByRole("image")
        .map((avatar) => avatar.props.accessibilityLabel),
    ).toEqual(expect.arrayContaining(["Ada Lovelace", "Grace Hopper"]));
    expect(
      StyleSheet.flatten(screen.getByTestId("ada-avatar").props.style),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: darkColors.action,
        minHeight: spacing.xxxl,
        minWidth: spacing.xxxl,
      }),
    );
  });

  test("composes member readiness and trip summary without owning domain transitions", async () => {
    const onOpen = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <View style={{ direction: "rtl" }}>
          <MemberReadinessRow
            displayName="Ada Lovelace"
            readiness={readyStatus}
            supportingText="Full photo access"
          />
          <TripSummaryCard
            action={{ label: "Open trip", onPress: onOpen }}
            details={[
              { label: "Ends", value: "2 September" },
              { label: "Members", value: "2 ready" },
            ]}
            name="Weekend in Goa"
            status={waitingStatus}
          />
        </View>
      </ThemeHarness>,
    );

    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Full photo access")).toBeTruthy();
    expect(screen.getByLabelText("Status: Ready")).toBeTruthy();
    expect(screen.getByText("Weekend in Goa")).toBeTruthy();
    expect(screen.getByText("2 September")).toBeTruthy();
    expect(screen.getByText("2 ready")).toBeTruthy();

    const open = screen.getByRole("button", { name: "Open trip" });
    expect(StyleSheet.flatten(open.props.style)).toEqual(
      expect.objectContaining({
        minHeight: 56,
        minWidth: spacing.xxxl,
      }),
    );
    await fireEvent.press(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("InviteCard copies a readable code without a competing invite link", async () => {
    const onCopy = jest.fn(async () => {});
    const screen = await render(
      <ThemeHarness>
        <InviteCard code="ABCD2345" onCopy={onCopy} />
      </ThemeHarness>,
    );
    expect(screen.getByText("ABCD2345")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  test("PhotoGrid exposes one positioned native listitem focus unit per photo", async () => {
    const photos = [
      {
        key: "photo-one",
        memberLabel: "From Ada",
        photoLabel: "Ada smiling by the sea",
        status: readyStatus,
      },
      {
        key: "photo-two",
        memberLabel: "From Grace",
        photoLabel: "Grace beside a palm tree",
        status: waitingStatus,
      },
    ] as const;
    const screen = await render(
      <ThemeHarness>
        <PhotoTile
          memberLabel={photos[0].memberLabel}
          photoLabel={photos[0].photoLabel}
          status={photos[0].status}
        />
        <PhotoGrid label="Trip photos" photos={photos} testID="photo-grid" />
      </ThemeHarness>,
    );

    expect(screen.getByTestId("photo-grid").props).toEqual(
      expect.objectContaining({
        accessibilityLabel: "Trip photos",
        role: "list",
      }),
    );
    expect(screen.getByTestId("photo-grid").props.accessible).not.toBe(true);

    const listItems = screen.getAllByRole("listitem");
    expect(listItems).toHaveLength(2);
    expect(
      listItems.map((item) => ({
        accessible: item.props.accessible,
        label: item.props.accessibilityLabel,
        role: item.props.role,
      })),
    ).toEqual([
      {
        accessible: true,
        label: "Ada smiling by the sea. From Ada. Ready. Photo 1 of 2",
        role: "listitem",
      },
      {
        accessible: true,
        label: "Grace beside a palm tree. From Grace. Waiting. Photo 2 of 2",
        role: "listitem",
      },
    ]);

    // The standalone tile exposes its image/status children. Grid descendants are
    // visual only so the listitem, rather than a nested child, is the focus unit.
    expect(
      screen.getAllByRole("image", { name: "Ada smiling by the sea" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByText("From Ada", { includeHiddenElements: true }),
    ).toHaveLength(2);
    expect(
      screen.getAllByLabelText("Status: Ready", {
        includeHiddenElements: true,
      }),
    ).toHaveLength(2);
  });

  test("renders transfer health, member coverage, and reconciliation with textual progress and 48-point actions", async () => {
    const onResolve = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <TransferHealthCard
          progress={{ label: "Trip delivery", value: 0.5 }}
          status={waitingStatus}
          summary="1 of 2 members complete"
          title="Delivery health"
        />
        <MemberCoverageCard
          deliveredLabel="8 saved"
          memberName="Ada Lovelace"
          missingLabel="2 remaining"
          progress={{ label: "Ada coverage", value: 0.8 }}
          status={waitingStatus}
        />
        <ReconciliationRow
          action={{ label: "Resolve permission", onPress: onResolve }}
          detail="2 photos still need access"
          label="Ada's library"
          status={{ icon: "!", label: "Needs attention", tone: "critical" }}
        />
      </ThemeHarness>,
    );

    expect(
      screen.getByRole("progressbar", { name: "Trip delivery" }).props
        .accessibilityValue,
    ).toEqual({ max: 100, min: 0, now: 50, text: "50%" });
    expect(
      screen.getByRole("progressbar", { name: "Ada coverage" }).props
        .accessibilityValue,
    ).toEqual({ max: 100, min: 0, now: 80, text: "80%" });
    expect(screen.getByText("8 saved")).toBeTruthy();
    expect(screen.getByText("2 remaining")).toBeTruthy();
    expect(screen.getByLabelText("Status: Needs attention")).toBeTruthy();

    const resolve = screen.getByRole("button", {
      name: "Resolve permission",
    });
    expect(StyleSheet.flatten(resolve.props.style)).toEqual(
      expect.objectContaining({ minHeight: 56 }),
    );
    await fireEvent.press(resolve);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  test("ReleaseModeField exposes a labeled radio group with checked, disabled, RTL-safe 48-point options", async () => {
    const onChange = jest.fn();
    const screen = await render(
      <ThemeHarness>
        <View style={{ direction: "rtl" }}>
          <ReleaseModeField
            immediateDescription="Photos arrive as soon as they are ready"
            label="Photo delivery"
            nightlyDescription="Photos arrive together each night"
            nightlyDisabled
            onChange={onChange}
            testID="release-mode"
            value="IMMEDIATE"
          />
        </View>
      </ThemeHarness>,
    );

    expect(screen.getByTestId("release-mode").props).toEqual(
      expect.objectContaining({
        accessibilityLabel: "Photo delivery",
        accessibilityRole: "radiogroup",
      }),
    );
    expect(screen.getByTestId("release-mode").props.accessible).not.toBe(true);
    const immediate = screen.getByRole("radio", { name: "Immediate" });
    const nightly = screen.getByRole("radio", { name: "Nightly" });

    expect(immediate.props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true, disabled: false }),
    );
    expect(nightly.props.accessibilityState).toEqual(
      expect.objectContaining({ checked: false, disabled: true }),
    );
    for (const option of [immediate, nightly]) {
      expect(StyleSheet.flatten(option.props.style)).toEqual(
        expect.objectContaining({
          minHeight: spacing.xxxl,
          minWidth: spacing.xxxl,
        }),
      );
    }

    await fireEvent.press(nightly);
    await fireEvent.press(immediate);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("IMMEDIATE");
  });
});
