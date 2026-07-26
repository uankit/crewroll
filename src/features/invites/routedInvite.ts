export type RoutedInviteParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * Convert a native CrewRoll invite into the internal route Expo Router expects.
 *
 * Expo Router can time out while asking Android for the cold-start URL. Expo
 * Linking keeps a synchronous copy of that URL, so the root layout uses this
 * helper to recover the intended Join route once navigation is mounted.
 */
export function nativeInviteRoute(rawUrl: string | null): string | null {
  if (!rawUrl || rawUrl.length > 4_096) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const isCanonicalJoin =
    url.protocol === 'airmesh:' &&
    url.hostname.toLowerCase() === 'join' &&
    (url.pathname === '' || url.pathname === '/');

  if (!isCanonicalJoin) return null;
  return `/join${url.search}`;
}

/**
 * Rebuild the complete deep link received from Expo Router.
 *
 * Keeping every query entry is deliberate: the domain invite decoder owns the
 * allowlist and must see unknown or duplicate fields instead of having the UI
 * silently sanitize a malformed link into a valid one.
 */
export function inviteLinkFromRouteParams(params: RoutedInviteParams): string {
  const query = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, rawValue]) => {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      return values.flatMap((value) =>
        typeof value === 'string'
          ? [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`]
          : [],
      );
    })
    .join('&');

  return query ? `airmesh://join?${query}` : '';
}

export function inviteLinkForJoinScreen(
  rawUrl: string | null,
  params: RoutedInviteParams,
): string {
  const routedLink = inviteLinkFromRouteParams(params);
  if (
    routedLink &&
    rawUrl &&
    /^airmesh:\/\/(?:[^/?#@]*@)?join(?:[/?#]|$)/i.test(rawUrl)
  ) {
    return rawUrl;
  }
  return routedLink;
}
