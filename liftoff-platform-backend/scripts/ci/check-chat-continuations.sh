#!/usr/bin/env bash
#
# The tenant database behaves as asserted, against the real schema.
#
# Two suites, one migrated database, because both ask a question a mocked
# client cannot answer:
#
#   the RLS census (migrations/__tests__/200_verification.integration.test.ts)
#     — every tenant table has RLS and a tenant_isolation policy, the few
#       excluded ones have neither, and a cross-tenant read or write is
#       actually refused. It has existed since migration 200 and nothing ran
#       it, so its baseline drifted: tables that migration 200 deliberately
#       enabled were still listed as excluded, and three fixtures named
#       columns and a table later migrations changed or dropped. A check
#       nobody runs is a check that is wrong by the time it matters.
#
#   the continuation rows (src/chat-continuations/__tests__/store.integration.test.ts)
#     — see below.
#
# WHY THIS EXISTS. src/chat-continuations/store.ts is a state machine in SQL
# (queued -> claimed -> running -> done | cancelled | failed, with a requeue
# on a busy lock and a cancel that covers queued AND claimed rows but never a
# running one), and its whole value is in which rows each statement touches:
# a claim that takes a row twice runs a paid turn twice; a cancel that misses
# a claimed row runs work the person has moved on from. The unit suite pins
# the TEXT of those statements with a mocked client, which can show a
# predicate was issued and never what it does. The assertions that answer the
# second question live in src/chat-continuations/__tests__/store.integration.test.ts
# and need a migrated database, which the unit config deliberately excludes.
#
# This script is the thing that RUNS them, on the migration gate's throwaway
# Postgres, which has just been migrated from scratch. Same three-state contract
# as check-registry-drift.sh, and for the same reason: a check that could not
# run knows nothing and must not fail the build, while a suite that skipped
# itself for want of TEST_DATABASE_URL is a green no-op and is refused.
#
# Usage: DATABASE_URL=postgres://... scripts/ci/check-chat-continuations.sh
#
# Exit codes:
#   0  the rows behave as asserted, and assertions actually ran
#   1  an assertion failed — block
#   2  INCONCLUSIVE. Does NOT block.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "check-chat-continuations: DATABASE_URL is required (a database with every migration applied)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILES="migrations/__tests__/200_verification.integration.test.ts src/chat-continuations/__tests__/store.integration.test.ts"
for f in $TEST_FILES; do
  if [ ! -f "$f" ]; then
    echo "check-chat-continuations: INCONCLUSIVE — $f is missing." >&2
    exit 2
  fi
done

RUNNER=node_modules/.bin/jest
if [ ! -x "$RUNNER" ]; then
  echo "check-chat-continuations: INCONCLUSIVE — $RUNNER is missing (was npm ci run?)." >&2
  exit 2
fi

# A database the migrations have not reached has no chat_continuations table;
# the suite would then fail every test and read exactly like the rows being
# wrong. Asked of the catalog rather than of the table: chat_continuations is
# FORCE RLS and its policy reads app.current_tenant_id strictly, as every
# tenant table here does, so SELECTing from it without a scope raises 42704 —
# which is the policy working, not the migrations missing.
if ! node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.argv[1] });
  c.connect()
    .then(() => c.query("SELECT to_regclass($1) AS t", ["public.chat_continuations"]))
    .then((r) => { if (!r.rows[0].t) throw new Error("missing"); })
    .then(() => c.end()).then(() => process.exit(0))
    .catch(() => process.exit(1));
' "$DATABASE_URL"; then
  echo "check-chat-continuations: INCONCLUSIVE — cannot read \`chat_continuations\` at the given DATABASE_URL." >&2
  echo "  Apply the migrations first; this script asks about a migrated database." >&2
  exit 2
fi

# A SUPERUSER bypasses row-level security entirely — FORCE included — so every
# cross-tenant denial the census asserts would be answered with the row it says
# must be hidden. That is the connection, not the schema: CI connects as the
# migration role, which owns the tables and is NOT a superuser, and a developer
# box connects as itself, which usually is. Refusing to run beats reporting a
# failure the code did not cause, and beats skipping quietly: exit 2 says the
# check could not run, and nothing below reads it as a pass.
if node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.argv[1] });
  c.connect()
    .then(() => c.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user"))
    .then((r) => { process.exitCode = r.rows[0] && r.rows[0].rolsuper ? 0 : 1; })
    .then(() => c.end())
    .catch(() => { process.exitCode = 1; });
' "$DATABASE_URL"; then
  echo "check-chat-continuations: INCONCLUSIVE — this connection is a SUPERUSER, which bypasses" >&2
  echo "  row-level security, so the census's cross-tenant denials cannot be asserted here." >&2
  echo "  CI connects as the non-superuser migration role and does run them." >&2
  exit 2
fi

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT

set +e
TEST_DATABASE_URL="$DATABASE_URL" \
  "$RUNNER" --config jest.integration.config.js --runInBand --forceExit \
            --json --outputFile="$REPORT" $TEST_FILES
STATUS=$?
set -e

VERDICT=$(node -e '
  const fs = require("fs");
  let r;
  try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch { console.log("unreadable"); process.exit(0); }
  if (!Number.isInteger(r.numTotalTests)) { console.log("unreadable"); process.exit(0); }
  if (r.numFailedTests > 0) { console.log("failed"); process.exit(0); }
  if (r.numFailedTestSuites > 0) { console.log("could-not-load"); process.exit(0); }
  console.log(r.numPassedTests > 0 ? "passed" : "nothing-ran");
' "$REPORT" 2>/dev/null || echo unreadable)

case "$VERDICT" in
  passed)
    echo "check-chat-continuations: the rows behave as asserted."
    exit 0 ;;
  failed)
    echo "check-chat-continuations: FAIL — a row does not behave as asserted (see the report above)." >&2
    exit 1 ;;
  could-not-load)
    echo "check-chat-continuations: INCONCLUSIVE — the suite could not load (see the error above)." >&2
    exit 2 ;;
  nothing-ran)
    echo "check-chat-continuations: INCONCLUSIVE — the suite ran no assertions." >&2
    echo "  It skips itself without TEST_DATABASE_URL, which would make this a green no-op." >&2
    exit 2 ;;
  *)
    echo "check-chat-continuations: INCONCLUSIVE — jest wrote no readable report (exit $STATUS)." >&2
    exit 2 ;;
esac
