#!/usr/bin/env bash
# WS-10.3 — stand up the ephemeral PR canary stack.
#
# Behavior:
#   1. Build the PR's tenant-runtime container with the same Dockerfile CI
#      uses, tag it with the PR sha, and push to the canary Artifact Registry.
#   2. Run node-pg-migrate against the canary Postgres so the PR's migrations
#      apply before the canary agent fires.
#   3. Deploy a transient Cloud Run service (canary-runtime-pr-<sha>) using
#      the image, wired to the canary-tenant Postgres (public IP + the
#      tenant-db-password secret). USE_CLOUD_TASKS_EXECUTION=false → the
#      runtime executes in-process, so no Pub/Sub / Cloud Tasks topology.
#   4. POST one synthetic invocation to the canary's scheduled-invoke endpoint
#      with `triggeredBy=cron`.
#   5. Export the canary service URL to $GITHUB_ENV so the next step
#      (canary-assertions.js) can poll it via $CANARY_API_URL.
#
# Auth: keyless. The workflow runs google-github-actions/auth@v2 (WIF →
# github-actions-dev@YOUR_CI_PROJECT_STAGING) BEFORE this script, so gcloud is
# already authenticated. No service-account key file.
#
# Requires (via env, set by canary-gate.yml):
#   CANARY_PROJECT_ID   — tenant-canary-${env} GCP project (default tenant-canary-dev)
#   CANARY_REGION       — default us-west1
#   PR_SHA              — github.sha (short)
set -euo pipefail

# Identity, defaults and database resolution all live in common.sh, so up.sh and
# down.sh cannot disagree about which agent a run owns or which database to
# reach. Teardown needs both to clean up what this script creates.
# shellcheck source=.github/canary-stack/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# google-github-actions/auth exports CLOUDSDK_CORE_PROJECT=YOUR_CI_PROJECT_STAGING
# (the WIF SA's own project) into $GITHUB_ENV, which OVERRIDES `gcloud config set
# project` for every subsequent gcloud call. So every project-scoped command below
# passes --project "$CANARY_PROJECT_ID" explicitly (a flag beats env + config);
# without it, `builds submit`/`run deploy` target the CI project and 403.
gcloud config set project "$CANARY_PROJECT_ID" >/dev/null 2>&1

# Resolve the canary Postgres (host + password -> DATABASE_URL).
if ! canary_resolve_db; then
  echo "could not resolve the canary database" >&2
  exit 1
fi

echo "canary identity: tenant=${CANARY_TENANT_ID} agent=${CANARY_AGENT_ID}"
echo "canary DB host: ${CANARY_DB_HOST}"

# 1. Build + push the runtime image (Cloud Build, same Dockerfile as CI).
# Uses cloudbuild.yaml (not --tag) so the Dockerfile's ARTIFACT_REGISTRY_TOKEN
# build-arg is supplied for the private @liftoffos/* npm pulls.
IMAGE="${CANARY_REGION}-docker.pkg.dev/${CANARY_PROJECT_ID}/canary/tenant-runtime:${PR_SHA}"
gcloud builds submit \
  --project "$CANARY_PROJECT_ID" \
  --config .github/canary-stack/cloudbuild.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  --timeout 1800s .

# 2. Run migrations against the canary DB from the runner (public IP).
#
# Mirror Dockerfile.migrate exactly: node-pg-migrate is NOT a package.json
# dependency, so install it INTO the repo node_modules (npm ci already put
# `pg` there) — a standalone `npx node-pg-migrate` can't resolve pg and dies
# with "Cannot find module pg/lib/connection-parameters". Use the current
# major (handles the BEGIN/COMMIT + DO-block migrations that v6 mis-splits).
# DATABASE_URL is already exported by canary_resolve_db. It is deliberately not
# rebuilt here: the password never leaves that function, so there is one place
# holding the credential instead of a copy in a shell variable that `set -x` or
# an error trace could print.
npm install --no-save node-pg-migrate@latest
./node_modules/.bin/node-pg-migrate up \
  --migrations-dir=migrations \
  --no-check-order \
  --ignore-pattern ".*\.md"

