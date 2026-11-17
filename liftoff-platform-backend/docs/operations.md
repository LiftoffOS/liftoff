# Operations: deploy, environments, database access

> Deploy discipline is INV-PB-007.
> The hard rules are docs/invariants.md. This file holds the detail.

## CRITICAL: Deployment

**NEVER run `gcloud builds submit` manually.**

**Prod is the only deployed environment.** `YOUR_CONTROL_PROJECT_STAGING` only hosts
the `npm-packages-dev` registry every repo resolves `@liftoffos/*` from, and
`YOUR_CI_PROJECT_STAGING` only hosts the GitHub Actions identity. A push to `main` runs
GitHub Actions CI and deploys nothing.

| Environment | CI Project | Trigger |
|-------------|-----------|---------|
| Prod | `YOUR_CI_PROJECT` | `platform-backend-prod` (push to `release`) |

To deploy:
1. Commit changes and push to `origin/main` (CI only)
2. Promote: on `release`, `git merge main --no-ff` and push
3. The trigger handles build, test, deploy, and migrations; follow it through and verify prod.

**A deploy never signs a coding tool out (INV-PB-014).** MCP credentials are opaque
tokens resolved against the database on every call, with membership and role re-read per
call, so an existing credential obeys a new rule from the first call after the deploy.
Connected tools gain new tools and instructions on their next session start, because
`initialize` and `tools/list` are served fresh; nothing needs a re-auth. There is no
revocation step in any release, dev or prod, and no script in this repo performs one; a
change to the identity model ships as a per-call read plus a backfilling migration.

## GCP Project Configuration

### Prod

| Service | GCP Project | Notes |
|---------|-------------|-------|
| Cloud Build Trigger | `YOUR_CI_PROJECT` | Trigger: `platform-backend-prod` |
| Cloud Run Service | `YOUR_CONTROL_PROJECT` | Service: `platform-backend` |
| Artifact Registry | `YOUR_CONTROL_PROJECT` | Registry: `YOUR_ARTIFACT_REPO` |
| Cloud SQL | `YOUR_CONTROL_PROJECT` | Instance: `control-plane-pg-prod` |
| Secrets | `YOUR_CONTROL_PROJECT` | OAuth secrets, DB password |

## Environment

### Prod
- Backend URL: `https://api.example.com` (custom domain — always use this for OAuth callbacks, webhook URLs, audience values, cross-service links)
- Direct Cloud Run URL: look up via `gcloud run services describe platform-backend --project=YOUR_CONTROL_PROJECT --region=us-west1 --format="value(status.url)"`. Never write the raw *.run.app URL into docs, configs, or messages; the custom domain is the only URL that circulates.

The pattern `api${env == 'prod' ? '' : '-' + env}.example.com` is the canonical surface for every environment — defined in `liftoff-infrastructure-gcp/terraform/projects/platform-control/main.tf` (`BACKEND_URL = var.environment == "prod" ? "https://api.example.com" : "https://api-${var.environment}.example.com"`).

### Frontend
- Frontend URL: `https://example.com` (custom domain on Cloud Run service `liftoff-react`, project: `YOUR_WEB_PROJECT`)
- Direct Cloud Run URL: `https://liftoff-react-YOUR_PROJECT_HASH-uw.a.run.app`
- Canonical routes (always link to these, never guess subdomains like `app.*`):
  - Sign-in: `https://example.com/login`
  - Root: `https://example.com/` (redirects to sign-in)
  - Signed-in dashboard: `https://example.com/dashboard`
  - Onboarding: `https://example.com/onboarding`
  - OAuth callback: `https://example.com/oauth/callback`
  - Routes are defined in `liftoff-react/src/App.tsx` — grep that file for the source of truth

## Running ad-hoc scripts / queries against prod (or dev) DB

