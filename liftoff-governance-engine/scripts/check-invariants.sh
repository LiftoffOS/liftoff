#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
# Invariants already covered by a test, CI/DB gate, or lint rule are listed under
# "Delegated" and are NOT re-implemented here (single source of enforcement).
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "no code path mutates audit_logs").
#             Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (new raw tenant query, new manual build, dropped
#             idempotency constraint). These are inherently about a diff, so they only
#             FAIL in --changed mode against the files a branch actually touched. In
#             full-tree mode they print the existing baseline as NOTICE and never fail
#             (existing code is not a regression).
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

# --- INV-GOV-002 — Audit log is append-only ---------------------------------------
# state: no code path issues UPDATE / DELETE / TRUNCATE against audit_logs. The only
# sanctioned deletion is purge_audit_logs_older_than() in migration 019.
# Product code paths only — test teardown legitimately purges the table between runs.
mut=$(grep -rInE "(UPDATE|DELETE[[:space:]]+FROM|TRUNCATE)[[:space:]]+audit_logs" src 2>/dev/null | grep -vE '(test|__tests__|__benchmark__)' || true)
if [ -n "$mut" ]; then failed "INV-GOV-002 (state): code mutates audit_logs; the trail is append-only (only purge_audit_logs_older_than may delete):"; echo "$mut"; else pass "INV-GOV-002 (state): no UPDATE/DELETE/TRUNCATE of audit_logs in src"; fi

# --- INV-GOV-003 — Tenant scoping via withTenantScope ------------------------------
# RLS tables (ENABLE, migration 001/009/010). Raw pool.query on these bypasses the
# tenant-isolation policy. Existing by-PK / owner reads are a known baseline (NOTICE);
# a NEW one in the diff FAILs under --changed.
RLS='actions|compensation_actions|compensation_plans|usage_events|burn_state|refunds|audit_logs|hitl_approval_requests|hitl_rate_limit_events|human_feedback|action_allowlists|cached_entitlements|kill_switches'
rawq_line='(pool\.query|getPool\(\)\.query)'
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); newraw=""
  [ -n "$cf" ] && newraw=$(echo "$cf" | grep -vE '(test|__tests__|__benchmark__)' | xargs grep -InE "$rawq_line" 2>/dev/null | grep -iE "$RLS" || true)
  if [ -n "$newraw" ]; then failed "INV-GOV-003 (change): this branch adds a raw pool.query on a tenant-scoped table. Use withTenantScope, or comment why isolation is not needed:"; echo "$newraw"; else pass "INV-GOV-003 (change): no new raw tenant-table query in the diff"; fi
else
  base=$(grep -rInE "$rawq_line" src 2>/dev/null | grep -vE '(test|__tests__|__benchmark__)' | grep -iE "$RLS" || true)
  [ -n "$base" ] && notice "INV-GOV-003 (baseline): existing raw query(ies) on an RLS table below (deliberate by-PK/owner reads). Enforced on diffs via --changed:" && echo "$base"
  [ -z "$base" ] && pass "INV-GOV-003 (state): no raw tenant-table query in src"
fi

# --- INV-GOV-006 — Ledger idempotency ---------------------------------------------
# change: do not DROP an idempotency unique constraint/index in a migration.
if [ "$MODE" = changed ]; then
  cf=$(changed_files 'migrations/.*\.sql$'); dropped=""
  [ -n "$cf" ] && dropped=$(echo "$cf" | xargs grep -InE "DROP[[:space:]]+(INDEX|CONSTRAINT).*idempotency" 2>/dev/null || true)
  if [ -n "$dropped" ]; then failed "INV-GOV-006 (change): this branch drops an idempotency constraint/index. Ledger dedup depends on it:"; echo "$dropped"; else pass "INV-GOV-006 (change): no idempotency constraint dropped in the diff"; fi
else
  base=$(grep -rInE "idempotency_key.*(UNIQUE|unique)" migrations 2>/dev/null | head -3 || true)
  [ -n "$base" ] && notice "INV-GOV-006 (baseline): idempotency uniqueness lives in migrations (007, 001). Do not DROP it. Enforced on diffs via --changed."
fi

# --- INV-GOV-009 — Deploy discipline: no manual build introduced --------------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE '#' || true)
  if [ -n "$mb" ]; then failed "INV-GOV-009 (change): this branch adds a 'gcloud builds submit' action. Deploys are trigger-only (main->dev, production->prod):"; echo "$mb"; else pass "INV-GOV-009 (change): no manual build introduced"; fi
else
  notice "INV-GOV-009: change gate. Run with --changed in CI to flag a diff that adds a manual 'gcloud builds submit'."
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-GOV-001 Fail closed        -> src/__tests__/governance-invariants.test.ts (DB-unreachable suite)"
echo "  INV-GOV-004 HITL default-deny  -> src/__tests__/governance-invariants.test.ts (CI-blocking)"
echo "  INV-GOV-005 Preflight token    -> src/auth/preflight-token.test.ts"
echo "  INV-GOV-007 Audit redaction    -> src/audit/__tests__/sanitize-args.test.ts"
echo "  INV-GOV-008 Latency budget     -> .github/workflows/benchmarks.yml + src/__benchmark__/*.bench.test.ts"
echo "  INV-GOV-002 append-only (DB)   -> migrations/019 triggers audit_logs_no_mutate / audit_logs_no_truncate"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
