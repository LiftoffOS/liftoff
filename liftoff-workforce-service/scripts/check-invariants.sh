#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
# Every invariant in this repo is currently `social` (no lint rule / CI gate / test
# yet), so all of them are implemented here.
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "no direct provider SDK call
#             anywhere in src"). Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (a new manual build). These are inherently
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

# The five RLS-protected tables (INV-WF-001) and the non-RLS service tables (INV-WF-002).
RLS_TABLES='workforce_plans|team_plan_threads|team_plan_messages|team_plan_rate_limit_events|caio_memory'

# --- INV-WF-001 — RLS tables must be queried through withTenantContext -------------
# state: no query issued on a POOL may name an RLS table in a SQL position.
#
# Two simpler shapes of this check both miss real bugs. A single-line grep for
# `getPool().query` next to a table name never fires, because real code puts
# `const pool = getPool()` at the top of a try block and `INSERT INTO
# caio_memory` twenty lines down. Widening it to file scope fired on every legitimately mixed file
# (repository.ts wraps most queries and pool-calls a function; router.ts writes
# a non-RLS table), which is the kind of noise that gets a gate switched off.
#
# So: find the pool-issued query calls, and look at the statement each one
# opens. `client.query` inside withTenantContext is invisible to this by
# construction, which is exactly the distinction that matters.
SQL_POS="(FROM|JOIN|INTO|UPDATE)[ \t]+($RLS_TABLES)[^a-zA-Z_]"
STMT_WINDOW=25

