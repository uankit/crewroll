import { AuthView } from "@clerk/expo/native";

export function ClerkAuthSurface() {
  return <AuthView mode="signInOrUp" isDismissible={false} />;
}
