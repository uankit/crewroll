# Push wake-ups

This is the local implementation and deployment checklist. No provider credentials were read, no push was sent to a real device, and no hosted database or Worker was changed during implementation.

The existing Cloudflare Worker and PostgreSQL database dispatch native APNs/iOS and FCM/Android hints. No always-on Node process, new queue service or paid infrastructure is introduced. The existing minute cron repairs interrupted work. After a successful trip mutation or photo commit, `waitUntil` also attempts a small batch after the HTTP response, then closes that request's database pool. A push failure does not roll back the committed photo or prevent normal foreground/scheduled reconciliation.

## Configuration

`PUSH_DISPATCH_ENABLED` is checked in as `"false"` in the base and production environments. Enable only after migrations 012–013, native registration/receiver acceptance and credential setup have been verified in the intended environment. Missing or malformed credentials when enabled produce `push_dispatch_configuration_missing`; deliberately disabled dispatch is quiet. Neither condition marks a push as accepted. Pending hints retain their one-hour expiry and bounded metadata cleanup still runs.

`PUSH_PROVIDER_CREDENTIALS_JSON` is a Worker secret with this shape. These are placeholders, not usable credentials:

```json
{
  "apns": {
    "bundleId": "app.crewroll.mobile",
    "keyId": "APPLEKEY01",
    "teamId": "TEAMID1234",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "environment": "production"
  },
  "firebaseServiceAccountJson": "{\"project_id\":\"your-project\",\"client_email\":\"push@your-project.iam.gserviceaccount.com\",\"private_key\":\"...\"}"
}
```

Either platform can be configured independently, but dispatch for the other platform will retry with `PROVIDER_CONFIGURATION` and eventually dead-letter. Store this secret using the approved environment's secret-management workflow; do not commit it, paste it into command arguments or print its value. Keep `PUSH_TOKEN_ENCRYPTION_KEY_V1` unchanged: it decrypts the existing `CRWORK01` device-bound token frames and is a separate key from provider credentials, media and identity keys. Existing planned Node `APNS_*` and `FIREBASE_SERVICE_ACCOUNT_JSON` settings do not configure this Worker secret.

APNs tokens must match `environment`: sandbox for development provisioning, production for distribution/TestFlight/App Store provisioning. Do not mix those tokens in one deployment. `BadDeviceToken` can mean the wrong environment, so it does not erase a registration. `DeviceTokenNotForTopic` and authentication failures also require configuration review. Only explicit APNs 410 unregistration/expiry or FCM `UNREGISTERED` responses retire a matching token. Invalidation compares the captured token hash and device revision; APNs' invalidation timestamp also protects a later registration of the same token.

The Firebase service account needs FCM send permission for the Android app's actual Firebase project. Its OAuth URL is fixed to Google's HTTPS endpoint; any `token_uri` supplied in JSON is ignored. Android messages are restricted to `com.uankit53.airmesh`. No Firebase Admin SDK or analytics dependency is added. The binary still needs its matching Android client configuration and iOS push entitlement/provider setup before physical acceptance.

## Durable behavior

