# CrewRoll AWS Staging Foundation Design

**Date:** 2026-09-01

**Status:** Approved for implementation after the explicit zero-container decision

## 1. Outcome

CrewRoll needs one durable, production-shaped staging control plane today so one physical iPhone and one physical Android phone can complete the real create, join, approval, full-photo readiness, Start, ACTIVE, restart recovery, and sign-out-erasure journey.

The accepted deployment is the existing Node 22/Fastify API on AWS Elastic Beanstalk's managed Node.js 22 Amazon Linux 2023 platform, backed by private RDS PostgreSQL 17. The release artifact is an immutable API-only source ZIP stored as a versioned KMS-encrypted S3 object. Cloudflare remains authoritative DNS and publishes only `api.staging.crewroll.app` after health and migration gates pass.

This design uses no Docker daemon, Dockerfile, Compose file, OCI image, registry, ECS, ECR, Fargate, or Testcontainers in repository code, local testing, CI, packaging, Terraform, or deployment. AWS may internally implement a managed service with infrastructure that is opaque to us; that does not change the zero-container repository and deployment contract.

This is a staging trip-room checkpoint, not production readiness and not `WOW-001`. The encrypted photo-transfer milestone remains next.

## 2. Fixed scope and account boundary

- Region is `ap-south-1` only.
- The account ID is verified out of band before every live phase.
- Authentication must be for the AWS account associated with `uankitu@gmail.com`; any VectaTech or other account identity blocks work.
- Every supported resource is tagged `Project=CrewRoll`, `Environment=staging`, and `ManagedBy=Terraform`, with names prefixed `crewroll-staging-`.
- CrewRoll receives a dedicated VPC. Default VPCs and unrelated buckets/resources remain untouched.
- Cloudflare may create only ACM validation records and the DNS-only API CNAME. Apex, `www`, `go`, relay, site, email routing, MX, SPF, and DKIM are out of scope.
- The existing Clerk Development application and EAS project `fe1de141-5c42-4250-9c1f-f7313845dc8e` are reused. No second project/application is created.
- No production environment/account is created.

## 3. Chosen topology

```text
Physical Expo 57 iOS/Android development or preview build
                            |
                            | HTTPS api.staging.crewroll.app
                            v
                Cloudflare DNS-only CNAME
                            |
                            v
        ACM TLS -> AWS WAF -> public managed ALB
                            |
                            v
       Elastic Beanstalk load-balanced environment
          Node.js 22 on Amazon Linux 2023
        min/desired 2, max 4 private instances
               |                         |
               |                         +-> NAT -> Clerk/external APIs
               v
          private RDS PostgreSQL 17
         isolated private DB subnets

Versioned/KMS S3 artifact -> immutable Beanstalk application version
Secrets Manager -> Beanstalk application environment secrets
SSM -> closed, allowlisted diagnostics only
CloudWatch -> health, application, WAF, RDS and cost evidence
```

Only the ALB accepts Internet traffic. Application instances and RDS have no public IP. Port 5432 accepts traffic only from the exact Beanstalk instance security group.

## 4. Why Elastic Beanstalk

Elastic Beanstalk supplies a managed Node 22 deployment path without requiring us to build or operate container artifacts. It gives the milestone a load-balanced multi-instance service, immutable application versions, deployment health/rollback, Auto Scaling, instance profiles, SSM-managed hosts, and normal Node process semantics while retaining external private RDS.

The live platform is not guessed. At each service plan/apply, an account/region-bound resolver lists and describes supported AWS platforms, then returns the actual ARN for branch `Node.js 22 running on 64bit Amazon Linux 2023`. The current reviewed platform is branch version `6.11.7` with Node `22.23.2`, status `Ready`, and owner `AWSElasticBeanstalk`. If AWS advances, withdraws, retires, or changes that platform, planning fails until the version/runtime change receives review. Terraform never accepts a caller-invented platform ARN.

Rejected approaches for this checkpoint:

