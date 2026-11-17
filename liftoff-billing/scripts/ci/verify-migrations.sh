#!/usr/bin/env bash
#
# Apply every migration to an empty Postgres, from scratch, in order.
#
# WHY THIS EXISTS. The test suite here has no database, so a migration's SQL is
# never executed anywhere until the billing-migrate Cloud Run Job runs it
# against Cloud SQL — after the images are built, minutes into a deploy. And
# node-pg-migrate applies the whole pending batch in ONE transaction, so a
# single bad statement rolls back every other migration in the batch and blocks
# every deploy behind it.
#
# The specific rot this catches: a migration referencing an object that a LATER
# migration creates. That cannot fail in a live database, because the earlier
# migration is already recorded and never runs again — so the chain can be
# broken for months while every deploy stays green. It surfaces only where the
# order actually matters: provisioning a new environment, or a restore. That is
# the worst possible time to find it.
#
# The typical cause: an already-applied migration is edited to GRANT on a
# table a later migration creates. Nothing rebuilds the chain, so nothing
# notices until somebody tries.
#
# FROM SCRATCH, not incrementally, because it costs the same and proves more:
# that the whole chain still applies to an empty database, which is what
# standing up a new environment does.
#
# WHAT IT DOES NOT CATCH, so it is not oversold: anything data-dependent (a NOT
# NULL added to a column that has nulls in production), lock contention, or
# volume. This removes the "cannot be applied in order" class. The real migrate
# step still runs.
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

# The project's own binary rather than npx: npx fetches into an isolated cache
# from which `pg` does not resolve, and the run dies with ERR_MODULE_NOT_FOUND
# before touching a migration — which reads as a broken migration if you are not
# looking closely.
RUNNER=node_modules/.bin/node-pg-migrate
if [ ! -x "$RUNNER" ]; then
  echo "verify-migrations: $RUNNER not found — run npm ci first" >&2
  exit 2
fi

# The roles every GRANT in this chain targets. A bare container has none of
# them, and migration 008 grants to all three, so without this the run fails on
# a missing role rather than on anything about the SQL — an INCONCLUSIVE result
# dressed up as a failure.
node scripts/ci/prepare-verify-db.cjs || exit 2

OUT=$(mktemp)
if "$RUNNER" --migrations-dir ./migrations up >"$OUT" 2>&1; then
  echo "verify-migrations: OK — all $COUNT migrations apply to an empty database"
  exit 0
fi

echo "verify-migrations: FAILED — the chain does not apply to an empty database" >&2
echo "--- node-pg-migrate output ---" >&2
tail -40 "$OUT" >&2
exit 1
