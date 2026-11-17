# Deployment

Current-state snapshot of how the connector service is deployed and
what infrastructure it owns. The authoritative definitions live in
Terraform; this file summarizes them so operators don't have to
re-derive from `liftoff-infrastructure-gcp`.

## What's deployed (dev)

- **Cloud Run service** `connector-service` in `YOUR_CONTROL_PROJECT_STAGING`
  - Ingress: internal + Cloud Load Balancer (no public ingress)
  - Min-instances: 1 (no cold starts on the revenue path)
  - Service account: `connector-service-dev@...`
  - Terraform-owned — `module.platform_control.module.connector_service`
    with `connector_service_enabled = true`
- **Cloud Run migrate job** `connector-service-migrate` in the same project
- **Cloud SQL** `connector-pg-dev` — database `connector_service`, user
  `connector_app`
- **Secrets** `connector-service-token` (service auth) and
  `connector-pg-password` in platform-control, CMEK-protected
- **Cloud Build trigger** `connector-service-dev` in `YOUR_CI_PROJECT_STAGING`,
  fires on push to `main`
- **Artifact Registry** `us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/YOUR_ARTIFACT_REPO_STAGING/connector-service[-migrate]`
- **Migrations applied**: 001–004
  (`001_initial_schema`, `002_enable_rls`, `003_oauth_and_sync_stats`,
  `004_oauth_dcr_columns`)
- **Proto version**: `@liftoffos/proto-gen@0.3.0`

## Who calls us

- **tenant-runtime** tool-gateway → `Execute`, `ExecuteBatch`, `Warm`
  (hot path; no caching on these)
- **tenant-runtime** tool-schema cache → `ListTools`
  (5-min TTL, unchanged-hash short-circuit)
- **platform-backend** `src/connectors/proxy.ts` → forwards every
  `/api/connectors/*` HTTP request over Connect-RPC (OAuth start/callback,
  CRUD, apikey/keypair setup, instant-connect, health)
- **platform-backend** `connector-service-cache.ts` →
  `GetCapabilities`, `GetFunctionalTypes`, `ListTools`,
  `ListTenantConnectors` (5-min TTL, same short-circuit)

## Prod

Same topology in `YOUR_CONTROL_PROJECT` with
`connector-pg-prod`. Triggered by pushes to `release` (the `connector-service-prod`
Cloud Build trigger fires on `^release$`; promote with `main → release`). The
`production` branch is defunct/abandoned — do not push there.

## Adding a connector (operator view)

1. Add the connector-type + OAuth provider config + tool schemas inside
   this repo.
2. For static-OAuth providers, add the `_CLIENT_ID` / `_CLIENT_SECRET`
   secrets in `liftoff-infrastructure-gcp`
   (`terraform/projects/platform-control/main.tf`'s `oauth_secrets` list)
   and populate them in Secret Manager. DCR providers skip this.
3. Push to `main` → Cloud Build deploys, callers pick up the new connector
   on their next `ListTools` / `GetCapabilities` refresh (≤5 min).
4. (Optional) Frontend copy + icon in `liftoff-react`.

## Operational runbooks

- Build / deploy / migrate fail → see the Cloud Build log; standard
  `gcloud builds log <id>` flow.
- Service unhealthy → check `gcloud run services describe connector-service`
  and the Cloud Run logs. Min-instances = 1 means a bad revision is
  caught immediately.
- Credential rotation → rotate the secret in Secret Manager; the service
  picks up new versions on the next credential fetch (no restart needed
  for OAuth client secrets because the Cloud Run service is configured
  to mount `:latest`).