- A local tunnel would make the Mac and local database runtime dependencies.
- A serverless/runtime port would introduce lifecycle and database compatibility seams today.
- Container tooling and container orchestrators are explicitly rejected by the user's zero-container decision.
- A managed external application database such as Supabase is unnecessary here because the selected AWS topology already has private RDS; it may be reconsidered in a separate architecture change, not mixed into this foundation.

## 5. Immutable API-only release artifact

A clean reviewed Git commit produces a deterministic ZIP with this exact logical boundary:

```text
Procfile
package.json
npm-shrinkwrap.json
.npmrc
service/src/**/*.js
vendor/crewroll-contracts/package.json
vendor/crewroll-contracts/dist/**/*.js
certs/global-bundle.pem
.platform/hooks/prebuild/10-install-rds-ca.sh
.platform/hooks/predeploy/10-verify-tls-migrate.sh
```

`Procfile` is exactly:

```text
web: node service/src/api/main.js
```

The runtime package contains only production dependencies and binds `@crewroll/contracts` to the included compiled local package. A shrinkwrap pins every transitive dependency. The closed `.npmrc` contains only `ignore-scripts=true`, `omit=dev`, `fund=false`, and `audit=false`. Elastic Beanstalk performs a shrinkwrap-backed `npm install` and must honor those settings; pre-upload verification separately uses `npm ci --omit=dev --ignore-scripts`. Arbitrary lifecycle scripts are not executed. Import-graph policy removes/rejects currently unused `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@js-temporal/polyfill`, `@opentelemetry/sdk-node`, `firebase-admin`, and `pg-boss` unless a reviewed accepted API path becomes reachable. The ZIP excludes TypeScript declarations (`.d.ts`), mobile/native source, tests, source maps, development dependencies, workspaces, secrets, `.env*`, Git data, Terraform files/state/plans, caches, logs, and coverage.

The builder normalizes file order, timestamps, ownership, and modes. Two builds from the same clean commit must produce the same SHA-256. The artifact object key is:

```text
applications/<git-sha>/crewroll-control-plane-<zip-sha256>.zip
```

The private artifact bucket is versioned and KMS-encrypted with S3 Bucket Keys disabled so KMS policy can bind each exact object ARN. Beanstalk's application-version API names an S3 bucket/key, not a version parameter, so the deployment gate reads the approved object version and the current object head immediately before registration and requires identical version ID, checksums, and reviewed metadata. The deploy role has exact-object S3/KMS read both for that verification and because `CreateApplicationVersion` requires the caller to read a custom bucket. The Beanstalk EC2 instance-profile role separately has exact-object `GetObject`/`kms:Decrypt` to retrieve the application; the Beanstalk service role has neither. The content-addressed key and hashes are embedded in the unique application-version label. Evidence binds Git SHA, ZIP SHA, runtime manifest SHA, shrinkwrap SHA, S3 object version ID, and label. The runbook never overwrites an object and never reuses a label for different bytes.

Two other deterministic artifacts remain isolated from the API and from each other:

- `bootstrap/<git-sha>/crewroll-db-bootstrap-<sha>.zip` contains only the database/Secrets Manager bootstrap command and no test runner.
- `acceptance/<git-sha>/crewroll-rds-acceptance-<sha>.zip` contains only migrations/integration tests and no master-secret/bootstrap code.

Each has a separate manifest, shrinkwrap, S3 version, private instance profile, launch template/Auto Scaling group, and SSM document. Neither is a Beanstalk application version.

## 6. Node, CA, database, and migration contract

The prebuild hook verifies Node `22.23.2`, verifies the pinned public Amazon RDS CA bundle checksum, and installs it root-owned mode `0444` at:

```text
/etc/crewroll/rds-global-bundle.pem
```

Every production database process requires a PostgreSQL URL containing exactly:

```text
uselibpqcompat=true
sslmode=verify-full
sslrootcert=/etc/crewroll/rds-global-bundle.pem
```

The API, migration, TLS verifier, and migration verifier share one fail-closed parser. Missing, duplicate, downgraded, encoded, or conflicting parameters fail startup/deployment.

