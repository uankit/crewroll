# CrewRoll AWS Staging Foundation Design

**Date:** 2026-09-01

**Status:** Proposed for implementation after user review

## 1. Objective

Create a durable staging foundation for CrewRoll and use it to complete the
physical trip-room checkpoint. The environment must exercise the accepted Expo
57 mobile application against the real Node.js control plane, real PostgreSQL
17, the existing Clerk development instance, and AWS KMS. A local tunnel is not
acceptance evidence.

The public mobile origin will be:

```text
https://api.staging.crewroll.app
```

The staging foundation is accepted only after real iOS and Android development
builds complete sign-in, device provisioning, trip creation, invite joining,
approval, readiness, Start, restart recovery, and authorization-failure tests.
This is a production-shaped prerequisite, not the first shippable product
milestone. `WOW-001` remains the first product milestone and additionally
requires bidirectional encrypted photo transfer, exact library saves, receipts,
S3 purge, failure recovery, and full traces to pass three consecutive times on
release-signed preview builds.

## 2. Verified account and isolation boundary

The authenticated AWS account is the standalone account named
`personalprojects`. It is not the Vecta account and is not a member of AWS
Organizations. Mumbai (`ap-south-1`) and Stockholm (`eu-north-1`) currently
contain no ECS clusters, ECR repositories, RDS instances, load balancers,
Secrets Manager application secrets, customer-managed KMS aliases, or active
CloudFormation stacks. One unrelated S3 bucket exists and is outside CrewRoll
scope.

CrewRoll staging will therefore use the existing account but remain isolated by
all of the following controls:

- Region is fixed to `ap-south-1`.
- Terraform refuses to plan or apply unless the caller account ID matches an
  out-of-band `allowed_account_id` value.
- Every managed resource carries `Project=CrewRoll`, `Environment=staging`,
  and `ManagedBy=Terraform` tags where AWS supports tagging.
- CrewRoll receives a new VPC. The default VPCs and all existing resources are
  untouched.
- Resource names use the `crewroll-staging-` prefix.
- This account receives no production CrewRoll deployment. Production remains
  a separately reviewed future account and Terraform state.

## 3. Options considered

### Chosen: AWS control plane with Cloudflare DNS

Cloudflare remains authoritative for `crewroll.app`. A DNS-only CNAME and ACM
validation records point `api.staging.crewroll.app` to an AWS Application Load
Balancer. AWS runs the accepted Node 22/Fastify process on ECS Fargate, private
PostgreSQL 17 on RDS, KMS, Secrets Manager, ECR, CloudWatch, and WAF.

This matches the accepted CrewRoll blueprint and keeps PostgreSQL, KMS, and the
future encrypted S3 media plane in one provider.

### Rejected for the milestone: Cloudflare Tunnel

A tunnel would leave the Mac and local PostgreSQL as production dependencies.
It remains useful only for bounded debugging.

### Rejected for the milestone: Workers or Cloudflare Containers

Direct Workers requires a lifecycle adapter, Hyperdrive, and runtime
compatibility work. Cloudflare Containers can run the process but still needs
external PostgreSQL and AWS KMS, splitting one control plane across providers.
Neither improves this staging foundation enough to justify the additional
seams.

## 4. Runtime topology

```text
Expo 57 development builds
          |
          | HTTPS https://api.staging.crewroll.app
          v
Cloudflare authoritative DNS (DNS-only CNAME)
          |
          v
ACM TLS certificate -> AWS WAF -> public ALB (two public subnets)
                                      |
                                      v
                          ECS Fargate API service
                         two tasks, no public IPs
                           two private app subnets
                              |             |
                              |             +-> NAT -> Clerk JWKS/API
                              |                    and external providers
                              v
                    private RDS PostgreSQL 17
                     private database subnets

ECS task role -> runtime KMS operations
              -> scoped staging S3 media operations
ECS execution role -> ECR image and CloudWatch logs
                   -> exact Secrets Manager values and their decrypt keys
One-off migration task -> RDS before API rollout
```

