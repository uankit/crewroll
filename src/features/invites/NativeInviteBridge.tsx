import * as Linking from 'expo-linking';
import { type Href, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';

import { nativeInviteRoute } from './routedInvite';

/** Recovers Android cold-start invites that Expo Router may receive too late. */
export function NativeInviteBridge() {
  const rawUrl = Linking.useLinkingURL();
  const navigationState = useRootNavigationState();
  const router = useRouter();
  const handledUrl = useRef<string | null>(null);
  const route = useMemo(() => nativeInviteRoute(rawUrl), [rawUrl]);

  useEffect(() => {
    if (!navigationState?.key || !rawUrl || !route || handledUrl.current === rawUrl) {
      return;
    }
    handledUrl.current = rawUrl;
    router.replace(route as Href);
  }, [navigationState?.key, rawUrl, route, router]);

  return null;
}