# Pre-filter on `.query`, not `query(` — the call is routinely generic
# (`pool.query<{ id: string }>(`), and filtering on the paren dropped exactly
# the file this invariant exists to police.
rls_direct=$(grep -rIl "\.query" src 2>/dev/null \
  | grep -vE "infrastructure/(database|rls)\\.ts" \
  | xargs awk -v pos="$SQL_POS" -v win="$STMT_WINDOW" '
      FNR==1 { left = 0 }
      /[Pp]ool\)?\.query[<(]/ { left = win }
      left > 0 {
        # Match against the line plus a sentinel space: the table name is
        # routinely the last thing on its line (`\`UPDATE workforce_plans`),
        # and without this the trailing char class has nothing to match and the
        # check silently never fires and passes while the bug is live.
        if (($0 " ") ~ pos) { print FILENAME ":" FNR ": " $0; left = 0 }
        else left--
      }
    ' 2>/dev/null || true)
if [ -n "$rls_direct" ]; then failed "INV-WF-001 (state): a pool-issued query names an RLS table (must use withTenantContext):"; echo "$rls_direct"; else pass "INV-WF-001 (state): no pool-issued query touches an RLS table"; fi

# --- INV-WF-002 — non-RLS service tables stay on the direct pool -------------------
# state: withTenantContext body should not reference a non-RLS service table. Heuristic:
#        flag lines that mention capability_tokens/outbox_events/etc. inside a file that
#        also imports withTenantContext (manual review — NOTICE, not FAIL).
NONRLS='capability_tokens|hrbp_provisioning|outbox_events|processed_events|workforce_audit_log|plan_pending_integrations'
mixed=$(grep -rIlE "withTenantContext" src 2>/dev/null | xargs grep -InE "$NONRLS" 2>/dev/null || true)
if [ -n "$mixed" ]; then notice "INV-WF-002 (state): a file using withTenantContext also names a non-RLS service table; verify the non-RLS table is NOT wrapped:"; echo "$mixed"; else pass "INV-WF-002 (state): no non-RLS service table obviously mixed into a withTenantContext file"; fi

# --- INV-WF-003 — capability tokens: hash-only, atomic burn ------------------------
CAP=src/workforce-plans/capability-tokens.ts
if [ -f "$CAP" ]; then
  # The INSERT must persist token_hash, never a raw token column.
  ins=$(grep -nE "INSERT INTO capability_tokens" "$CAP" || true)
  if [ -n "$ins" ] && grep -qE "token_hash" "$CAP"; then pass "INV-WF-003 (state): capability_tokens INSERT stores token_hash"; else failed "INV-WF-003 (state): capability_tokens INSERT does not reference token_hash — raw token may be persisted"; echo "$ins"; fi
  # The burn must be a single atomic UPDATE ... RETURNING guarded on used_at IS NULL.
  if grep -qE "UPDATE capability_tokens" "$CAP" && grep -qE "used_at\s+IS NULL" "$CAP" && grep -qE "RETURNING" "$CAP"; then pass "INV-WF-003 (state): validate/burn uses atomic UPDATE ... RETURNING guarded on used_at IS NULL"; else failed "INV-WF-003 (state): capability-token burn is not an atomic UPDATE ... RETURNING guarded on used_at IS NULL"; fi
else
  notice "INV-WF-003: $CAP not found (file moved?) — update this check."
fi

# --- INV-WF-004 — LLM calls only via the platform-backend relay --------------------
# state: no provider SDK instantiation or direct provider call anywhere in src.
prov=$(grep -rInE "new Anthropic\(|from ['\"]@anthropic-ai/sdk['\"]|\.messages\.create\(" src 2>/dev/null || true)
if [ -n "$prov" ]; then failed "INV-WF-004 (state): direct provider SDK usage found — all LLM calls must go through PB /api/internal/llm/complete:"; echo "$prov"; else pass "INV-WF-004 (state): no direct provider SDK usage; LLM path is the PB relay only"; fi

# --- INV-WF-005 — service-to-service auth header present ---------------------------
# state: EVERY file that calls a platform-backend /api/ route must carry service
# auth — not just the LLM relay.
#
# Scoped to every platform-backend caller, not to a single URL. An invariant
# pinned to one endpoint only ever polices the call that already works.
#
# Bearer-only is the shape to catch: this service's outbound identity is an OIDC
# token plus X-Service-Auth, both of which getServiceAuthHeaders() supplies.
pb_callers=$(grep -rlE "PLATFORM_BACKEND_URL" src --include="*.ts" 2>/dev/null | grep -v "__tests__" | grep -v "infrastructure/config.ts" || true)
noauth=""
for f in $pb_callers; do
  grep -qE "/api/" "$f" 2>/dev/null || continue
  grep -qE "X-Service-Auth|x-service-auth|getServiceAuthHeaders" "$f" 2>/dev/null || noauth="$noauth$f\n"
done
if [ -n "$noauth" ]; then failed "INV-WF-005 (state): file(s) call a platform-backend /api/ route without service auth (X-Service-Auth / getServiceAuthHeaders):"; printf "%b" "$noauth"; else pass "INV-WF-005 (state): every platform-backend caller carries service auth"; fi

# change: a changed .ts file that calls any PB /api/ route must include service auth.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); missing=""
  for f in $cf; do
    [ -f "$f" ] || continue
    case "$f" in *__tests__*) continue ;; esac
    if grep -qE "PLATFORM_BACKEND_URL" "$f" && grep -qE "/api/" "$f" && ! grep -qE "X-Service-Auth|x-service-auth|getServiceAuthHeaders" "$f"; then missing="$missing$f\n"; fi
  done
  if [ -n "$missing" ]; then failed "INV-WF-005 (change): a changed file calls platform-backend without X-Service-Auth / getServiceAuthHeaders:"; printf "%b" "$missing"; else pass "INV-WF-005 (change): no changed PB caller is missing service auth"; fi
fi

# --- INV-WF-006 — deploy discipline: no manual build introduced --------------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  # Exclude cloudbuild.yaml's documented stale-build guard, which merely references the phrase.
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE 'skipping stale|Manual build|# ' || true)
  if [ -n "$mb" ]; then failed "INV-WF-006 (change): this branch adds a 'gcloud builds submit' action. Deploys are trigger-only for workforce-service:"; echo "$mb"; else pass "INV-WF-006 (change): no manual build introduced"; fi
else
  base=$(grep -rInE 'gcloud builds submit' cloudbuild.yaml 2>/dev/null | grep -vE 'skipping stale|Manual build' || true)
  [ -n "$base" ] && notice "INV-WF-006 (baseline): existing 'gcloud builds submit' reference(s) below (allowed; enforced on diffs via --changed):" && echo "$base"
  [ -z "$base" ] && pass "INV-WF-006 (state): no manual 'gcloud builds submit' in build config"
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  (none yet — every INV-WF invariant is 'social'; promoting to lint/gate/test is the backlog)"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