Elastic Beanstalk runs predeploy on every new immutable-deployment instance. Each hook runs TLS verification first, then the compiled migrator, then five-contiguous-migration verification (`001` through `005`) before the new application version becomes eligible for traffic. The current Kysely PostgreSQL migrator uses an advisory-lock wait fixed at one hour; tests preserve that honest bound. Migrations are transactional, already-applied exact names/timestamps are idempotent, and the session lock releases in `finally`. Concurrent hooks serialize safely; the design never assumes a leader or single invocation. Current Kysely history has no checksum column, so the milestone does not claim database-side checksums; immutable artifact hashes and the source migration-manifest gate protect reviewed bytes. API startup never migrates or repairs the schema. A failed predeploy hook fails that application deployment while the previous immutable version remains the rollback target.

Production API/diagnostic pools have finite `connectionTimeoutMillis=10000`, `idleTimeoutMillis=30000`, and `max=10`. Migration processes use one connection and always destroy it.

TLS acceptance proves:

- a real database connection has `pg_stat_ssl.ssl=true`;
- the CA chain is accepted;
- a negative probe opens TCP to the same parsed RDS endpoint but changes only the TLS hostname/SNI;
- only `ERR_TLS_CERT_ALTNAME_INVALID` passes the negative probe;
- DNS failure, refusal, timeout, authentication failure, or query failure cannot impersonate hostname verification;
- the negative path runs no SQL query and logs no endpoint, URL, username, certificate, raw error, or secret.

## 7. Direct PostgreSQL testing

Local integration uses a directly running PostgreSQL 17 server only at:

```text
postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17
```

The destructive test reset is allowed only when these exact variables are present:

```text
CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN=DISPOSABLE_LOOPBACK_ONLY
CREWROLL_TEST_EXTERNAL_POSTGRES_URL=postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17
```

The harness verifies loopback host, exact port/database/user, PostgreSQL major version 17, and explicit opt-in before it resets the dedicated test database. It rejects staging/remote hosts, another database, another port, or a fallback. It never installs, starts, or discovers infrastructure implicitly.

Credential-free CI has a separate direct-database lane. It installs PostgreSQL 17 from the signed official PGDG packages on the ephemeral runner, binds the dedicated cluster to port 55433, creates only role `uankit` and database `crewroll_test_pg17`, verifies `server_version_num`, exports the same two approved variables, runs the full integration suite, then drops the exact database/role and stops the cluster in an always-run cleanup step. It uses no service container and proves nothing remains listening on the dedicated port.

Managed-RDS proof uses two mutually exclusive, private, no-public-IP Auto Scaling groups with desired 0 when idle and exactly 1 when activated. Each launch template requires IMDSv2 tokens with hop limit 1, an encrypted delete-on-termination root volume, and no SSH key. Each activation creates a hard one-hour deadline enforced by an independent scheduled scale-to-zero watchdog; the normal always-run stop path is additional protection, not the only termination mechanism. The bootstrap/admin runner has no tests; it alone reads the RDS-managed master secret. Initial `bootstrap-app-db` creates or repairs the application role to the complete contract `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 VALID UNTIL 'infinity'`, removes all role memberships in either direction, verifies every catalog attribute plus password-validity state and its owned database/privileges, and only then promotes the app URL. Later `acceptance-prepare <nonce>` creates the exact database `crewroll_acceptance_<nonce>` plus an ephemeral owner with the same closed privilege contract, `CONNECTION LIMIT 20`, and password validity exactly two hours from preparation; it removes/verifies no memberships, grants no app-database CONNECT, and writes that unprivileged URL as the sole current acceptance-run secret. The bootstrap runner returns to desired 0 before tests.

The acceptance runner reads only the current unprivileged nonce URL and its test artifact. Its process/IMDS cannot obtain the RDS master, app URL, another secret, or any CREATEDB/CREATEROLE credential. Its wrapper requests the secret only with explicit `VersionStage=AWSCURRENT`; IAM denies an omitted stage, any `VersionId`, `AWSPREVIOUS`, and an unlabeled retired version. Test-only `acceptance-run <nonce>` validates URL/database/owner identity and runs migrations/full suite without create/drop authority. The runner returns to desired 0 even after failure or operator interruption through the deadline watchdog. The no-test bootstrap runner then returns for `acceptance-clean <nonce>`, terminates sessions, drops exact database/owner, verifies absence, retires the current URL stage, and returns to desired 0. Completion requires no acceptance database/role/current URL and no runner instance. This test never claims the staging application database was an integration fixture.

