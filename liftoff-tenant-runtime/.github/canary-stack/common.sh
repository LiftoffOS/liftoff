#!/usr/bin/env bash
# Shared canary-stack identity and connection resolution.
#
# WHY THIS FILE EXISTS. up.sh and down.sh both need the canary's identity and
# both need to reach the canary database, and they had neither in common: up.sh
# derived the ids and resolved the DB inline, down.sh knew only the service
# name. So teardown could delete the Cloud Run service and nothing else, and the
# rows a run created — including its execution lock — outlived it.
#
# ── The failure this addresses ────────────────────────────────────────────────
#
# Every canary run deployed its own service (canary-runtime-pr-<sha>) but all of
# them shared ONE agent id. The agent lock is keyed (tenant_id, agent_id), so two
# canary runs in flight at once contended for the same lock: the first took it,
# the second got `agent_already_running` / failureClass agent_busy and never
# produced an invocation, and canary-assertions read `outcome=null` and failed.
# canary-gate.yml has no `concurrency` group, so every branch's canary runs
# simultaneously — during a burst of dependency pull requests that is the normal
# case, not the edge case. The gate was red on every branch from 2026-07-31.
#
# It compounded: the job fails at assertions, down.sh deletes the service while
# the run still holds the lock, and the release path never executes. The lock
# then sits until its 15-minute expiry, so even a serial retry inside that window
# fails the same way. The logs show it plainly — three `agent_lock_acquired`
# events in two hours and not one `agent_lock_released`.
#
# ── The fix ───────────────────────────────────────────────────────────────────
#
# The AGENT id becomes per-run, derived from the commit under test. Two canary
# runs can no longer contend, because they no longer share the row the lock is
# keyed on. The TENANT stays stable: it is what seed.sql keys `external_id` on,
# and making it per-run would mean deleting tenant-scoped history on teardown to
# avoid unbounded growth — a much larger blast radius for no extra isolation.
#
# Because the tenant is shared, "the most recent invocation for this tenant" is
# no longer this run's invocation, so the canary API filters by agent as well.
# That is why CANARY_AGENT_ID is passed to the service, not just to the seed.
#
# Both ids stay RFC 4122 valid — version nibble 4, variant nibble 8 — because the
# structured logger validates canary_tenant_id with a strict UUID schema and
# rejected the previous all-zero-prefixed values on every run.

: "${CANARY_PROJECT_ID:=tenant-canary-dev}"
: "${CANARY_REGION:=us-west1}"
: "${PR_SHA:=$(git rev-parse HEAD)}"
: "${CANARY_DB_NAME:=tenant_runtime}"
: "${CANARY_DB_USER:=tenant_app}"

# 12 hex characters of the commit, which is the UUID node field. `tr -dc` keeps
# this honest if PR_SHA ever arrives with a prefix or stray whitespace, and the
# pad covers a short sha (7 chars) so the result is always a well-formed UUID
# rather than a truncated one that fails at the database instead of here.
CANARY_RUN_KEY="$(printf '%s' "$PR_SHA" | tr -dc '0-9a-f' | cut -c1-12)"
while [ "${#CANARY_RUN_KEY}" -lt 12 ]; do CANARY_RUN_KEY="${CANARY_RUN_KEY}0"; done

# Stable across runs: one canary tenant, seeded once, referenced by external_id.
CANARY_TENANT_ID="${CANARY_TENANT_ID:-00000000-0000-4000-8000-0000000ca90d}"
# Per-run: this is the isolation that stops concurrent canaries colliding.
CANARY_AGENT_ID="${CANARY_AGENT_ID:-00000000-0000-4001-8000-${CANARY_RUN_KEY}}"

CANARY_SERVICE="canary-runtime-pr-${PR_SHA}"

export CANARY_PROJECT_ID CANARY_REGION PR_SHA CANARY_DB_NAME CANARY_DB_USER
export CANARY_TENANT_ID CANARY_AGENT_ID CANARY_SERVICE

# Resolve the canary Postgres and export DATABASE_URL.
#
# No hardcoded IP: the instance can be recreated. The instance is canary-pg-<env>
# where <env> is the last hyphen-delimited segment of the project id
# (tenant-canary-dev → dev).
#
# Returns non-zero rather than exiting, so teardown can skip database cleanup
# when the database is unreachable instead of failing the whole job over it.
canary_resolve_db() {
  local host password
  host=$(gcloud sql instances describe "canary-pg-${CANARY_PROJECT_ID##*-}" \
    --project "$CANARY_PROJECT_ID" \
    --format='value(ipAddresses[0].ipAddress)' 2>/dev/null) || return 1
  [ -n "$host" ] || return 1
  password=$(gcloud secrets versions access latest \
    --secret=tenant-db-password --project "$CANARY_PROJECT_ID" 2>/dev/null) || return 1
  [ -n "$password" ] || return 1
  CANARY_DB_HOST="$host"
  export CANARY_DB_HOST
  export DATABASE_URL="postgresql://${CANARY_DB_USER}:${password}@${host}:5432/${CANARY_DB_NAME}"
}