Only the ALB accepts Internet traffic. ECS tasks and RDS have no public IPs.
RDS port 5432 accepts traffic only from the API and migration security groups.

## 5. Terraform structure

Terraform owns every AWS workload resource and its IAM policy. The initial
implementation uses these bounded units:

```text
infra/terraform/
  bootstrap/
    state.tf                 # encrypted versioned state bucket and lockfile policy
    deploy-role.tf           # temporary-credential Terraform deployment role
  modules/control-plane/
    network.tf               # VPC, subnets, route tables, NAT, endpoints
    security.tf              # security groups, WAF, ACM inputs
    database.tf              # PostgreSQL 17 and subnet/parameter groups
    storage.tf               # staging media and access-log buckets
    identity.tf              # KMS keys, task roles, execution/migration roles
    secrets.tf               # secret containers and ECS references, never values
    compute.tf               # ECR, task definitions, ALB, ECS service
    observability.tf         # logs, alarms, SNS, dashboard
    variables.tf
    outputs.tf
    versions.tf
    control-plane.tftest.hcl
  environments/staging/
    backend.tf
    foundation.tf            # network, RDS, ECR, keys, secret containers, edge
    runtime.tf               # task definitions, migration, API service and DNS
    variables.tf
    outputs.tf
```

Remote state uses a dedicated S3 bucket with block-public-access, versioning,
SSE-KMS, and `use_lockfile = true`. DynamoDB locking is not added because S3
lockfiles are the current supported mechanism and DynamoDB locking is
deprecated. Terraform state is confidential and never committed.

The Cloudflare provider owns only the ACM-validation records and the exact
`api.staging.crewroll.app` DNS record. Its scoped token is supplied through the
provider's environment variable and never stored in Terraform state or source.
The existing apex, email, site, and relay records are outside this state.

## 6. Staging resource policy

### Network

- Dedicated `10.42.0.0/16` VPC in two availability zones.
- Two public ALB subnets, two private application subnets, and two private
  database subnets.
- One NAT gateway for staging. Production will require a separate availability
  design.
- S3 gateway endpoint; interface endpoints are added only where they reduce a
  required NAT dependency without blocking external Clerk calls.

### Compute

- One immutable ECR repository with vulnerability scanning and lifecycle
  cleanup of untagged images.
- A multi-stage image pinned to Node.js 22.13.x.
- Two Fargate API tasks spread across both application subnets. Each staging
  task starts at 0.5 vCPU and 1 GiB memory; service autoscaling is bounded from
  two through four tasks and targets 60% CPU while ALB latency/request alarms
  provide a second scaling and investigation signal.
- Each task starts the compiled `services/control-plane` API with
  `HOST=0.0.0.0` and `PORT=3000`.
- ALB health checks use `/health/ready`; deployment circuit breaker and rollback
  are enabled.
- The same image defines a separate one-off migration task. Migrations never run
  during API startup.
- No background worker service is invented before the repository contains an
  accepted worker entrypoint.

### PostgreSQL

- RDS PostgreSQL 17 on `db.t4g.small`, encrypted, private,
  deletion-protected, and single-AZ for staging.
- Automated backups and point-in-time recovery are retained for seven days.
- A final snapshot is required before an intentional destroy.
- Storage starts at 20 GiB gp3 and may autoscale only through 100 GiB.
- The parameter group sets `rds.force_ssl=1`. Both the migration and API
  processes use `sslmode=verify-full` with the pinned current Amazon RDS CA
  bundle; hostname and certificate verification are exercised before rollout.
- Database credentials live in Secrets Manager. They are not committed,
  printed, or placed in Terraform variable files.

Single-AZ staging is an explicit cost boundary, not a production precedent.
Production remains Multi-AZ in a separate account.

### KMS, secrets, and storage

- Separate customer-managed KMS keys protect Terraform state and encrypted push
  token data. Rotation is enabled; destructive key scheduling uses the maximum
  practical waiting period.
