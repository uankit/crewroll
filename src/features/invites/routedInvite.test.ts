import { describe, expect, it } from 'vitest';

import { decodeInviteDeepLink } from '@/core/invite';

import {
  inviteLinkForJoinScreen,
  inviteLinkFromRouteParams,
  nativeInviteRoute,
} from './routedInvite';

describe('nativeInviteRoute', () => {
  it('recovers the canonical Android cold-start invite route', () => {
    expect(nativeInviteRoute('airmesh://join?trip=trip%3Aone&secret=abc')).toBe(
      '/join?trip=trip%3Aone&secret=abc',
    );
  });

  it('preserves duplicate and unknown query entries for strict validation', () => {
    expect(nativeInviteRoute('airmesh://join?trip=one&trip=two&unknown=x')).toBe(
      '/join?trip=one&trip=two&unknown=x',
    );
  });

  it('does not redirect unrelated or malformed native URLs', () => {
    expect(nativeInviteRoute('airmesh://trip/join?trip=one')).toBeNull();
    expect(nativeInviteRoute('airmesh:///join?trip=one')).toBeNull();
    expect(nativeInviteRoute('https://example.com/join?trip=one')).toBeNull();
    expect(nativeInviteRoute('not a url')).toBeNull();
    expect(nativeInviteRoute(null)).toBeNull();
  });
});

describe('inviteLinkFromRouteParams', () => {
  it('preserves unknown fields so the strict invite decoder can reject them', () => {
    const link = inviteLinkFromRouteParams({ trip: 'trip:one', secret: 'secret', code: 'OLD123' });
    const decoded = decodeInviteDeepLink(link);

    expect(link).toContain('code=OLD123');
    expect(decoded.ok).toBe(false);
  });

  it('preserves duplicate route values instead of choosing one', () => {
    const link = inviteLinkFromRouteParams({ trip: ['trip:one', 'trip:two'], secret: 'secret' });

    expect(link.match(/trip=/g)).toHaveLength(2);
    expect(decodeInviteDeepLink(link).ok).toBe(false);
  });

  it('returns a rejectable link when routed parameters are incomplete', () => {
    const link = inviteLinkFromRouteParams({ trip: 'trip:one' });

    expect(link).not.toBe('');
    expect(decodeInviteDeepLink(link).ok).toBe(false);
  });

  it('keeps the manual join screen empty when there are no routed parameters', () => {
    expect(inviteLinkFromRouteParams({})).toBe('');
  });

  it('keeps raw credentials visible to strict validation after Router normalization', () => {
    const raw = 'airmesh://user:pass@join?trip=trip%3Aone&secret=secret';

    expect(
      inviteLinkForJoinScreen(raw, { trip: 'trip:one', secret: 'secret' }),
    ).toBe(raw);
    expect(decodeInviteDeepLink(raw).ok).toBe(false);
  });

  it('keeps a raw fragment visible to strict validation after Router normalization', () => {
    const raw = 'airmesh://join?trip=trip%3Aone&secret=secret#tampered';

    expect(
      inviteLinkForJoinScreen(raw, { trip: 'trip:one', secret: 'secret' }),
    ).toBe(raw);
    expect(decodeInviteDeepLink(raw).ok).toBe(false);
  });

  it('does not reuse the last deep link when the manual screen has no route parameters', () => {
    expect(inviteLinkForJoinScreen('airmesh://join?trip=old', {})).toBe('');
  });
});
