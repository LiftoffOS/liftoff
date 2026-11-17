#!/usr/bin/env bash
#
# The model registry and the code constants must give the same answer, and the
# registry must be able to answer at all.
#
# WHY THIS EXISTS. Model names live in three places — the `models` registry,
# each provider's static TIER_MODELS/DEFAULT_MODEL, and the Workspace AI vendor
# map. Loaders now drive the second and third from the first, but an overlay
# only covers what the registry HAS, and only after the first load lands. A seed
# with no row behind it, or a seed the registry disagrees with, is the same
# drift one step further in: it resolves, nothing notices, and the vision gate
# and the pricing sync cannot see the model either. That drift is what put two
# non-existent Gemini ids in the Google tier map, 404-ing every tier-only
# request on large and medium.
#
# AND THE WINDOW. A registry row that resolves but records no `context_window`
# is the same class of defect one field along. Nothing fails: every consumer
# falls back to a conservative 128,000 tokens, so a 1M model closes its turns
# at ~90,000 and reports nothing. Eight rows sat that way until migration 522.
# A database-free unit test cannot see a NULL in a column, which is why the
# assertion lives here, in the one gate that runs against a migrated database.
#
# The assertions live in migrations/__tests__/395_registry_tier_drift.integration.test.ts.
# This script is the thing that RUNS them. It is separate from
# verify-migrations.sh because that script answers a different question — "will
# Postgres accept this SQL" — and because a check that only ever runs when a
# person remembers to type it is not a check. `npm test` cannot host these
# assertions: the unit config excludes *.integration.test.ts, deliberately,
# because they need a database.
#
# TWO PRECONDITIONS, both of which produce INCONCLUSIVE rather than a failure
# when unmet, because a check that could not run knows nothing:
#
#   * The caller owns a database with every migration applied. In CI that is the
#     migration gate's throwaway Postgres, which has just been migrated from
#     scratch, so this costs one jest run and no extra container. Probed before
#     the assertions run, because a beforeAll that cannot connect fails every
#     test and reads exactly like every test finding drift.
#   * The workspace packages are BUILT. The assertions read each provider's tier
#     constants, and importing a provider reaches `@liftoffos/telemetry` through
#     infrastructure/logging — so without `dist/` the suite cannot even load.
#
# Usage: DATABASE_URL=postgres://... scripts/ci/check-registry-drift.sh
#
# Exit codes mirror verify-migrations.sh, and for the same reason:
#   0  the registry and the constants agree, and assertions actually ran
#   1  they disagree — block
#   2  INCONCLUSIVE. Does NOT block: a gate that fails the build over its own
#      plumbing gets deleted rather than fixed.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "check-registry-drift: DATABASE_URL is required (a database with every migration applied)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE=migrations/__tests__/395_registry_tier_drift.integration.test.ts
if [ ! -f "$TEST_FILE" ]; then
  echo "check-registry-drift: INCONCLUSIVE — $TEST_FILE is missing." >&2
  exit 2
fi

# The project's own jest, for the same reason verify-migrations uses the
# project's own node-pg-migrate: npx fetches into an isolated cache from which
# the transitive deps do not resolve, and the run dies before reaching an
# assertion — which reads as a passing check if you are not looking closely.
RUNNER=node_modules/.bin/jest
if [ ! -x "$RUNNER" ]; then
  echo "check-registry-drift: INCONCLUSIVE — $RUNNER is missing (was npm ci run?)." >&2
  echo "  No assertion was evaluated, so this says nothing about the registry." >&2
  exit 2
fi