- Secret containers hold `DATABASE_URL`, Clerk server credentials, the Clerk
  issuer and authorized-party JSON, both HMAC keys, APNs values, and the Firebase
  service account JSON. Terraform creates metadata and permissions but never
  embeds secret values in source.
- Because ECS resolves secret-backed environment values before the container
  starts, only the ECS execution and migration execution roles receive exact
  `secretsmanager:GetSecretValue` and required decrypt permissions. The API task
  role receives no Secrets Manager read permission and retains only runtime KMS
  and S3 permissions used by application code.
- The staging media bucket blocks all public access, uses default encryption,
  has versioning and Object Lock disabled, aborts incomplete multipart uploads
  after one day, and expires objects after 22 days. It has no browser CORS rule.
- The API task role receives only the currently required object and KMS actions.

### Edge and DNS

- ACM issues the certificate for `api.staging.crewroll.app` in Mumbai.
- Terraform's narrowly scoped Cloudflare provider creates only the ACM
  validation records and a DNS-only CNAME to the ALB hostname.
- Port 80 performs an unconditional redirect to 443. Port 443 uses
  `ELBSecurityPolicy-TLS13-1-2-2021-06` and the ACM certificate; plaintext
  forwarding is impossible.
- WAF blocks the AWS managed Common, Known Bad Inputs, and IP Reputation rule
  groups and an IP rate rule of 2,000 `/v1/` requests per five-minute window.
  Application-level authenticated command limits remain authoritative.
- WAF sampled requests are disabled. Its encrypted logging configuration
  redacts `authorization`, `cookie`, `svix-id`, `svix-timestamp`, and
  `svix-signature` headers before delivery; tests inject canaries into every
  field and prove neither WAF nor application logs retain them.
- Existing apex, `www`, `go`, relay, email-routing, MX, SPF, and DKIM records are
  not modified during staging creation.

### Cost and retention bounds

- RDS, ECS, storage, and autoscaling cannot exceed the bounds above without a
  reviewed Terraform change.
- CloudWatch application logs retain 30 days, ALB/WAF access logs retain 90
  days, and incomplete or expired storage follows the explicit lifecycle rules.
- Before apply, an Infracost estimate (including one NAT gateway, ALB, WAF,
  two continuously running API tasks, RDS, logs, and storage) must remain below
  the USD 200 monthly alert threshold. Any higher estimate stops the apply.
- The budget alerts at 50%, 80%, 100%, and 100% forecast are monitoring, not a
  spending cap; anomaly detection and service alarms provide earlier signals.

## 7. Account security bootstrap

The account currently has root MFA enabled, but also reports one root access
key, no non-root human identity, and no budget. No workload is deployed until
these gates are closed:

1. Authenticate the local CLI using `aws login --profile crewroll-staging`,
   which provides temporary console-backed credentials. Do not overwrite the
   existing default/Vecta profile.
2. Create one non-root `crewroll-operator` IAM console identity with its own MFA,
   no access keys, and permission only to view the account and assume the named
   Terraform deployment role. Require a password reset at first sign-in. This
   is the durable human credential source until the account later adopts an
   organization-wide workforce identity provider.
3. Trust the deployment role only from that exact operator principal with MFA
   present and a one-hour maximum session. Use the operator's console session
   with `aws login --profile crewroll-staging`, then assume the deployment role;
   root is no longer part of routine CLI or deployment authentication.
4. Create separate ECS execution, API task, and migration roles with explicit
   policies. There are no application access keys.
5. Add an account budget using the account's existing primary email, with
   actual-spend alerts at 50%, 80%, and 100%, and a forecast alert at 100%.
   The initial monthly alert threshold is USD 200; a budget is an alert, not a
   hard spending cap.
6. Inspect the root access key's last-used metadata. After its use is ruled out
   and the user confirms the exact destructive action, deactivate and then
   delete it.