## 8. Network and data resources

- VPC `10.42.0.0/16` across two availability zones.
- Public subnets `10.42.0.0/24` and `10.42.1.0/24` for the managed ALB.
- Private application subnets `10.42.10.0/24` and `10.42.11.0/24` for Beanstalk instances.
- Private database subnets `10.42.20.0/24` and `10.42.21.0/24` with no Internet route.
- One NAT gateway for cost-bounded staging and one S3 gateway endpoint.
- RDS PostgreSQL 17 on `db.t4g.small`, single-AZ, encrypted, deletion-protected, seven-day backups, final snapshot, 20 GiB gp3 expandable only through 100 GiB, `manage_master_user_password=true`, and parameter `rds.force_ssl=1`.
- Single-AZ is a staging cost boundary, not a production precedent.
- The guarded media bucket is private, has no CORS/Object Lock/versioning, aborts incomplete multipart uploads after one day, and expires objects after 22 days. Current API permissions contain no media-object action.
- State, audit, artifact, access-log, and media buckets have public blocking, ownership controls, encryption, retention/lifecycle policy, `force_destroy=false`, and explicit deletion guards.

## 9. Elastic Beanstalk runtime policy

- Load-balanced environment on the live-discovered Node.js 22 AL2023 platform.
- Private instances in two application subnets; no public instance IP.
- Auto Scaling minimum/desired 2 and maximum 4.
- Immutable deployment policy and enhanced health.
- ALB health path `/health/ready`; environment must be `Ready/Green` with two healthy targets before DNS publication.
- Previous immutable application versions and source-object versions remain available for rollback.
- External RDS is never coupled to the Beanstalk environment lifecycle.
- The service role and EC2 instance profile are separate and have no access keys.
- SSM is enabled for allowlisted diagnostics only; interactive shell, arbitrary command, port forwarding, and broad parameter access are forbidden.
- No background worker is invented until the repository has an accepted worker entrypoint.

The instance profile reads exactly seven runtime secrets:

```text
DATABASE_URL
BACKGROUND_CREDENTIAL_HMAC_KEY_V1
INVITE_CODE_HMAC_KEY
CLERK_SECRET_KEY
CLERK_WEBHOOK_SECRET
CLERK_ISSUER
CLERK_AUTHORIZED_PARTIES_JSON
```

They are delivered only through `aws:elasticbeanstalk:application:environmentsecrets`. Plain environment contains only Node mode, host, port, log level, AWS region, and the exact runtime KMS key ID. APNs, Firebase, media bucket, debug CORS, endpoints, URLs, and secret values are absent.

`CLERK_AUTHORIZED_PARTIES_JSON` is canonical `[]` when the safe development inspector observes an ordinary Expo token with absent `azp`; if `azp` is present, it is the canonical array containing the exact observed HTTPS origin. Absent claim follows the accepted absent branch. Present claim must match the configured list and therefore fails against `[]`. Issuer is never guessed as an authorized party.

Terraform creates secret metadata and permissions, never external secret values. RDS manages its master secret. The no-test bootstrap runner alone uses it to create/promote the app URL and prepare/clean nonce-scoped acceptance databases/URL stages; it returns to desired 0 before and after tests. The test-bearing acceptance runner sees only one current unprivileged nonce URL and returns to desired 0 after the test run. API roles see neither private-runner secret. The deployment role can add external provider/HMAC secret versions but cannot read them. Provider secrets are entered via no-echo stdin only after the exact destination is shown and fresh action-time confirmation is received.

## 10. Edge, logging, and observability

