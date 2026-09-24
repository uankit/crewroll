# Account deletion and safety operations

The app and `https://crewroll.app/delete-account` use the same authenticated deletion endpoint. A random receipt remains usable after sign-out. Background cleanup revokes Apple access before deleting the Clerk identity, removes account records and temporary objects, and retries provider or storage failures. It cannot recall originals already saved in anyone's system photo library.

Production uses the `crewroll_production` database, `crewroll_prod` application role, `crewroll-api-production` Worker and `crewroll-production-ciphertext` bucket. The earlier beta retains its separate Clerk instance, database and bucket. Do not point an existing beta runtime at production or claim its accounts were migrated.

## Daily review

The operator must check unresolved in-app reports and `support@crewroll.app` daily, and handle urgent safety reports promptly. Email Routing forwards this address to the owner's verified inbox. There is no automatic image inspection or moderation team: photo contents are encrypted and reports contain the reason, optional text and identifiers.

Build the control plane, then run the operator CLI with a restricted production database connection. Use TLS `sslmode=verify-full` and the provider's CA certificate. Load credentials from protected local storage; do not paste them into shell history, reports or Git.

```sh
node tools/review-safety-reports.mjs list
node tools/review-safety-reports.mjs remove-photo REPORT_UUID
node tools/review-safety-reports.mjs ban-member REPORT_UUID
node tools/review-safety-reports.mjs dismiss REPORT_UUID
```

The three actions above only preview the target. Append `--apply` after reviewing a specific report. `DATABASE_URL` is required; banning also requires the corresponding `CLERK_SECRET_KEY`. A ban revokes Clerk sessions, suspends the local account, revokes devices and ends its participation. Removing a photo stops pending deliveries and schedules its temporary copies for deletion. Saved originals remain with their recipients. Do not promise their recall.

If a report describes imminent danger or suspected child exploitation, preserve only necessary evidence and follow the applicable reporting and emergency process. Do not request private photos or credentials by email. Document the decision before resolving the report. Resolved reports expire after 90 days.

## Deletion failures

Review pending jobs whose `available_at` is overdue and the Worker's sanitized cleanup errors. Jobs retain a lease and exponential retry delay; do not mark one complete manually. Confirm the matching Clerk instance, object bucket and seven production secrets before retrying. `apple_grant` is an encrypted checkpoint, never an operator-readable token. Retain the background credential key while outstanding checkpoints exist.

For pre-production Apple accounts created through the earlier native-only login flow, provider grants may be unavailable. Complete personal-data deletion and give the user Apple's instructions for removing CrewRoll from Sign in with Apple in their Apple Account settings. Do not claim an unavailable provider grant was revoked. New production sign-in uses Clerk's OAuth flow so the provider grant is available to the deletion worker.

Deletion receipts expire after 30 days. Hashed deleted-account identifiers expire after 90 days to prevent late events recreating accounts. Rate-limit records expire after one day. Check that the minutely scheduled cleanup continues to succeed.

## Release boundaries

Version 1.0.4 includes native account erasure and uses runtime isolation. Build new iOS and Android binaries; never publish its JavaScript to runtime 1.0.3. Test the new binaries for sign-in, consent, report/block, deletion, and a host/join photo transfer before public rollout. Automated checks and upload success do not establish physical camera/background acceptance or store approval.

The production database shares existing Supabase compute. Hyperdrive caching remains disabled for mutable trip state, with a ten-connection production limit. Each trip reserves at most 5,000 photos and 20 GiB, including pending uploads; retries reuse their reservation. Storage and request costs still depend on active trips and deliveries. No paid plan upgrade is part of this change.