7. Create a CloudTrail-backed alert for future root API/console activity and an
   IAM Access Analyzer for unintended external sharing.

Root access is used only for the one-time bootstrap and root-only cleanup.

## 8. Build and deployment flow

1. Verify the integrated CrewRoll source and lockfile hashes.
2. Run repository unit, boundary, type, lint, formatting, migration, and
   PostgreSQL integration gates.
3. Run Terraform format, validate, tests, policy checks, and an account/region
   fail-closed plan plus the bounded monthly cost estimate.
4. Apply only the state bucket, operator/deployment identity, audit, budget, and
   access-analysis bootstrap; verify non-root role assumption before continuing.
5. Re-authenticate as the non-root operator/deployment role. Apply the
   foundation phase: VPC, security groups, KMS, RDS, ECR, secret containers,
   logs, WAF, ALB, ACM request, and Terraform-owned Cloudflare validation
   records. Wait for ACM validation before creating an HTTPS listener.
6. Build the control-plane image from the reviewed commit, scan it, push a
   content-addressed ECR tag, and plan runtime resources against that exact
   digest.
7. Register the intended Clerk development `user.deleted` webhook endpoint at
   `https://api.staging.crewroll.app/webhooks/clerk` before it is reachable, then
   store the endpoint's signing secret. Populate all remaining secret versions
   through Secrets Manager without printing values. Any browser action that
   transmits a provider secret requires action-time user confirmation.
8. Apply only immutable runtime task definitions; do not create the ECS API
   service or an autoscaling target yet. Run the one-off migration task and
   verify all five migrations.
9. Only after migration success, create the ECS service at desired/minimum count
   two and register autoscaling. Wait for both targets and `/health/ready` to
   become healthy, then create the Terraform-owned DNS-only API CNAME. Failed
   health checks prevent DNS publication and trigger ECS rollback.
10. Ask Clerk to redeliver the signed `user.deleted` test event and verify
    signature handling, idempotent replay, and invalid-signature rejection.
11. Put both `EXPO_PUBLIC_API_URL=https://api.staging.crewroll.app` and the
    existing Clerk development publishable key into the EAS development and
    preview environments. Neither value is copied into source.
12. Verify ALB, ECS, RDS TLS, KMS, logs, alarms, WAF, Clerk, and public health
    behavior before building the physical-device previews.

No resource is created manually in the console when Terraform can own it.

## 9. Error handling and rollback

- Terraform applies are serialized by the S3 lockfile and rejected in the wrong
  account or region.
- ECS deployment circuit breaker rolls back failed health checks to the prior
  task definition; first deployment failure leaves the service unpublished.
- A failed migration prevents API rollout; API startup never attempts repair.
- RDS deletion protection and final snapshots prevent accidental data loss.
- KMS keys, state, logs, and database resources use explicit deletion guards.
- Secret values are rotated by adding a new secret version and recycling tasks;
  old task definitions remain immutable.
- Cloudflare API DNS is created only after both ALB targets are healthy. DNS
  rollback removes only that new record without deleting AWS data.

## 10. Acceptance gates

### Infrastructure

- Terraform tests prove private RDS, non-public ECS tasks, exact security-group
  edges, encrypted state, deletion protection, backups, two API tasks, WAF,
  least-privilege role separation, logging, alarms, and budget configuration.
- The plan contains only `Project=CrewRoll` staging resources in the verified
  account and touches neither the default VPC nor existing S3 buckets.
- RDS is unreachable from the public Internet.
- A real API connection proves `rds.force_ssl=1`, CA verification, and hostname
  verification; plaintext or unverifiable database sessions fail.
- HTTP redirects to HTTPS, the HTTPS listener negotiates only the chosen modern
  TLS policy, and WAF managed/rate rules block their controlled probes.
- A clean rebuild from remote state produces no drift.

### API and persistence

- `/health/live` and `/health/ready` succeed over the public HTTPS hostname.
- PostgreSQL migrations are contiguous and migration task logs are clean.
- The full pinned PostgreSQL integration suite passes against an isolated
  acceptance database before staging data is created.
