#!/usr/bin/env bash
#
# The feature-flag rows a gate is switched on by actually exist, in a database
# built from the migration chain.
#
# WHY THIS EXISTS. `FeatureFlagService.isEnabled` returns FALSE for a MISSING
# row. That is the right default and it is also a silent one: a gate whose row
# was never inserted, or was deleted by a later migration, is indistinguishable
# from a gate somebody deliberately turned off. The injection detector spent its
# whole life in that state — every screen in two services, gated on two keys
# that existed in no environment, so `resolveInjectionMode` answered `off` for
# every tenant and the detector was a feature wired at one end.
#
# Migration 540 seeds them. What this step adds over the migration running is
# the SECOND failure: a later migration, or a hand-run statement folded into
# one, dropping or flipping the rows. The migration gate would still be green —
# it applies the chain and asks nothing about its output — and the detector
# would be off again with nothing saying so.
#
# The assertions live in
# migrations/__tests__/540_injection_detection_flags.integration.test.ts and
# need a migrated database, which the unit config deliberately excludes. This
# script is the thing that RUNS them, on the migration gate's throwaway
# Postgres. Same three-state contract as check-registry-drift.sh, and for the
# same reason: a check that could not run knows nothing and must not fail the
# build, while a suite that skipped itself for want of TEST_DATABASE_URL is a
# green no-op and is refused.
#
# Usage: DATABASE_URL=postgres://... scripts/ci/check-seeded-feature-flags.sh
#
# Exit codes:
#   0  the rows are present, with the values the rollout needs
#   1  a row is missing or carries the wrong value — block
#   2  INCONCLUSIVE. Does NOT block.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "check-seeded-feature-flags: DATABASE_URL is required (a database with every migration applied)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILES="migrations/__tests__/540_injection_detection_flags.integration.test.ts migrations/__tests__/543_injection_detection_enforces.integration.test.ts"
for f in $TEST_FILES; do
  if [ ! -f "$f" ]; then
    echo "check-seeded-feature-flags: INCONCLUSIVE — $f is missing." >&2
    exit 2
  fi
done

RUNNER=node_modules/.bin/jest
if [ ! -x "$RUNNER" ]; then
  echo "check-seeded-feature-flags: INCONCLUSIVE — $RUNNER is missing (was npm ci run?)." >&2
  exit 2
fi

# A database the migrations have not reached has no feature_flags table, and the
# suite would then fail every test and read exactly like the rows being absent —
# which is the one thing this check exists to tell apart. Asked of the catalog,
# because feature_flags is not tenant-scoped and a plain SELECT on it is a fair
# question.
if ! node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.argv[1] });
  c.connect()
    .then(() => c.query("SELECT to_regclass($1) AS t", ["public.feature_flags"]))
    .then((r) => { if (!r.rows[0].t) throw new Error("missing"); })
    .then(() => c.end()).then(() => process.exit(0))
    .catch(() => process.exit(1));
' "$DATABASE_URL"; then
  echo "check-seeded-feature-flags: INCONCLUSIVE — cannot read \`feature_flags\` at the given DATABASE_URL." >&2
  echo "  Apply the migrations first; this script asks about a migrated database." >&2
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
    echo "check-seeded-feature-flags: the seeded rows are present, with the values the rollout needs."
    exit 0 ;;
  failed)
    echo "check-seeded-feature-flags: FAIL — a seeded flag row is missing or carries the wrong value." >&2
    echo "  isEnabled() reads false for a missing row, so the gate it guards is OFF and silent." >&2
    exit 1 ;;
  could-not-load)
    echo "check-seeded-feature-flags: INCONCLUSIVE — the suite could not load (see the error above)." >&2
    exit 2 ;;
  nothing-ran)
    echo "check-seeded-feature-flags: INCONCLUSIVE — the suite ran no assertions." >&2
    echo "  It skips itself without TEST_DATABASE_URL, which would make this a green no-op." >&2
    exit 2 ;;
  *)
    echo "check-seeded-feature-flags: INCONCLUSIVE — jest wrote no readable report (exit $STATUS)." >&2
    exit 2 ;;
esac
