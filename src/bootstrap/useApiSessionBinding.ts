import { useCallback, useLayoutEffect, useRef } from "react";

type ClerkIdentity = Readonly<{
  user: Readonly<{ id: string }> | null | undefined;
  session: Readonly<{ id: string }> | null | undefined;
}>;

/** Match committed UI ownership to the SDK instance that supplies each token. */
export function useApiSessionBinding(
  clerk: ClerkIdentity,
  committedBinding: string | null,
): () => string | null {
  const binding = useRef(committedBinding);
  useLayoutEffect(() => {
    binding.current = committedBinding;
    return () => {
      binding.current = null;
    };
  }, [committedBinding]);
  return useCallback(() => {
    const userId = clerk.user?.id;
    const sessionId = clerk.session?.id;
    if (!userId || !sessionId) return null;
    const active = JSON.stringify([userId, sessionId]);
    // Clerk can change its active session before React commits useAuth's update.
    return active === binding.current ? active : null;
  }, [clerk]);
}