- ACM issues `api.staging.crewroll.app` in Mumbai.
- Port 80 redirects unconditionally to 443.
- Port 443 uses `ELBSecurityPolicy-TLS13-1-2-2021-06` and the ACM certificate.
- WAF uses AWS managed Common, Known Bad Inputs, and IP Reputation groups plus an IP rate limit of 2,000 `/v1/` requests per five minutes.
- Sampled requests are disabled at every WAF level.
- WAF logging redacts authorization, cookie, and all Svix signature headers.
- Controlled canaries prove WAF and application logs contain no JWT, invite, background bearer, push token, database URL, secret, raw provider error, or redacted header value.
- Application logs retain 30 days; ALB/WAF logs retain 90 days.
- ALB access logs use S3 SSE-S3 (`AES256`) because ALB delivery does not support a customer-managed key for that destination. Its bucket policy grants only the current ALB log-delivery service principal to the exact account/prefix and denies insecure transport.
- WAF and application CloudWatch logs use separate customer-managed KMS keys.
- Health/capacity/deployment, ALB targets/latency/5xx, NAT, RDS CPU/storage/connections/free space, WAF, root activity, anomaly, and budget alarms are enabled.

## 11. Terraform and state structure

```text
infra/terraform/
  bootstrap/
    backend.tf
    main.tf
    variables.tf
    outputs.tf
    versions.tf
    tests/bootstrap.tftest.hcl
  modules/control-plane/
    network.tf
    database.tf
    storage.tf
    identity.tf
    secrets.tf
    elastic-beanstalk.tf
    ephemeral-runners.tf
    edge.tf
    observability.tf
    ssm.tf
    variables.tf
    outputs.tf
    versions.tf
    tests/data-foundation.tftest.hcl
    tests/runtime-edge.tftest.hcl
  environments/staging/
    backend.tf
    providers.tf
    main.tf
    variables.tf
    outputs.tf
    versions.tf
    infracost-usage.yml
    tests/staging.tftest.hcl
```

Remote state uses a dedicated versioned S3 bucket, SSE-KMS, block public access, and `use_lockfile=true`. Backend configuration contains no nested assume role because the selected final profile already supplies the deploy-role session. The migration uses `terraform init -migrate-state`, preserves a mode-0600 checksum backup, compares lineage/serial/non-secret address inventory, and deletes local source state only after equality and a zero-drift remote plan.

Workload phases are:

1. `foundation`: network, RDS, KMS, guarded buckets, secret metadata, logs/alarms, ACM and validation DNS. No application version/environment/API CNAME.
2. `bootstrap-runner-start/stop`: scale only the no-test admin group 0→1→0 for app bootstrap or acceptance prepare/cleanup.
3. `acceptance-runner-start/stop`: scale only the unprivileged test group 0→1→0; it is mutually exclusive with bootstrap.
4. `service`: exact API S3 object evidence and live-discovered platform create the immutable application version and environment. DNS remains false.
5. `publish-dns`: creates exactly one DNS-only API CNAME after health gates.
6. `rollout`: adds a new immutable application version and updates only the exact environment.
7. `withdraw-dns`: removes only the API CNAME.
8. `drift`: expects no changes with explicit current deployment variables and both runner groups desired 0.

Every apply uses a saved reviewed plan. Immediately before apply, the operator displays its SHA-256 and add/change/destroy counts. `-auto-approve`, unsaved plans, ambient profiles, default phase values, and provider secrets in variables are forbidden.

## 12. IAM and account bootstrap

The durable chain is:

```text
crewroll-operator-login
  -> crewroll-operator-process
  -> MFA crewroll-staging-role
  -> crewroll-staging-deploy
```

Terraform/provider/backend consume only the final profile. The operator has console login, required password reset, MFA, no access key, exact attachment of AWS-managed `SignInLocalDevelopmentAccess`, and separate permission only to assume the first one-hour CrewRoll role. AWS CLI >=2.32 obtains the first profile through `aws login`; a `credential_process` exports only process-format temporary credentials into the MFA operator-role profile, which is the source of the final one-hour deploy-role profile. No config or credentials file contains an access-key pair. Root is not routine deployment authentication.

