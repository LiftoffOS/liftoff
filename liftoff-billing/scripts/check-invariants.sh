#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md (liftoff-billing).
#
# Implements the drift checks that are not already a CI gate/test. Gate/test-enforced
# invariants are listed under "Delegated" and not re-implemented here.
#
#   state   — property of the current tree (always evaluated; can FAIL/NOTICE).
#   change  — "do not ADD X" rules; only FAIL in --changed mode against the diff vs origin/main.
#
# Usage:  scripts/check-invariants.sh            # state checks + baseline notices
#         scripts/check-invariants.sh --changed  # also enforce change-rules on the diff
# Exit code: 0 = clean, 1 = at least one FAIL. NOTICE never fails the run.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

MODE=full
[ "${1:-}" = "--changed" ] && MODE=changed
fail=0
pass()   { printf '  PASS   %s\n' "$1"; }
notice() { printf '  NOTICE %s\n' "$1"; }
failed() { printf '  FAIL   %s\n' "$1"; fail=1; }
changed_files() { git diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$1" || true; }

echo "== docs/invariants.md fitness functions (mode: $MODE) =="

# INV-BILL-001 — One meter.
# state: every `event_name:` in src resolves to the OU_METER_EVENT_NAME constant, never a
# string literal other than operating_unit_consumed.
badname=$(grep -rInE "event_name:\s*'" src 2>/dev/null | grep -v "operating_unit_consumed" || true)
if [ -n "$badname" ]; then failed "INV-BILL-001 (state): meter event_name string literal other than operating_unit_consumed (use the OU_METER_EVENT_NAME constant):"; echo "$badname"; else pass "INV-BILL-001 (state): no rogue event_name literal"; fi
# state: OU_METER_EVENT_NAME is still 'operating_unit_consumed'.
if grep -qE "OU_METER_EVENT_NAME\s*=\s*'operating_unit_consumed'" src/infrastructure/metronome-client.ts 2>/dev/null; then pass "INV-BILL-001 (state): OU_METER_EVENT_NAME === 'operating_unit_consumed'"; else failed "INV-BILL-001 (state): OU_METER_EVENT_NAME definition changed or moved"; fi
# change: no NEW meter creation introduced by this branch.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); newmeter=""
  [ -n "$cf" ] && newmeter=$(echo "$cf" | xargs grep -InE '\.meters\.create\(' 2>/dev/null || true)
  if [ -n "$newmeter" ]; then failed "INV-BILL-001 (change): this branch adds a meter creation; there is only operating_unit_consumed:"; echo "$newmeter"; else pass "INV-BILL-001 (change): no new meter creation in the diff"; fi
fi

# INV-BILL-006 — Deploy discipline: no manual build introduced.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE 'Skip when|# ' || true)
  if [ -n "$mb" ]; then failed "INV-BILL-006 (change): this branch adds a 'gcloud builds submit' action; deploys are trigger-only:"; echo "$mb"; else pass "INV-BILL-006 (change): no manual build introduced"; fi
else
  notice "INV-BILL-006: change gate. Run with --changed in CI to check the diff."
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-BILL-004 OU-native cost    -> .github/workflows/ou-native-grep-gate.yml"
echo "  INV-BILL-005 Proto compat      -> .github/workflows/both-sides-green.yml"
echo "  INV-BILL-002/003 drain+webhook -> social/test; review-gate"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
