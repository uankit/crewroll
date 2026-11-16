import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { act, fireEvent, render } from "@testing-library/react-native";
import { InviteCodeSheet, TripInvitationCard } from "./index";
import type { TripInvitePreview } from "../../domain/trips/model";
import { CrewRollThemeProvider } from "../../design-system";

const preview: TripInvitePreview = {
  tripId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
  name: "Goa",
  startsAt: null,
  endsAt: "2030-11-17T18:00:00Z",
  hostDisplayName: "Riya",
  members: [
    { displayName: "Riya", role: "OWNER" },
    { displayName: "Arjun", role: "MEMBER" },
  ],
};
function sheet(
  onLookup: (code: string) => Promise<TripInvitePreview> = jest
    .fn()
    .mockResolvedValue(preview),
) {
  const onDismiss = jest.fn(),
    onFound = jest.fn();
  return {
    onDismiss,
    onFound,
    onLookup,
    render: () =>
      render(
        <SafeAreaInsetsContext.Provider
          value={{ top: 47, bottom: 34, left: 0, right: 0 }}
        >
          <InviteCodeSheet {...{ onDismiss, onFound, onLookup }} />
        </SafeAreaInsetsContext.Provider>,
      ),
  };
}

it("normalizes a pasted invite and leaves the decision to join on Home", async () => {
  const props = sheet();
  const view = await props.render();
  await fireEvent.changeText(view.getByLabelText("Invite code"), " abcd 2345 ");
  await fireEvent.press(view.getByRole("button", { name: "Find trip" }));
  expect(props.onLookup).toHaveBeenCalledWith("ABCD2345");
  expect(props.onFound).toHaveBeenCalledWith("ABCD2345", preview);
});
it.each(["", "ABCD234", "ABCD23456"])(
  "disables lookup for incomplete or overlong input %s, including keyboard submit",
  async (code) => {
    const props = sheet(),
      view = await props.render();
    const input = view.getByLabelText("Invite code");
    await fireEvent.changeText(input, code);
    expect(view.getByRole("button", { name: "Find trip" })).toBeDisabled();
    await fireEvent(input, "submitEditing");
    expect(view.queryByRole("alert")).toBeNull();
    expect(props.onLookup).not.toHaveBeenCalled();
    expect(props.onFound).not.toHaveBeenCalled();
  },
);
it("enables Find trip only after the normalized code reaches eight characters", async () => {
  const props = sheet(),
    view = await props.render();
  const input = view.getByLabelText("Invite code");
  await fireEvent.changeText(input, " abcd 234 ");
  expect(input.props.value).toBe("ABCD234");
  expect(view.getByRole("button", { name: "Find trip" })).toBeDisabled();
  await fireEvent(input, "submitEditing");
  expect(props.onLookup).not.toHaveBeenCalled();
  await fireEvent.changeText(input, " abcd 2345 ");
  expect(view.getByRole("button", { name: "Find trip" })).toBeEnabled();
  await fireEvent(input, "submitEditing");
  expect(props.onLookup).toHaveBeenCalledTimes(1);
  expect(props.onLookup).toHaveBeenCalledWith("ABCD2345");
});
it.each(["BADCODE1", "ABCI2345"])(
  "reports an eight-character code with an unsupported letter (%s) without a length error or API call",
  async (code) => {
    const props = sheet(),
      view = await props.render();
    await fireEvent.changeText(view.getByLabelText("Invite code"), code);
    expect(view.getByRole("button", { name: "Find trip" })).toBeEnabled();
    await fireEvent.press(view.getByRole("button", { name: "Find trip" }));
    view.getByText("That code doesn’t look right. Check it with your host.");
    view.getByRole("alert");
    expect(view.queryByText(/Enter the 8-character/)).toBeNull();
    expect(props.onLookup).not.toHaveBeenCalled();
    expect(props.onFound).not.toHaveBeenCalled();
  },
);
it.each(["INVITE_INVALID", "NETWORK_ERROR"])(
  "allows editing after %s",
  async (code) => {
    const props = sheet(
        jest.fn().mockRejectedValue({ code, detail: "private token" }),
      ),
      view = await props.render();
    await fireEvent.changeText(view.getByLabelText("Invite code"), "ABCD2345");
    await fireEvent.press(view.getByRole("button", { name: "Find trip" }));
    view.getByRole("alert");
    view.getByText(
      code === "INVITE_INVALID"
        ? "Trip not found. Check the code with your host."
        : "Couldn’t load this trip. Try again.",
    );
    expect(props.onLookup).toHaveBeenCalledTimes(1);
    expect(props.onFound).not.toHaveBeenCalled();
    expect(view.queryByText(/private token/)).toBeNull();
    await fireEvent.changeText(view.getByLabelText("Invite code"), "ABCD2346");
    expect(view.queryByRole("alert")).toBeNull();
  },
);
it("ignores repeated taps and a late lookup after the drawer closes", async () => {
  let resolve!: (trip: TripInvitePreview) => void;
  const props = sheet(
      jest.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    ),
    view = await props.render();
  await fireEvent.changeText(view.getByLabelText("Invite code"), "ABCD2345");
  const find = view.getByRole("button", { name: "Find trip" });
  // Submit twice before React commits disabled controls to exercise the synchronous fence.
  const submit = view.getByLabelText("Invite code").props.onSubmitEditing;
  await act(() => {
    submit();
    submit();
  });
  await fireEvent.press(find);
  expect(view.getByRole("button", { name: "Find trip" })).toBeDisabled();
  expect(props.onLookup).toHaveBeenCalledTimes(1);
  await fireEvent.press(
    view.getByRole("button", { name: "Close Join a trip" }),
  );
  await act(async () => resolve(preview));
  expect(props.onDismiss).toHaveBeenCalledTimes(1);
  expect(props.onFound).not.toHaveBeenCalled();
});
it("keeps the named trip and crew on the card after requesting approval", async () => {
  const card = (pending: boolean) => (
    <CrewRollThemeProvider scheme="dark" reduceMotion>
      <TripInvitationCard
        preview={preview}
        request={pending ? "pending" : "preview"}
        onChangeCode={jest.fn()}
        onJoin={jest.fn()}
      />
    </CrewRollThemeProvider>
  );
  const view = await render(card(false));
  expect(view.getByRole("header", { name: "Goa" }).props.allowFontScaling).toBe(
    true,
  );
  expect(view.getAllByText("Riya")).toHaveLength(1);
  view.getByText(/Arjun/);
  await view.rerender(card(true));
  view.getByText("Waiting for approval");
  view.getByRole("header", { name: "Goa" });
  expect(view.queryByRole("button")).toBeNull();
});
