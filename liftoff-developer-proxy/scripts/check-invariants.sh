#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "the upstream fetch body is the
#             raw buffer"). Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (a new Stripe meter, a manual build). These are
#             inherently about a diff, so they only FAIL in --changed mode against the
#             files a branch actually touched. In full-tree mode they print the
#             existing baseline as NOTICE and never fail (existing code is not a regression).
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

# --- INV-DP-001 — Transparent proxy: body is adapter-owned (Anthropic verbatim / OpenAI allowlist) ---
# state: the upstream fetch body is the adapter's normalizeRequestBody output, not a
# body the handler builds itself. Anthropic's adapter returns the raw buffer verbatim;
# OpenAI's re-serializes through a field allowlist. Both are confined to the adapter.
if grep -qE 'body:\s*upstreamBody' src/proxy/handler.ts 2>/dev/null \
   && grep -qE 'upstreamBody\s*=\s*adapter\.normalizeRequestBody\(' src/proxy/handler.ts 2>/dev/null; then
  pass "INV-DP-001 (state): upstream fetch forwards adapter.normalizeRequestBody output"
else
  failed "INV-DP-001 (state): could not confirm the upstream fetch body comes from adapter.normalizeRequestBody in src/proxy/handler.ts"
fi
# state: the handler must never re-serialize a body itself (the only re-serialization
# allowed is inside a vendor adapter's normalizeRequestBody).
reser=$(grep -rInE 'body:\s*JSON\.stringify\(' src/proxy/handler.ts 2>/dev/null || true)
if [ -n "$reser" ]; then failed "INV-DP-001 (state): handler re-serializes a body onto the wire (belongs in the adapter):"; echo "$reser"; else pass "INV-DP-001 (state): handler does not rebuild a body; transform stays in the adapter"; fi

# --- INV-DP-002 — API keys / secrets never logged or returned -----------------------
# state: no log/console statement references raw key material.
leaks=$(grep -rInE '(request\.log|console)\.(log|info|warn|error|debug)\([^)]*\b(apiKey|vendorApiKey|fullKey|rawToken|anthropicApiKey)\b' src 2>/dev/null || true)
if [ -n "$leaks" ]; then failed "INV-DP-002 (state): a log statement references raw key material:"; echo "$leaks"; else pass "INV-DP-002 (state): no key material in log/console statements"; fi
# state: outbound credential responses strip secretName.
if grep -qE 'secretName:\s*_secretName' src/credentials/service.ts 2>/dev/null; then
  pass "INV-DP-002 (state): toResponse strips secretName from outbound responses"
else
  notice "INV-DP-002 (state): could not confirm secretName is stripped in credentials/service.ts toResponse — verify manually"
fi

# --- INV-DP-003 — Rate limit before proxy ------------------------------------------
# state: the proxy handler is registered and a rate-limit preHandler exists in routes.ts.
if grep -qE 'checkPgRateLimit' src/proxy/routes.ts 2>/dev/null && grep -qE 'handleVendorProxy' src/proxy/routes.ts 2>/dev/null; then
  pass "INV-DP-003 (state): proxy handler + checkPgRateLimit preHandler co-located in src/proxy/routes.ts"
else
  failed "INV-DP-003 (state): rate-limit hook and/or proxy handler not found together in src/proxy/routes.ts"
fi
# state: handleVendorProxy is not registered outside routes.ts (which would skip the hook).
stray=$(grep -rInE '\.(post|get|route)\([^)]*handleVendorProxy' src 2>/dev/null | grep -v 'src/proxy/routes.ts' || true)
if [ -n "$stray" ]; then failed "INV-DP-003 (state): proxy handler registered outside the rate-limited sub-app:"; echo "$stray"; else pass "INV-DP-003 (state): proxy handler mounted only under the rate-limited sub-app"; fi

# --- INV-DP-004 — OU-native metering; no per-vendor Stripe meter --------------------
# state: no Stripe import or meter creation anywhere in src.
badmeter=$(grep -rInE 'meters\.create|meter_events\.create|from ["'"'"']stripe|require\(["'"'"']stripe' src 2>/dev/null || true)
if [ -n "$badmeter" ]; then failed "INV-DP-004 (state): Stripe/meter creation in src — usage must funnel to the OU model, not a per-vendor meter:"; echo "$badmeter"; else pass "INV-DP-004 (state): no Stripe import or meter creation in src"; fi
# change: no NEW meter/topic/subscriber introduced by this branch.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); newm=""
  [ -n "$cf" ] && newm=$(echo "$cf" | xargs grep -InE 'meters\.create|meter_events\.create|new PubSub\(\).*topic|createTopic' 2>/dev/null || true)
  if [ -n "$newm" ]; then failed "INV-DP-004 (change): this branch adds a meter/topic. Usage funnels to operating_unit_consumed via billing:"; echo "$newm"; else pass "INV-DP-004 (change): no new meter/topic in the diff"; fi
