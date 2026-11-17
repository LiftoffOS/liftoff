#!/usr/bin/env bash
#
# Apply every migration to an empty Postgres, from scratch.
#
# WHY THIS EXISTS. A migration can carry SQL Postgres rejects during parse
# analysis — e.g. `LAG() OVER (...)` inside `jsonb_agg()`'s arguments, 42803,
# `parse_agg.c:check_agg_arguments_walker` — so it never touches a row. Nothing
# in the test suite can catch that: the suite has no database, and the
# statement is never executed anywhere until Cloud Run runs it for real, deep
# into the build.
#
# The blast radius is why this is a gate rather than a nicety. node-pg-migrate
# applies the pending batch in ONE transaction, so one invalid statement rolls
# back other, unrelated migrations in the batch too, pins the database behind
# them, and queues every deploy step behind it.
#
# A SQL linter cannot replace this. The error comes from parse ANALYSIS, which
# needs the catalog — a raw parser (libpg_query and friends) accepts the
# statement happily. The only thing that can answer "will Postgres take this" is
# Postgres.
#
# FROM SCRATCH, not incrementally, because it costs the same and proves more:
# that the whole chain still applies to an empty database, which is exactly what
# provisioning a new tenant does.
#
# WHAT IT DOES NOT CATCH, so it is not oversold: anything data-dependent (a NOT
# NULL added to a column that has nulls in production), lock contention, or
# volume. This removes the "not valid SQL" class. The real migrate step still
# runs.
#
# Usage: DATABASE_URL=postgres://... scripts/ci/verify-migrations.sh
# The caller owns the database: this script assumes it is empty and disposable.

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

# Install the runner INTO this project's node_modules, which is what
# Dockerfile.migrate does (`npm install node-pg-migrate` inside /app) and
# therefore what production actually runs.
#
# Not `npx`. node-pg-migrate is not a dependency here, so npx fetches it into an
# isolated cache and its ESM `import 'pg'` resolves from THAT directory, not from
# the project — ERR_MODULE_NOT_FOUND before a single migration is touched.
# `npx -p node-pg-migrate -p pg` appears to fix it and does so only on some Node
# versions: it worked on 20.x locally and failed on 20.20.2 in Cloud Build.
# Installing beside `pg` in the project tree removes the resolution question
# instead of betting on it.
OUT=$(mktemp)
if [ ! -x node_modules/.bin/node-pg-migrate ]; then
  echo "verify-migrations: installing the migration runner"
  # The @liftoffos scope needs a token; node-pg-migrate does not, but npm still
  # reads .npmrc and an unset variable there makes it unhappy. CI writes the
  # token to /workspace/.ar-token in an earlier step.
  if [ -z "${ARTIFACT_REGISTRY_TOKEN:-}" ] && [ -f /workspace/.ar-token ]; then
    ARTIFACT_REGISTRY_TOKEN="$(cat /workspace/.ar-token)"
    export ARTIFACT_REGISTRY_TOKEN
  fi
  if ! npm install --no-save --no-audit --no-fund node-pg-migrate >"$OUT" 2>&1; then
    tail -20 "$OUT" >&2
    echo "verify-migrations: INCONCLUSIVE — could not install the migration runner." >&2
    echo "  No migration was executed, so this says nothing about the SQL." >&2
    rm -f "$OUT"
    exit 2
  fi
fi

set +e
node_modules/.bin/node-pg-migrate up \
  --migrations-dir=migrations \
  --no-check-order \
  --ignore-pattern '.*\.md' >"$OUT" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  tail -40 "$OUT" >&2
  echo "" >&2
  # A runner that never started and a migration that Postgres refused are
  # different problems, and reporting the first as the second sends the reader
  # looking for a SQL bug that is not there. This distinction cost a debugging
  # cycle the first time this script ran.
  if grep -q "ERR_MODULE_NOT_FOUND\|Cannot find package\|command not found" "$OUT"; then
    echo "verify-migrations: INCONCLUSIVE — the migration runner could not start." >&2
    echo "  No migration was executed, so this says nothing about the SQL." >&2
    rm -f "$OUT"
    exit 2
  fi
  # A missing extension is the test database being wrong, not the migration.
  # Cloud SQL provides pgvector; a stock postgres image does not, and reporting
  # that as "this migration is broken" sends the reader hunting for a SQL bug in
  # a statement production runs happily every day.
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