The deployment policy is an explicit action/resource/condition matrix for state, bootstrap refresh, network, RDS, Beanstalk, platform discovery, S3 artifacts, exact role passing, ALB reads/WAF association, ACM, logs/alarms, KMS, secret metadata/version writes, allowlisted SSM, and bounded workload IAM. It requires Mumbai and exact request/resource tags wherever AWS supports them. It omits data/database/bucket/key deletion, IAM users/access keys, secret reads, interactive SSM, arbitrary commands, broad role passing, and mutations outside CrewRoll boundaries.

The final policy is parsed by tests, validated by IAM Access Analyzer, and simulated for representative allowed/denied calls before workload apply. Any destructive exception requires a separately reviewed temporary policy plus fresh action-time confirmation.

Root key last-used inspection is read-only. Exact deactivation and deletion each require a fresh confirmation naming the key ID, performed from verified root/bootstrap proof, never through the deploy role. The account also gets CloudTrail root alerts, Access Analyzer, anomaly controls, and budget alerts at 50%, 80%, 100%, and 100% forecast of USD 200.

## 13. Cost gate

Before the first foundation apply, Terraform creates a complete non-applied `service` cost-envelope plan with DNS false and locked placeholder coordinates for all three artifacts. Plan policy rejects any apply, delete/replace, early DNS, missing paid resource, invented platform, or mutable artifact.

Pinned Infracost `0.10.45` consumes one committed conservative usage file covering one NAT, two managed API instances, conservative hours for both mutually exclusive runners, ALB, WAF, RDS/storage/backups, S3 storage/requests, CloudWatch ingestion/storage/scans, Secrets Manager calls, and transfer. Missing/unresolved resources, zeroed assumptions used to suppress cost, non-USD output, or monthly total at/above USD 200 blocks foundation. Budget alerts monitor; they are not a hard cap.

## 14. Deployment flow

1. Verify clean reviewed source, lockfiles, no-container policy, deterministic archive, and exact Expo 57/native gates.
2. Run the full direct local PostgreSQL 17 suite at the exact loopback URL with explicit opt-in.
3. Verify Terraform/tests/policies and the complete pre-foundation cost envelope.
4. Bootstrap state, non-root operator/deploy role, audit/analyzer/budget; migrate state and prove non-root operation.
5. Apply foundation only and verify private RDS, guarded storage/KMS, ACM validation, logging, alarms, and no runtime/DNS.
6. Observe ordinary Clerk `azp` safely and populate the six operator-provided runtime secret versions; provider-secret transfers require action-time confirmation.
7. Build all three deterministic ZIPs twice, upload once to separate content-addressed S3 keys, and record object versions.
8. Scale the no-test bootstrap runner to one, create/promote the app database URL, then scale it to zero after an exact saved-plan/destructive confirmation. Require all seven API secrets current.
9. Discover and validate the current supported Node.js 22 AL2023 platform ARN; never invent it.
10. Apply service with DNS false. Prebuild installs the CA; every-instance predeploy verifies TLS, migrates under the one-hour Kysely lock, then verifies five migrations.
11. Wait for Ready/Green and two healthy targets; run allowlisted API TLS/migration diagnostics.
12. For managed-RDS integration: bootstrap prepare nonce and stop; unprivileged acceptance test and stop even on failure; bootstrap cleanup nonce and stop. Every stop has exact saved-plan/destructive confirmation. Require both groups desired 0 and no database/role/current URL.
13. Probe the final hostname against ALB before DNS; then publish exactly one DNS-only CNAME and recheck public behavior.
14. Reuse the existing Clerk/EAS projects, register/replay the Clerk webhook, and set only the public API origin and publishable key in EAS development/preview.
15. Run physical development and preview journeys, including accepted-response loss/restart and native session erasure.
16. Re-run drift with exact profile/variables, remove only exact temporary artifacts, log out operator, and prove fresh MFA after the one-hour role session expires.

## 15. Physical acceptance

The mandatory gate uses one physical iPhone and one physical Android phone. Two phones are a cross-platform minimum, not a room limit: the API enforces at most ten trip members including the owner, and an optional 3–10-phone fan-out may be added without delaying today's pair.

