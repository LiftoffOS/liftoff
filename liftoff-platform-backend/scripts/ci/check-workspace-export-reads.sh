#!/usr/bin/env bash
#
# The workspace export's reads mean what they say, against the real schema.
#
# WHY THIS EXISTS. src/workspace-export/queries.ts is a set of SQL statements
# whose whole value is in their predicates: an assignment removed AFTER the
# cutoff is still in the archive, a person's upload is never a produced file,
# two rows sharing a boundary timestamp survive a page break, a team-chat
# sender resolves the way listMessages resolves it. The unit suite pins the
# TEXT of those statements with a mocked client, which can show a predicate was
# issued and never what it means. The assertions that answer the second
# question live in src/workspace-export/__tests__/queries.integration.test.ts
# and need a migrated database, which the unit config deliberately excludes.
#
# This script is the thing that RUNS them, on the migration gate's throwaway
# Postgres, which has just been migrated from scratch. Same three-state contract
# as check-registry-drift.sh, and for the same reason: a check that could not
# run knows nothing and must not fail the build, while a suite that skipped
# itself for want of TEST_DATABASE_URL is a green no-op and is refused.
#
# Usage: DATABASE_URL=postgres://... scripts/ci/check-workspace-export-reads.sh
#
# Exit codes:
#   0  the reads behave as asserted, and assertions actually ran
#   1  an assertion failed — block
#   2  INCONCLUSIVE. Does NOT block.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "check-workspace-export-reads: DATABASE_URL is required (a database with every migration applied)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE=src/workspace-export/__tests__/queries.integration.test.ts
if [ ! -f "$TEST_FILE" ]; then
  echo "check-workspace-export-reads: INCONCLUSIVE — $TEST_FILE is missing." >&2
  exit 2
fi

RUNNER=node_modules/.bin/jest
if [ ! -x "$RUNNER" ]; then
  echo "check-workspace-export-reads: INCONCLUSIVE — $RUNNER is missing (was npm ci run?)." >&2
  exit 2
fi

# A database the migrations have not reached has no generated_files table; the
# suite would then fail every test and read exactly like the reads being wrong.
if ! node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.argv[1] });
  c.connect().then(() => c.query("SELECT 1 FROM generated_files LIMIT 0"))
    .then(() => c.end()).then(() => process.exit(0))
    .catch(() => process.exit(1));
' "$DATABASE_URL"; then
  echo "check-workspace-export-reads: INCONCLUSIVE — cannot read \`generated_files\` at the given DATABASE_URL." >&2
  echo "  Apply the migrations first; this script asks about a migrated database." >&2
  exit 2
fi

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT

set +e
TEST_DATABASE_URL="$DATABASE_URL" \
  "$RUNNER" --config jest.integration.config.js --runInBand --forceExit \
            --json --outputFile="$REPORT" "$TEST_FILE"
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
    echo "check-workspace-export-reads: the reads behave as asserted."
    exit 0 ;;
  failed)
    echo "check-workspace-export-reads: FAIL — a read does not behave as asserted (see the report above)." >&2
    exit 1 ;;
  could-not-load)
    echo "check-workspace-export-reads: INCONCLUSIVE — the suite could not load (see the error above)." >&2
    exit 2 ;;
  nothing-ran)
    echo "check-workspace-export-reads: INCONCLUSIVE — the suite ran no assertions." >&2
    echo "  It skips itself without TEST_DATABASE_URL, which would make this a green no-op." >&2
    exit 2 ;;
  *)
    echo "check-workspace-export-reads: INCONCLUSIVE — jest wrote no readable report (exit $STATUS)." >&2
    exit 2 ;;
esac