# 2b. Seed the synthetic canary account/tenant/agent + entitlements so the
# scheduled-invoke has an ACTIVE agent to run. Idempotent (ON CONFLICT).
CANARY_TENANT_ID="$CANARY_TENANT_ID" \
CANARY_AGENT_ID="$CANARY_AGENT_ID" \
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v tenant_id="$CANARY_TENANT_ID" \
  -v agent_id="$CANARY_AGENT_ID" \
  -f .github/canary-stack/seed.sql

# 3. Deploy transient Cloud Run service.
#
# --no-allow-unauthenticated: the org policy blocks allUsers on run.invoker, so
# the service is private and the trigger + assertion steps authenticate with an
# identity token (minted below). github-actions-dev holds project-level
# run.invoker (granted in tenant-canary-template).
#
# NODE_ENV=canary (non-production) enables the scheduled-invoke dev auth bypass
# via the x-internal-secret header (app-level); the identity token satisfies
# Cloud Run IAM. The URL envs (PLATFORM_BACKEND_URL/TENANT_RUNTIME_URL/
# COORDINATOR unset) are placeholders — the in-process canary never calls them,
# but the runtime requires them present at boot. TENANT_RUNTIME_SERVICE_TOKEN is
# a required secret satisfied here by an env override (unused by the audit turn).
SERVICE="$CANARY_SERVICE"
INTERNAL_SECRET="canary-${PR_SHA}"
# Sizing mirrors the real service: terraform gives tenant-runtime cpu=1,
# memory=1Gi (tenant-runtime-template/main.tf). The canary ran on 512Mi — half
# of production — so it gated a configuration nobody deploys, and once the
# runtime's startup footprint grew past that it stopped booting: Cloud Run
# OOM-killed it mid-request ("Memory limit of 512 MiB exceeded with 553 MiB
# used"), the trigger got HTTP 503, no invocation was written, and the
# assertions reported outcome=null. That is the whole 2026-07-31 regression.
#
# The flags below are one backslash-continued command. Do not put comments
# between its lines: the continuation ends at the comment, the remaining flags
# run as their own command, and the deploy silently proceeds WITHOUT them.
gcloud run deploy "$SERVICE" \
  --project "$CANARY_PROJECT_ID" \
  --image "$IMAGE" \
  --region "$CANARY_REGION" \
  --no-allow-unauthenticated \
  --service-account "canary-runner@${CANARY_PROJECT_ID}.iam.gserviceaccount.com" \
  --set-env-vars "ENVIRONMENT=canary,NODE_ENV=canary,GCP_PROJECT=${CANARY_PROJECT_ID},GCP_PROJECT_ID=${CANARY_PROJECT_ID},PLATFORM_BACKEND_URL=https://api-dev.example.com,TENANT_RUNTIME_URL=https://api-dev.example.com,CLOUD_SCHEDULER_SERVICE_ACCOUNT=canary-runner@${CANARY_PROJECT_ID}.iam.gserviceaccount.com,TENANT_RUNTIME_SERVICE_TOKEN=canary-unused,USE_CLOUD_TASKS_EXECUTION=false,DB_HOST=${CANARY_DB_HOST},DB_PORT=5432,DB_NAME=${CANARY_DB_NAME},DB_USER=${CANARY_DB_USER},INTERNAL_SERVICE_SECRET=${INTERNAL_SECRET},CANARY_TENANT_ID=${CANARY_TENANT_ID},CANARY_AGENT_ID=${CANARY_AGENT_ID}" \
  --set-secrets "DB_PASSWORD=tenant-db-password:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest" \
  --cpu 1 --memory 1Gi --min-instances 0 --max-instances 1 \
  --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE" --project "$CANARY_PROJECT_ID" --region "$CANARY_REGION" --format='value(status.url)')

