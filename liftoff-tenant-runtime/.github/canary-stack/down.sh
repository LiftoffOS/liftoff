#!/usr/bin/env bash
# WS-10.3 — tear down the ephemeral PR canary stack.
#
# Idempotent: if the service was never created (up.sh failed early), every step
# here is a no-op. We keep the artifact-registry image so post-mortem triage on a
# failed canary PR can inspect what shipped.
#
# Teardown deletes the Cloud Run service AND the rows this run created. Deleting
# only the service is what left the estate dirty: the run holds a per-agent
# execution lock for the duration of its turn, and killing the container skips
# the release path entirely — the logs showed three `agent_lock_acquired` events
# and no `agent_lock_released` at all. The lock then sat until its 15-minute
# expiry. That no longer blocks a *different* run now that agent ids are
# per-run, but it does leave a lock, an agent and a compiled_instructions row
# behind on every single canary, forever, which is its own slow problem.
#
# Scoped to this run's agent. The tenant is deliberately shared and is NOT
# deleted: it is the stable identity seed.sql keys external_id on, and its
# invocations are the canary's history.
set -euo pipefail

# shellcheck source=.github/canary-stack/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SERVICE="$CANARY_SERVICE"

gcloud config set project "$CANARY_PROJECT_ID" >/dev/null 2>&1
# Explicit --project: the auth action's CLOUDSDK_CORE_PROJECT env var overrides
# `gcloud config set project` (see up.sh), so delete in the canary project or the
# teardown silently targets the CI project and leaves the ephemeral service live.
gcloud run services delete "$SERVICE" \
  --project "$CANARY_PROJECT_ID" \
  --region "$CANARY_REGION" \
  --quiet || true

# Release this run's execution lock and drop its agent.
#
# Best-effort by design: teardown runs `if: always()`, so it fires on runs that
# failed before the database existed or before credentials were available. A
# cleanup that cannot reach the database must not turn a reported test failure
# into a confusing teardown failure that hides it.
if canary_resolve_db; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v tenant_id="$CANARY_TENANT_ID" \
    -v agent_id="$CANARY_AGENT_ID" <<'SQL' || echo "canary DB cleanup skipped (non-fatal)"
-- Order matters: the lock and the instructions reference the agent.
DELETE FROM agent_execution_locks
 WHERE tenant_id = :'tenant_id' AND agent_id = :'agent_id';

DELETE FROM compiled_instructions
 WHERE tenant_id = :'tenant_id' AND agent_id = :'agent_id';

-- Invocations are kept: they are this canary's history and are what
-- /canary/latest-invocation reads. Only the agent row itself goes, and only if
-- nothing still references it.
DELETE FROM agents
 WHERE id = :'agent_id'
   AND tenant_id = :'tenant_id'
   AND NOT EXISTS (SELECT 1 FROM invocations WHERE agent_id = :'agent_id');
SQL
  echo "canary DB cleanup complete for agent ${CANARY_AGENT_ID}"
else
  echo "canary DB unreachable; skipping row cleanup (non-fatal)"
fi

echo "canary teardown complete for $SERVICE"