fi

# --- INV-DP-005 — Metering atomic + never breaks the response -----------------------
# state: writeUsageAndOutbox wraps its writes in one BEGIN/COMMIT transaction.
if grep -qE "client\.query\('BEGIN'\)" src/proxy/handler.ts 2>/dev/null && grep -qE "client\.query\('COMMIT'\)" src/proxy/handler.ts 2>/dev/null; then
  pass "INV-DP-005 (state): usage log + outbox written in one BEGIN/COMMIT transaction"
else
  failed "INV-DP-005 (state): could not confirm the usage/outbox write is transactional in src/proxy/handler.ts"
fi

# --- INV-DP-006 — Tenant/user isolation on credential + usage tables ----------------
TENANT_TABLES='developer_proxy_credentials|developer_proxy_usage_log'
# Sanctioned unscoped callsites (bypass policies + explicit tenant_id filters). A NEW
# reference outside this set is what the drift check is meant to catch.
# src/audit/anchor-job.ts reads the usage log to hash a whole partition for the
# daily chain-of-custody anchor. Cross-tenant by definition — an anchor scoped to
# one tenant would attest to a fraction of the partition — and read-only.
ALLOWED='src/proxy/auth.ts|src/proxy/handler.ts|src/proxy/routes.ts|src/outbox/worker.ts|src/usage/routes.ts|src/rpc/data-subject.ts|src/credentials/routes.ts|src/audit/anchor-job.ts'
raw=$(grep -rInE "$TENANT_TABLES" src --include=*.ts 2>/dev/null | grep -vE "$ALLOWED" | grep -viE 'withByok|repository|__tests__|^\s*//' || true)
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); newraw=""
  [ -n "$cf" ] && newraw=$(echo "$cf" | grep -vE "$ALLOWED" | xargs grep -InE "$TENANT_TABLES" 2>/dev/null | grep -viE 'withByok|repository' || true)
  if [ -n "$newraw" ]; then failed "INV-DP-006 (change): new reference to a tenant table outside the sanctioned scoped/bypass callsites — route it through withByokUser/withByokTenant:"; echo "$newraw"; else pass "INV-DP-006 (change): no new unscoped tenant-table access in the diff"; fi
else
  if [ -n "$raw" ]; then notice "INV-DP-006 (state): tenant-table reference(s) outside the allow-list — confirm each is a documented bypass path:"; echo "$raw"; else pass "INV-DP-006 (state): no tenant-table access outside the sanctioned callsites"; fi
fi

# --- INV-DP-007 — Deploy discipline -------------------------------------------------
# state: the Cloud Run deploy keeps --no-allow-unauthenticated.
if grep -qE '\-\-no-allow-unauthenticated' cloudbuild.yaml 2>/dev/null; then
  pass "INV-DP-007 (state): cloudbuild deploy keeps --no-allow-unauthenticated"
else
  failed "INV-DP-007 (state): cloudbuild.yaml deploy step is missing --no-allow-unauthenticated"
fi
# change: no manual 'gcloud builds submit' introduced.
if [ "$MODE" = changed ]; then
  # Exclude this checker itself — it names the forbidden string in its own error text.
  cf=$(changed_files '\.(sh|ya?ml)$' | grep -v 'scripts/check-invariants.sh'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE '# |Skip when not started' || true)
  if [ -n "$mb" ]; then failed "INV-DP-007 (change): this branch adds a 'gcloud builds submit' action. Deploys are trigger-only:"; echo "$mb"; else pass "INV-DP-007 (change): no manual build introduced"; fi
else
  mb=$(grep -rInE 'gcloud builds submit' scripts .github cloudbuild.yaml 2>/dev/null | grep -vE '# |Skip when not started|scripts/check-invariants.sh' || true)
  [ -n "$mb" ] && notice "INV-DP-007 (baseline): existing 'gcloud builds submit' reference(s). Enforced on diffs via --changed:" && echo "$mb"
fi

echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
