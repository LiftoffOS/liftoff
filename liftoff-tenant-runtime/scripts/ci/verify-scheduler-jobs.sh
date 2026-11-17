#!/usr/bin/env bash
# Verifies that the Cloud Scheduler jobs whose silence costs the most exist and
# are enabled. Fail-closed.
#
# NOT wired into cloudbuild — run it by hand against a tenant project. A list
# nothing runs is a list nobody notices going stale, so keep it in step with the
# authoritative set below and drop jobs whose handlers no longer exist.
#
# The AUTHORITATIVE set is terraform/projects/tenant-runtime-template/
# r5_scheduler_jobs.tf in the infrastructure repo. This is a deliberately short
# subset: jobs whose absence is silent and costly rather than obvious.
set -euo pipefail

TENANT_PROJECT="${TENANT_PROJECT:-YOUR_TENANT_PROJECT}"
LOCATION="${SCHEDULER_LOCATION:-us-west1}"

REQUIRED_JOBS=(
  "chat-turn-locks-reaper-hourly"
  "mirror-locks-reaper-hourly"
  "stalled-run-reconcile"
  "canonical-agent-reconciler"
  "reflection-outcome-closure"
)

missing=0
for job in "${REQUIRED_JOBS[@]}"; do
  status=$(gcloud scheduler jobs describe "$job" \
    --location="$LOCATION" \
    --project="$TENANT_PROJECT" \
    --format="value(state)" 2>/dev/null || echo "MISSING")
  if [[ "$status" != "ENABLED" ]]; then
    echo "FAIL: scheduled job $job is $status (expected ENABLED)"
    missing=$((missing + 1))
  else
    echo "OK: $job=$status"
  fi
done

if [[ $missing -gt 0 ]]; then
  echo "${missing} scheduler jobs missing or disabled in $TENANT_PROJECT/$LOCATION"
  exit 1
fi
echo "All required scheduler jobs present."
