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
#   state   — a property of the current tree (e.g. "no credential value is logged").
#             Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (new plaintext credential column, manual build).
#             These are inherently about a diff, so they only FAIL in --changed mode
#             against the files a branch actually touched. In full-tree mode they print
#             the existing baseline as NOTICE and never fail (existing code is not a
#             regression).
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

# --- INV-CONN-001 — Credentials never live in plaintext ----------------------------
# state: no logger/console call interpolates a raw credential-bearing variable.
CREDVARS='accessToken|refreshToken|apiKey|privateKey|client_secret|clientSecret'
credlog=$(grep -rInE "(logger\.(info|debug|warn|error)|console\.(log|info|error|warn|debug))\(" src 2>/dev/null \
  | grep -v -E '\.test\.ts|__tests__|test-utils' \
  | grep -InE "\b($CREDVARS)\b" || true)
if [ -n "$credlog" ]; then
  failed "INV-CONN-001 (state): a log/console call appears to reference a raw credential value. Log present:true / a boolean, never the value:"; echo "$credlog"
else
  pass "INV-CONN-001 (state): no credential value logged"
fi
# state: the secret-name / path-segment validation guards are still present.
if grep -q 'SECRET_NAME_RE' src/secrets/client.ts 2>/dev/null && grep -q 'assertSafeSecretSegment' src/secrets/client.ts 2>/dev/null; then
  pass "INV-CONN-001 (state): secret-name + path-segment validation intact in src/secrets/client.ts"
else
  failed "INV-CONN-001 (state): SECRET_NAME_RE / assertSafeSecretSegment missing from src/secrets/client.ts — path-traversal guard removed?"
fi
# change: this branch must not add a plaintext credential column on a connector table.
if [ "$MODE" = changed ]; then
  mf=$(changed_files 'migrations/.*\.(sql|js)$'); newcol=""
  [ -n "$mf" ] && newcol=$(echo "$mf" | xargs grep -InE 'ADD COLUMN.*(token|secret|api_?key|private_?key|password)' 2>/dev/null | grep -viE 'DROP|secret_path|_secret_path|needs_reconnect' || true)
  if [ -n "$newcol" ]; then failed "INV-CONN-001 (change): this branch adds a column that looks like it stores a credential. Credentials live only in Secret Manager:"; echo "$newcol"; else pass "INV-CONN-001 (change): no plaintext-credential column added"; fi
else
  notice "INV-CONN-001: change gate for new credential columns. Run with --changed in CI."
fi

# --- INV-CONN-005 — Tenant DB access is RLS-scoped ---------------------------------
# state: no raw pool.query naming an RLS table, outside db/, polling/, and the
# intentional service-internal *Internal methods.
rls=$(grep -rInE 'pool\.query' src 2>/dev/null \
  | grep -v -E 'src/db/|src/polling/|\.test\.ts|__tests__' \
  | grep -InE 'connectors|connector_credentials' || true)
if [ -n "$rls" ]; then
  notice "INV-CONN-005 (state): pool.query referencing an RLS table outside db/. Confirm each is an intentional withAdminScope/service-internal by-PK read (e.g. getByIdInternal), not an accidental unscoped query:"; echo "$rls"
else
  pass "INV-CONN-005 (state): no raw pool.query on connectors/connector_credentials outside db/"
fi

# --- INV-CONN-008 — Deploy discipline: no manual build introduced ------------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE '# ' || true)
  if [ -n "$mb" ]; then failed "INV-CONN-008 (change): this branch adds a 'gcloud builds submit' action. Deploys are trigger-only:"; echo "$mb"; else pass "INV-CONN-008 (change): no manual build introduced"; fi
else
  base=$(grep -rInE 'gcloud builds submit' src scripts .github cloudbuild.yaml 2>/dev/null | grep -vE '# |check-invariants\.sh' || true)
  if [ -n "$base" ]; then notice "INV-CONN-008 (baseline): existing 'gcloud builds submit' reference(s). Enforced on diffs via --changed:"; echo "$base"; else notice "INV-CONN-008: change gate. Run with --changed in CI to flag a manual build in a diff."; fi
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-CONN-002 No stub success   -> eslint r5-local/no-stub-success-fallback"
echo "  INV-CONN-003 Fresh fixtures     -> src/contract-tests/response-shapes/fixture-age-test.test.ts (+ fixture-age-quarterly.yml)"
echo "  INV-CONN-004 Valid tool schemas -> src/catalog/tool-schemas.test.ts + src/contract-tests/**"
echo "  INV-CONN-006 Generated in sync  -> cloudbuild.yaml step check-connector-docs-drift"
echo "  INV-CONN-007 Latency budgets    -> .github/workflows/benchmarks.yml + cloudbuild.yaml step bench"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
