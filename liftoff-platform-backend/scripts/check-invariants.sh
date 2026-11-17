#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
# Invariants already covered by a lint rule, CI gate, or verification test are listed
# under "Delegated" and are NOT re-implemented here (single source of enforcement).
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "the only meter event_name is
#             operating_unit_consumed"). Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (new meter, manual build). These are inherently
#             about a diff, so they only FAIL in --changed mode against the files a
#             branch actually touched. In full-tree mode they print the existing
#             baseline as NOTICE and never fail (existing code is not a regression).
#
# Usage:  scripts/check-invariants.sh            # state checks + baseline notices
#         scripts/check-invariants.sh --changed  # also enforce change-rules on the diff vs origin/main
# Exit code: 0 = clean, 1 = at least one FAIL. NOTICE lines never fail the run.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

MODE=full
[ "${1:-}" = "--changed" ] && MODE=changed

fail=0
pass()   { printf '  PASS   %s\n' "$1"; }
notice() { printf '  NOTICE %s\n' "$1"; }
failed() { printf '  FAIL   %s\n' "$1"; fail=1; }

# Files a branch changed vs origin/main, filtered to an extension ERE ($1).
changed_files() { git diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$1" || true; }

echo "== docs/invariants.md fitness functions (mode: $MODE) =="

# --- INV-PB-002 — One Stripe meter -------------------------------------------------
# state: no meter event_name other than operating_unit_consumed anywhere in src.
badname=$(grep -rInE "event_name:\s*'" src 2>/dev/null | grep -v "operating_unit_consumed" || true)
if [ -n "$badname" ]; then failed "INV-PB-002 (state): meter event_name other than operating_unit_consumed:"; echo "$badname"; else pass "INV-PB-002 (state): only operating_unit_consumed used as event_name"; fi
# change: no NEW Stripe meter creation introduced by this branch.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); newmeter=""
  [ -n "$cf" ] && newmeter=$(echo "$cf" | xargs grep -InE '\.meters\.create\(' 2>/dev/null || true)
  if [ -n "$newmeter" ]; then failed "INV-PB-002 (change): this branch adds/edits a Stripe meter creation. Meters are infra-managed; there is only operating_unit_consumed:"; echo "$newmeter"; else pass "INV-PB-002 (change): no new meter creation in the diff"; fi
else
  base=$(grep -rInE '\.meters\.create\(' src 2>/dev/null || true)
  [ -n "$base" ] && notice "INV-PB-002 (baseline): existing meter-creation callsite(s) below. Enforced on diffs via --changed:" && echo "$base"
fi

# --- INV-PB-005 — Non-RLS tables stay on the default pool --------------------------
NONRLS='accounts|plans|subscriptions|tenants|staff_roles|feature_flags|models|model_pricing|distillation_cache|tool_classification_cache|schema_migrations'
scoped=$(grep -rInE "withTenantScope" src 2>/dev/null | grep -Ei "from\s+($NONRLS)\b" || true)
if [ -n "$scoped" ]; then notice "INV-PB-005 (state): withTenantScope near a platform-global table; verify it is not scoping a non-RLS read:"; echo "$scoped"; else pass "INV-PB-005 (state): no platform-global table obviously wrapped in withTenantScope"; fi

# --- INV-PB-006 — Slack tokens require reading docs/slack-tokens.md -----------------
SLACK='src/agent-chat/slack-adapter/(config-token-service|bot-token-service|oauth-callback-router)\.ts'
if [ "$MODE" = changed ]; then
  s=$(changed_files "$SLACK")
  if [ -n "$s" ]; then notice "INV-PB-006 (change): Slack-token files changed. Confirm docs/slack-tokens.md was read and which of the 3 systems you touched:"; echo "$s"; else pass "INV-PB-006 (change): no Slack-token files changed"; fi
else
  notice "INV-PB-006: review gate. Run with --changed in CI to flag a diff that touches Slack-token files."
fi

# --- INV-PB-007 — Deploy discipline: no manual build introduced --------------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE 'Skip when not started|# ' || true)
  if [ -n "$mb" ]; then failed "INV-PB-007 (change): this branch adds a 'gcloud builds submit' action. Deploys are trigger-only for platform-backend:"; echo "$mb"; else pass "INV-PB-007 (change): no manual build introduced"; fi
else
  notice "INV-PB-007: change gate (excludes docs + the documented per-tenant-runtime exception). Run with --changed in CI."
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-PB-001 RLS            -> eslint no-restricted-imports + migrations/__tests__/200_verification.integration.test.ts"
echo "  INV-PB-003 OU-native cost -> .github/workflows/ou-native-grep-gate.yml"
echo "  INV-PB-004 No stub success-> eslint r5/no-stub-success-fallback"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
