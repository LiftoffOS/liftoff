#!/usr/bin/env bash
#
# Apply every migration to an empty Postgres, from scratch.
#
# WHY THIS EXISTS. This repo has 300+ migrations and a test suite with no
# database, so a migration's SQL is never executed anywhere until the migrate
# step runs it against Cloud SQL — after the images are built, minutes into the
# deploy. A statement with a window function inside an aggregate's arguments is
# rejected at parse analysis (42803, `parse_agg.c:check_agg_arguments_walker`),
# and because node-pg-migrate applies the pending batch in ONE transaction it
# takes unrelated migrations down with it, pins the database back, and queues
# every deploy behind it. Nothing else here would catch it.
#
# A linter cannot replace this. The error comes from parse ANALYSIS, which needs
# the catalog — a raw parser (libpg_query and friends) accepts the statement
# happily. The only thing that can answer "will Postgres take this" is Postgres.
# It needs no data, no snapshot and no managed instance: an empty container,
# discarded.
#
# FROM SCRATCH, not incrementally, because it costs the same and proves more:
# that the whole chain still applies to an empty database, which is what
# provisioning a new environment does.
#
# WHAT IT DOES NOT CATCH, so it is not oversold: anything data-dependent (a NOT
# NULL added to a column that has nulls in production), lock contention, or
# volume. This removes the "not valid SQL" class. The real migrate step still
# runs.
#
# Usage: DATABASE_URL=postgres://... scripts/ci/verify-migrations.sh
# The caller owns the database: this assumes it is empty and disposable.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "verify-migrations: DATABASE_URL is required (an empty, disposable database)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ ! -d migrations ]; then
  echo "verify-migrations: no migrations/ directory at $ROOT" >&2
  exit 2
fi

COUNT=$(find migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')
echo "verify-migrations: applying $COUNT migrations to an empty database"

# node-pg-migrate is a direct dependency here, so the project's own binary is
# used rather than npx. That matters: npx fetches into an isolated cache from
# which `pg` does not resolve, and the run dies with ERR_MODULE_NOT_FOUND before
# touching a migration — which reads as a broken migration if you are not
# looking closely.
RUNNER=node_modules/.bin/node-pg-migrate
OUT=$(mktemp)

if [ ! -x "$RUNNER" ]; then
  echo "verify-migrations: INCONCLUSIVE — $RUNNER is missing (was npm ci run?)." >&2
  echo "  No migration was executed, so this says nothing about the SQL." >&2
  rm -f "$OUT"
  exit 2
fi

# Cloud SQL hands the migrations three roles that an empty container does not
# have. Create them before the first GRANT goes looking for a grantee.
if ! node scripts/ci/prepare-verify-db.cjs; then
  echo "verify-migrations: INCONCLUSIVE — could not prepare the test database." >&2
  echo "  No migration was executed, so this says nothing about the SQL." >&2
  rm -f "$OUT"
  exit 2
fi

# The SAME flags Dockerfile.migrate runs in production. A check that applies
# migrations differently from the thing it protects is checking a different
# program; --no-check-order in particular changes which migrations are eligible.
set +e
"$RUNNER" up \
  --migrations-dir=migrations \
  --no-check-order \
  --ignore-pattern '.*\.md' >"$OUT" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  tail -40 "$OUT" >&2
  echo "" >&2
  # A check that could not run and a migration Postgres refused are different
  # problems. Reporting the first as the second sends the reader hunting for a
  # SQL bug that is not there.
  if grep -q "ERR_MODULE_NOT_FOUND\|Cannot find package\|command not found" "$OUT"; then
    echo "verify-migrations: INCONCLUSIVE — the migration runner could not start." >&2
    echo "  No migration was executed, so this says nothing about the SQL." >&2
    rm -f "$OUT"
    exit 2
  fi
  # A missing extension is the test database being wrong, not the migration.
  # Cloud SQL provides pgvector; a stock postgres image does not.
  # A missing ROLE is the same shape of problem: the managed instance provides
  # it and a bare container does not. prepare-verify-db.cjs creates the three we
  # know about, so reaching here means a migration named a NEW one — which is a
  # gap in the gate's furniture, not proof that the SQL is bad.
  if grep -q 'role "[^"]*" does not exist' "$OUT"; then
    echo "verify-migrations: INCONCLUSIVE — a migration grants to a role the test database lacks." >&2
    echo "  Cloud SQL provides it and this container does not. Add it to the ROLES list" >&2
    echo "  in scripts/ci/prepare-verify-db.cjs rather than changing the migration." >&2
    rm -f "$OUT"
    exit 2
  fi
  if grep -q 'extension "[^"]*" is not available\|could not open extension control file' "$OUT"; then
    echo "verify-migrations: INCONCLUSIVE — the test database lacks an extension the migrations need." >&2
    echo "  The migration is not at fault: Cloud SQL provides it and this image does not." >&2
    echo "  Use an image that carries it (pgvector/pgvector:pgNN) rather than stock postgres." >&2
    rm -f "$OUT"
    exit 2
  fi
  echo "verify-migrations: FAILED — a migration cannot be applied to a clean database." >&2
  echo "" >&2
  echo "  This is what the deploy would have hit. Because the batch runs in one" >&2
  echo "  transaction, it would also roll back every other pending migration and" >&2
  echo "  block every deploy behind it." >&2
  rm -f "$OUT"
  exit 1
fi

rm -f "$OUT"
echo "verify-migrations: OK — all $COUNT migrations apply to an empty database"
