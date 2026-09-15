import { AuthView, useAuthViewState } from "@clerk/expo/native";

export function ClerkAuthSurface({
  loading = null,
}: Readonly<{ loading?: ReturnType<typeof AuthView> | null }>) {
  const { isLoaded } = useAuthViewState();
  if (!isLoaded) return loading;
  return <AuthView mode="signInOrUp" isDismissible={false} />;
}
