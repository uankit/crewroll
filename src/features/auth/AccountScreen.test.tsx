import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { CrewRollThemeProvider } from "../../design-system";
import { AccountScreen, type AccountFlow } from "./AccountScreen";
import { ProfileScreen } from "./ProfileScreen";
import { TermsScreen } from "./TermsScreen";

type HostElement = Readonly<{
  parent: HostElement | null;
  props: Readonly<Record<string, unknown>>;
}>;
function centeredParent(element: HostElement): HostElement | null {
  let parent = element.parent;
  while (parent !== null) {
    const style = StyleSheet.flatten(
      parent.props.style as StyleProp<ViewStyle>,
    );
    if (style?.justifyContent === "center" && style.flexGrow === 1)
      return parent;
    parent = parent.parent;
  }
  return null;
}
function isScrollable(element: HostElement): boolean {
  let parent = element.parent;
  while (parent !== null) {
    if (parent.props.contentInsetAdjustmentBehavior === "automatic")
      return true;
    parent = parent.parent;
  }
  return false;
}
function account(overrides: Partial<AccountFlow> = {}): AccountFlow {
  return {
    email: "guest@example.com",
    code: "123456",
    password: "saved-password-draft",
    passwordRequired: false,
    verifying: false,
    busy: false,
    error: null,
    resendSeconds: 0,
    setEmail: jest.fn(),
    setCode: jest.fn(),
    setPassword: jest.fn(),
    submitEmail: jest.fn(async () => {}),
    submitPassword: jest.fn(async () => {}),
    useEmailCode: jest.fn(async () => {}),
    verify: jest.fn(async () => {}),
    resend: jest.fn(async () => {}),
    editEmail: jest.fn(),
    social: jest.fn(async () => {}),
    ...overrides,
  };
}

it.each([
  [
    "email",
    "Sign in or create an account",
    "Email address",
    "Continue with email",
  ],
  ["password", "Welcome back.", "Password", "Sign in"],
  ["verification", "Check your inbox.", "Verification code", "Verify email"],
] as const)(
  "keeps the %s form together in the center with pinned brand/back navigation",
  async (step, title, label, primary) => {
    const flow = account({
      passwordRequired: step === "password",
      verifying: step === "verification",
    });
    const back = jest.fn();
    const view = await render(
      <CrewRollThemeProvider reduceMotion>
        <AccountScreen flow={flow} onBack={back} />
      </CrewRollThemeProvider>,
    );
    const body = centeredParent(view.getByRole("header", { name: title }));
    expect(body).not.toBeNull();
    expect(centeredParent(view.getByLabelText(label))).toBe(body);
    expect(isScrollable(view.getByLabelText(label))).toBe(true);
    expect(view.getAllByLabelText("CrewRoll")).toHaveLength(1);
    expect(isScrollable(view.getByLabelText("CrewRoll"))).toBe(false);
    expect(view.queryByRole("button", { name: "Your account" })).toBeNull();
    const action = view.getByRole("button", { name: primary });
    expect(centeredParent(action)).toBeNull();
    expect(isScrollable(action)).toBe(false);
    await fireEvent.press(view.getByRole("button", { name: primary }));
    expect(
      step === "email"
        ? flow.submitEmail
        : step === "password"
          ? flow.submitPassword
          : flow.verify,
    ).toHaveBeenCalledTimes(1);
    await fireEvent.press(view.getByRole("button", { name: "Back" }));
    expect(step === "email" ? back : flow.editEmail).toHaveBeenCalledTimes(1);
  },
);

it("preserves the controlled password draft, secure input and email-code alternative through an error", async () => {
  const flow = account({ passwordRequired: true });
  const contents = (busy: boolean, error: string | null) => (
    <CrewRollThemeProvider reduceMotion>
      <AccountScreen flow={{ ...flow, busy, error }} onBack={jest.fn()} />
    </CrewRollThemeProvider>
  );
  const view = await render(contents(false, null));
  const password = view.getByLabelText("Password");
  expect(password.props.secureTextEntry).toBe(true);
  await fireEvent.changeText(password, "updated-password");
  expect(flow.setPassword).toHaveBeenCalledWith("updated-password");
  await fireEvent.press(
    view.getByRole("button", { name: "Use an email code" }),
  );
  expect(flow.useEmailCode).toHaveBeenCalledTimes(1);
  await view.rerender(contents(true, "That password didn’t work. Try again."));
  expect(view.getByLabelText("Password").props.value).toBe(flow.password);
  expect(view.getByRole("button", { name: "Sign in" })).toBeDisabled();
  view.getByRole("alert");
});

it("keeps profile input centered and its existing account-switch actions in the footer", async () => {
  const save = jest.fn(),
    another = jest.fn(),
    setName = jest.fn();
  const view = await render(
    <CrewRollThemeProvider reduceMotion>
      <ProfileScreen
        name="Guest"
        setName={setName}
        busy={false}
        error={null}
        onSave={save}
        onUseAnotherAccount={another}
      />
    </CrewRollThemeProvider>,
  );
  const body = centeredParent(view.getByRole("header", { name: "Your name." }));
  expect(body).not.toBeNull();
  expect(centeredParent(view.getByLabelText("Name"))).toBe(body);
  expect(
    centeredParent(view.getByRole("button", { name: "Continue" })),
  ).toBeNull();
  expect(isScrollable(view.getByLabelText("CrewRoll"))).toBe(false);
  expect(isScrollable(view.getByRole("button", { name: "Continue" }))).toBe(
    false,
  );
  expect(view.queryByRole("button", { name: "Your account" })).toBeNull();
  await fireEvent.changeText(view.getByLabelText("Name"), "Riya");
  expect(setName).toHaveBeenCalledWith("Riya");
  await fireEvent.press(view.getByRole("button", { name: "Continue" }));
  await fireEvent.press(
    view.getByRole("button", { name: "Use another account" }),
  );
  expect(save).toHaveBeenCalledTimes(1);
  expect(another).toHaveBeenCalledTimes(1);
});

it.each([null, "Couldn’t load your account."])(
  "keeps consent and its recovery state centered with pinned back navigation (%s)",
  async (error) => {
    const back = jest.fn();
    const view = await render(
      <CrewRollThemeProvider reduceMotion>
        <TermsScreen
          busy={false}
          error={error}
          onAccept={jest.fn()}
          onRetry={jest.fn()}
          onBack={back}
        />
      </CrewRollThemeProvider>,
    );
    expect(
      centeredParent(
        view.getByRole("header", {
          name: error ? "Let’s try again." : "Share with care.",
        }),
      ),
    ).not.toBeNull();
    expect(isScrollable(view.getByLabelText("CrewRoll"))).toBe(false);
    expect(isScrollable(view.getByRole("button", { name: "Back" }))).toBe(
      false,
    );
    expect(view.queryByRole("button", { name: "Your account" })).toBeNull();
    expect(
      isScrollable(
        view.getByRole("button", {
          name: error ? "Try again" : "Agree & continue",
        }),
      ),
    ).toBe(false);
    await fireEvent.press(view.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalledTimes(1);
  },
);