- ECS task replacement and RDS connection recycling preserve idempotent trip
  behavior.
- Logs contain no JWTs, invite codes, background bearers, push tokens, keys,
  database URLs, or raw provider errors.
- WAF and application log canaries prove that authorization, cookie, and Svix
  headers are redacted and that request sampling cannot create a second copy.
- The Clerk `user.deleted` webhook verifies signatures, handles duplicate
  delivery idempotently, and rejects invalid signatures without logging bodies
  or secrets.

### Physical trip-room checkpoint

- Physical iOS and Android Expo 57 development builds use the existing Clerk
  development application and ordinary `getToken()` session JWTs.
- Both EAS development and preview environments contain exactly the staging API
  origin and the existing Clerk development publishable key.
- Physical tokens prove the issuer and exact `azp`/authorized-party behavior:
  the expected party succeeds and an unlisted party fails without token logging.
- Each platform registers a real device through `POST /v1/devices` without a JWT
  template, audience mutation, or token logging.
- Two distinct accounts complete create, join, approval, readiness, Start, and
  ACTIVE hydration through the deployed API.
- Response-loss and app-restart recovery preserve exactly-once outcomes.
- Revoked/wrong devices, expired invites, idempotency conflicts, and auth
  invalidation remain fail-closed with privacy-safe UI.
- Foreground polling stops when backgrounded or ACTIVE.
- Native share/link failures are contained.
- The milestone is not called production-ready until native background bearer
  erasure on sign-out/account invalidation is implemented and physically
  verified.

### First shippable product milestone (`WOW-001`)

This staging checkpoint does not close `WOW-001`. Work continues through the
accepted media API, native photo engines, worker, telemetry, and staging worker
deployment. The first shippable milestone is accepted only when one physical
iPhone and one physical Android phone complete the full ten-step bidirectional
encrypted photo/save/receipt/purge sequence from `docs/TECHNICAL_TASKS.md` three
consecutive times on release-signed preview builds. Health checks, an ACTIVE
trip, simulators, mocks, or isolated API tests cannot substitute for that gate.

## 11. Legacy Cloudflare cleanup

Legacy cleanup is deliberately sequenced after the new staging milestone is
green because it does not block `api.staging.crewroll.app`.

- Preserve the `crewroll.app` zone, nameservers, support email routing, and all
  MX/SPF/DKIM records.
- Archive the deployed `crewroll-relay` source/configuration and record the
  Durable Object inventory before deletion.
- Deleting `RelayRoom` and `SourceGate` state is permanent and requires a fresh
  action-time user confirmation.
- Replace the stale apex/`www`/`go` site before deleting `crewroll-site` so the
  public domain does not go dark.
- All Bhasha resources remain out of scope.

## 12. Explicit exclusions

- No production AWS environment or account is created in this milestone.
- No Cloudflare Worker or Container port is attempted.
- No worker process is invented before an accepted worker entrypoint exists;
  after that entrypoint is reviewed, a follow-up staging change adds the worker
  before `WOW-001` can run.
- No media-transfer feature beyond the private staging bucket is added by this
  foundation change. The accepted `WOW-001` backlog remains the immediate
  product continuation, not a waived requirement.
- No provider secret is committed, printed, copied into chat, or placed in a
  Terraform plan file.
- No existing unrelated AWS or Cloudflare resource is modified or deleted.

## 13. Authoritative references

- Existing CrewRoll blueprint:
  `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md`
- Existing control-plane plan:
  `docs/superpowers/plans/2026-08-28-crewroll-control-plane.md`
- Product milestone backlog:
  `docs/TECHNICAL_TASKS.md` (`WOW-001`)
- AWS root-user guidance:
  <https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html>
- AWS CLI temporary console authentication:
  <https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html>
- Terraform S3 backend and lockfile:
  <https://developer.hashicorp.com/terraform/language/backend/s3>