Development accounts A/B prove:

- ordinary Clerk session and real device registration;
- CREATE accepted-response loss across the built-in identical retry, force quit, and outcome reconciliation without a third create;
- JOIN accepted-response loss, force quit, and exact replay;
- Expo 57 full-photo permission mapping and readiness journal recovery;
- START accepted-response loss while the peer reaches ACTIVE;
- Elastic Beanstalk `restart-app-server` plus RDS reboot before retained START recovery;
- auth revocation and explicit sign-out erase only the selected native session while preserving identity/trip keys;
- offline relaunch cannot resume a background bearer.

Fresh preview accounts C/D repeat the ordinary full journey. Expo Router still discovers the acceptance route file, but in preview/production it immediately redirects, obtains no token, dynamically imports/allocates/reads no development control, and cannot arm a cut. Optional extra phones join sequentially; an eleventh member fails `TRIP_FULL`.

Evidence includes only safe hashes, build IDs, versions, request/command IDs, timestamps, platforms, statuses, and pass/fail. It excludes emails, tokens, invite codes, device fingerprints, database values, secrets, and sensitive screenshots.

## 16. Rollback and failure behavior

- Failed predeploy checks prevent the new application version from serving.
- Failed environment health returns to the previous immutable application version or leaves the new environment unpublished.
- Rollback selects a prior immutable S3-version-backed application version; it never overwrites an object or label.
- Traffic withdrawal removes only the API CNAME and retains application versions, artifact versions, ACM validation, RDS, state, logs, and keys.
- A failed migration is repaired only by a separately reviewed forward migration.
- RDS deletion protection/final snapshots, bucket/key/state guards, and absence of destructive standing permissions remain mandatory.
- SSM acceptance cleanup fails the checkpoint if its disposable database remains.

## 17. Acceptance gates

Infrastructure:

- exact account/region and zero unrelated drift;
- private RDS and instances, public ALB only;
- live-discovered reviewed platform, immutable artifact/version evidence;
- min/desired 2 and max 4, Ready/Green, two healthy targets;
- WAF/TLS/log redaction, alarms, cost below USD 200;
- no container tooling/artifacts/resources in active repository/deployment paths.

API/persistence:

- public live/ready health;
- real verify-full RDS TLS and same-endpoint hostname rejection;
- exactly five migrations before service readiness;
- direct local PostgreSQL 17 and disposable managed-RDS acceptance suites pass;
- Clerk webhook valid/duplicate/invalid behavior;
- app-server restart and RDS recycle preserve idempotent trip recovery.

Mobile/privacy:

- development and preview iOS/Android pair journeys pass;
- full photo permission is required before Ready;
- accepted-response recovery replays exact commands only;
- foreground work stops when backgrounded/ACTIVE;
- native share failures are contained;
- revocation/sign-out erases selected native session and offline relaunch remains signed out.

## 18. Explicit exclusions

- No production environment/account.
- No alternative runtime/database migration hidden inside this milestone.
- No background worker until an accepted entrypoint exists.
- No media-transfer feature beyond the guarded empty staging bucket.
- No provider secret in source, Terraform state/plan, output, logs, evidence, or chat.
- No unrelated AWS/Cloudflare deletion or mutation.
- No claim that this checkpoint completes `WOW-001`.

## 19. Authoritative references

- Existing CrewRoll blueprint: `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md`
- Existing control-plane plan: `docs/superpowers/plans/2026-08-28-crewroll-control-plane.md`
- Product milestone backlog: `docs/TECHNICAL_TASKS.md` (`WOW-001`)
- Elastic Beanstalk Node platform: <https://docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html>
- Elastic Beanstalk platform hooks: <https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.hooks.html>
- Elastic Beanstalk environment secrets: <https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/AWSHowTo.secrets.html>
- Terraform S3 backend and lockfile: <https://developer.hashicorp.com/terraform/language/backend/s3>
- Amazon RDS PostgreSQL SSL: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html>
