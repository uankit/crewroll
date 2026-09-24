import {
  isClerkAPIResponseError,
  useAuth,
  useSignIn,
  useSignUp,
  useSSO,
} from "@clerk/expo";
import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";

function authCode(error: unknown): string | undefined {
  if (isClerkAPIResponseError(error)) return error.errors[0]?.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "clerkError" in error &&
    error.clerkError === true &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return undefined;
}

function authMessage(error: unknown): string {
  const code = authCode(error);
  if (code === "form_code_incorrect")
    return "That code didn’t work. Check it and try again.";
  if (code === "verification_expired" || code === "verification_failed")
    return "That code has expired. Request a new one below.";
  if (code === "too_many_requests")
    return "Please wait a moment before trying again.";
  if (
    code === "form_identifier_invalid" ||
    code === "form_param_format_invalid"
  )
    return "Enter a valid email address.";
  return "We couldn’t complete sign-in. Check your connection and try again.";
}

/** One account flow for both new and returning users; Clerk owns credentials. */
export function useAccountAuthentication() {
  const { isLoaded } = useAuth();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { startSSOFlow } = useSSO();
  const [email, setEmail] = useState("");
  const [code, setCodeValue] = useState("");
  const [kind, setKind] = useState<"signin" | "signup" | "mfa" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const working = useRef(false);
  useEffect(() => {
    if (!resendAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  function cooldown() {
    setNow(Date.now());
    setResendAt(Date.now() + 30_000);
  }
  async function run(operation: () => Promise<void>) {
    if (!isLoaded || working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(authMessage(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function submitEmail() {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    await run(async () => {
      setEmail(address);
      const attempt = await signIn.create({ identifier: address });
      if (attempt.error) {
        if (authCode(attempt.error) !== "form_identifier_not_found")
          throw attempt.error;
        const created = await signUp.create({ emailAddress: address });
        if (created.error) throw created.error;
        const sent = await signUp.verifications.sendEmailCode();
        if (sent.error) throw sent.error;
        setKind("signup");
      } else {
        const sent = await signIn.emailCode.sendCode({ emailAddress: address });
        if (sent.error) throw sent.error;
        setKind("signin");
      }
      setCodeValue("");
      cooldown();
    });
  }
  async function verify() {
    if (!kind || code.length !== 6) return;
    await run(async () => {
      const result =
        kind === "signup"
          ? await signUp.verifications.verifyEmailCode({ code })
          : kind === "mfa"
            ? await signIn.mfa.verifyEmailCode({ code })
            : await signIn.emailCode.verifyCode({ code });
      if (result.error) throw result.error;
      const resource = kind === "signup" ? signUp : signIn;
      if (resource.status === "complete") {
        const finalized = await resource.finalize();
        if (finalized.error) throw finalized.error;
      } else if (
        kind !== "signup" &&
        signIn.status === "needs_second_factor" &&
        signIn.supportedSecondFactors?.some((f) => f.strategy === "email_code")
      ) {
        const sent = await signIn.mfa.sendEmailCode();
        if (sent.error) throw sent.error;
        setKind("mfa");
        setCodeValue("");
        cooldown();
      } else {
        setError(
          "Your account needs another verification step. Try your connected Google or Apple account.",
        );
      }
    });
  }
  async function resend() {
    if (!kind || Date.now() < resendAt) return;
    await run(async () => {
      const result =
        kind === "signup"
          ? await signUp.verifications.sendEmailCode()
          : kind === "mfa"
            ? await signIn.mfa.sendEmailCode()
            : await signIn.emailCode.sendCode({ emailAddress: email });
      if (result.error) throw result.error;
      setCodeValue("");
      cooldown();
    });
  }
  async function social(provider: "google" | "apple") {
    await run(async () => {
      // Clerk retains the provider grant so account deletion can revoke it.
      const result = await startSSOFlow({
        strategy: provider === "apple" ? "oauth_apple" : "oauth_google",
        redirectUrl: Linking.createURL("/"),
      });
      if (result.createdSessionId && result.setActive)
        await result.setActive({ session: result.createdSessionId });
      else if (result.signIn || result.signUp)
        setError(
          "Sign-in needs another step. Continue with email to finish your account.",
        );
    });
  }
  return {
    email,
    code,
    verifying: kind !== null,
    busy: busy || !isLoaded,
    error,
    resendSeconds: Math.max(0, Math.ceil((resendAt - now) / 1000)),
    setEmail,
    setCode(value: string) {
      setCodeValue(value.replace(/\D/g, "").slice(0, 6));
      setError(null);
    },
    submitEmail,
    verify,
    resend,
    social,
    editEmail() {
      if (!working.current) {
        setKind(null);
        setCodeValue("");
        setError(null);
      }
    },
  };
}
