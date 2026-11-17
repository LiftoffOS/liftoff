#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of docs/invariants.md into real checks so a human,
# CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
#
# tenant-runtime is the org's most-enforced repo: nearly every invariant is already
# backed by a local ESLint rule (eslint-rules/), a boot-time assert, a CI gate, or a
# verification test. Those are the SINGLE SOURCE of enforcement and are listed under
# "Delegated" below — this script does NOT re-implement them (a second, weaker copy
# would only drift). It implements the handful of drift checks that are cheap greps
# with no authoritative lint/gate home, so `npm run lint` + CI + this script together
# cover the full invariant set.
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "no direct process.env.TENANT_RUNTIME_URL
#             read outside runtime-env.ts"). Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (a new manual build, a growing console.* count).
#             These are about a diff, so they only FAIL in --changed mode against the
#             files a branch actually touched. In full-tree mode they print the existing
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

# --- INV-TR-003 — No console.* in src/ ---------------------------------------------
# state: enforced at `warn` by r5/no-console-in-src (legacy sites remain). Track the
# baseline count so it never grows; the lint rule is the authoritative enforcer.
consolecount=$(grep -rInE 'console\.(log|warn|error|info|debug)\b' src 2>/dev/null | wc -l | tr -d ' ')
if [ "$MODE" = changed ]; then
  cf=$(changed_files '^src/.*\.ts$'); newc=""
  [ -n "$cf" ] && newc=$(echo "$cf" | grep -vE '(__tests__|\.test\.ts)$' | xargs grep -InE 'console\.(log|warn|error|info|debug)\b' 2>/dev/null || true)
  if [ -n "$newc" ]; then failed "INV-TR-003 (change): this branch adds console.* under src/. Use scrubLogger:"; echo "$newc"; else pass "INV-TR-003 (change): no new console.* under src/"; fi
else
  notice "INV-TR-003 (baseline): $consolecount existing console.* call(s) in src/. Enforced by r5/no-console-in-src; count must not grow (run --changed in CI)."
fi

# --- INV-TR-006 — TENANT_RUNTIME_URL only via runtime-env.ts ------------------------
# state: no direct process.env.TENANT_RUNTIME_URL in business logic. The runtime-env
# module owns the guarded read; tests + test-utils legitimately set the env for fixtures
# (the no-restricted-syntax rule allow-lists them), so they are excluded here too.
badenv=$(grep -rInE 'process\.env\.TENANT_RUNTIME_URL' src 2>/dev/null | grep -vE 'src/infrastructure/runtime-env\.ts|__tests__|\.test\.ts|src/test-utils/' || true)
if [ -n "$badenv" ]; then failed "INV-TR-006 (state): direct process.env.TENANT_RUNTIME_URL read outside runtime-env.ts. Use getTenantRuntimeUrl():"; echo "$badenv"; else pass "INV-TR-006 (state): no direct TENANT_RUNTIME_URL env read outside runtime-env.ts"; fi

# --- INV-TR-007 — Vendor SDKs stay behind the adapter ------------------------------
# state (advisory): flag vendor-SDK imports outside the known adapter/provider seams.
# no-restricted-imports in eslint.config.mjs is authoritative (with the real allow-list);
# this is a coarse notice to catch a seam that moved without updating the config.
VENDOR="@anthropic-ai/(sdk|claude-agent-sdk)|(^|[^-])openai($|[^a-z])|@openai/|@google/(genai|gemini-cli)|tiktoken"
SEAM='src/agent-execution/adapter/|src/llm/providers/|src/trajectories/(per-vendor|recorder)|adapter/tools/code-session|\.test\.ts|__tests__'
vendorimp=$(grep -rInE "from ['\"]($VENDOR)" src 2>/dev/null | grep -vE "$SEAM" || true)
if [ -n "$vendorimp" ]; then notice "INV-TR-007 (state): vendor-SDK import outside the known adapter/provider seam. Confirm it is allow-listed in eslint.config.mjs (no-restricted-imports is authoritative):"; echo "$vendorimp"; else pass "INV-TR-007 (state): no vendor-SDK import outside the adapter/provider seam"; fi

# --- INV-TR-009 — Deploy discipline: no manual build; no migration collision --------
# change: no `gcloud builds submit` introduced by this branch.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE '# ' || true)
  if [ -n "$mb" ]; then failed "INV-TR-009 (change): this branch adds a 'gcloud builds submit'. Deploys are trigger-only, per tenant:"; echo "$mb"; else pass "INV-TR-009 (change): no manual build introduced"; fi
else
  base=$(grep -rInE 'gcloud builds submit' scripts cloudbuild.yaml .github 2>/dev/null | grep -vE '# ' || true)
  [ -n "$base" ] && notice "INV-TR-009 (baseline): existing 'gcloud builds submit' reference(s) below. Enforced on diffs via --changed:" && echo "$base"
fi
# state: migration NNN prefixes are unique (delegates to the collision script).
if [ -x scripts/check-migration-collisions.sh ]; then
  if scripts/check-migration-collisions.sh migrations >/dev/null 2>&1; then pass "INV-TR-009 (state): no duplicate migration NNN prefix (check-migration-collisions.sh)"; else failed "INV-TR-009 (state): duplicate migration NNN prefix — run scripts/check-migration-collisions.sh"; fi
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-TR-001 Memories tenant-scoped     -> eslint r5/memories-must-be-tenant-scoped + RLS migration 241"
echo "  INV-TR-002 Log events literal+schema  -> eslint r5/log-event-must-be-literal + scripts/ci/verify-log-schemas.ts"
echo "  INV-TR-003 No console.* in src/       -> eslint r5/no-console-in-src (count tracked above)"
echo "  INV-TR-004 No stub success            -> eslint r5/no-stub-success-fallback + src/tools/handler-completeness.ts (boot) + canary-gate.yml"
echo "  INV-TR-005 createIsolatedPath assigned-> eslint r5/no-unassigned-isolated-path"
echo "  INV-TR-006 TENANT_RUNTIME_URL guard   -> eslint no-restricted-syntax (state grep above)"
echo "  INV-TR-007 Vendor-SDK isolation       -> eslint no-restricted-imports + no-restricted-syntax (state grep above)"
echo "  INV-TR-008 Durable idempotency        -> src/agent-execution/dedup-posture + run-state tests"
echo "  INV-TR-009 Deploy discipline          -> cloudbuild.yaml check-migration-collisions.sh + ci.yml no-focused-tests"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
