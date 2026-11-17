#!/usr/bin/env bash
#
# The migration gate's Postgres must be the SAME major version Cloud SQL runs.
#
# verify-migrations answers "will Postgres accept these migrations". That answer
# is only about production if it comes from production's major version: a gate on
# a different one can reject SQL Cloud SQL accepts, and accept SQL Cloud SQL
# rejects — a gate on Postgres 16 in front of a POSTGRES_15 instance, say.
#
# The image tag is pinned by hand in cloudbuild.yaml, so it WILL drift the day
# somebody upgrades Cloud SQL and does not think about CI. A gate testing the
# wrong version is worse than no gate, because it is green. This makes the pair
# move together: upgrade the database and this fails until the tag follows.
#
# Usage: check-migration-gate-version.sh <project> <instance> [cloudbuild.yaml]

set -euo pipefail

PROJECT="${1:?project required}"
INSTANCE="${2:?instance required}"
CONFIG="${3:-cloudbuild.yaml}"

# What the gate is pinned to: pgvector/pgvector:pgNN
PINNED=$(grep -oE 'pgvector/pgvector:pg[0-9]+' "$CONFIG" | head -1 | grep -oE '[0-9]+$' || true)
if [ -z "$PINNED" ]; then
  echo "check-migration-gate-version: no pgvector/pgvector:pgNN image found in $CONFIG" >&2
  echo "  If the migration gate's image moved, this check has to move with it." >&2
  exit 1
fi

# What Cloud SQL actually runs. A lookup failure is INCONCLUSIVE, not a mismatch:
# no permission or no instance says nothing about whether the versions agree,
# and failing a build over an unreadable answer is how a check gets deleted.
if ! LIVE_RAW=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
      --format='value(databaseVersion)' 2>/dev/null); then
  echo "check-migration-gate-version: INCONCLUSIVE — could not read $INSTANCE in $PROJECT."
  echo "  Gate pinned to Postgres $PINNED; live version unverified."
  exit 0
fi

LIVE=$(printf '%s' "$LIVE_RAW" | grep -oE '[0-9]+' | head -1 || true)
if [ -z "$LIVE" ]; then
  echo "check-migration-gate-version: INCONCLUSIVE — unexpected databaseVersion '$LIVE_RAW'."
  exit 0
fi

if [ "$PINNED" != "$LIVE" ]; then
  echo "" >&2
  echo "check-migration-gate-version: MISMATCH" >&2
  echo "" >&2
  echo "  Cloud SQL ($INSTANCE) runs Postgres $LIVE" >&2
  echo "  The migration gate tests against Postgres $PINNED" >&2
  echo "" >&2
  echo "  The gate is now answering a question about a database nobody runs. Point" >&2
  echo "  cloudbuild.yaml's migration-verify-db step at pgvector/pgvector:pg$LIVE." >&2
  echo "" >&2
  echo "  If this fired because the database was deliberately upgraded, that is the" >&2
  echo "  check working: the tag and the instance are meant to move together." >&2
  exit 1
fi

echo "check-migration-gate-version: OK — gate and Cloud SQL are both Postgres $LIVE"