**All Cloud SQL instances are private-IP only.** `gcloud sql connect` and Cloud SQL Auth Proxy from a laptop both fail (the proxy reaches the Cloud SQL Admin API but can't tunnel to the private IP). The only working pattern is a one-shot Cloud Run Job with **both** `--set-cloudsql-instances` (mounts the Unix socket) **and** `--vpc-connector serverless-connector --vpc-egress private-ranges-only` (so the embedded Cloud SQL sidecar can dial the private IP).

### Pattern for raw `psql`

```bash
gcloud run jobs create db-probe \
  --image=postgres:16-alpine \
  --region=us-west1 --project=YOUR_CONTROL_PROJECT \
  --service-account=<sa>@YOUR_CONTROL_PROJECT.iam.gserviceaccount.com \
  --set-cloudsql-instances=YOUR_CONTROL_PROJECT:us-west1:control-plane-pg-prod \
  --vpc-connector=serverless-connector \
  --vpc-egress=private-ranges-only \
  --set-env-vars="PGHOST=/cloudsql/YOUR_CONTROL_PROJECT:us-west1:control-plane-pg-prod,PGUSER=liftoff_app,PGDATABASE=liftoff_control" \
  --set-secrets="PGPASSWORD=control-plane-db-password:latest" \
  --command=sh --args="-c,psql -c 'SELECT 1' >&2" \
  --max-retries=0
gcloud run jobs execute db-probe --region=us-west1 --project=YOUR_CONTROL_PROJECT --wait
gcloud run jobs delete db-probe --region=us-west1 --project=YOUR_CONTROL_PROJECT --quiet
```

**Important details (every flag matters — leaving any one out gives a confusing "connection timeout" error):**
- `--vpc-connector serverless-connector --vpc-egress private-ranges-only` — required for the Cloud SQL sidecar to reach the private IP. The `--set-cloudsql-instances` flag mounts the socket but is not sufficient on its own.
- `DB_USER=liftoff_app` (NOT `platform_backend`), `DB_NAME=liftoff_control`, secret `control-plane-db-password` (NOT `platform-backend-db-password`).
- Redirect stdout → stderr (`>&2`). Cloud Run captures stderr as `textPayload` in Cloud Logging; stdout is unreliable for scripted reads.
- The SA needs `roles/cloudsql.client` and `roles/secretmanager.secretAccessor` on the secret. For dev, swap project + IPs accordingly.

### Pattern for a TypeScript script in this repo (e.g. `src/scripts/foo.ts`)

Use the platform-backend image at the SHA that contains your script:

```bash
gcloud run jobs create foo-runner \
  --image=us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT/YOUR_ARTIFACT_REPO/platform-backend:<sha> \
  --region=us-west1 --project=YOUR_CONTROL_PROJECT \
  --service-account=<sa>@YOUR_CONTROL_PROJECT.iam.gserviceaccount.com \
  --set-cloudsql-instances=YOUR_CONTROL_PROJECT:us-west1:control-plane-pg-prod \
  --vpc-connector=serverless-connector \
  --vpc-egress=private-ranges-only \
  --set-env-vars="CLOUD_SQL_CONNECTION_NAME=YOUR_CONTROL_PROJECT:us-west1:control-plane-pg-prod,DB_USER=liftoff_app,DB_NAME=liftoff_control,GCP_PROJECT_ID=YOUR_CONTROL_PROJECT,NODE_ENV=production,..." \
  --set-secrets="DB_PASSWORD=control-plane-db-password:latest,..." \
  --command=node --args="dist/scripts/foo.js,...args" \
  --memory=1Gi --cpu=1 --task-timeout=600 --max-retries=0
```

The image SHA must be **already built and pushed** to Artifact Registry. Prod images are built from the `release` branch — promote `main → release` and push before referencing a SHA the prod registry hasn't seen.

**Always delete the job when done** to avoid stale references to old image SHAs.

## Database Migrations

Migrations run automatically during deployment via a Cloud Run Job (`platform-backend-migrate`).

To run migrations manually (rarely needed):
```bash
gcloud run jobs execute platform-backend-migrate \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT \
  --wait
```

