#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
# Invariants already covered by a CI gate or validator (INV-INFRA-006 IAM/KMS/SQL
# validators, INV-INFRA-008 fmt/validate/shellcheck) are listed under "Delegated"
# and are NOT re-implemented here (single source of enforcement).
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "prod deploy branch is ^release$").
#             Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (public allUsers, manual apply, new internal-only
#             ingress). These are inherently about a diff, so they only FAIL in
#             --changed mode against the files a branch actually touched. In full-tree
#             mode they print the existing baseline as NOTICE and never fail (existing
#             infra is not a regression).
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
# Self-exclude this checker: it legitimately contains the very tokens it scans for
# ('gcloud builds submit', 'terraform apply -auto-approve') as patterns and messages,
# so it must never scan itself or it flags its own definitions.
changed_files() { git diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$1" | grep -vF 'scripts/check-invariants.sh' || true; }

echo "== docs/invariants.md fitness functions (mode: $MODE) =="

# --- INV-INFRA-001 — Per-env deploy-branch mapping ---------------------------------
# state: prod applies off ^release$, staging off ^staging$; the plan trigger stays
# plan-only and the apply trigger stays apply. Crossed wires would ship un-promoted prod.
prodok=$(grep -E 'deploy_branch_pattern\s*=\s*"\^release\$"' terraform/environments/prod/main.tf 2>/dev/null || true)
if [ -n "$prodok" ]; then pass "INV-INFRA-001 (state): prod deploy_branch_pattern is ^release\$"; else failed "INV-INFRA-001 (state): prod deploy_branch_pattern is NOT ^release\$ (prod must deploy off 'release', not 'main')"; fi
stgok=$(grep -E 'deploy_branch_pattern\s*=\s*"\^staging\$"' terraform/environments/staging/main.tf 2>/dev/null || true)
if [ -n "$stgok" ]; then pass "INV-INFRA-001 (state): staging deploy_branch_pattern is ^staging\$"; else failed "INV-INFRA-001 (state): staging deploy_branch_pattern is NOT ^staging\$"; fi
planonly=$(grep -A30 'google_cloudbuild_trigger" "infrastructure_plan"' terraform/projects/platform-ci/main.tf 2>/dev/null | grep -E '_PLAN_ONLY\s*=\s*"true"' || true)
applyon=$(grep -A30 'google_cloudbuild_trigger" "infrastructure_apply"' terraform/projects/platform-ci/main.tf 2>/dev/null | grep -E '_PLAN_ONLY\s*=\s*"false"' || true)
if [ -n "$planonly" ] && [ -n "$applyon" ]; then pass "INV-INFRA-001 (state): plan trigger is _PLAN_ONLY=true, apply trigger is _PLAN_ONLY=false"; else failed "INV-INFRA-001 (state): plan/apply _PLAN_ONLY wiring changed — plan must stay true, apply false"; fi

# --- INV-INFRA-002 — No manual apply, no gcloud builds submit ----------------------
# change: this branch must not introduce a manual build or a manual (non-saved-plan) apply.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml|tf)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE '# ' || true)
  if [ -n "$mb" ]; then failed "INV-INFRA-002 (change): this branch adds a 'gcloud builds submit'. Infra deploys are trigger-only:"; echo "$mb"; else pass "INV-INFRA-002 (change): no manual 'gcloud builds submit' introduced"; fi
  # manual apply = `terraform apply -auto-approve` with NO saved plan file argument, outside cloudbuild.yaml (which applies a saved plan).
  ma=""
  [ -n "$cf" ] && ma=$(echo "$cf" | grep -v 'cloudbuild.yaml' | xargs grep -InE 'terraform apply' 2>/dev/null | grep -E 'auto-approve' | grep -vE 'apply\b.*tfplan|apply .*\$\{?plan|# ' || true)
  if [ -n "$ma" ]; then failed "INV-INFRA-002 (change): this branch adds a 'terraform apply -auto-approve' with no saved plan file. Apply the reviewed plan, not a fresh re-plan:"; echo "$ma"; else pass "INV-INFRA-002 (change): no manual auto-approve apply introduced"; fi
else
  base=$(grep -rInE 'gcloud builds submit' scripts .github 2>/dev/null | grep -vE '# ' || true)
  [ -n "$base" ] && notice "INV-INFRA-002 (baseline): existing 'gcloud builds submit' reference(s). Enforced on diffs via --changed:" && echo "$base"
fi

# --- INV-INFRA-003 — Deliberate drift review ---------------------------------------
# state: the apply pipeline must apply a SAVED plan file, never re-plan at apply time.
savedplan=$(grep -E 'terraform apply .*tfplan' cloudbuild.yaml 2>/dev/null || true)
if [ -n "$savedplan" ]; then pass "INV-INFRA-003 (state): cloudbuild apply step applies the saved plan file (tfplan), not a fresh re-plan"; else failed "INV-INFRA-003 (state): cloudbuild apply no longer applies a saved 'tfplan' — an apply that re-plans can sweep up unrelated drift"; fi

# --- INV-INFRA-004 — No public / unauthenticated resources -------------------------
PUBLIC='member\s*=\s*"(allUsers|allAuthenticatedUsers)"'
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.tf$'); addpub=""
  # only lines this branch ADDED (leading +) in .tf files, matching a public IAM member.
  [ -n "$cf" ] && addpub=$(git diff origin/main...HEAD -- '*.tf' 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$PUBLIC" || true)
  if [ -n "$addpub" ]; then failed "INV-INFRA-004 (change): this branch ADDS an allUsers/allAuthenticatedUsers binding. Only the frontend CDN bucket + Stripe webhook may be public — get review + a justifying comment:"; echo "$addpub"; else pass "INV-INFRA-004 (change): no new public IAM member added"; fi
else
  base=$(grep -rInE "$PUBLIC" terraform 2>/dev/null || true)
  [ -n "$base" ] && notice "INV-INFRA-004 (baseline): existing public IAM binding(s) below (expected: frontend CDN bucket + Stripe webhook). Enforced on diffs via --changed:" && echo "$base"
fi

# --- INV-INFRA-005 — Internal services use ingress=all + no-allow-unauthenticated --
# Match real assignments only (ingress = "...INTERNAL_ONLY"), not comments/enum descriptions.
INTERNAL='ingress[[:space:]]*=[[:space:]]*"INGRESS_TRAFFIC_INTERNAL_ONLY"'
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.tf$'); addint=""
  [ -n "$cf" ] && addint=$(git diff origin/main...HEAD -- '*.tf' 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$INTERNAL" || true)
  if [ -n "$addint" ]; then notice "INV-INFRA-005 (change): this branch adds an INGRESS_TRAFFIC_INTERNAL_ONLY assignment. Confirm the service is VPC-only (never behind the GCLB / a public URL) — otherwise use ingress=all + no-allow-unauthenticated:"; echo "$addint"; else pass "INV-INFRA-005 (change): no new internal-only ingress assignment introduced"; fi
else
  base=$(grep -rInE "$INTERNAL" terraform 2>/dev/null || true)
  if [ -n "$base" ]; then notice "INV-INFRA-005 (state): INGRESS_TRAFFIC_INTERNAL_ONLY assignments below; each must be a VPC-only service (e.g. tenant-runtime split services), not a GCLB/public-URL-fronted one:"; echo "$base"; else pass "INV-INFRA-005 (state): no INGRESS_TRAFFIC_INTERNAL_ONLY assignments"; fi
fi

# --- INV-INFRA-009 — Slack tokens / secrets ----------------------------------------
# state: prod slack_bot_token must have NO default (the guard rail).
prodslack=$(awk '/variable "slack_bot_token"/{f=1} f{print} /^}/{if(f)f=0}' terraform/environments/prod/main.tf 2>/dev/null | grep -E 'default\s*=' || true)
if [ -n "$prodslack" ]; then failed "INV-INFRA-009 (state): prod var.slack_bot_token has a default — remove it; the missing default is the prod guard rail:"; echo "$prodslack"; else pass "INV-INFRA-009 (state): prod var.slack_bot_token has no default (guard rail intact)"; fi
if [ "$MODE" = changed ]; then
  s=$(changed_files 'slack|environments/prod/main\.tf')
  if [ -n "$s" ]; then notice "INV-INFRA-009 (change): Slack-token / prod-slack file(s) changed. Confirm CLAUDE.md 'Slack tokens' was read and which of the 3 systems you touched:"; echo "$s"; else pass "INV-INFRA-009 (change): no Slack-token files changed"; fi
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-INFRA-006 least privilege -> scripts/ci/validate-secret-accessor.sh + validate-kms-key-ref.sh + validate-no-cloudsqlsuperuser.sh (ci.yml iam-validators)"
echo "  INV-INFRA-007 env survives apply -> module review (no automated check yet)"
echo "  INV-INFRA-008 fmt/validate/shell -> ci.yml terraform-validate + shellcheck + pr-title"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
