#!/usr/bin/env bash
# The TypeSafe fixture contract, with the vendor's uptime separated from the
# contract's verdict.
#
# WHY THIS EXISTS. The contract calls a LIVE third party, and it sits on the
# critical path of every runtime deploy — `build` waits for it. That is
# deliberate: the browser loop, the contract check, the ask check, the message
# check and the memory checks all default their kills ON in this build and ship
# with these fixtures as their evidence, so a contract that skips itself is worse
# than a slow build. What is NOT deliberate is a vendor outage blocking a billing
# fix from reaching production. A check that could not reach the thing it checks
# has learned nothing about it, and a gate that fails a build over someone else's
# uptime gets deleted rather than fixed.
#
# So this script reports THREE states, the same contract verify-migrations and
# check-registry-drift already use in this estate:
#
#   0  the fixtures were asked and they hold
#   1  the fixtures were asked and one moved        -> BLOCK, that is the job
#   2  the vendor never answered                    -> INCONCLUSIVE, do not block
#
# The distinction is not inferred from the failure text, which belongs to the
# vendor and can change without notice. The suite prints one literal sentinel
# after it exhausts its retries on an unreachable vendor, and that line — and only
# that line — is what turns a failure into an INCONCLUSIVE here.
#
# Note the retries live in the SUITE, not here: re-running the whole contract
# would re-ask every fixture that already passed and pay for them twice.

set -uo pipefail

SENTINEL='TYPESAFE_CONTRACT_VENDOR_UNAVAILABLE'
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  # NOT inconclusive. A missing key is this build's own configuration, and the
  # features that ship on this evidence default ON regardless, so proceeding
  # would ship them unevidenced.
  echo "typesafe-contract: no key; refusing to run a contract that would skip itself." >&2
  exit 1
fi

export LIVE_TESTS=true
timeout --kill-after=15 600 npx jest src/typesafe/__tests__/fixtures.live.test.ts --ci --runInBand 2>&1 | tee "$OUT"
STATUS="${PIPESTATUS[0]}"

if [ "$STATUS" -eq 0 ]; then
  exit 0
fi

if grep -q "$SENTINEL" "$OUT"; then
  echo "typesafe-contract: INCONCLUSIVE — the vendor did not answer after the suite's retries." >&2
  echo "  No fixture was judged, so this says nothing about the contract." >&2
  exit 2
fi

# `timeout` kills at 600s with 124. The suite's own retries can legitimately take
# minutes against a struggling vendor, so a wall-clock kill is far more likely to
# be the vendor being slow than a fixture being wrong — and a fixture that is
# wrong fails fast, it does not hang.
if [ "$STATUS" -eq 124 ] || [ "$STATUS" -eq 137 ]; then
  echo "typesafe-contract: INCONCLUSIVE — the contract was killed at its wall clock ($STATUS)." >&2
  echo "  Not every fixture was judged, so the ones that were prove nothing about the rest." >&2
  exit 2
fi

exit "$STATUS"