# Prove the preconditions BEFORE asserting anything, because jest cannot tell
# them apart afterwards. A `beforeAll` that cannot reach the database fails every
# test in the suite, which is indistinguishable from every test finding drift —
# and reporting an unreachable database as "the registry disagrees" sends a
# reader to correct a constant that is correct. Probing first means a jest
# failure can only mean the thing this gate is named for.
#
# `models` specifically, not `SELECT 1`: a database that is up but unmigrated
# answers a trivial query perfectly well and has nothing to compare against.
if ! node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.argv[1] });
  c.connect()
    .then(() => c.query("SELECT 1 FROM models LIMIT 1"))
    .then(() => c.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
' "$DATABASE_URL"; then
  echo "check-registry-drift: INCONCLUSIVE — cannot read \`models\` at the given DATABASE_URL." >&2
  echo "  The database is unreachable or has not been migrated. Nothing was asserted, so this" >&2
  echo "  says NOTHING about the registry." >&2
  exit 2
fi

echo "check-registry-drift: asserting the registry against the code constants, and that every reachable model is sized"

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT

# The test SKIPS itself when TEST_DATABASE_URL is unset, so passing it is what
# makes this a real run rather than a green no-op. globalSetup honours it too:
# it uses the database given here and leaves it alone, rather than reaching for
# a docker-compose Postgres that no CI step started.
set +e
TEST_DATABASE_URL="$DATABASE_URL" \
  "$RUNNER" --config jest.integration.config.js --runInBand \
            --json --outputFile="$REPORT" "$TEST_FILE"
STATUS=$?
set -e

# Jest exits 1 for BOTH "an assertion failed" and "the suite could not load",
# and those are opposite answers: the first is the drift this gate exists to
# catch, the second is no answer at all. Reporting a module-resolution error as
# a registry disagreement sends a reader to correct a constant that is correct.
# The machine-readable report is what separates them — and it also answers the
# question no exit code can, which is whether any assertion ran at all. A suite
# that skipped itself exits 0 having proven nothing, and a green no-op is the
# failure mode this whole gate was built to remove.
VERDICT=$(node -e '
  const fs = require("fs");
  let r;
  try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch { console.log("unreadable"); process.exit(0); }
  if (!Number.isInteger(r.numTotalTests)) { console.log("unreadable"); process.exit(0); }
  // A failed ASSERTION is drift. A failed SUITE with no failed assertion never
  // loaded, and reports zero tests — so this order matters: checking the test
  // count first would call an unloadable suite "ran no assertions" and send the
  // reader to look for a missing TEST_DATABASE_URL instead of an unbuilt package.
  if (r.numFailedTests > 0) { console.log("disagrees"); process.exit(0); }
  if (r.numFailedTestSuites > 0) { console.log("could-not-load"); process.exit(0); }
  // Skipped tests COUNT toward numTotalTests, so "did anything actually assert"
  // is numPassedTests, not numTotalTests. describe.skip is how this suite opts
  // out without a database, and that is precisely the green no-op to reject.
  console.log(r.numPassedTests > 0 ? "agrees" : "nothing-ran");
' "$REPORT" 2>/dev/null || echo unreadable)

case "$VERDICT" in
  agrees)
    if [ "$STATUS" -ne 0 ]; then
      echo "check-registry-drift: INCONCLUSIVE — jest exited $STATUS with no failed assertion." >&2
      exit 2
    fi
    echo "check-registry-drift: OK — every reachable model id is registered and sized, and every tier agrees"
    exit 0
    ;;
  disagrees)
    echo "check-registry-drift: the registry and the code constants DISAGREE (see the failures above)." >&2
    echo "  Either register the model (a migration) or correct the constant — but not neither." >&2
    echo "  A model reported as carrying no context window is the same answer in the same place:" >&2
    echo "  record it in a migration from the vendor's own documentation (migrations 343, 522)," >&2
    echo "  never from a guess — a recorded window licenses a consumer to end a session on it." >&2
    exit 1
    ;;
  could-not-load)
    echo "check-registry-drift: INCONCLUSIVE — the suite could not load (see the error above)." >&2
    echo "  Nothing was asserted, so this says NOTHING about the registry. The usual cause is" >&2
    echo "  unbuilt workspace packages: the assertions import the provider modules, which reach" >&2
    echo "  @liftoffos/telemetry. Run: npm run build --workspaces --if-present" >&2
    exit 2
    ;;
  nothing-ran)
    echo "check-registry-drift: INCONCLUSIVE — the suite ran no assertions." >&2
    echo "  It skips itself without TEST_DATABASE_URL, which would make this a green no-op." >&2
    exit 2
    ;;
  *)
    echo "check-registry-drift: INCONCLUSIVE — jest wrote no readable report (exit $STATUS)." >&2
    exit 2
    ;;
esac
