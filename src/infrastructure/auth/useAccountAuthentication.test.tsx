import { act, renderHook } from "@testing-library/react-native";
import { useSignIn, useSignUp, useSSO } from "@clerk/expo";
import { useAccountAuthentication } from "./useAccountAuthentication";

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ isLoaded: true }),
  useSignIn: jest.fn(),
  useSignUp: jest.fn(),
  useSSO: jest.fn(),
  isClerkAPIResponseError: (value: { errors?: unknown }) =>
    Array.isArray(value?.errors),
}));
jest.mock("@clerk/expo/apple", () => ({
  useSignInWithApple: () => ({ startAppleAuthenticationFlow: jest.fn() }),
}));
jest.mock("expo-linking", () => ({ createURL: () => "airmesh:///" }));

const success = () => Promise.resolve({ error: null });
function fixture() {
  const signIn = {
    create: jest.fn(success),
    status: "complete",
    finalize: jest.fn(success),
    emailCode: { sendCode: jest.fn(success), verifyCode: jest.fn(success) },
    mfa: { sendEmailCode: jest.fn(success), verifyEmailCode: jest.fn(success) },
  };
  const signUp = {
    create: jest.fn(success),
    status: "complete",
    finalize: jest.fn(success),
    verifications: {
      sendEmailCode: jest.fn(success),
      verifyEmailCode: jest.fn(success),
    },
  };
  (useSignIn as jest.Mock).mockReturnValue({ signIn });
  (useSignUp as jest.Mock).mockReturnValue({ signUp });
  (useSSO as jest.Mock).mockReturnValue({
    startSSOFlow: jest.fn().mockResolvedValue({ createdSessionId: null }),
  });
  return { signIn, signUp };
}

describe("account authentication", () => {
  it("signs a returning user in without creating another account", async () => {
    const { signIn, signUp } = fixture();
    const { result } = await renderHook(useAccountAuthentication);
    await act(() => result.current.setEmail(" guest@example.com "));
    await act(() => result.current.submitEmail());
    expect(signIn.create).toHaveBeenCalledWith({
      identifier: "guest@example.com",
    });
    expect(signUp.create).not.toHaveBeenCalled();
    expect(result.current.verifying).toBe(true);
    await act(() => result.current.setCode("123456"));
    await act(() => result.current.verify());
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
  });

  it("creates a missing account, then requires successful email verification", async () => {
    const { signIn, signUp } = fixture();
    signIn.create.mockResolvedValueOnce({
      error: { clerkError: true, code: "form_identifier_not_found" },
    } as never);
    const { result } = await renderHook(useAccountAuthentication);
    await act(() => result.current.setEmail("new@example.com"));
    await act(() => result.current.submitEmail());
    expect(signUp.create).toHaveBeenCalledTimes(1);
    expect(signUp.finalize).not.toHaveBeenCalled();
    await act(() => result.current.setCode("654321"));
    await act(() => result.current.verify());
    expect(signUp.verifications.verifyEmailCode).toHaveBeenCalledWith({
      code: "654321",
    });
    expect(signUp.finalize).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid taps and does not resend during the cooldown", async () => {
    const { signIn } = fixture();
    const { result } = await renderHook(useAccountAuthentication);
    await act(() => result.current.setEmail("guest@example.com"));
    await act(async () => {
      await Promise.all([
        result.current.submitEmail(),
        result.current.submitEmail(),
      ]);
    });
    await act(() => result.current.resend());
    expect(signIn.create).toHaveBeenCalledTimes(1);
    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);
  });

  it("keeps an invalid code on the verification screen without opening a session", async () => {
    const { signIn } = fixture();
    signIn.emailCode.verifyCode.mockResolvedValueOnce({
      error: { clerkError: true, code: "form_code_incorrect" },
    } as never);
    const { result } = await renderHook(useAccountAuthentication);
    await act(() => result.current.setEmail("guest@example.com"));
    await act(() => result.current.submitEmail());
    await act(() => result.current.setCode("000000"));
    await act(() => result.current.verify());
    expect(result.current.error).toMatch(/code didn’t work/);
    expect(result.current.verifying).toBe(true);
    expect(signIn.finalize).not.toHaveBeenCalled();
  });
});