# Assert the service actually got the sizing we asked for.
#
# gcloud exits 0 when a flag never reaches it — that is exactly how this broke:
# a comment inserted between the continued lines of the deploy ended the
# continuation, the remaining flags ran as a separate command, and the service
# deployed on the default memory while the script reported success. A canary
# that silently runs on the wrong shape is the thing this whole file exists to
# prevent, so it is checked rather than assumed.
DEPLOYED_MEMORY=$(gcloud run services describe "$SERVICE" \
  --project "$CANARY_PROJECT_ID" --region "$CANARY_REGION" \
  --format='value(spec.template.spec.containers[0].resources.limits.memory)')
if [ "$DEPLOYED_MEMORY" != "1Gi" ]; then
  echo "::error::canary deployed with memory=${DEPLOYED_MEMORY:-unset}, expected 1Gi — a deploy flag was dropped" >&2
  exit 1
fi
echo "canary sizing verified: memory=${DEPLOYED_MEMORY}"
echo "canary service: ${SERVICE_URL}"

# Identity token for Cloud Run IAM (aud = the service URL). Under WIF the active
# credential is an impersonated/external account, so a bare
# `print-identity-token --audiences` fails ("Invalid account type ... Requires
# valid service account"). Mint it via IAM Credentials by impersonating
# canary-runner (holds project-level run.invoker, so the token's identity passes
# the Cloud Run IAM check). github-actions-dev holds tokenCreator on canary-runner
# (granted in tenant-canary-template). --include-email so Cloud Run can map the
# token subject to the run.invoker binding.
CANARY_RUNNER_SA="canary-runner@${CANARY_PROJECT_ID}.iam.gserviceaccount.com"
ID_TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account="$CANARY_RUNNER_SA" \
  --audiences="${SERVICE_URL}" \
  --include-email)

# 4. Fire one synthetic trigger. Bearer = Cloud Run IAM; x-internal-secret =
# app-level scheduled-invoke dev bypass.
# The response body carries the run result, and a rejected run still returns
# 2xx with success:false — `agent_already_running` arrived that way. Swallowing
# it and letting the assertions time out is what turned every canary defect into
# the same unreadable `outcome=null`, so the reason is surfaced here instead.
TRIGGER_HTTP=0
TRIGGER_BODY=$(curl -s -w '\n%{http_code}' -X POST "${SERVICE_URL}/api/execution/scheduled-invoke" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "x-internal-secret: ${INTERNAL_SECRET}" \
  -d "{\"tenantId\":\"${CANARY_TENANT_ID}\",\"agentId\":\"${CANARY_AGENT_ID}\",\"triggeredBy\":\"cron\"}") || TRIGGER_HTTP=1
TRIGGER_CODE=$(printf '%s' "$TRIGGER_BODY" | tail -n1)
TRIGGER_JSON=$(printf '%s' "$TRIGGER_BODY" | sed '$d')
echo "scheduled-invoke HTTP ${TRIGGER_CODE}: ${TRIGGER_JSON}"

if [ "$TRIGGER_HTTP" -ne 0 ] || [ "${TRIGGER_CODE:0:1}" != "2" ]; then
  echo "::error::canary trigger failed at the transport (HTTP ${TRIGGER_CODE})" >&2
  exit 1
fi
case "$TRIGGER_JSON" in
  *'"success":false'*)
    echo "::error::canary trigger was rejected by the runtime: ${TRIGGER_JSON}" >&2
    exit 1
    ;;
esac

# 5. Export for the next workflow step. CANARY_API_TOKEN carries the identity
# token so canary-assertions.js can reach the private service.
{
  echo "CANARY_SERVICE=${SERVICE}"
  echo "CANARY_API_URL=${SERVICE_URL}"
  echo "CANARY_TENANT_ID=${CANARY_TENANT_ID}"
  # down.sh purges rows for exactly this agent, so it must be given the same id
  # rather than deriving it a second time and risking a different answer.
  echo "CANARY_AGENT_ID=${CANARY_AGENT_ID}"
  echo "CANARY_API_TOKEN=${ID_TOKEN}"
} >> "${GITHUB_ENV:-/dev/null}"