- Trip approval/readiness/start events use the existing transactional outbox. Photo commit now adds an outbox event atomically with deliveries/inbox events, excluding the source phone. Version-changing lifecycle transitions produce the same durable wake path.
- A bounded materializer expands each outbox event into one `push_wakeups` row per nominated recipient. `published_at` means durable fan-out, not push delivery or photo save. Device save receipts remain the only delivery-completion evidence.
- The only hint fields are `type: "crewroll.sync.v1"`, `deviceId`, `tripId` and stable `eventId`. They contain opaque UUIDs. No names, photos, signed URLs, invite codes, credentials or account identifiers are sent in the payload. Receivers must validate current account/device/trip scope and consent, then reconcile authenticated server state.
- Leases last two minutes and use compare-and-set completion. A crash can cause a duplicate hint after lease expiry; event identity stays stable. Provider acceptance cannot prove device receipt. APNs/FCM collapse hints per device/trip, and the server defers follow-up accepted hints for at least 60 seconds. At most 100 older pending rows are coalesced after acceptance; a failed or nearly expired old wake cannot absorb a newer commit.
- A hint expires within one hour of its originating event and no later than trip hard deletion. Temporary failures use exponential backoff, bounded jitter and provider `Retry-After`. APNs 5xx waits at least 15 minutes. Eight attempts exhaust a row into `DEAD_LETTERED`; expiry and ineligible recipients have separate outcomes.
- Account suspension/deletion, device revocation, background credential expiry, membership/device changes and token rotation are checked before send and again after decryption. A mutation racing an already-started provider request cannot retract that request; the hint contains no content, and the receiver must reject stale scope.
- Token PATCH requests reserve a per-device database counter before protection and commit only if their revision is newer than the last successful token write. A delayed older request cannot overwrite a newer rotation or clear; a newer failed protection does not block an earlier valid write. The counter and committed revision survive database backup/restore. Token invalidation also compares the committed revision, including same-token registrations within one clock second.
- Each post-response run claims at most four rows; a scheduled run at most 16, with at most four concurrent provider operations. Each provider HTTP request, including its body, has an eight-second deadline and a 16 KiB response limit. Completed outbox/child metadata older than seven days is removed in bounded batches of 200. Expired pending rows are retired in bounded batches, including while dispatch is disabled.

## Verification and activation

1. Run source, contract, migration and unit checks, then real disposable PostgreSQL integration tests. Verify concurrent materialization/claim, lease expiry and stale acknowledgements; retry and dead-letter behavior; account suspension/revocation; token rotation and same-token registration; transactional photo fan-out; and the old-expiring/new-photo race. Unit tests inject transport responses and never contact APNs, FCM or Google OAuth.
2. Verify the locally built app registers the native token to the current authenticated device, handles token refresh and sign-out, and rejects stale/foreign hints without activating sharing or changing consent. Notification denial must preserve foreground and scheduled transfer paths.
3. With separate cloud/deployment authorization, reconcile credentials and client configuration, apply migrations 012–013 to the intended environment, deploy with dispatch still disabled, and check health and existing photo workflows. Enable dispatch for a test environment and representative devices first.
4. Observe first-photo delivery while the recipient is foregrounded, backgrounded and locked on both platforms. Exercise network loss, provider throttling, expired credentials, token replacement, sign-out, account switching and force-stop/reopen. Compare original hashes and actual system-library save receipts. APNs' silent background notifications and normal-priority FCM are best effort and can be delayed or dropped; no continuous-background guarantee follows from a successful send.
5. Monitor before wider activation. Roll back by setting `PUSH_DISPATCH_ENABLED` to `"false"`; foreground/native scheduled work continues. Do not rotate the token-encryption key as a rollback mechanism.

Inspect only aggregate counts and owned error codes. `push_dispatch_completed` includes accepted, retried, retired, failed and configuration-error counts; `push_dispatch_failed` identifies a run that needs cron recovery. Alert on persistent configuration errors, increasing due backlog/oldest age, repeated provider failures and dead letters. Distinguish `SENT` (provider acceptance), `COALESCED`, `EXPIRED`, `INELIGIBLE`, `INVALID_TOKEN` and `DEAD_LETTERED` in database counts. Do not log token frames, plaintext tokens, provider bodies, payloads or signed request URLs. Tune batch/retention settings from measured traffic and current billing before adding infrastructure.

## Provider references and proof boundary

[Apple's APNs request documentation](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) requires HTTP/2, background push type and priority 5. [Apple's response documentation](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns) defines unregistration timestamps and retry behavior. [FCM's HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [Android message configuration](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#AndroidConfig), [error codes](https://firebase.google.com/docs/cloud-messaging/error-codes) and [Google service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account) define the Android transport.

Cloudflare's maintainer explains [production Workers' HTTP/2 proxy behavior and local workerd's limitation](https://github.com/cloudflare/workerd/issues/4841). The Worker uses `fetch`; it never imports the non-functional `node:http2` stubs. Local Worker/R2 and injected provider tests cannot establish live APNs HTTP/2 compatibility, credentials or physical push delivery. Those remain explicit environment acceptance checks. The client follows [Expo SDK 57 notification APIs](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/), not Expo Go.
