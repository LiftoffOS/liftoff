#!/usr/bin/env bash
# C.1 — auto-rollback helper for post-deploy smoke.
#
# Called by Cloud Build's auto-rollback step when the post-deploy-smoke
# step fails. Shifts 100% of Cloud Run traffic back to the previous
# revision so the broken deploy stops serving users.
#
# Required env:
#   PROJECT_ID   — Cloud Run project (e.g. tenant-<id>-prod)
#   REGION       — Cloud Run region (e.g. us-west1)
#   SERVICE_NAME — Cloud Run service name (e.g. agent-service)
#
# Required gcloud auth: the runner SA must have roles/run.developer on
# the service. Cloud Build's default SA already has this for services in
# the same project.

set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"
: "${SERVICE_NAME:?SERVICE_NAME is required}"

echo "C.1 auto-rollback: listing recent revisions for ${SERVICE_NAME} in ${PROJECT_ID}/${REGION}"

# List the two most recent revisions in DESC order. [0] = current (broken),
# [1] = previous (last known good).
mapfile -t REVISIONS < <(
  gcloud run revisions list \
    --service="${SERVICE_NAME}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --sort-by="~creationTimestamp" \
    --limit=2 \
    --format="value(metadata.name)"
)

if [[ "${#REVISIONS[@]}" -lt 2 ]]; then
  echo "C.1 auto-rollback: only ${#REVISIONS[@]} revision(s) exist — cannot roll back. Aborting." >&2
  exit 2
fi

CURRENT="${REVISIONS[0]}"
PREVIOUS="${REVISIONS[1]}"

echo "C.1 auto-rollback: shifting 100% of traffic from ${CURRENT} → ${PREVIOUS}"

gcloud run services update-traffic "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --to-revisions="${PREVIOUS}=100"

echo "C.1 auto-rollback: traffic shifted. Post-deploy smoke failed but prod is now serving the prior revision."
echo "C.1 auto-rollback: investigate the broken revision (${CURRENT}) before redeploying."
