# Clerk Expo session-token compatibility gate

CrewRoll accepts the ordinary session JWT returned by `@clerk/expo`'s
`getToken()`. API-002 does not configure or require an `aud` claim, a custom JWT
template, `CLERK_AUDIENCE`, or a Clerk dashboard mutation. Automated tests sign
synthetic RS256 tokens and perform no Clerk or other external network calls.

Before production release, run a separate compatibility gate against the
configured Clerk instance with one signed-in physical iOS Expo 57 client and
one signed-in physical Android Expo 57 client. On each platform:

1. Obtain the ordinary `getToken()` session token in memory.
2. Send it only as `Authorization: Bearer <token>` to the production verifier
   and complete `POST /v1/devices` with a valid native registration body.
3. Record only environment, platform, Expo SDK version, app version, time, and
   pass/fail plus HTTP status.

Never print, decode into logs, persist, or attach the JWT or its subject. The
exercise is read-only with respect to Clerk: do not alter claims, create a JWT
template, change authorized parties, or mutate provider configuration. This
manual iOS-and-Android observation is a required compatibility gate; synthetic
test success is not a substitute.
