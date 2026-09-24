# CrewRoll UX and performance follow-up — 23 September 2026

Implemented against the existing working tree. Existing user changes were preserved. The iPhone is running the updated JavaScript through Metro; no native release or production Worker deployment was made.

## Screens and audit fixes

- **Host lobby (71):** “Who’s coming along?” is the top heading. Removed the repeated trip name, gathering badge and empty notification bell. The current account reads “You · Host”; “Sync Host” was the QA account name. Three decorative dotted rows appear while alone; joined and waiting members replace them. Pending requests retain their notification action.
- **Invite (39):** the code and Copy button lead. Trip name/date/time use small secondary text. Copy feedback changes the button label without resizing the sheet.
- **UX-01:** the iOS screen now resizes its content above the software keyboard. Verified Create trip stayed visible and worked while the keyboard was open. Done dismisses the keyboard; the explicit Create button submits.
- **UX-02:** Start trip uses a visible secondary button, with explanations for permission checks, missing access, pending approval, missing devices and unavailable actions. Eligible solo hosts can start; the screen explains that others may join later. The original report’s “disabled” observation included an enabled text button that looked disabled.
- **UX-03:** the current member’s readiness uses the current phone permission before the server catches up. Revoked access visibly showed “Photo access needed”; Home now says “Gathering your crew” instead of implying readiness.
- **SIM-01:** added the manual Settings path and a visible error when Settings cannot open. The supported Expo Linking.openSettings API still opens general Settings on this simulator. This is mitigated, not certified fixed on a physical iPhone. No private Settings URL was introduced.

## PERF-01

Implemented three bounded improvements:

1. Seed Home’s account/device-scoped trip query from the fresh launch recovery response, avoiding an immediate duplicate trip-list request. It stays fresh for five seconds and is cleared on account changes.
2. Poll Home only when the screen is visible and the app is active. Previously the mounted Home route could keep requesting the library every five seconds under another screen: up to 720 avoidable requests per hidden-screen hour per client.
3. Reuse the public Clerk signing-key resolver across requests in a Worker isolate. Previously a new request runtime recreated its JWKS cache. Tokens are still verified individually, including issuer, signature, expiry and authorized parties; database pools and actors remain request scoped. The library retains its ten-minute key cache and rotation behavior.

The third change is **implemented and tested, not deployed**. The working tree also contains pre-existing backend changes (including cleanup migration 009 and storage protocol changes). A full-tree deploy would publish that wider batch. This follow-up does not silently deploy it.

Cold reopen on the current development build: Expo launcher visible at the 2-second capture, native splash at 3 seconds, app loading at 5.001–5.114 seconds, saved Home/trip visible by 8.002–8.111 seconds. The old report observed a trip-loading screen at 4.675 seconds and a restored trip by 10.114 seconds. These are coarse observations from different runs, not a controlled benchmark or a proven speedup. Release-build startup remains open; the Mac has approximately 250 MB free and cannot support a fresh Android/native build. Cloudflare capacity changes alone are not justified by the measured API latency.

## Cloudflare review

Read-only inspection confirmed deployed version `fb9456eb-20fe-4f0b-ae39-7f83d891571f` from 16 September, Standard usage model, targeted placement (the local config targets AWS Seoul), a 20-origin-connection Hyperdrive pool, query caching disabled, one-minute cleanup, private APAC R2 Standard storage, 30-second CPU limit, logs at 100% sampling with invocation logs disabled, and traces disabled.

Seven-day Cloudflare analytics, 16 September 04:58 UTC to 23 September 04:58 UTC (adaptive sampling; values are estimates):

| Metric                        |            Observed |
| ----------------------------- | ------------------: |
| Worker requests               |              88,660 |
| Worker execution errors       |                   0 |
| CPU total                     |      901,807.896 ms |
| CPU median / p95              |   9.264 / 16.721 ms |
| Request duration median / p95 | 73.041 / 127.357 ms |
| Wall time median / p95        | 78.153 / 321.799 ms |
| R2 current objects / size     |             0 / 0 B |

Worker execution errors are not equivalent to application HTTP errors. Worker request duration excludes the phone’s full network and startup path. GraphQL timing units were checked against its schema; `durationP95` is GB-seconds and was not misreported as latency.

**Keep:** Hyperdrive, query caching off for permission/membership correctness, placement near PostgreSQL, and one-minute cleanup for expiry. No evidence from this sample warrants raising the pool or CPU limit. Pool utilization itself was not measured. Rewriting Fastify, adding Durable Objects, or moving databases is not supported by these measurements.

**Follow up:** R2 currently has only a seven-day incomplete-multipart abort rule, with no object-age expiry backstop. Confirm a safe maximum ciphertext/tombstone lifetime before adding one; arbitrary deletion can break pending saves. Keep application expiry authoritative. Add sampled phase timings for a release startup measurement before tuning infrastructure. A smaller API CPU cap could contain runaway cost, but needs separate worst-case cleanup measurements first.

## Cost

At the measured seven-day pace, a simple 30-day projection is about **380,000 requests and 3.86 million CPU milliseconds**. CrewRoll alone stays under the Standard included 10 million requests and 30 million CPU milliseconds. Published Workers Paid pricing starts at **US$5 per account per month**; incremental CrewRoll overage at this pace would be zero if other account workloads do not consume the shared allowances. Hyperdrive is included. This is a price estimate, not the actual bill. The subscription/billing API returned an authentication error with the current OAuth permissions. Supabase, Clerk, taxes and other Cloudflare projects are not included.

R2 Standard includes 10 GB-month, 1 million Class A and 10 million Class B operations monthly; beyond that, storage is US$0.015/GB-month, Class A US$4.50/million and Class B US$0.36/million, with free egress. An empty current bucket does not prove zero historical operation charges. Standard is appropriate for short-lived staging; Infrequent Access has a 30-day minimum and retrieval fees.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Expo 57 Linking](https://docs.expo.dev/versions/v57.0.0/sdk/linking/), [jose remote key resolver](https://github.com/panva/jose/blob/main/src/jwks/remote.ts).

## Validation

- Six targeted app suites: **167 tests passed**, including local permission versus stale server state, disabled Start explanations, account-scoped launch cache, and hidden/background polling.
- Authentication suite: **39 tests passed**, including reuse across request verifiers, key-cache expiry and invalid-token rejection.
- App/control-plane and Worker TypeScript checks passed. Scoped app and backend lint passed. Formatting and whitespace checks passed.
- Worker dry-run bundle passed (approximately 955 KiB gzip); no deployment. Local Worker startup profiling measured an 81.5 ms window with 38.9 ms active time, including 3.8 ms garbage collection. This is a local profile, not a Cloudflare cold-start SLA.
- Live iPhone checks: create with keyboard visible, new lobby, invite/copy feedback, revoked permission, reopening and trip persistence. Full Photos access was restored through the native permission prompt, and the ready lobby was verified at the end.
- Android/cross-platform joining, physical-device Settings, real photo sync/save, and release startup timing remain unverified. The original disk-space blocker still applies. This is not a full cross-platform acceptance sign-off.
